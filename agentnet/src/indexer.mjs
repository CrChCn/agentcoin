/* agentnet/indexer.mjs — независимый наблюдатель.
   Свой ed25519-ключ, свой nodeId, собственные P2P-подключения и история.
   Не проксирует ответы нод: публикует только то, что проверил сам. */
'use strict';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeConfig } from './config.mjs';
import { AgentcoinNode } from './node.mjs';
import { HistoryStore } from './history.mjs';
import { OperatorRegistry } from './operator.mjs';
import { EventHub } from './events.mjs';
import { NetworkApi } from './api.mjs';
import { classifyHeads, computeLevel, detectForks } from './truth.mjs';
import { publicEndpoint, publicNode } from './privacy.mjs';
import { ensureDir } from './util.mjs';

export class Indexer {
  constructor({ dataDir, config = {}, log = null, seeds = null } = {}) {
    this.dataDir = dataDir;
    ensureDir(dataDir, 0o700);
    this.config = mergeConfig(DEFAULT_CONFIG, config);
    const nodeConfig = {
      ...this.config,
      version: this.config.version,
      listen: { host: '127.0.0.1', port: 0 },
      api: { host: '127.0.0.1', port: 0 },
      nat: { enabled: false },
      privacy: { publishEndpoint: false, region: null },
      sync: { ...this.config.sync, fetchBodies: false, intervalMs: 3000 },
      discovery: {
        ...this.config.discovery,
        staticSeeds: seeds || this.config.discovery.staticSeeds || [],
        minPeers: 1,
        intervalMs: 2000,
        maxPeers: 16,
      },
    };
    this.node = new AgentcoinNode({ dataDir: path.join(dataDir, 'node'), config: nodeConfig, log });
    this.identity = this.node.identity;
    this.history = new HistoryStore({ dir: path.join(dataDir, 'history') });
    this.operators = new OperatorRegistry({ file: path.join(dataDir, 'operators.json'), maxNodesPerOperator: 5 });
    this.hub = new EventHub();
    this.api = new NetworkApi({
      identity: this.identity,
      port: this.config.apiPort || 0,
      siteDir: null,
      hub: this.hub,
      log: log || (() => {}),
    });
    this.observations = new Map();
    this.headerProof = new Map();
    this.headerAsked = new Map();
    this.dialBack = new Map();
    this.forks = [];
    this.timers = [];
    this.startedAt = null;
    this._log = log || ((line) => { if (process.env.AGENTNET_LOG !== '0') console.log(line); });
  }

  get id() { return this.node.id; }
  get url() { return this.api.url; }

  async start() {
    await this.node.start();
    this._registerRoutes();
    await this.api.start();
    this.startedAt = Date.now();

    this.node.on('peer.connected', (info) => {
      const obs = this.observations.get(info.nodeId);
      if (info.direction === 'outbound' && obs && obs.endpoint) {
        this.dialBack.set(info.nodeId, { ok: true, at: Date.now() });
      }
      this.hub.publish('node.handshake', { nodeId: info.nodeId, direction: info.direction, version: info.version, by: this.id });
    });
    this.node.on('node.discovered', (info) => {
      this.hub.publish('node.discovered', { ...info, by: this.id });
    });
    this.node.on('node.stale', (info) => {
      this.hub.publish('node.stale', { ...info, by: this.id });
    });
    this.node.on('fork.detected', (info) => {
      const entry = { ...info, at: new Date().toISOString(), by: this.id };
      this.forks.push(entry);
      this.history.incident({ type: 'fork_detected', detail: info });
      this.hub.publish('fork.detected', entry);
    });
    this.node.on('fork.resolved', (info) => {
      this.history.incident({ type: 'fork_resolved', detail: info });
      this.hub.publish('fork.resolved', { ...info, by: this.id });
    });
    this.node.on('headers.message', ({ nodeId, payload }) => this._onHeaderProof(nodeId, payload));
    this.node.on('diskfull', () => this.hub.publish('incident', { type: 'disk_full', by: this.id }));

    this._every(1000, () => this._observe());
    this._every(2000, () => this._askHeaderProofs());
    this._every(4000, () => this._tryDialBack().catch(() => {}));
    this._log(`[indexer] ${this.id} слушает ${this.url}, пиры: ${this.node.config.discovery.staticSeeds.join(',') || '—'}`);
    return this;
  }

  _every(ms, fn) {
    const t = setInterval(() => { try { fn(); } catch (e) { this._log(`[indexer] timer: ${e.message}`); } }, ms);
    if (t.unref) t.unref();
    this.timers.push(t);
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.api.stop();
    await this.node.stop('indexer_stop');
  }

