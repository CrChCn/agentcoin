/* agentnet/node.mjs — нода сети: TCP P2P, рукопожатие HELLO/CHALLENGE с ed25519,
   X25519+AES-GCM канал, объявления, обмен пирами, headers-first синхронизация,
   штрафы/баны, NAT-статус, локальный управляющий API и GUI. */
'use strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG, dataPaths, ensureLayout, loadConfig, mergeConfig, PROTOCOL_VERSION,
} from './config.mjs';
import { loadOrCreateIdentity, verifyWithPublicKey } from './identity.mjs';
import {
  DEFAULT_TTL_MS, MAX_MESSAGE_BYTES, openEnvelope, ReplayGuard, signEnvelope,
} from './envelope.mjs';
import { PeerBook, normalizeEndpoint } from './peers.mjs';
import { Discovery, parseSeed } from './discovery.mjs';
import { openChain } from './chain.mjs';
import { acquireGuard, GuardError } from './guard.mjs';
import { detectReachability, localAddressSummary, NAT_STATUS } from './nat.mjs';
import {
  computeSharedSecret, createEphemeralKeyPair, createSecureChannel,
  dial, FrameStream, keyConfirm,
} from './wire.mjs';
import { closeServers, listenDualStack } from './dual-listen.mjs';
import { randomHex, sleep, waitFor } from './util.mjs';
import { UpdateManager } from './updates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANNOUNCE_TTL_MS = 180000;
const ANNOUNCE_INTERVAL_MS = 60000;
const STALE_AFTER_MS = 180000;
const MAX_SYNC_ROUNDS = 5000;

function publicHostOf(config) {
  if (config.publicEndpoint && config.publicEndpoint.host) {
    return normalizeEndpoint(config.publicEndpoint.host, config.publicEndpoint.port || config.listen.port);
  }
  const host = config.listen.host;
  if (!host || host === '0.0.0.0' || host === '::') return null;
  return normalizeEndpoint(host, config.listen.port);
}

// Wildcard-адрес нельзя объявлять пирам: 0.0.0.0 не dialable. Если внешний
// endpoint ещё не известен (NAT не отработал), отдаём только порт.
function advertisedListen(config, port) {
  const ep = publicHostOf(config);
  return { host: ep ? ep.host : null, port };
}

export class AgentcoinNode extends EventEmitter {
  constructor({ dataDir, config = {}, identity = null, chain = null, log = null } = {}) {
    super();
    this.dataDir = dataDir;
    this.config = mergeConfig(DEFAULT_CONFIG, config);
    this.paths = dataPaths(ensureLayout(dataDir));
    this._logSink = log;
    this._log = log || ((line) => { if (process.env.AGENTNET_LOG !== '0') console.log(line); });
    this.identity = identity || loadOrCreateIdentity(dataDir);
    this.updater = new UpdateManager({
      stateFile: path.join(this.paths.state, 'updates.json'),
      currentVersion: this.config.version,
      protocolVersion: PROTOCOL_VERSION,
      releaseKeys: this.config.updates.releaseKeys || [],
      apply: (version) => { this.version = version; this.config.version = version; },
      log: (l) => this._log(l),
    });
    this.chain = chain || openChain({
      dir: this.paths.chain,
      networkId: this.config.networkId,
      pruneBodies: this.config.sync.pruneBodies,
    });
    this.book = new PeerBook({
      dir: this.paths.peers,
      file: this.paths.peersFile,
      banThreshold: this.config.limits.banThreshold,
      banMs: this.config.limits.banMs,
    }).load();
    this.discovery = new Discovery({
      book: this.book,
      seeds: this.config.discovery.staticSeeds,
      dnsSeeds: this.config.discovery.dnsSeeds,
      log: this._log.bind(this),
    });
    this.replay = new ReplayGuard();
    this.sessions = new Map(); // "nodeId:direction" → session
    this.pending = new Set();
    this.announcements = new Map(); // nodeId → {payload, receivedAt, expiresAt, via}
    this.seenRelays = new Map(); // messageId → expiresAt
    this.mempool = new Map();
    this._dialCooldown = new Map(); // "host:port" → until: не долбить тот же адрес
    this.state = 'new';
    this.startedAt = null;
    this.server = null;
    this.servers = [];
    this.listenEndpoints = [];
    this.apiServer = null;
    this.listenPort = null;
    this.apiPort = null;
    this.guard = null;
    this.nat = { status: NAT_STATUS.OUTBOUND_ONLY, mapped: false, cgnat: false, ipv6: false, externalIp: null, method: null, checkedAt: null };
    this.sync = { lastAt: null, lastError: null, headersAdded: 0, bodiesAdded: 0, inFlight: new Set(), completedAt: null };
    this.counters = { handshakes: 0, rejected: 0, bans: 0, announcements: 0, forks: 0, reorgs: 0, txs: 0 };
    this.timers = [];
    this.version = this.config.version;
    this.networkId = this.config.networkId;
  }

  _log(line) {
    if (this._logSink) return this._logSink(line);
    if (process.env.AGENTNET_LOG !== '0') console.log(line);
  }

  get id() { return this.identity.nodeId; }
  get isRunning() { return this.state === 'running'; }

