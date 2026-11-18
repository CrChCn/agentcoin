#!/usr/bin/env node
/* Общие хендлеры изолированного стенда: те же пути, что у ноды, плюс
   документированный механизм обнаружения подписи GET /queue/auth-capabilities
   и подписанные POST /queue/signed/{join,claim,done} (verifyActionSig + nonce). */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AgentQueue } from '../../queue.mjs';
import { verifyActionSig } from '../../queue-auth.mjs';
import { validateServiceOffer, validateAssignment, validateArtifact, verifyArtifactHash, hashOf } from './schemas.mjs';
import crypto from 'node:crypto';

const GENESIS = 'stand-genesis-001';
export async function createStand(tmp) {
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const queue = new AgentQueue(dataDir);
  const usedNonce = new Map(); // nonceKey(address|nonce) -> {digest,result}
  const offers = {}; // offerId -> {versions:[offer], }
  const orders = {}; // assignmentId -> {assignment, artifacts:[], state}
  const idemOrder = new Map(); // customer|offerId|idemKey -> assignmentId (защита от повторного принятия)
  // ---- Этап C: события с курсором + api-monitor (файловая персистентность для рестарта) ----
  const persistFile = (n) => path.join(dataDir, n);
  const loadJson = (n, fb) => { try { return JSON.parse(fs.readFileSync(persistFile(n), 'utf8')); } catch { return fb; } };
  const saveJson = (n, v) => { try { fs.writeFileSync(persistFile(n), JSON.stringify(v)); } catch {} };
  let events = loadJson('events.json', []);
  const monitors = Object.assign({}, loadJson('monitors.json', {}));
  let runs = loadJson('runs.json', []);
  // восстановление orders/offers тоже переживает рестарт стенда в том же tmp
  Object.assign(offers, loadJson('offers.json', {}));
  Object.assign(orders, loadJson('orders.json', {}));
  for (const [k, v] of Object.entries(loadJson('idem.json', {}))) idemOrder.set(k, v);
  const settlements = Object.assign({}, loadJson('settlements.json', {}));
  const testBalances = Object.assign({}, loadJson('test-balances.json', {})); // тестовая книга TEST-AGT, не mainnet
  const persistMarket = () => {
    saveJson('events.json', events.slice(-500)); saveJson('monitors.json', monitors);
    saveJson('runs.json', runs.slice(-500)); saveJson('offers.json', offers);
    saveJson('orders.json', orders); saveJson('idem.json', Object.fromEntries(idemOrder));
    saveJson('settlements.json', settlements); saveJson('test-balances.json', testBalances);
  };
  const emit = (eventType, entityId, entityVersion, visibility, payload, parties) => {
    const seq = events.length;
    const occurredAt = Date.now();
    const ev = {
      eventId: crypto.createHash('sha256').update([seq, eventType, entityId].join('|')).digest('hex').slice(0, 16),
      seq, eventType, entityId, entityVersion: String(entityVersion || '1'),
      occurredAt, observedAt: Date.now(), source: 'stand', network: 'AGENTCOIN-stand',
      genesis: GENESIS, visibility, parties: parties || [], payload: payload || {},
    };
    events.push(ev); persistMarket(); return ev;
  };
  const isPrivateTarget = (raw) => {
    let u2; try { u2 = new URL(String(raw)); } catch { return 'bad_url'; }
    if (!['http:', 'https:'].includes(u2.protocol)) return 'protocol_denied';
    if (String(raw).length > 2048) return 'url_too_long';
    const h = u2.hostname.toLowerCase();
    if (['localhost', '::1'].includes(h) || h.endsWith('.local') || h.endsWith('.internal')) return 'ssrf_denied';
    if (/^(127\.|0\.0\.0\.0|169\.254\.|10\.|192\.168\.)/.test(h)) return 'ssrf_denied';
    const m172 = h.match(/^172\.(\d+)\./); if (m172 && +m172[1] >= 16 && +m172[1] <= 31) return 'ssrf_denied';
    if (/^[a-z0-9-]+$/.test(h) && !h.includes('.') && h !== 'example') return 'ssrf_denied'; // однословные хосты, кроме стендового example
    return null;
  };
  const monitorDue = (mon, nowMs) => {
    const start = mon.createdAt; const per = mon.periodMs;
    if (nowMs >= mon.expiresAt || mon.canceled) return [];
    if (mon.paused) return [];
    const idx = Math.floor((nowMs - start) / per);
    return idx >= 0 ? [idx] : [];
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {}; try { b = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'bad_json' }); }
      if (u.pathname === '/info') return send(200, { chain: 'AGENTCOIN-stand', blocks: 1, genesisHash: GENESIS });
      if (u.pathname === '/queue/auth-capabilities') return send(200, { signed: true, chain: 'AGENTCOIN', genesis: GENESIS, actions: ['join', 'claim', 'done', 'publish', 'order', 'artifact', 'accept', 'monitor', 'mtick', 'mpause', 'mcancel', 'settle', 'ssend', 'sconfirm', 'sdispute', 'scancel'] });
      if (u.pathname === '/queue/status') return send(200, queue.status());
      if (u.pathname === '/queue/assignments') return send(200, { onDuty: queue.state.onDuty }); // стенд-only: prod этого не отдаёт, там — ownership_unknown без журнала/истории
      if (u.pathname === '/queue/history') return send(200, { history: queue.state.history || [] });
      if (u.pathname === '/balances') return send(200, { balances: [{ address: u.searchParams.get('addresses'), balance: 0 }] });
      if (u.pathname === '/jobs/state') return send(200, { stats: { total: 0, open: 0 }, fees: [], open: [], history: [] });
      if (u.pathname === '/queue/join' && req.method === 'POST') { const r = queue.join(String(b.address || ''), String(b.handle || '')); return send(r.ok ? 200 : 409, r); }
      if (u.pathname === '/queue/claim' && req.method === 'POST') {
        const r = queue.claim(String(b.taker || ''));
        if (!r.ok) return send(409, r);
        return send(200, { ...r, task: r.repeat ? null : 'стенд-задача', bountyAGT: 2 });
      }
      if (u.pathname === '/queue/done' && req.method === 'POST') {
        if (!queue.state.onDuty[String(b.jobId)]) return send(404, { error: 'job_not_found' });
        const agent = queue.state.onDuty[String(b.jobId)];
        const r = queue.done(String(b.jobId), String(b.summary || ''), agent);
        queue.requeue(agent);
        return send(200, { ...r, agent, bounty: { skipped: true, reason: 'stand-no-fund' } });
      }
      const m = u.pathname.match(/^\/queue\/signed\/(join|claim|done)$/);
      if (m && req.method === 'POST') {
        const action = m[1] === 'join' ? 'join' : m[1];
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action, body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        const { actionDigest } = { actionDigest: v.digest };
        if (prev) {
          if (prev.digest !== actionDigest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' });
          return send(200, { ...prev.result, replay: true });
        }
        let result;
        if (action === 'join') result = queue.join(String(b.body.address || b.address), String(b.body.handle || ''));
        else if (action === 'claim') {
          const r = queue.claim(String(b.body.taker || b.address));
          if (!r.ok) return send(409, r);
          result = { ...r, task: r.repeat ? null : 'стенд-задача-подпись', bountyAGT: 2 };
        } else {
          const { jobId, summary } = b.body || {};
          const agent = queue.state.onDuty[String(jobId)];
          if (!agent) return send(404, { error: 'job_not_found' });
          if (agent !== b.address) return send(403, { error: 'foreign_task' });
          const r = queue.done(String(jobId), String(summary || ''), agent);
          queue.requeue(agent);
          result = { ...r, agent };
        }
        usedNonce.set(key, { digest: actionDigest, result });
        return send(200, result);
      }
      // ---- Stage B: каталог услуг и заказы (подписанные мутации, чтение публичное) ----
      if (u.pathname === '/catalog/offers' && req.method === 'GET') {
        const skill = u.searchParams.get('skill') || '', maxP = u.searchParams.get('maxPriceAtomic'), fmt = u.searchParams.get('format') || '';
        const out = [];
        for (const [id, e] of Object.entries(offers)) for (const o of e.versions) {
          if (skill && !(o.skills || []).some(s => String(s).includes(skill)) && !String(o.title).includes(skill)) continue;
          if (maxP !== null && maxP !== '' && Number(o.priceAtomic) > Number(maxP)) continue;
          if (fmt && !(o.acceptedInputFormats || []).includes(fmt) && !(o.producedOutputFormats || []).includes(fmt)) continue;
          out.push({ ...o, expired: Number(o.expiresAt) <= Date.now() });
        }
        return send(200, { offers: out });
      }
      const mo = u.pathname.match(/^\/catalog\/offers\/([A-Za-z0-9_-]+)$/);
      if (mo && req.method === 'GET') {
        const e = offers[mo[1]];
        if (!e) return send(404, { error: 'offer_not_found' });
        return send(200, { offerId: mo[1], versions: e.versions });
      }
      if (u.pathname === '/catalog/publish' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'publish', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const o = b.body?.offer;
        const err = validateServiceOffer(o);
        if (err) return send(400, { error: err });
        if (o.provider !== b.address) return send(403, { error: 'provider_mismatch' });
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        offers[o.offerId] ||= { versions: [] };
        if (offers[o.offerId].versions.some(x => x.version === o.version)) {
          const res = { ok: true, offerId: o.offerId, version: o.version, note: 'версия уже была — повтор без изменений' };
          usedNonce.set(key, { digest: v.digest, result: res });
          return send(200, res);
        }
        offers[o.offerId].versions.push(o);
        const res = { ok: true, offerId: o.offerId, version: o.version, snapshotHash: hashOf(o) };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      if (u.pathname === '/orders/create' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'order', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { offerId, offerVersion, input, idempotencyKey } = b.body || {};
        const e = offers[offerId];
        if (!e) return send(404, { error: 'offer_not_found' });
        const snap = offerVersion ? e.versions.find(x => x.version === offerVersion) : e.versions[e.versions.length - 1];
        if (!snap) return send(404, { error: 'offer_version_not_found' });
        if (Number(snap.expiresAt) <= Date.now()) return send(409, { error: 'offer_expired' });
        const idem = String(idempotencyKey || '');
        const idemKey = b.address + '|' + offerId + '|' + idem;
        if (idem && idemOrder.has(idemKey)) {
          const res = { ok: true, assignment: orders[idemOrder.get(idemKey)].assignment, replay: true };
          usedNonce.set(key, { digest: v.digest, result: res });
          return send(200, res);
        }
        const assignmentId = crypto.createHash('sha256').update([b.address, offerId, snap.version, idem || String(b.nonce)].join('|')).digest('hex').slice(0, 16);
        const assignment = { assignmentId, offerId, offerVersion: snap.version, offerSnapshotHash: hashOf(snap), priceAtomic: snap.priceAtomic, customer: b.address, provider: snap.provider, input: input || {}, acceptanceMethod: snap.acceptance.method, state: 'open', createdAt: Date.now() };
        const verr = validateAssignment(assignment);
        if (verr) return send(400, { error: verr });
        orders[assignmentId] = { assignment, artifacts: [], acceptance: null };
        if (idem) idemOrder.set(idemKey, assignmentId);
        persistMarket();
        emit('order.created', assignmentId, snap.version, 'parties', { offerId }, [b.address, snap.provider]);
        const res = { ok: true, assignment };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      const mg = u.pathname.match(/^\/orders\/([a-f0-9]{16})$/);
      if (mg && req.method === 'GET') {
        const o = orders[mg[1]];
        if (!o) return send(404, { error: 'order_not_found' });
        const req2 = u.searchParams.get('requester') || '';
        const pub = o.artifacts.map(a => ({ ...a.meta, content: a.meta.accessPolicy === 'public' || req2 === o.assignment.customer || req2 === o.assignment.provider ? a.content : undefined }));
        return send(200, { assignment: o.assignment, artifacts: pub, acceptance: o.acceptance });
      }
      if (u.pathname === '/orders/submit-artifact' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'artifact', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { assignmentId, artifact, content } = b.body || {};
        const o = orders[assignmentId];
        if (!o) return send(404, { error: 'order_not_found' });
        if (b.address !== o.assignment.provider) return send(403, { error: 'foreign_artifact', hint: 'артефакт сдаёт только provider заказа' });
        const err = validateArtifact({ ...artifact, assignmentId });
        if (err) return send(400, { error: err });
        const bytes = Buffer.from(String(content || ''), 'base64');
        const herr = verifyArtifactHash(bytes, artifact);
        if (herr) return send(400, { error: herr });
        if (o.artifacts.some(a => a.meta.artifactId === artifact.artifactId)) return send(409, { error: 'artifact_version_exists', hint: 'изменение артефакта — новый artifactId' });
        o.artifacts.push({ meta: { ...artifact, assignmentId }, content: artifact.accessPolicy === 'public' ? String(content) : '[private]' });
        persistMarket();
        emit('order.artifact', assignmentId, artifact.artifactId, artifact.accessPolicy === 'public' ? 'public' : 'parties', artifact.accessPolicy === 'public' ? { artifactId: artifact.artifactId } : { artifactId: artifact.artifactId, private: true }, [o.assignment.customer, o.assignment.provider]);
        const res = { ok: true, artifactId: artifact.artifactId };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      if (u.pathname === '/orders/accept' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'accept', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { assignmentId, verdict } = b.body || {};
        const o = orders[assignmentId];
        if (!o) return send(404, { error: 'order_not_found' });
        if (b.address !== o.assignment.customer) return send(403, { error: 'foreign_accept', hint: 'принимает только customer' });
        if (o.assignment.state === 'accepted') { const res = { ok: true, replay: true, assignment: o.assignment }; usedNonce.set(key, { digest: v.digest, result: res }); return send(200, res); }
        o.assignment.state = 'accepted';
        o.acceptance = { verdict: verdict || 'accepted', at: Date.now(), method: o.assignment.acceptanceMethod };
        persistMarket();
        emit('order.accepted', assignmentId, '1', 'parties', { verdict: o.acceptance.verdict }, [o.assignment.customer, o.assignment.provider]);
        const res = { ok: true, assignment: o.assignment };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      // ---- Этап C: события с курсором ----
      if (u.pathname === '/events' && req.method === 'GET') {
        const cur = u.searchParams.get('cursor') || '0';
        const lim = Math.min(100, Math.max(1, Number(u.searchParams.get('limit') || 20)));
        const requester = u.searchParams.get('requester') || '';
        const idx = Number(cur);
        if (!Number.isInteger(idx) || idx < 0 || idx > events.length) return send(410, { error: 'cursor_expired', hint: 'курсор истёк — нужен новый снимок с cursor=0' });
        const slice = events.slice(idx, idx + lim);
        const out = slice.filter((e) => e.visibility === 'public' || !requester ? e.visibility === 'public' : (e.parties || []).includes(requester) || e.visibility === 'public').map((e) => {
          if (e.visibility === 'public') return e;
          const mine = requester && (e.parties || []).includes(requester);
          return mine ? e : { ...e, payload: { redacted: true } };
        });
        return send(200, { events: out, nextCursor: String(idx + slice.length), total: events.length });
      }
      // ---- Этап C: api-monitor (повторяющаяся услуга) ----
      if (u.pathname === '/monitors/create' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'monitor', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const mm = b.body?.monitor || {};
        const deny = isPrivateTarget(mm.targetUrl || '');
        if (deny) return send(400, { error: deny, hint: 'SSRF-защита: внутренние и служебные адреса запрещены' });
        if (!Number.isInteger(mm.periodMs) || mm.periodMs < 1000) return send(400, { error: 'bad_period', hint: 'periodMs целое >= 1000' });
        if (!Number.isInteger(mm.priceAtomicPerRun) || mm.priceAtomicPerRun < 0) return send(400, { error: 'bad_price' });
        if (!Number.isInteger(mm.maxCostPerPeriodAtomic) || mm.maxCostPerPeriodAtomic < mm.priceAtomicPerRun) return send(400, { error: 'bad_maxCost', hint: 'лимит периода не покрывает цену одного запуска; это лимит стоимости заказов, не резерв AGT' });
        if (Number(mm.expiresAt) <= Date.now()) return send(400, { error: 'monitor_expired' });
        const monitorId = String(mm.monitorId || crypto.createHash('sha256').update([b.address, mm.targetUrl, String(b.nonce)].join('|')).digest('hex').slice(0, 12));
        if (monitors[monitorId]) { const res = { ok: true, monitor: monitors[monitorId], replay: true }; usedNonce.set(key, { digest: v.digest, result: res }); return send(200, res); }
        monitors[monitorId] = { monitorId, owner: b.address, provider: mm.provider || b.address, targetUrl: mm.targetUrl, periodMs: mm.periodMs, expiresAt: mm.expiresAt, priceAtomicPerRun: mm.priceAtomicPerRun, maxCostPerPeriodAtomic: mm.maxCostPerPeriodAtomic, maxConcurrentRuns: Math.min(4, Math.max(1, mm.maxConcurrentRuns || 1)), paused: false, canceled: false, createdAt: Date.now() };
        persistMarket();
        emit('monitor.created', monitorId, '1', 'parties', { targetUrl: mm.targetUrl }, [b.address]);
        const res = { ok: true, monitor: monitors[monitorId] };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      if (u.pathname === '/monitors/tick' && req.method === 'POST') {
        const nowMs = Number(b.nowMs || Date.now());
        const mon = monitors[b.monitorId];
        if (!mon) return send(404, { error: 'monitor_not_found' });
        if (mon.canceled) return send(409, { error: 'monitor_canceled' });
        if (mon.paused) return send(200, { ok: true, ran: [], note: 'paused — будущие запуски остановлены' });
        const idxs = monitorDue(mon, nowMs);
        const ran = [];
        for (const pi of idxs) {
          const runId = `${mon.monitorId}|${pi}`;
          if (runs.some((r) => r.runId === runId)) { ran.push({ runId, replay: true }); continue; }
          const active = runs.filter((r) => r.monitorId === mon.monitorId && r.state === 'open').length;
          if (active >= mon.maxConcurrentRuns) { ran.push({ runId, skipped: 'max_concurrent' }); continue; }
          const assignmentId = crypto.createHash('sha256').update(['monitor', runId].join('|')).digest('hex').slice(0, 16);
          if (!orders[assignmentId]) orders[assignmentId] = { assignment: { assignmentId, offerId: 'api-monitor-v1', offerVersion: '1', offerSnapshotHash: 'monitor', customer: mon.owner, provider: mon.provider, input: { monitorId: mon.monitorId, periodIndex: pi, targetUrl: mon.targetUrl }, acceptanceMethod: 'human', state: 'open', createdAt: Date.now(), runId }, artifacts: [], acceptance: null };
          runs.push({ runId, monitorId: mon.monitorId, periodIndex: pi, assignmentId, state: 'open', createdAt: Date.now(), costAtomic: mon.priceAtomicPerRun });
          emit('monitor.run', runId, '1', 'parties', { assignmentId }, [mon.owner, mon.provider]);
          ran.push({ runId, assignmentId });
        }
        persistMarket();
        return send(200, { ok: true, ran });
      }
      const mhist = u.pathname.match(/^\/monitors\/([A-Za-z0-9|_-]+)\/history$/);
      if (mhist && req.method === 'GET') {
        const mon = monitors[mhist[1]];
        if (!mon) return send(404, { error: 'monitor_not_found' });
        const requester = u.searchParams.get('requester') || '';
        if (requester && requester !== mon.owner && requester !== mon.provider) return send(403, { error: 'foreign_monitor' });
        return send(200, { monitor: mon, runs: runs.filter((r) => r.monitorId === mon.monitorId) });
      }
      if ((u.pathname === '/monitors/pause' || u.pathname === '/monitors/cancel') && req.method === 'POST') {
        const act = u.pathname.endsWith('pause') ? 'mpause' : 'mcancel';
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: act, body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const mon = monitors[b.body?.monitorId];
        if (!mon) return send(404, { error: 'monitor_not_found' });
        if (b.address !== mon.owner) return send(403, { error: 'foreign_monitor' });
        if (act === 'mpause') mon.paused = !!b.body?.paused;
        else mon.canceled = true;
        persistMarket();
        emit(act === 'mpause' ? 'monitor.paused' : 'monitor.canceled', mon.monitorId, '1', 'parties', { paused: mon.paused }, [mon.owner]);
        return send(200, { ok: true, monitor: mon });
      }
      // ---- Проход 3: тестовый расчёт TEST-AGT (стенд; не эскроу, не mainnet) ----
      if (u.pathname === '/settlements/faucet' && req.method === 'POST') {
        const to = String(b.address || ''); const amt = Number(b.amountAtomic || 0);
        if (!to || !Number.isInteger(amt) || amt <= 0 || amt > 1000000) return send(400, { error: 'bad_faucet' });
        testBalances[to] = (testBalances[to] || 0) + amt;
        persistMarket();
        emit('settlement.funded', to, '1', 'parties', { amountAtomic: amt, test: true }, [to]);
        return send(200, { ok: true, address: to, balanceTestAtomic: testBalances[to], test: true });
      }
      if (u.pathname === '/settlements/balances' && req.method === 'GET') {
        const a = u.searchParams.get('address') || '';
        return send(200, { address: a, balanceTestAtomic: testBalances[a] || 0, test: true, note: 'тестовые единицы стенда, не AGT mainnet' });
      }
      const mset = u.pathname.match(/^\/settlements\/([a-f0-9]{16})$/);
      if (mset && req.method === 'GET') {
        const s = settlements[mset[1]];
        if (!s) return send(404, { error: 'settlement_not_found' });
        const rq = u.searchParams.get('requester') || '';
        if (rq && rq !== s.payer && rq !== s.recipient) return send(403, { error: 'foreign_settlement' });
        return send(200, { settlement: s });
      }
      if (u.pathname === '/settlements/create' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'settle', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { assignmentId } = b.body || {};
        if (settlements[assignmentId]) { const res = { ok: true, settlement: settlements[assignmentId], replay: true }; usedNonce.set(key, { digest: v.digest, result: res }); return send(200, res); }
        const o = orders[assignmentId];
        if (!o) return send(404, { error: 'order_not_found' });
        if (o.assignment.state !== 'accepted') return send(409, { error: 'no_obligation', hint: 'обязательство возникает только после приёмки (accept)' });
        if (b.address !== o.assignment.customer) return send(403, { error: 'foreign_settle' });
        const amount = Number(o.assignment.priceAtomic ?? 0);
        if (!Number.isInteger(amount) || amount < 0) return send(400, { error: 'bad_amount' });
        if ((testBalances[b.address] || 0) < amount) return send(409, { error: 'insufficient_test_funds', hint: 'пополните тестовый баланс через /settlements/faucet' });
        const s = { paymentId: 'pay-' + assignmentId, assignmentId, amountAtomic: amount, payer: o.assignment.customer, recipient: o.assignment.provider, network: 'AGENTCOIN-stand', genesis: GENESIS, purpose: assignmentId, state: 'obligation', txid: null, dispute: null, test: true, createdAt: Date.now() };
        settlements[assignmentId] = s;
        persistMarket();
        emit('settlement.obligation', assignmentId, '1', 'parties', { paymentId: s.paymentId, amountAtomic: amount }, [s.payer, s.recipient]);
        const res = { ok: true, settlement: s };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      if ((u.pathname === '/settlements/send' || u.pathname === '/settlements/confirm' || u.pathname === '/settlements/dispute' || u.pathname === '/settlements/cancel') && req.method === 'POST') {
        const act = u.pathname.endsWith('/send') ? 'ssend' : u.pathname.endsWith('/confirm') ? 'sconfirm' : u.pathname.endsWith('/dispute') ? 'sdispute' : 'scancel';
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: act, body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const { assignmentId, reason } = b.body || {};
        const s = settlements[assignmentId];
        if (!s) return send(404, { error: 'settlement_not_found', hint: 'сначала /settlements/create после приёмки' });
        if (act === 'ssend') {
          if (b.address !== s.payer) return send(403, { error: 'foreign_settle' });
          if (s.state === 'sent' || s.state === 'confirmed') return send(200, { ok: true, settlement: s, replay: true });
          if (s.state !== 'obligation') return send(409, { error: 'bad_state', state: s.state });
          if (s.dispute && !s.dispute.resolved) return send(409, { error: 'disputed', hint: 'спор открыт — отправка заблокирована до разрешения (проход 4)' });
          if ((testBalances[s.payer] || 0) < s.amountAtomic) return send(409, { error: 'insufficient_test_funds' });
          testBalances[s.payer] -= s.amountAtomic;
          s.state = 'sent'; s.txid = 'test-tx-' + crypto.createHash('sha256').update(s.paymentId).digest('hex').slice(0, 16);
          persistMarket();
          emit('settlement.sent', assignmentId, '1', 'parties', { paymentId: s.paymentId, txid: s.txid }, [s.payer, s.recipient]);
          return send(200, { ok: true, settlement: s });
        }
        if (act === 'sconfirm') {
          if (s.state === 'confirmed') return send(200, { ok: true, settlement: s, replay: true });
          if (s.state !== 'sent') return send(409, { error: 'bad_state', hint: 'подтверждается только sent' });
          s.state = 'confirmed'; testBalances[s.recipient] = (testBalances[s.recipient] || 0) + s.amountAtomic;
          persistMarket();
          emit('settlement.confirmed', assignmentId, '1', 'parties', { paymentId: s.paymentId }, [s.payer, s.recipient]);
          return send(200, { ok: true, settlement: s });
        }
        if (act === 'sdispute') {
          if (s.state === 'confirmed') { s.dispute = { by: b.address, reason: String(reason || ''), at: Date.now(), note: 'спор после подтверждения выплату не отменяет (лимит прохода 3)' }; persistMarket(); return send(200, { ok: true, settlement: s, note: s.dispute.note }); }
          if (s.state === 'canceled') return send(409, { error: 'bad_state' });
          s.dispute = { by: b.address, reason: String(reason || ''), at: Date.now(), resolved: false };
          persistMarket();
          emit('settlement.disputed', assignmentId, '1', 'parties', { reason: s.dispute.reason }, [s.payer, s.recipient]);
          return send(200, { ok: true, settlement: s });
        }
        if (b.address !== s.payer) return send(403, { error: 'foreign_settle' });
        if (s.state !== 'obligation') return send(409, { error: 'bad_state', hint: 'отмена только до отправки' });
        s.state = 'canceled';
        persistMarket();
        emit('settlement.canceled', assignmentId, '1', 'parties', { paymentId: s.paymentId }, [s.payer, s.recipient]);
        return send(200, { ok: true, settlement: s });
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, queue, genesis: GENESIS, close: () => server.close() };
}