  _registerRoutes() {
    this.api
      .route('summary', () => this.summary())
      .route('observations', () => ({
        indexerId: this.id,
        networkId: this.node.networkId,
        observations: [...this.observations.values()].map((o) => ({ ...o, endpoint: publicEndpoint(o.endpoint) })),
        forks: this.forks.slice(-20),
      }))
      .route('edges', () => ({ edges: this.edges() }))
      .route('eventlog', () => ({ hub: this.hub.snapshot(), events: this.hub.since(0).slice(-200) }))
      .route('history', ({ query }) => {
        const nodeId = query.get('nodeId');
        const limit = Math.min(Number(query.get('limit')) || 200, 1000);
        return {
          nodeId,
          timeline: this.history.timeline(nodeId, { limit }),
          uptime: nodeId ? this.history.uptime(nodeId) : null,
          incidents: this.history.incidents({ limit: 50 }),
          forks: this.history.forks(),
        };
      })
      .route('consensus', () => this.consensus())
      .route('operators', () => ({ operators: this.operators.list(), summary: this.operators.snapshot() }))
      .route('identity', () => ({ nodeId: this.id, pubkey: this.identity.publicKeyPem, role: 'indexer' }));
    // /nodes/:id
    this.api.route('nodes', ({ params }) => {
      if (params && params.length > 0) {
        const node = this.publicNodes().find((n) => n.nodeId === params[0]);
        if (!node) return { node: null };
        return { node };
      }
      return { nodes: this.publicNodes() };
    });
  }

  _onHeaderProof(nodeId, payload) {
    const ann = this.node.announcements.get(nodeId);
    if (!ann) return;
    const ok = payload.genesisHash === ann.payload.genesisHash
      && payload.height === ann.payload.height
      && payload.tipHash === ann.payload.tipHash;
    this.headerProof.set(nodeId, {
      ok,
      at: Date.now(),
      height: payload.height,
      tipHash: payload.tipHash,
      headers: Array.isArray(payload.headers) ? payload.headers.length : 0,
    });
  }

  _askHeaderProofs() {
    const now = Date.now();
    for (const nodeId of this.node.announcements.keys()) {
      if (nodeId === this.id) continue;
      if (now - (this.headerAsked.get(nodeId) || 0) < 5000) continue;
      const session = this.node.sessions.get(`${nodeId}:inbound`) || this.node.sessions.get(`${nodeId}:outbound`);
      if (!session || !session.authenticated) continue;
      const ann = this.node.announcements.get(nodeId);
      this.headerAsked.set(nodeId, now);
      this.node._send(session, 'GET_HEADERS', { locator: [ann.payload.tipHash], limit: 1, probe: true });
    }
  }

  async _tryDialBack() {
    for (const [nodeId, obs] of this.observations) {
      if (this.dialBack.get(nodeId)?.ok) continue;
      if (!obs.endpoint) continue;
      if (this.node.sessions.has(`${nodeId}:outbound`)) {
        this.dialBack.set(nodeId, { ok: true, at: Date.now() });
        continue;
      }
      if (this.node.sessions.has(`${nodeId}:inbound`)) continue;
      const res = await this.node.connect(obs.endpoint, { source: 'indexer_dialback' });
      if (!res.ok) continue;
      await new Promise((r) => setTimeout(r, 250));
      if (this.node.sessions.has(`${nodeId}:outbound`) || this.node.sessions.has(`${nodeId}:inbound`)) {
        this.dialBack.set(nodeId, { ok: true, at: Date.now() });
      }
    }
  }