  async start() {
    if (this.state === 'running') return this;
    this.guard = acquireGuard(this.paths.guard, { meta: { networkId: this.networkId, role: 'node' } });
    this.chain.on('diskfull', (info) => {
      this._log(`[node] диск заполнен — запись остановлена (${info.at})`);
      this.emit('diskfull', info);
      this.emit('incident', { type: 'disk_full', at: info.at });
    });
    this.chain.on('reorg', (r) => {
      this.counters.reorgs++;
      this.emit('fork.resolved', r);
      this._log(`[node] reorg на высоте ${r.forkHeight}: ${r.oldTip.hash.slice(0, 12)} → ${r.newTip.hash.slice(0, 12)}`);
    });

    // Wildcard = два слушателя на одном порту: 0.0.0.0 (IPv4) и [::] (IPv6-only),
    // чтобы входящие пиры работали в обоих семействах адресов.
    const bound = await listenDualStack({
      host: this.config.listen.host,
      port: this.config.listen.port,
      maxConnections: this.config.limits.maxPeers + this.config.limits.maxInbound,
      onConnection: (socket) => this._onInbound(socket),
    });
    this.servers = bound.servers;
    this.server = bound.servers[0];
    this.listenEndpoints = bound.endpoints;
    this.listenPort = bound.port;
    this.config.listen.port = this.listenPort;
    if (bound.ipv6Error) this._log(`[node] IPv6-слушатель не открылся: ${bound.ipv6Error}`);

    this.apiServer = http.createServer((req, res) => this._onApi(req, res));
    await new Promise((resolve) => this.apiServer.listen(this.config.api.port, this.config.api.host, resolve));
    this.apiPort = this.apiServer.address().port;

    this.state = 'running';
    this.startedAt = Date.now();
    const listenText = this.listenEndpoints.map((e) => `${e.host}:${e.port}`).join(', ');
    this._log(`[node] ${this.id} запущен: p2p ${listenText}, api ${this.config.api.host}:${this.apiPort}, сеть ${this.networkId}, высота ${this.chain.height}`);

    if (this.config.nat.enabled) {
      this._refreshNat().catch(() => {});
    } else {
      this.nat = { ...this.nat, status: NAT_STATUS.OUTBOUND_ONLY, method: 'disabled', checkedAt: new Date().toISOString() };
    }

    this._every(ANNOUNCE_INTERVAL_MS, () => this.broadcastAnnouncement());
    this._every(this.config.sync.intervalMs, () => this.maybeSync());
    this._every(this.config.discovery.intervalMs, () => this._bootstrap().catch(() => {}));
    this._every(20000, () => this._heartbeat());
    this._every(15000, () => this._expireAnnouncements());

    this.emit('started', this.snapshot());
    setTimeout(() => this._bootstrap().catch(() => {}), 25).unref?.();
    return this;
  }

  _every(ms, fn) {
    const t = setInterval(() => { try { fn(); } catch (e) { this._log(`[node] timer error: ${e.message}`); } }, ms);
    if (t.unref) t.unref();
    this.timers.push(t);
  }