  _observe() {
    const now = Date.now();
    for (const [nodeId, rec] of this.node.announcements) {
      if (nodeId === this.id) continue;
      const p = rec.payload;
      const prev = this.observations.get(nodeId) || { nodeId, firstSeen: new Date(rec.receivedAt).toISOString() };
      const session = this.node.sessions.get(`${nodeId}:inbound`) || this.node.sessions.get(`${nodeId}:outbound`);
      const proof = this.headerProof.get(nodeId);
      const obs = {
        nodeId,
        indexerId: this.id,
        networkId: this.node.networkId,
        observedAt: new Date(now).toISOString(),
        firstSeen: prev.firstSeen,
        version: p.version || null,
        protocol: p.protocol || null,
        height: Number.isFinite(p.height) ? p.height : null,
        tipHash: p.tipHash || null,
        chainwork: p.chainwork || null,
        genesisHash: p.genesisHash || null,
        peers: Number.isFinite(p.peers) ? p.peers : null,
        uptimeSec: Number.isFinite(p.uptimeSec) ? p.uptimeSec : null,
        natStatus: p.nat?.status || null,
        endpoint: p.endpoint || null,
        region: p.consent?.region ? (p.region || null) : null,
        operatorId: p.operatorId || null,
        challenge: Boolean(session && session.authenticated),
        headers: Boolean(proof && proof.ok && now - proof.at < 30000),
        dialBack: Boolean(this.dialBack.get(nodeId)?.ok),
        latencyMs: session ? session.rtt : null,
        status: now - rec.receivedAt > 60000 ? 'stale' : 'online',
        signatureValid: true,
      };
      obs.level = computeLevel(obs);
      obs.ready = obs.status === 'online' && obs.challenge && obs.headers;
      this.observations.set(nodeId, obs);
      const last = this.history.lastOf(nodeId);
      const changed = !last || last.height !== obs.height || last.version !== obs.version
        || last.status !== obs.status || last.level !== obs.level || last.peers !== obs.peers;
      this.history.record(nodeId, {
        at: obs.observedAt,
        height: obs.height,
        tipHash: obs.tipHash,
        version: obs.version,
        peers: obs.peers,
        status: obs.status,
        level: obs.level,
        operatorId: obs.operatorId,
      }, { minIntervalMs: changed ? 0 : 10000 });
      if (last && last.status !== obs.status) {
        this.hub.publish(obs.status === 'online' ? 'node.ready' : obs.status === 'stale' ? 'node.stale' : 'node.offline', { nodeId, status: obs.status, by: this.id });
      }
    }
    for (const obs of this.observations.values()) {
      if (now - Date.parse(obs.observedAt) > 180000 && obs.status !== 'offline') {
        obs.status = 'offline';
        obs.ready = false;
        this.hub.publish('node.offline', { nodeId: obs.nodeId, by: this.id });
      }
    }
  }

  publicNodes() {
    const now = Date.now();
    return [...this.observations.values()]
      .map((obs) => {
        const operator = this.operators.verifyNode(obs.nodeId);
        const base = publicNode({ ...obs, operator }, { now });
        base.ready = Boolean(obs.ready);
        base.reasons = base.ready ? [] : [
          ...(obs.status !== 'online' ? ['stale'] : []),
          ...(!obs.challenge ? ['challenge_missing'] : []),
          ...(!obs.headers ? ['head_not_verified'] : []),
        ];
        base.observedBy = [this.id];
        return base;
      })
      .sort((a, b) => (a.nodeId > b.nodeId ? 1 : -1));
  }

  edges() {
    const out = [];
    for (const nodeId of this.observations.keys()) out.push([this.id, nodeId]);
    return out;
  }

  summary() {
    const nodes = this.publicNodes();
    const live = nodes.filter((n) => n.status === 'online');
    const heights = live.map((n) => n.height).filter(Number.isFinite);
    return {
      indexerId: this.id,
      networkId: this.node.networkId,
      nodes: nodes.length,
      online: live.length,
      publicReachable: live.filter((n) => n.level === 'PUBLIC_REACHABLE' || n.level === 'INDEPENDENT_OPERATOR').length,
      behindNat: live.filter((n) => n.natStatus && !['PUBLIC', 'PORT_FORWARDED', 'IPV6_PUBLIC'].includes(n.natStatus)).length,
      operators: new Set(live.map((n) => n.operatorId).filter(Boolean)).size,
      regions: new Set(live.map((n) => n.region).filter(Boolean)).size,
      height: heights.length ? Math.max(...heights) : null,
      forks: this.forks.length,
      peers: this.node.authenticatedCount(),
      chainHeight: this.node.chain.height,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
    };
  }

  consensus() {
    const nodes = [...this.observations.values()];
    const forks = detectForks(nodes);
    const comparisons = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const c = classifyHeads(nodes[i], nodes[j]);
        if (c === 'DIVERGENT') comparisons.push({ a: nodes[i].nodeId, b: nodes[j].nodeId, result: c, height: nodes[i].height });
      }
    }
    return {
      indexerId: this.id,
      genesisHash: this.node.chain.genesisHash,
      height: this.node.chain.height,
      forks,
      comparisons,
      note: 'один наблюдатель: MULTI_OBSERVED и PUBLIC_REACHABLE подтверждает агрегатор трёх indexer-ов',
    };
  }
}

export async function startIndexer(opts) {
  const idx = new Indexer(opts);
  await idx.start();
  return idx;
}