  async stop(reason = 'stopped') {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of [...this.sessions.values()]) {
      try { this._send(s, 'NODE_GOODBYE', { reason }); } catch { /* noop */ }
      this._closeSession(s, reason);
    }
    for (const s of [...this.pending]) this._closeSession(s, reason);
    await closeServers(this.servers.length ? this.servers : (this.server ? [this.server] : []));
    this.servers = [];
    if (this.apiServer) await new Promise((r) => this.apiServer.close(() => r()));
    this.book.save();
    if (this.guard) this.guard.release();
    this.state = 'stopped';
    this.emit('stopped', { reason });
    this._log(`[node] остановлен: ${reason}`);
  }

  // ---------------------------------------------------------------- NAT
  async _refreshNat() {
    const cfg = { ...this.config.nat, relay: this.config.relay };
    const res = await detectReachability({
      port: this.listenPort,
      config: cfg,
      log: (l) => this._log(l),
    });
    this.nat = { ...res, localAddresses: undefined };
    this.emit('nat', this.nat);
    return this.nat;
  }

  // ----------------------------------------------------------- sessions
  _sessionKey(nodeId, direction) { return `${nodeId}:${direction}`; }

  _makeSession(socket, direction) {
    const session = {
      direction,
      socket,
      stream: null,
      nodeId: null,
      pubkey: null,
      xpub: null,
      eph: null,
      shared: null,
      authenticated: false,
      helloNonce: null,
      myNonce: null,
      challenge: null,
      listen: null,
      version: null,
      operatorId: null,
      region: null,
      lastSeen: Date.now(),
      lastPong: Date.now(),
      rtt: null,
      violations: 0,
      rate: { tokens: this.config.limits.rateBurst, at: Date.now() },
      startedAt: Date.now(),
      announcedHeight: null,
      syncInFlight: false,
      relayed: new Set(),
    };
    session.stream = new FrameStream(socket, {
      onMessage: (msg) => this._onFrame(session, msg),
      onClose: (reason) => this._closeSession(session, reason),
      onProtocolError: (reason) => this._violation(session, `protocol:${reason}`, 20),
      idleMs: this.config.limits.idleTimeoutMs,
      maxFrame: MAX_MESSAGE_BYTES.BLOCKS,
    });
    session.timer = setTimeout(() => {
      if (!session.authenticated) this._closeSession(session, 'handshake_timeout');
    }, this.config.limits.handshakeTimeoutMs);
    if (session.timer.unref) session.timer.unref();
    this.pending.add(session);
    return session;
  }

  _onInbound(socket) {
    if (this.state !== 'running') { try { socket.destroy(); } catch { /* noop */ } return; }
    const inbound = [...this.pending].filter((s) => s.direction === 'inbound').length
      + [...this.sessions.values()].filter((s) => s.direction === 'inbound').length;
    if (inbound >= this.config.limits.maxInbound) {
      this._log('[node] входящий лимит исчерпан — соединение отклонено');
      try { socket.destroy(); } catch { /* noop */ }
      return;
    }
    const session = this._makeSession(socket, 'inbound');
    session.timer = setTimeout(() => {
      if (!session.authenticated) this._closeSession(session, 'handshake_timeout');
    }, this.config.limits.handshakeTimeoutMs);
  }

  async connect(endpoint, { source = 'manual', timeoutMs = 4000 } = {}) {
    const ep = normalizeEndpoint(endpoint && endpoint.host, endpoint && endpoint.port);
    if (!ep) return { ok: false, reason: 'bad_endpoint' };
    if (this._isSelfEndpoint(ep.host, ep.port)) return { ok: false, reason: 'self' };
    if (this.state !== 'running') return { ok: false, reason: 'not_running' };
    let socket;
    try {
      socket = await dial({ host: ep.host, port: ep.port, timeoutMs });
    } catch (e) {
      this.book.markSeen({ ...ep, ok: false, error: e.message });
      return { ok: false, reason: 'dial_failed', error: e.message };
    }
    this.book.markSeen({ ...ep, ok: true });
    const session = this._makeSession(socket, 'outbound');
    session.target = ep;
    session.eph = createEphemeralKeyPair();
    session.helloNonce = randomHex(16);
    const hello = {
      pubkey: this.identity.publicKeyPem,
      xpub: session.eph.pub,
      xsig: this.identity.signB64u(Buffer.from(session.eph.pub, 'utf8')),
      nonce: session.helloNonce,
      networkId: this.networkId,
      protocol: PROTOCOL_VERSION,
      version: this.version,
      listen: advertisedListen(this.config, this.listenPort),
      operatorId: this.config.operator.id,
      region: this.config.privacy.region,
      consent: { publishEndpoint: Boolean(this.config.privacy.publishEndpoint), region: Boolean(this.config.privacy.region) },
      capabilities: ['headers', 'blocks', 'tx', 'peers'],
    };
    this._send(session, 'HELLO', hello);
    return { ok: true, endpoint: ep, source };
  }

  _send(session, type, payload, { ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!session || !session.stream || session.stream.closed) return false;
    try {
      return session.stream.send(signEnvelope(this.identity, type, payload, { ttlMs }));
    } catch (e) {
      this._log(`[node] отправка ${type} не удалась: ${e.message}`);
      return false;
    }
  }

  _sendRaw(session, env) {
    if (!session || !session.stream || session.stream.closed) return false;
    return session.stream.send(env);
  }

  _rateAllow(session, now = Date.now()) {
    const l = session.rate;
    const dt = Math.max(0, now - l.at) / 1000;
    l.tokens = Math.min(this.config.limits.rateBurst, l.tokens + dt * this.config.limits.ratePerSecond);
    l.at = now;
    if (l.tokens < 1) return false;
    l.tokens -= 1;
    return true;
  }

  _violation(session, reason, points = 10) {
    session.violations++;
    if (session.nodeId) {
      const res = this.book.penalize(session.nodeId, points, reason);
      if (res.banned) this.counters.bans++;
    }
    this._log(`[node] нарушение (${session.nodeId ? session.nodeId.slice(0, 12) : 'pending'}): ${reason} [${session.violations}]`);
    if (session.violations >= 3) this._closeSession(session, `violations:${reason}`);
  }

  _closeSession(session, reason = 'closed') {
    if (!session || session.closed) return;
    session.closed = true;
    if (!session.authenticated && session.direction === 'outbound' && session.target) {
      // Рукопожатие не состоялось (self/duplicate/чужaя сеть): не повторять
      // этот адрес каждые 5 секунд, иначе получается шквал reconnect-попыток.
      this._dialCooldown.set(`${session.target.host}:${session.target.port}`, Date.now() + 60000);
    }
    if (session.timer) clearTimeout(session.timer);
    this.pending.delete(session);
    if (session.nodeId) {
      const key = this._sessionKey(session.nodeId, session.direction);
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      this.emit('peer.disconnected', { nodeId: session.nodeId, direction: session.direction, reason });
      this._log(`[node] отключён ${session.nodeId.slice(0, 12)} (${session.direction}/${reason})`);
    }
    try { session.stream?.close(reason); } catch { /* noop */ }
  }

  // ------------------------------------------------------------ handshake
  _onFrame(session, env) {
    if (!this._rateAllow(session)) {
      this._violation(session, 'rate_limit', 15);
      return;
    }
    session.lastSeen = Date.now();
    if (!session.authenticated) return this._handshake(session, env);
    const check = openEnvelope(env, {
      pubkeyPem: session.pubkey,
      expectedNodeId: session.nodeId,
      replay: this.replay,
      maxBytes: MAX_MESSAGE_BYTES.BLOCKS,
    });
    if (!check.ok) {
      this._violation(session, `envelope:${check.reason}`, 25);
      return;
    }
    switch (env.type) {
      case 'PING': return this._send(session, 'PONG', { nonce: env.payload?.nonce, t: env.payload?.t });
      case 'PONG': {
        if (typeof env.payload?.t === 'number') session.rtt = Date.now() - env.payload.t;
        session.lastPong = Date.now();
        this.book.reward(session.nodeId, 1);
        return;
      }
      case 'NODE_ANNOUNCE': return this._onAnnouncement(session, env);
      case 'PEERS': return this._onPeers(session, env);
      case 'GET_HEADERS': return this._onGetHeaders(session, env);
      case 'HEADERS': return this._onHeaders(session, env);
      case 'GET_BLOCKS': return this._onGetBlocks(session, env);
      case 'BLOCKS': return this._onBlocks(session, env);
      case 'TX': return this._onTx(session, env);
      case 'NODE_GOODBYE': return this._closeSession(session, 'goodbye');
      default: return this._violation(session, `unexpected:${env.type}`, 10);
    }
  }

  _handshake(session, env) {
    if (session.direction === 'inbound') {
      if (session.challenge) {
        if (env.type === 'CHALLENGE') return this._onChallengeResponse(session, env);
        return this._violation(session, `expected_challenge_response:${env.type}`, 25);
      }
      if (env.type !== 'HELLO' || session.nodeId) return this._violation(session, 'expected_hello', 20);
      const check = openEnvelope(env, { pubkeyPem: env.payload?.pubkey, replay: this.replay, maxBytes: MAX_MESSAGE_BYTES.HELLO });
      if (!check.ok) return this._violation(session, `hello:${check.reason}`, 25);
      return this._acceptHello(session, env);
    }
    if (env.type === 'CHALLENGE' && !session.authenticated) return this._answerChallenge(session, env);
    return this._violation(session, `unexpected_handshake:${env.type}`, 20);
  }

  _acceptHello(session, env) {
    const p = env.payload || {};
    if (p.networkId !== this.networkId) {
      this._log(`[node] чужaя сеть ${p.networkId} — отказ`);
      return this._closeSession(session, 'network_mismatch');
    }
    if (Number(p.protocol) !== PROTOCOL_VERSION) return this._closeSession(session, 'protocol_mismatch');
    if (env.nodeId === this.id) {
      this._log('[node] self-connect — отказ');
      return this._closeSession(session, 'self_connect');
    }
    if (this.book.isBanned(env.nodeId)) {
      this._log(`[node] забаненный ${env.nodeId.slice(0, 12)} — отказ`);
      return this._closeSession(session, 'banned');
    }
    if (session.nodeId) return this._violation(session, 'double_hello', 30);
    // Один пир — один канал. Если сессия уже есть (в любом направлении), второй
    // dial отклоняем: иначе обе стороны шлют одно объявление дважды и получают
    // ложный replay.
    if ([...this.sessions.values()].some((s) => s.nodeId === env.nodeId)) {
      this._log(`[node] дубликат входящего ${env.nodeId.slice(0, 12)} — close`);
      return this._closeSession(session, 'duplicate_peer');
    }
    if (typeof p.xpub !== 'string' || !verifyWithPublicKey(p.pubkey, Buffer.from(p.xpub, 'utf8'), p.xsig)) {
      return this._violation(session, 'bad_key_proof', 30);
    }
    session.nodeId = env.nodeId;
    session.pubkey = p.pubkey;
    session.xpub = p.xpub;
    session.version = String(p.version || 'unknown');
    session.listen = normalizeEndpoint(p.listen?.host, p.listen?.port);
    session.operatorId = p.operatorId || null;
    session.region = p.consent?.region ? p.region : null;
    session.helloNonce = p.nonce;
    session.eph = createEphemeralKeyPair();
    session.shared = computeSharedSecret(session.eph.privateKey, p.xpub);
    session.challenge = randomHex(32);
    session.myNonce = randomHex(16);
    const challenge = {
      pubkey: this.identity.publicKeyPem,
      xpub: session.eph.pub,
      xsig: this.identity.signB64u(Buffer.from(session.eph.pub, 'utf8')),
      nonce: session.myNonce,
      challenge: session.challenge,
      helloNonce: session.helloNonce,
      networkId: this.networkId,
      protocol: PROTOCOL_VERSION,
      version: this.version,
      listen: advertisedListen(this.config, this.listenPort),
    };
    this._send(session, 'CHALLENGE', challenge);
  }

  _answerChallenge(session, env) {
    const p = env.payload || {};
    const check = openEnvelope(env, { pubkeyPem: p.pubkey, replay: this.replay, maxBytes: MAX_MESSAGE_BYTES.CHALLENGE });
    if (!check.ok) return this._violation(session, `challenge:${check.reason}`, 25);
    if (p.helloNonce && p.helloNonce !== session.helloNonce) return this._violation(session, 'challenge_nonce_mismatch', 30);
    if (p.networkId !== this.networkId) return this._closeSession(session, 'network_mismatch');
    if (Number(p.protocol) !== PROTOCOL_VERSION) return this._closeSession(session, 'protocol_mismatch');
    if (typeof p.xpub !== 'string' || !verifyWithPublicKey(p.pubkey, Buffer.from(p.xpub, 'utf8'), p.xsig)) {
      return this._violation(session, 'bad_key_proof', 30);
    }
    session.nodeId = env.nodeId;
    session.pubkey = p.pubkey;
    session.xpub = p.xpub;
    session.version = String(p.version || 'unknown');
    session.listen = normalizeEndpoint(p.listen?.host, p.listen?.port);
    session.shared = computeSharedSecret(session.eph.privateKey, p.xpub);
    session.myNonce = randomHex(16);
    const response = {
      pubkey: this.identity.publicKeyPem,
      xpub: session.eph.pub,
      xsig: this.identity.signB64u(Buffer.from(session.eph.pub, 'utf8')),
      role: 'response',
      challenge: p.challenge,
      nonce: session.myNonce,
      confirm: keyConfirm(session.shared, session.helloNonce, p.nonce),
    };
    this._send(session, 'CHALLENGE', response);
    this._enableSessionCrypto(session, { initiator: true });
    this._markAuthenticated(session);
  }

  _enableSessionCrypto(session, { initiator }) {
    const channel = createSecureChannel(session.shared, { initiator });
    session.stream.setOutChannel({ seal: channel.seal });
    session.stream.setInChannel({ open: channel.open });
  }

  _onChallengeResponse(session, env) {
    const p = env.payload || {};
    if (p.role !== 'response') return this._violation(session, 'bad_challenge_role', 20);
    if (p.challenge !== session.challenge) return this._violation(session, 'bad_challenge_value', 30);
    // HMAC считается по nonce инициатора (HELLO) и СВОЕМУ nonce ответчика (CHALLENGE)
    if (p.confirm !== keyConfirm(session.shared, session.helloNonce, session.myNonce)) {
      return this._violation(session, 'bad_key_confirm', 30);
    }
    this._enableSessionCrypto(session, { initiator: false });
    this._markAuthenticated(session);
  }

  _markAuthenticated(session) {
    if (session.authenticated) return;
    if (this.book.isBanned(session.nodeId)) return this._closeSession(session, 'banned');
    const key = this._sessionKey(session.nodeId, session.direction);
    const existing = this.sessions.get(key);
    if (existing && existing !== session) return this._closeSession(session, 'duplicate_peer');
    session.authenticated = true;
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    this.pending.delete(session);
    this.sessions.set(key, session);

    // Гонка встречных dial: оба узла одновременно подключились друг к другу.
    // Оставляем один канал — тот, что инициировал меньший nodeId; на обеих
    // сторонах это один и тот же TCP-канал.
    const oppositeKey = this._sessionKey(session.nodeId, session.direction === 'inbound' ? 'outbound' : 'inbound');
    const opposite = this.sessions.get(oppositeKey);
    if (opposite) {
      const keepOutbound = this.id < session.nodeId;
      const keep = keepOutbound
        ? (session.direction === 'outbound' ? session : opposite)
        : (session.direction === 'inbound' ? session : opposite);
      if (keep !== session) {
        this.sessions.delete(key);
        session.authenticated = false;
        return this._closeSession(session, 'duplicate_peer');
      }
      this._closeSession(opposite, 'duplicate_peer');
    }

    this.counters.handshakes++;
    this.book.add({ ...(session.listen || session.target || {}), nodeId: session.nodeId, source: session.direction });
    this._log(`[node] peer authenticated ${session.nodeId.slice(0, 12)} (${session.direction}, ${session.version})`);
    this.emit('peer.connected', this._sessionInfo(session));
    this._sendAnnouncement(session);
    this._sendPeers(session);
    setTimeout(() => { if (session.authenticated) this.requestSync(session); }, 30).unref?.();
  }

  _sessionInfo(session) {
    return {
      nodeId: session.nodeId,
      direction: session.direction,
      version: session.version,
      operatorId: session.operatorId,
      region: session.region,
      rtt: session.rtt,
      encrypted: session.stream.stats().encrypted,
      connectedAt: new Date(session.startedAt).toISOString(),
      remote: session.listen || null,
    };
  }

  // --------------------------------------------------------- announcements
  _announcementPayload() {
    const consent = Boolean(this.config.privacy.publishEndpoint);
    const ep = consent ? publicHostOf(this.config) : null;
    return {
      pubkey: this.identity.publicKeyPem,
      version: this.version,
      protocol: PROTOCOL_VERSION,
      networkId: this.networkId,
      height: this.chain.height,
      tipHash: this.chain.tip ? this.chain.tip.hash : null,
      chainwork: this.chain.work.toString(),
      genesisHash: this.chain.genesisHash,
      peers: this.authenticatedCount(),
      inboundVerified: [...this.sessions.values()].filter((s) => s.direction === 'inbound').length,
      nat: {
        status: this.nat.status,
        mapped: Boolean(this.nat.mapped),
        cgnat: Boolean(this.nat.cgnat),
        ipv6: Boolean(this.nat.ipv6),
      },
      endpoint: ep ? { host: ep.host, port: ep.port } : null,
      relayUrl: this.config.relay.enabled ? this.config.relay.url : null,
      operatorId: this.config.operator.id || null,
      region: this.config.privacy.region || null,
      consent: { publishEndpoint: consent, region: Boolean(this.config.privacy.region) },
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      capabilities: ['headers', 'blocks', 'tx', 'peers'],
    };
  }

  announcement() {
    return signEnvelope(this.identity, 'NODE_ANNOUNCE', this._announcementPayload(), { ttlMs: ANNOUNCE_TTL_MS });
  }

  _sendAnnouncement(session) {
    this._send(session, 'NODE_ANNOUNCE', this._announcementPayload(), { ttlMs: ANNOUNCE_TTL_MS });
  }

  broadcastAnnouncement() {
    if (!this.isRunning) return 0;
    const env = this.announcement();
    let n = 0;
    for (const s of this.sessions.values()) {
      if (this._sendRaw(s, env)) n++;
    }
    return n;
  }

  _recordAnnouncement(env, { via = null } = {}) {
    const p = env.payload || {};
    if (p.networkId !== this.networkId) return null;
    const old = this.announcements.get(env.nodeId);
    const record = {
      nodeId: env.nodeId,
      payload: p,
      receivedAt: Date.now(),
      expiresAt: env.expiresAt,
      via,
      messageId: env.messageId,
    };
    this.announcements.set(env.nodeId, record);
    if (!old) this.emit('node.discovered', { nodeId: env.nodeId, via, height: p.height });
    if (old && old.payload && p.height === old.payload.height && p.tipHash && old.payload.tipHash && p.tipHash !== old.payload.tipHash) {
      this.counters.forks++;
      this._log(`[node] FORK на высоте ${p.height}: ${old.payload.tipHash.slice(0, 12)} ≠ ${p.tipHash.slice(0, 12)} (${env.nodeId.slice(0, 12)})`);
      this.emit('fork.detected', {
        height: p.height,
        hashes: [old.payload.tipHash, p.tipHash],
        nodeId: env.nodeId,
      });
    }
    if (p.height != null) this.emit('node.sync_progress', { nodeId: env.nodeId, height: p.height, tipHash: p.tipHash });
    return record;
  }

  _onAnnouncement(session, env) {
    if (env.nodeId !== session.nodeId) return this._violation(session, 'announcement_from_other_node', 30);
    if (env.payload && Number.isFinite(env.payload.height)) session.announcedHeight = Number(env.payload.height);
    const rec = this._recordAnnouncement(env, { via: session.nodeId });
    if (!rec) return this._violation(session, 'announcement_bad_network', 20);
    // Relay: вложенные подписанные объявления других нод (не более 2 hops).
    const relay = env.payload && env.payload.relay;
    if (Array.isArray(relay)) {
      const hops = Number(env.payload.hops) || 0;
      if (hops <= 2) {
        let accepted = 0;
        for (const nested of relay.slice(0, 16)) {
          if (!nested || this.seenRelays.has(nested.messageId)) continue;
          const check = openEnvelope(nested, { pubkeyPem: nested.payload?.pubkey, replay: this.replay, maxBytes: MAX_MESSAGE_BYTES.NODE_ANNOUNCE });
          if (!check.ok || nested.type !== 'NODE_ANNOUNCE') continue;
          if (nested.nodeId === this.id) continue;
          this.seenRelays.set(nested.messageId, nested.expiresAt);
          this._recordAnnouncement(nested, { via: session.nodeId });
          accepted++;
        }
        if (accepted > 0) this._gossipRelay(env, session);
      }
    }
  }

  _gossipRelay(env, except) {
    const nested = (env.payload?.relay || []).slice(0, 16);
    if (nested.length === 0) return;
    const out = signEnvelope(this.identity, 'NODE_ANNOUNCE', {
      relay: nested,
      hops: (Number(env.payload?.hops) || 0) + 1,
    }, { ttlMs: ANNOUNCE_TTL_MS });
    for (const s of this.sessions.values()) {
      if (s === except) continue;
      this._sendRaw(s, out);
    }
  }

  _expireAnnouncements() {
    const now = Date.now();
    for (const [id, rec] of this.announcements) {
      if (rec.expiresAt <= now) {
        this.announcements.delete(id);
        this.emit('node.stale', { nodeId: id, lastSeen: new Date(rec.receivedAt).toISOString() });
      }
    }
    for (const [id, exp] of this.seenRelays) if (exp <= now) this.seenRelays.delete(id);
  }

  // ---------------------------------------------------------------- peers
  _sendPeers(session, { find = null } = {}) {
    const exclude = new Set([`${session.listen?.host || ''}:${session.listen?.port || ''}`]);
    const known = this.discovery.closestKnown(find || session.nodeId, { k: 8, exclude });
    const list = known.map((p) => ({ host: p.host, port: p.port, nodeId: p.nodeId }));
    this._send(session, 'PEERS', { list, find });
  }

  _onPeers(session, env) {
    const p = env.payload || {};
    if (p.find) {
      this.discovery.noteLookup();
      return this._sendPeers(session, { find: p.find });
    }
    const added = this.discovery.learn(p.list, 'pex');
    if (added > 0) this.emit('peers.learned', { from: session.nodeId, added });
    const auth = this.authenticatedCount();
    if (auth < this.config.discovery.minPeers) this._bootstrap().catch(() => {});
  }

  authenticatedCount() {
    return new Set([...this.sessions.values()].map((s) => s.nodeId)).size;
  }

  _isSelfEndpoint(host, port) {
    if (Number(port) !== this.listenPort) return false;
    if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
    if (host === this.config.listen.host) return true;
    const local = localAddressSummary();
    return local.v4.includes(host) || local.v6.includes(host);
  }

  async _bootstrap() {
    if (!this.isRunning) return;
    if (this.authenticatedCount() >= this.config.discovery.maxPeers) return;
    const exclude = new Set();
    for (const s of this.sessions.values()) {
      if (s.listen) exclude.add(`${s.listen.host}:${s.listen.port}`);
      if (s.target) exclude.add(`${s.target.host}:${s.target.port}`);
    }
    exclude.add(`${this.config.listen.host}:${this.listenPort}`);
    const candidates = await this.discovery.candidates({ limit: 8, exclude });
    for (const c of candidates) {
      if (this.authenticatedCount() >= this.config.discovery.maxPeers) break;
      if (this._isSelfEndpoint(c.host, c.port)) continue;
      const key = `${c.host}:${c.port}`;
      const cooldown = this._dialCooldown.get(key);
      if (cooldown && cooldown > Date.now()) continue;
      if (this._dialing && this._dialing.has(key)) continue;
      this._dialing = this._dialing || new Set();
      this._dialing.add(key);
      this.connect(c, { source: c.source }).finally(() => this._dialing.delete(key));
    }
  }

  _heartbeat() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      this._send(s, 'PING', { nonce: randomHex(8), t: now });
      if (now - s.lastPong > 3 * 60000) this._closeSession(s, 'ping_timeout');
    }
    this.book.save();
  }

  // ----------------------------------------------------------------- sync
  requestSync(session) {
    if (!session || !session.authenticated || this.chain.readOnly) return false;
    if (session.syncInFlight) return false;
    session.syncInFlight = true;
    return this._send(session, 'GET_HEADERS', {
      locator: this.chain.locator(),
      limit: this.config.sync.headersPerBatch,
    });
  }

  maybeSync() {
    if (!this.isRunning || this.chain.readOnly) return;
    const peers = [...this.sessions.values()].filter((s) => s.authenticated);
    if (peers.length === 0) return;
    const best = peers
      .filter((s) => Number(s.announcedHeight) > this.chain.height || this.chain.height === 0)
      .sort((a, b) => (b.announcedHeight || 0) - (a.announcedHeight || 0))[0] || peers[0];
    this.sync.lastAt = new Date().toISOString();
    this.requestSync(best);
  }

  _onGetHeaders(session, env) {
    const p = env.payload || {};
    const headers = this.chain.headersAfter(p.locator, Math.min(500, Number(p.limit) || 200));
    this._send(session, 'HEADERS', {
      headers,
      height: this.chain.height,
      tipHash: this.chain.tip ? this.chain.tip.hash : null,
      chainwork: this.chain.work.toString(),
      genesisHash: this.chain.genesisHash,
    });
  }

  _onHeaders(session, env) {
    session.syncInFlight = false;
    const p = env.payload || {};
    if (p.genesisHash && p.genesisHash !== this.chain.genesisHash) {
      return this._violation(session, 'genesis_mismatch', 50);
    }
    this.emit('headers.message', { nodeId: session.nodeId, payload: p });
    if (!Array.isArray(p.headers)) return this._violation(session, 'headers_not_array', 25);
    if (p.headers.length > 500) return this._violation(session, 'headers_batch_too_large', 25);
    if (p.headers.length === 0) {
      // ответ «у меня нет продолжения»: это не ошибка (locator уже на tip)
      this.sync.completedAt = new Date().toISOString();
      this.emit('sync.ready', { height: this.chain.height, tipHash: this.chain.tip ? this.chain.tip.hash : null });
      return;
    }
    const res = this.chain.addHeaders(p.headers);
    if (!res.ok) {
      if (res.reason === 'not_heavier') {
        const known = this.chain.headerAt(res.forkHeight);
        this.emit('fork.detected', {
          height: res.forkHeight,
          hashes: [known ? known.hash : null, p.tipHash].filter(Boolean),
          nodeId: session.nodeId,
        });
        return;
      }
      this.sync.lastError = res.reason;
      return this._violation(session, `headers:${res.reason}`, 30);
    }
    if (res.reorg) {
      this.emit('sync.progress', { nodeId: session.nodeId, reorg: true, height: this.chain.height });
    }
    if (res.added > 0) {
      this.sync.headersAdded += res.added;
      this.sync.lastError = null;
      session.announcedHeight = Math.max(Number(session.announcedHeight) || 0, this.chain.height);
      this._log(`[node] +${res.added} заголовков от ${session.nodeId.slice(0, 12)}, высота ${this.chain.height}`);
      this.emit('sync.progress', { nodeId: session.nodeId, added: res.added, height: this.chain.height });
      this.broadcastAnnouncement();
      if (this.config.sync.fetchBodies) this._requestBodies(session);
    }
    if (p.headers.length >= Math.min(500, this.config.sync.headersPerBatch) && res.added > 0) {
      // хвост не последний — продолжаем с новым locator
      if (!session._syncRounds || session._syncRounds < MAX_SYNC_ROUNDS) {
        session._syncRounds = (session._syncRounds || 0) + 1;
        setTimeout(() => this.requestSync(session), 10).unref?.();
      }
    } else {
      session._syncRounds = 0;
      this.sync.completedAt = new Date().toISOString();
      this.emit('sync.ready', { height: this.chain.height, tipHash: this.chain.tip ? this.chain.tip.hash : null });
    }
  }

  _requestBodies(session) {
    if (session.bodyInFlight) return;
    const missing = this.chain.missingBodies(0, this.config.sync.blocksPerBatch);
    if (missing.length === 0) return;
    const sent = this._send(session, 'GET_BLOCKS', { from: missing[0], limit: this.config.sync.blocksPerBatch });
    if (sent) session.bodyInFlight = true;
  }

  _onGetBlocks(session, env) {
    const p = env.payload || {};
    const from = Math.max(0, Number(p.from) || 0);
    const limit = Math.min(200, Number(p.limit) || 50);
    const blocks = this.chain.blocksFrom(from, limit);
    this._send(session, 'BLOCKS', { blocks, from, total: this.chain.height });
  }

  _onBlocks(session, env) {
    session.bodyInFlight = false;
    const p = env.payload || {};
    if (!Array.isArray(p.blocks)) return this._violation(session, 'blocks_not_array', 25);
    const res = this.chain.addBlocks(p.blocks.slice(0, 200));
    if (!res.ok) {
      this.sync.lastError = res.reason;
      return this._violation(session, `block:${res.reason}`, 50);
    }
    const added = res.added || 0;
    this.sync.bodiesAdded += added;
    if (added > 0) this.emit('sync.progress', { nodeId: session.nodeId, bodies: added, height: this.chain.height });
    const more = this.chain.missingBodies(0, 1);
    if (more.length) this._requestBodies(session);
    else this.emit('sync.ready', { height: this.chain.height, bodies: this.chain.bodies.size });
  }

  _onTx(session, env) {
    const tx = env.payload && env.payload.tx;
    if (!tx || typeof tx !== 'object' || typeof tx.txid !== 'string') {
      return this._violation(session, 'bad_tx', 10);
    }
    if (this.mempool.has(tx.txid)) return;
    this.mempool.set(tx.txid, { tx, at: Date.now(), from: session.nodeId });
    this.counters.txs++;
    const gossip = signEnvelope(this.identity, 'TX', { tx });
    for (const s of this.sessions.values()) {
      if (s.nodeId !== session.nodeId) this._sendRaw(s, gossip);
    }
    this.emit('tx', { txid: tx.txid, from: session.nodeId });
  }

  async submitTx(tx) {
    if (!tx || typeof tx.txid !== 'string') return { ok: false, reason: 'bad_tx' };
    this.mempool.set(tx.txid, { tx, at: Date.now(), from: this.id });
    const env = signEnvelope(this.identity, 'TX', { tx });
    let sent = 0;
    for (const s of this.sessions.values()) if (this._sendRaw(s, env)) sent++;
    return { ok: true, peers: sent, txid: tx.txid };
  }

  // ------------------------------------------------------------------ API
  snapshot({ includePrivate = false } = {}) {
    const peers = [...this.sessions.values()];
    const inbound = peers.filter((s) => s.direction === 'inbound');
    const out = {
      nodeId: this.id,
      version: this.version,
      protocol: PROTOCOL_VERSION,
      networkId: this.networkId,
      state: this.state,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      chain: this.chain.snapshot(),
      peers: {
        total: new Set(peers.map((s) => s.nodeId)).size,
        sessions: peers.length,
        inbound: inbound.length,
        outbound: peers.length - inbound.length,
        known: this.book.addresses.size,
        banned: this.book.snapshot().banned,
      },
      inboundVerified: inbound.length,
      inboundPeers: inbound.length,
      outboundPeers: peers.length - inbound.length,
      // true только если NAT/проброс/IPv6 действительно дают внешнюю достижимость.
      publicReachable: [NAT_STATUS.PUBLIC, NAT_STATUS.PORT_FORWARDED, NAT_STATUS.IPV6_PUBLIC]
        .includes(this.nat.status),
      listen: {
        host: this.config.listen.host,
        port: this.listenPort,
        endpoints: this.listenEndpoints,
      },
      nat: {
        status: this.nat.status,
        method: this.nat.method,
        mapped: Boolean(this.nat.mapped),
        cgnat: Boolean(this.nat.cgnat),
        ipv6: Boolean(this.nat.ipv6),
        externalIp: includePrivate ? this.nat.externalIp : undefined,
        checkedAt: this.nat.checkedAt,
      },
      sync: {
        lastAt: this.sync.lastAt,
        completedAt: this.sync.completedAt,
        lastError: this.sync.lastError,
        headersAdded: this.sync.headersAdded,
        bodiesAdded: this.sync.bodiesAdded,
      },
      announcements: this.announcements.size,
      counters: this.counters,
      listenPort: this.listenPort,
      apiPort: this.apiPort,
      guard: this.guard ? { pid: this.guard.pid, startedAt: this.guard.record.startedAt } : null,
      discovery: this.discovery.report(),
    };
    if (includePrivate) {
      out.sessions = peers.map((s) => ({
        ...this._sessionInfo(s),
        remoteAddress: s.stream.remoteAddress,
        bytesIn: s.stream.bytesIn,
        bytesOut: s.stream.bytesOut,
        violations: s.violations,
      }));
      out.knownPeers = this.book.known({ limit: 50, includeBanned: true });
    }
    return out;
  }

  publicAnnouncement() {
    const env = this.announcement();
    const { pubkey, ...rest } = env.payload;
    return { ...rest, nodeId: env.nodeId, announcement: env };
  }

  async _onApi(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const json = (code, obj) => {
      const body = JSON.stringify(obj, null, 2);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': 'http://127.0.0.1',
      });
      res.end(body);
    };
    const readBody = async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 256 * 1024) throw new Error('body_too_large');
        chunks.push(chunk);
      }
      if (chunks.length === 0) return {};
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    try {
      if (p === '/info') return json(200, this.snapshot());
      if (p === '/status') return json(200, this.snapshot({ includePrivate: true }));
      if (p === '/announce') {
        if (req.method === 'GET') return json(200, this.publicAnnouncement());
        if (req.method === 'POST') {
          const sent = this.broadcastAnnouncement();
          return json(200, { ok: true, peers: sent });
        }
      }
      if (p === '/peers' && req.method === 'GET') {
        return json(200, {
          sessions: [...this.sessions.values()].map((s) => this._sessionInfo(s)),
          known: this.book.known({ limit: 50 }),
        });
      }
      if (p === '/sync' && req.method === 'POST') {
        this.maybeSync();
        return json(200, { ok: true, peers: this.authenticatedCount() });
      }
      if (p === '/tx' && req.method === 'POST') {
        return json(200, await this.submitTx((await readBody()).tx));
      }
      if (p === '/nat' && req.method === 'POST') {
        const nat = await this._refreshNat();
        return json(200, { ok: true, nat });
      }
      if (p === '/updates' && req.method === 'GET') return json(200, this.updater.snapshot());
      if (p === '/updates/check' && req.method === 'POST') {
        return json(200, this.updater.check((await readBody()).manifest, { nodeId: this.id }));
      }
      if (p === '/updates/apply' && req.method === 'POST') {
        const r = await this.updater.apply((await readBody()).manifest, { nodeId: this.id });
        if (r.ok) { this.broadcastAnnouncement(); this.emit('update.applied', r); }
        return json(r.ok ? 200 : 409, r);
      }
      if (p === '/updates/rollback' && req.method === 'POST') {
        const r = await this.updater.rollback();
        if (r.ok) { this.broadcastAnnouncement(); this.emit('update.rolled_back', r); }
        return json(r.ok ? 200 : 409, r);
      }
      if (p === '/connect' && req.method === 'POST') {
        const b = await readBody();
        const r = await this.connect({ host: b.host, port: b.port });
        return json(r.ok ? 200 : 400, r);
      }
      if (p === '/shutdown' && req.method === 'POST') {
        json(200, { ok: true });
        setTimeout(() => this.stop('api_shutdown'), 50);
        return;
      }
      if (p === '/gui' || p === '/') {
        const html = fs.readFileSync(path.join(__dirname, 'site', 'node-gui.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      return json(404, { error: 'not_found' });
    } catch (e) {
      return json(500, { error: 'internal', message: e.message });
    }
  }
}

export async function startNode(opts) {
  const node = new AgentcoinNode(opts);
  await node.start();
  return node;
}

export async function waitForPeers(node, count, timeoutMs = 5000) {
  return waitFor(() => node.authenticatedCount() >= count, { timeoutMs, label: `peers>=${count}` });
}

export { GuardError, parseSeed, sleep };
