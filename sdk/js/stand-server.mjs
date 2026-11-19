#!/usr/bin/env node
/* Общие хендлеры изолированного стенда: те же пути, что у ноды, плюс
   документированный механизм обнаружения подписи GET /queue/auth-capabilities
   и подписанные POST /queue/signed/{join,claim,done} (verifyActionSig + nonce). */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AgentQueue } from '../../queue.mjs';
import { verifyActionSig } from '../../queue-auth.mjs';
import { validateServiceOffer, validateAssignment, validateArtifact, verifyArtifactHash, validateSubscription, hashOf } from './schemas.mjs';
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
  // ---- Этап D: делегирование (бюджет/глубина), независимый reviewer, спор ----
  const disputes = Object.assign({}, loadJson('disputes.json', {})); // disputeId -> {assignmentId, by, state,...}
  const MAX_DELEGATION_DEPTH = 3; // жёсткий предел вложенности найма на стенде
  // ---- Этап E: независимый поставщик ресурса ----
  // Ресурс — измеримая квота (секунды/байты/запросы), а не готовый результат.
  // Поставщик — любой агент со своим endpoint: платформа его НЕ вызывает и НЕ проверяет
  // (verified=false); потребление фиксирует сам поставщик, оплата — по измеренному.
  const resources = Object.assign({}, loadJson('resources.json', {}));
  const leases = Object.assign({}, loadJson('leases.json', {}));
  const usageSeen = Object.assign({}, loadJson('usage-seen.json', {}));
  const RESOURCE_KINDS = ['compute', 'storage', 'bandwidth', 'api-quota'];
  // SSRF-политика для ресурса: локальный endpoint разрешён только явным стендовым флагом,
  // и только здесь — у мониторов и остального она остаётся строгой.
  const resourceEndpointDeny = (raw) => {
    const d = isPrivateTarget(raw);
    if (!d) return null;
    if (d === 'ssrf_denied' && process.env.STAND_ALLOW_LOCAL_RESOURCE_ENDPOINT === '1') return null;
    return d;
  };
  /* Резерв бюджета живёт ровно столько, сколько подзаказ обязателен.
     held — бюджет родителя занят; released — подзаказ закрыт, резерв возвращён.
     Возврат идемпотентен: повторный релиз не уменьшает счётчик дважды. */
  const releaseReservation = (o, why) => {
    const dg = o?.assignment?.delegation;
    if (!dg || !dg.parentId || dg.reservation !== 'held') return false;
    const parent = orders[dg.parentId];
    if (parent?.assignment?.delegation) {
      parent.assignment.delegation.committedAtomic = Math.max(0, Number(parent.assignment.delegation.committedAtomic || 0) - Number(dg.budgetAtomic || 0));
    }
    dg.reservation = 'released'; dg.releasedAt = Date.now(); dg.releaseReason = String(why || '');
    return true;
  };
  const holdReservation = (o, why) => {
    const dg = o?.assignment?.delegation;
    if (!dg || !dg.parentId) return true;
    if (dg.reservation === 'held') return true;
    const pd = orders[dg.parentId]?.assignment?.delegation;
    if (!pd) return false;
    const total = Number(pd.budgetAtomic || 0), committed = Number(pd.committedAtomic || 0);
    if (committed + Number(dg.budgetAtomic || 0) > total) return false;
    pd.committedAtomic = committed + Number(dg.budgetAtomic || 0);
    dg.reservation = 'held'; dg.reheldAt = Date.now(); dg.releaseReason = null;
    return true;
  };
  // ---- Проход 4: модерация (отдельный операторский контур, не меняет подписи/артефакты/расчёты) ----
  const OPERATOR = process.env.STAND_OPERATOR || loadJson('operator.json', { address: '' }).address || '';
  // Проход 1 (ТЗ п.1): приватное чтение только с доказательством владения адресом.
  // requester без валидной подписи action='read' НЕ доверяем: считаем анонимом.
  // Тело подписи: {resource, id, requester}. Подмена адреса без ключа даёт только public/redacted.
  const verifiedReader = (sp, resource, id) => {
    const requester = String(sp.get('requester') || '');
    if (!requester) return '';
    const fromPub = String(sp.get('fromPub') || '');
    const signature = String(sp.get('signature') || '');
    const nonce = String(sp.get('nonce') || '');
    const expiry = Number(sp.get('expiry') || 0);
    if (!fromPub || !signature || !nonce || !expiry) return '';
    const v = verifyActionSig({ address: requester, fromPub, signature, action: 'read', body: { resource: String(resource), id: String(id || ''), requester }, nonce, expiry, chain: 'AGENTCOIN' });
    return v.ok ? requester : '';
  };
  // Faucet: лимит одной суммы недостаточен — общий бюджет + частота + контролируемый доступ.
  const FAUCET_PER_REQUEST_MAX = 1000000;
  const FAUCET_GLOBAL_CAP = Number(process.env.STAND_FAUCET_GLOBAL_CAP || 50000000);
  const FAUCET_PER_ADDR_DAY = Number(process.env.STAND_FAUCET_PER_ADDR_DAY || 2000000);
  const faucetStats = Object.assign({ total: 0, perAddr: {} }, loadJson('faucet-stats.json', {}));
  const persistFaucet = () => saveJson('faucet-stats.json', faucetStats);
  const faucetCheck = (to, amt) => {
    if (!to || !Number.isInteger(amt) || amt <= 0 || amt > FAUCET_PER_REQUEST_MAX) return 'bad_faucet';
    if (process.env.STAND_FAUCET_OPEN === '0') return 'faucet_closed';
    const day = new Date().toISOString().slice(0, 10);
    const e = faucetStats.perAddr[to] || { day, total: 0, times: [] };
    const eday = e.day === day ? e : { day, total: 0, times: [] };
    const now = Date.now();
    eday.times = (eday.times || []).filter((t) => now - t < 60_000);
    if (eday.times.length >= 5) return 'faucet_rate_limited';
    if (eday.total + amt > FAUCET_PER_ADDR_DAY) return 'faucet_daily_limited';
    if (faucetStats.total + amt > FAUCET_GLOBAL_CAP) return 'faucet_global_empty';
    eday.total += amt; eday.times.push(now);
    faucetStats.perAddr[to] = eday; faucetStats.total += amt;
    persistFaucet();
    return null;
  };
  const moderation = Object.assign({ hidden: {}, suspended: {}, complaints: [], decisions: [], pubLog: [] }, loadJson('moderation.json', {}));
  let pubCount = loadJson('pubcount.json', {}); // provider -> [timestamps] антиспам
  const persistMod = () => { saveJson('moderation.json', moderation); saveJson('pubcount.json', pubCount); saveJson('operator.json', { address: OPERATOR }); };
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
    saveJson('disputes.json', disputes);
    saveJson('resources.json', resources); saveJson('leases.json', leases); saveJson('usage-seen.json', usageSeen);
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
    if (h.includes(':') || h === '[::1]' || /^\[.*\]$/.test(h)) return 'ssrf_denied'; // IPv6-литералы запрещены
    if (/^0x[0-9a-f]+$/i.test(h.replace(/\./g, '')) || /^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const parts = h.split('.').map(Number);
      if (parts.length === 4 && parts.every((n) => n >= 0 && n <= 255)) {
        const [a, b2] = parts;
        if (a === 127 || a === 10 || (a === 172 && b2 >= 16 && b2 <= 31) || (a === 192 && b2 === 168) || (a === 169 && b2 === 254) || a === 0) return 'ssrf_denied';
      }
    }
    // DNS-rebinding/redirect: фактическое исходящее чтение запрещено без guardFetch
    // (DNS-перепроверка + запрет редиректов + тайм-аут 10с + лимит 1MB + без секретов).
    // Сейчас стенд targetUrl только хранит и отдаёт сторонам, fetch не выполняет.
    const m172 = h.match(/^172\.(\d+)\./); if (m172 && +m172[1] >= 16 && +m172[1] <= 31) return 'ssrf_denied';
    if (/^[a-z0-9-]+$/.test(h) && !h.includes('.') && h !== 'example') return 'ssrf_denied'; // однословные хосты, кроме стендового example
    return null;
  };
  /* Каденция: возвращаем ВСЕ наступившие периоды с прошлого тика.
     Пропущенный период — missed (не работа, не оплата), оплачиваемый только текущий.
     Повтор тика идемпотентен: runId = monitorId|periodIndex. */
  const monitorDue = (mon, nowMs) => {
    const per = mon.periodMs;
    if (nowMs >= mon.expiresAt || mon.canceled || mon.paused) return { current: -1, indices: [] };
    const current = Math.floor((nowMs - mon.createdAt) / per);
    if (current < 0) return { current: -1, indices: [] };
    const from = Number.isInteger(mon.lastIndex) ? mon.lastIndex + 1 : 0;
    const indices = [];
    for (let i = Math.max(0, from); i <= current; i++) indices.push(i);
    return { current, indices };
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let body = '';
    let bodyTooLarge = false;
    req.on('data', (c) => { if (body.length + c.length > 262144) { bodyTooLarge = true; body = ''; try { req.destroy(); } catch {} return; } body += c; });
    req.on('end', () => {
      if (bodyTooLarge) return send(413, { error: 'body_too_large', hint: 'лимит тела 256KB' });
      let b = {}; try { b = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'bad_json' }); }
      if (u.pathname === '/info') return send(200, { chain: 'AGENTCOIN-stand', blocks: 1, genesisHash: GENESIS });
      if (u.pathname === '/queue/auth-capabilities') return send(200, { signed: true, chain: 'AGENTCOIN', genesis: GENESIS, auth: 'read-proof-required', actions: ['join', 'claim', 'done', 'publish', 'order', 'artifact', 'accept', 'monitor', 'mtick', 'mpause', 'mcancel', 'settle', 'ssend', 'sconfirm', 'sdispute', 'scancel', 'complain', 'mdecide', 'delegate', 'review', 'dispute', 'dresolve', 'rregister', 'rlease', 'rconsume', 'rclose', 'read'] });
      if (u.pathname === '/queue/status') return send(200, queue.status());
      if (u.pathname === '/queue/assignments') return send(200, { onDuty: queue.state.onDuty }); // стенд-only: prod этого не отдаёт, там — ownership_unknown без журнала/истории
      if (u.pathname === '/queue/history') return send(200, { history: queue.state.history || [] });
      if (u.pathname === '/balances') return send(200, { balances: [{ address: u.searchParams.get('addresses'), balance: 0 }] });
      if (u.pathname === '/jobs/state') return send(200, { stats: { total: 0, open: 0 }, fees: [], open: [], history: [] });
      if ((u.pathname === '/queue/join' || u.pathname === '/queue/claim' || u.pathname === '/queue/done') && req.method === 'POST') {
        return send(410, { error: 'legacy_unsigned_disabled', hint: 'неподписанные мутации отключены: используйте POST /queue/signed/{join,claim,done} с подписью queue-auth' });
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
        for (const [id, e] of Object.entries(offers)) { if (moderation.hidden[id]) continue; for (const o of e.versions) {
          if (skill && !(o.skills || []).some(s => String(s).includes(skill)) && !String(o.title).includes(skill)) continue;
          if (maxP !== null && maxP !== '' && Number(o.priceAtomic) > Number(maxP)) continue;
          if (fmt && !(o.acceptedInputFormats || []).includes(fmt) && !(o.producedOutputFormats || []).includes(fmt)) continue;
          out.push({ ...o, expired: Number(o.expiresAt) <= Date.now() });
        } }
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
        const now = Date.now();
        pubCount[b.address] = (pubCount[b.address] || []).filter((t) => now - t < 3600_000);
        if (pubCount[b.address].length >= 10) return send(429, { error: 'spam_limited', hint: 'лимит публикаций: 10 в час на провайдера' });
        pubCount[b.address].push(now); persistMod();
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
        if (moderation.suspended[offerId]) return send(409, { error: 'offer_suspended', hint: 'создание новых заказов по предложению приостановлено; существующие заказы не изменены' });
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
        const assignment = {
          assignmentId, offerId, offerVersion: snap.version, offerSnapshotHash: hashOf(snap), priceAtomic: snap.priceAtomic,
          customer: b.address, provider: snap.provider, input: input || {}, acceptanceMethod: snap.acceptance.method,
          state: 'open', createdAt: Date.now(), parentId: null,
          // Корень цепочки найма: бюджет — цена заказа, глубина 0.
          delegation: { parentId: null, rootId: assignmentId, depth: 0, budgetAtomic: Number(snap.priceAtomic || 0), committedAtomic: 0, maxDepth: MAX_DELEGATION_DEPTH, ancestry: [b.address], reservation: 'root' },
        };
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
        const auth = verifiedReader(u.searchParams, 'order', mg[1]);
        const isParty = auth && (auth === o.assignment.customer || auth === o.assignment.provider);
        const pub = o.artifacts.map(a => ({ ...a.meta, content: a.meta.accessPolicy === 'public' || isParty ? a.content : undefined }));
        return send(200, { assignment: o.assignment, artifacts: pub, dispute: o.assignment.disputeId ? (disputes[o.assignment.disputeId] || null) : null, acceptance: isParty || o.acceptance?.verdict === undefined ? o.acceptance : (o.acceptance ? { verdict: o.acceptance.verdict, at: o.acceptance.at, method: o.acceptance.method } : null), auth: auth ? 'owner' : 'public' });
      }
      // ---- Этап E: ресурс как услуга (квота, измерение, оплата по факту) ----
      if (u.pathname === '/resources' && req.method === 'GET') {
        const kind = u.searchParams.get('kind') || '';
        const out = Object.values(resources).filter((r) => !kind || r.kind === kind)
          .map((r) => ({ ...r, leaseable: Number(r.expiresAt) > Date.now() && !r.suspended }));
        return send(200, { resources: out, note: 'verified=false: платформа не проверяет ресурс и не обращается к endpoint' });
      }
      const mres = u.pathname.match(/^\/resources\/([A-Za-z0-9_-]+)$/);
      if (mres && req.method === 'GET') {
        const r = resources[mres[1]];
        if (!r) return send(404, { error: 'resource_not_found' });
        return send(200, { resource: r });
      }
      if (u.pathname === '/resources/register' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'rregister', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prevN = usedNonce.get(key);
        if (prevN) { if (prevN.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prevN.result, replay: true }); }
        const rr = b.body?.resource || {};
        const rid = String(rr.resourceId || '');
        if (!/^[A-Za-z0-9_-]{3,40}$/.test(rid)) return send(400, { error: 'bad_resourceId', hint: '3–40 символов: буквы, цифры, _ и -' });
        if (!RESOURCE_KINDS.includes(String(rr.kind))) return send(400, { error: 'bad_kind', hint: RESOURCE_KINDS.join('|') });
        if (!rr.unit || String(rr.unit).length > 24) return send(400, { error: 'bad_unit', hint: 'unit: second|byte|request|gb-hour' });
        if (!Number.isInteger(rr.priceAtomicPerUnit) || rr.priceAtomicPerUnit <= 0) return send(400, { error: 'bad_price', hint: 'priceAtomicPerUnit — целые атомарные единицы > 0' });
        if (!Number.isInteger(rr.capacity) || rr.capacity <= 0) return send(400, { error: 'bad_capacity' });
        if (!Number.isFinite(Number(rr.expiresAt)) || Number(rr.expiresAt) <= Date.now()) return send(400, { error: 'resource_expired' });
        const deny = rr.endpoint ? resourceEndpointDeny(String(rr.endpoint)) : null;
        if (deny) return send(400, { error: deny, hint: 'endpoint ресурса должен быть публичным; стенд его не вызывает' });
        const prevRes = resources[rid];
        if (prevRes && prevRes.provider !== b.address) return send(409, { error: 'resource_exists', hint: 'resourceId занят другим поставщиком' });
        resources[rid] = {
          resourceId: rid, provider: b.address, kind: String(rr.kind), unit: String(rr.unit),
          priceAtomicPerUnit: rr.priceAtomicPerUnit, capacity: rr.capacity,
          endpoint: rr.endpoint ? String(rr.endpoint) : null, terms: rr.terms ? String(rr.terms).slice(0, 500) : null,
          expiresAt: Number(rr.expiresAt), version: prevRes ? Number(prevRes.version || 1) + 1 : 1,
          createdAt: prevRes ? prevRes.createdAt : Date.now(), updatedAt: Date.now(), suspended: false, verified: false,
        };
        persistMarket();
        emit('resource.registered', rid, String(resources[rid].version), 'public', { kind: resources[rid].kind, unit: resources[rid].unit, priceAtomicPerUnit: resources[rid].priceAtomicPerUnit }, [b.address]);
        const res = { ok: true, resource: resources[rid], note: 'регистрация не подтверждает наличие ресурса: проверка — на стороне заказчика' };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      if (u.pathname === '/resources/lease' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'rlease', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prevN = usedNonce.get(key);
        if (prevN) { if (prevN.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prevN.result, replay: true }); }
        const { resourceId, units, idempotencyKey, leaseMs } = b.body || {};
        const res = resources[resourceId];
        if (!res) return send(404, { error: 'resource_not_found' });
        if (res.provider === b.address) return send(409, { error: 'self_lease', hint: 'нельзя арендовать свой же ресурс' });
        if (Number(res.expiresAt) <= Date.now() || res.suspended) return send(409, { error: 'resource_unavailable' });
        if (!Number.isInteger(units) || units <= 0) return send(400, { error: 'bad_units', hint: 'units — целые > 0' });
        if (units > res.capacity) return send(400, { error: 'capacity_exceeded', capacity: res.capacity });
        const idem = String(idempotencyKey || '');
        const idemKey = 'lease|' + String(b.address).toLowerCase() + '|' + resourceId + '|' + (idem || String(b.nonce));
        const doneId = idemOrder.get(idemKey);
        if (doneId && leases[doneId]) { const out = { ok: true, lease: leases[doneId], assignment: orders[doneId]?.assignment || null, replay: true }; usedNonce.set(key, { digest: v.digest, result: out }); return send(200, out); }
        const leaseId = crypto.createHash('sha256').update(['lease', b.address, resourceId, idem || String(b.nonce)].join('|')).digest('hex').slice(0, 16);
        const capAtomic = units * res.priceAtomicPerUnit;
        const lease = {
          leaseId, resourceId, provider: res.provider, customer: b.address, units, usedUnits: 0,
          unitPriceAtomic: res.priceAtomicPerUnit, capAtomic, usedAtomic: 0, state: 'active',
          createdAt: Date.now(), expiresAt: Math.min(Number(res.expiresAt), Date.now() + (Number.isInteger(leaseMs) && leaseMs > 0 ? leaseMs : 3_600_000)),
          closedAt: null, endpoint: res.endpoint, verified: false,
        };
        leases[leaseId] = lease;
        const assignment = {
          assignmentId: leaseId, offerId: resourceId, offerVersion: String(res.version), offerSnapshotHash: hashOf(res),
          priceAtomic: capAtomic, customer: b.address, provider: res.provider, input: { units },
          acceptanceMethod: 'human', state: 'open', createdAt: Date.now(), kind: 'resource',
          billing: { unitPriceAtomic: res.priceAtomicPerUnit, units, usedUnits: 0, usedAtomic: 0, capAtomic, finalized: false },
          parentId: null,
          delegation: { parentId: null, rootId: leaseId, depth: 0, budgetAtomic: capAtomic, committedAtomic: 0, maxDepth: MAX_DELEGATION_DEPTH, ancestry: [b.address], reservation: 'root' },
        };
        const verr = validateAssignment(assignment);
        if (verr) return send(400, { error: verr });
        orders[leaseId] = { assignment, artifacts: [], acceptance: null };
        idemOrder.set(idemKey, leaseId);
        persistMarket();
        emit('resource.leased', leaseId, '1', 'parties', { resourceId, units, capAtomic }, [b.address, res.provider]);
        const out = { ok: true, lease, assignment, note: 'capAtomic — потолок; оплата только за измеренное потребление' };
        usedNonce.set(key, { digest: v.digest, result: out });
        return send(200, out);
      }
      if (u.pathname === '/resources/consume' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'rconsume', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prevN = usedNonce.get(key);
        if (prevN) { if (prevN.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prevN.result, replay: true }); }
        const { leaseId, units, usageId } = b.body || {};
        const lease = leases[leaseId];
        if (!lease) return send(404, { error: 'lease_not_found' });
        if (b.address !== lease.provider) return send(403, { error: 'foreign_consume', hint: 'потребление фиксирует только поставщик ресурса' });
        if (lease.state !== 'active') return send(409, { error: 'lease_closed', state: lease.state });
        if (Date.now() > lease.expiresAt) return send(409, { error: 'lease_expired' });
        if (!usageId) return send(400, { error: 'bad_usageId', hint: 'usageId обязателен: повтор того же измерения не должен списываться дважды' });
        if (!Number.isInteger(units) || units <= 0) return send(400, { error: 'bad_units' });
        const uKey = leaseId + '|' + String(usageId);
        if (usageSeen[uKey]) { const out = { ok: true, lease, usage: usageSeen[uKey], replay: true }; usedNonce.set(key, { digest: v.digest, result: out }); return send(200, out); }
        if (lease.usedUnits + units > lease.units) return send(409, { error: 'quota_exceeded', usedUnits: lease.usedUnits, units: lease.units, hint: 'потребление не может превысить арендованную квоту' });
        lease.usedUnits += units;
        lease.usedAtomic = lease.usedUnits * lease.unitPriceAtomic;
        const ord = orders[leaseId];
        if (ord) { ord.assignment.billing.usedUnits = lease.usedUnits; ord.assignment.billing.usedAtomic = lease.usedAtomic; }
        usageSeen[uKey] = { units, usedUnits: lease.usedUnits, remainingUnits: lease.units - lease.usedUnits, usedAtomic: lease.usedAtomic, at: Date.now() };
        persistMarket();
        emit('resource.consumed', leaseId, String(lease.usedUnits), 'parties', { units, usedUnits: lease.usedUnits, usedAtomic: lease.usedAtomic }, [lease.customer, lease.provider]);
        const out = { ok: true, lease, usage: usageSeen[uKey] };
        usedNonce.set(key, { digest: v.digest, result: out });
        return send(200, out);
      }
      if (u.pathname === '/resources/close' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'rclose', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prevN = usedNonce.get(key);
        if (prevN) { if (prevN.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prevN.result, replay: true }); }
        const { leaseId } = b.body || {};
        const lease = leases[leaseId];
        if (!lease) return send(404, { error: 'lease_not_found' });
        if (b.address !== lease.customer && b.address !== lease.provider) return send(403, { error: 'foreign_lease', hint: 'аренду закрывает заказчик или поставщик' });
        if (lease.state === 'closed') { const out = { ok: true, lease, amountAtomic: lease.usedAtomic, replay: true }; usedNonce.set(key, { digest: v.digest, result: out }); return send(200, out); }
        lease.state = 'closed'; lease.closedAt = Date.now();
        const ord = orders[leaseId];
        if (ord) { ord.assignment.billing.finalized = true; ord.assignment.billing.usedUnits = lease.usedUnits; ord.assignment.billing.usedAtomic = lease.usedAtomic; }
        persistMarket();
        emit('resource.closed', leaseId, '1', 'parties', { usedUnits: lease.usedUnits, amountAtomic: lease.usedAtomic }, [lease.customer, lease.provider]);
        const out = { ok: true, lease, amountAtomic: lease.usedAtomic, note: 'оплата — по измеренному потреблению, остаток квоты не оплачивается' };
        usedNonce.set(key, { digest: v.digest, result: out });
        return send(200, out);
      }
      // ---- Этап D: делегирование с бюджетом и глубиной ----
      if (u.pathname === '/orders/delegate' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'delegate', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { parentId, offerId, offerVersion, input, budgetAtomic, maxDepth, idempotencyKey } = b.body || {};
        const parent = orders[parentId];
        if (!parent) return send(404, { error: 'order_not_found' });
        if (b.address !== parent.assignment.provider) return send(403, { error: 'foreign_delegate', hint: 'делегирует только provider родительского заказа' });
        if (parent.assignment.state !== 'open') return send(409, { error: 'bad_state', state: parent.assignment.state, hint: 'делегировать можно только пока заказ не принят/не в споре' });
        const pe = offers[offerId];
        if (!pe) return send(404, { error: 'offer_not_found' });
        const psnap = offerVersion ? pe.versions.find((x) => x.version === offerVersion) : pe.versions[pe.versions.length - 1];
        if (!psnap) return send(404, { error: 'offer_version_not_found' });
        if (Number(psnap.expiresAt) <= Date.now()) return send(409, { error: 'offer_expired' });
        const pd = parent.assignment.delegation || {
          parentId: null, rootId: parent.assignment.assignmentId, depth: 0,
          budgetAtomic: Number(parent.assignment.priceAtomic || 0), committedAtomic: 0,
          maxDepth: MAX_DELEGATION_DEPTH, ancestry: [parent.assignment.customer],
        };
        const limit = Math.min(MAX_DELEGATION_DEPTH, Number.isInteger(pd.maxDepth) ? pd.maxDepth : MAX_DELEGATION_DEPTH);
        if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1)) return send(400, { error: 'bad_maxDepth' });
        const depth = Number(pd.depth || 0) + 1;
        const ancestry = [...(pd.ancestry || []), b.address];
        const childProvider = String(psnap.provider);
        if (childProvider.toLowerCase() === String(b.address).toLowerCase()) return send(409, { error: 'self_delegation', hint: 'нельзя нанять самого себя' });
        if (ancestry.some((x) => String(x).toLowerCase() === childProvider.toLowerCase())) return send(409, { error: 'delegation_cycle', hint: 'подрядчик уже в цепочке найма' });
        const allowedDepth = maxDepth === undefined ? limit : Math.min(limit, maxDepth);
        if (depth > allowedDepth) return send(409, { error: 'depth_exceeded', depth, limit: allowedDepth, hint: 'предел вложенности найма исчерпан' });
        const budget = Number(budgetAtomic);
        if (!Number.isInteger(budget) || budget <= 0) return send(400, { error: 'bad_budget', hint: 'бюджет ребёнка — целые атомарные единицы > 0' });
        const total = Number(pd.budgetAtomic || 0), committed = Number(pd.committedAtomic || 0);
        if (committed + budget > total) return send(409, { error: 'budget_exceeded', budget, committed, total, hint: 'бюджет ребёнка превышает остаток бюджета родителя' });
        const idem = String(idempotencyKey || '');
        const idemKey = 'dlg|' + String(b.address).toLowerCase() + '|' + parentId + '|' + (idem || String(b.nonce));
        const doneId = idemOrder.get(idemKey);
        if (doneId && orders[doneId]) { const res = { ok: true, assignment: orders[doneId].assignment, replay: true }; usedNonce.set(key, { digest: v.digest, result: res }); return send(200, res); }
        const assignmentId = crypto.createHash('sha256').update(['delegate', parentId, b.address, psnap.offerId, psnap.version, idem || String(b.nonce)].join('|')).digest('hex').slice(0, 16);
        const assignment = {
          assignmentId, offerId, offerVersion: psnap.version, offerSnapshotHash: hashOf(psnap), priceAtomic: budget,
          customer: b.address, provider: childProvider, input: input || {}, acceptanceMethod: psnap.acceptance.method,
          state: 'open', createdAt: Date.now(), parentId,
          delegation: { parentId, rootId: pd.rootId, depth, budgetAtomic: budget, committedAtomic: 0, maxDepth: limit, ancestry, reservation: 'held' },
        };
        const verr = validateAssignment(assignment);
        if (verr) return send(400, { error: verr });
        orders[assignmentId] = { assignment, artifacts: [], acceptance: null };
        // Бюджет родителя резервируется, а не переводится: деньги не движутся.
        pd.committedAtomic = committed + budget;
        parent.assignment.delegation = pd;
        idemOrder.set(idemKey, assignmentId);
        persistMarket();
        emit('order.delegated', assignmentId, psnap.version, 'parties', { parentId, depth, budgetAtomic: budget }, [parent.assignment.customer, parent.assignment.provider, childProvider]);
        const res = { ok: true, assignment };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      // ---- Этап D: независимый reviewer (не сторона заказа) ----
      if (u.pathname === '/orders/review' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'review', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { assignmentId, verdict, rationale, evidenceHash } = b.body || {};
        const o = orders[assignmentId];
        if (!o) return send(404, { error: 'order_not_found' });
        if (verdict !== 'accepted' && verdict !== 'rejected') return send(400, { error: 'bad_verdict', hint: "verdict: 'accepted' | 'rejected'" });
        if (b.address === o.assignment.customer || b.address === o.assignment.provider) return send(403, { error: 'reviewer_not_independent', hint: 'ревьюер не может быть стороной заказа' });
        if (o.assignment.state === 'disputed') return send(409, { error: 'disputed', hint: 'исход спора определяет арбитр, не ещё один отзыв' });
        if (o.acceptance && o.acceptance.method === 'reviewer') {
          if (o.acceptance.verdict === verdict && o.acceptance.reviewedBy === b.address) { const res = { ok: true, replay: true, assignment: o.assignment, acceptance: o.acceptance }; usedNonce.set(key, { digest: v.digest, result: res }); return send(200, res); }
          return send(409, { error: 'already_reviewed', reviewedBy: o.acceptance.reviewedBy, verdict: o.acceptance.verdict, hint: 'один отзыв на заказ; пересмотр — только через спор' });
        }
        if (!o.artifacts.length) return send(409, { error: 'no_artifact', hint: 'проверять нечего: provider ещё не сдал артефакт' });
        if (o.assignment.state === 'accepted' || o.assignment.state === 'rejected') return send(409, { error: 'bad_state', state: o.assignment.state });
        o.assignment.state = verdict === 'accepted' ? 'accepted' : 'rejected';
        o.acceptance = { verdict, at: Date.now(), method: 'reviewer', reviewedBy: b.address, rationale: String(rationale || '').slice(0, 500), evidenceHash: evidenceHash ? String(evidenceHash).slice(0, 80) : null };
        // Отклонение закрывает подзаказ: бюджет возвращается родителю.
        if (verdict === 'rejected') releaseReservation(o, 'rejected');
        persistMarket();
        emit('order.reviewed', assignmentId, '1', 'parties', { verdict, reviewedBy: b.address }, [o.assignment.customer, o.assignment.provider, b.address]);
        const res = { ok: true, assignment: o.assignment, acceptance: o.acceptance };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      // ---- Этап D: спор сторон и независимый арбитр ----
      if (u.pathname === '/orders/dispute' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'dispute', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { assignmentId, reason, evidenceHash } = b.body || {};
        const o = orders[assignmentId];
        if (!o) return send(404, { error: 'order_not_found' });
        if (b.address !== o.assignment.customer && b.address !== o.assignment.provider) return send(403, { error: 'foreign_dispute', hint: 'спор открывает только сторона заказа' });
        if (!reason) return send(400, { error: 'bad_reason', hint: 'причина обязательна: она входит в запись спора' });
        if (o.assignment.state === 'canceled') return send(409, { error: 'bad_state', state: 'canceled' });
        const open = o.assignment.disputeId ? disputes[o.assignment.disputeId] : null;
        if (open && !open.resolved) { const res = { ok: true, dispute: open, replay: true }; usedNonce.set(key, { digest: v.digest, result: res }); return send(200, res); }
        const disputeId = 'd' + crypto.createHash('sha256').update([assignmentId, b.address, String(reason), String(b.nonce)].join('|')).digest('hex').slice(0, 12);
        const d = { disputeId, assignmentId, by: b.address, reason: String(reason).slice(0, 500), evidenceHash: evidenceHash ? String(evidenceHash).slice(0, 80) : null, at: Date.now(), state: 'open', resolved: false, arbiter: null, verdict: null, rationale: null };
        disputes[disputeId] = d;
        o.assignment.disputeId = disputeId;
        o.assignment.state = 'disputed';
        persistMarket();
        emit('order.disputed', disputeId, '1', 'parties', { assignmentId, reason: d.reason }, [o.assignment.customer, o.assignment.provider]);
        const res = { ok: true, dispute: d, assignment: o.assignment };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      if (u.pathname === '/orders/disputes/resolve' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'dresolve', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { disputeId, verdict, rationale } = b.body || {};
        const d = disputes[disputeId];
        if (!d) return send(404, { error: 'dispute_not_found' });
        const o = orders[d.assignmentId];
        if (!o) return send(404, { error: 'order_not_found' });
        if (verdict !== 'customer' && verdict !== 'provider') return send(400, { error: 'bad_verdict', hint: "verdict: 'customer' | 'provider'" });
        if (d.resolved) { const res = { ok: true, dispute: d, replay: true }; usedNonce.set(key, { digest: v.digest, result: res }); return send(200, res); }
        if (b.address === o.assignment.customer || b.address === o.assignment.provider || b.address === o.acceptance?.reviewedBy) {
          return send(403, { error: 'arbiter_not_independent', hint: 'арбитр не может быть стороной или ревьюером этого заказа' });
        }
        const st = settlements[d.assignmentId];
        // Возврат отклонённого подзаказа в работу снова занимает бюджет родителя.
        // Если место уже занято другим подзаказом — отказ, а не молчаливое переполнение.
        if (!(st && st.state === 'confirmed') && verdict === 'provider' && !holdReservation(o, 'dispute_provider')) {
          return send(409, { error: 'parent_budget_exhausted', hint: 'резерв бюджета родителя уже занят другим подзаказом: сначала закройте его или решите спор в пользу заказчика' });
        }
        d.resolved = true; d.state = 'resolved'; d.verdict = verdict; d.arbiter = b.address; d.rationale = String(rationale || '').slice(0, 500); d.resolvedAt = Date.now();
        if (st && st.state === 'confirmed') {
          d.note = 'выплата уже подтверждена — решение фиксируется, но перевод не отменяется';
          d.effect = 'recorded_only';
        } else {
          o.assignment.state = verdict === 'provider' ? 'accepted' : 'canceled';
          // Отмена закрывает подзаказ: бюджет возвращается родителю.
          if (verdict === 'customer') releaseReservation(o, 'dispute_customer');
          d.effect = verdict === 'provider' ? 'payment_allowed' : 'no_payment';
        }
        persistMarket();
        emit('order.dispute_resolved', d.disputeId, '1', 'parties', { verdict, effect: d.effect }, [o.assignment.customer, o.assignment.provider]);
        const res = { ok: true, dispute: d, assignment: o.assignment, effect: d.effect, note: d.note };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
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
        if (o.assignment.state === 'rejected') return send(409, { error: 'order_rejected', hint: 'отклонённый результат принимает только разрешение спора, не повторный accept' });
        if (o.assignment.state === 'disputed') return send(409, { error: 'disputed', hint: 'спор открыт — исход определяет независимый арбитр' });
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
        const claimed = u.searchParams.get('requester') || '';
        const auth = claimed ? verifiedReader(u.searchParams, 'events', cur) : '';
        const requester = auth;
        const spoofed = claimed && !auth;
        const idx = Number(cur);
        if (!Number.isInteger(idx) || idx < 0 || idx > events.length) return send(410, { error: 'cursor_expired', hint: 'курсор истёк — нужен новый снимок с cursor=0' });
        const slice = events.slice(idx, idx + lim);
        const out = slice.filter((e) => e.visibility === 'public' || (requester && (e.parties || []).includes(requester))).map((e) => {
          if (e.visibility === 'public') return e;
          const mine = requester && (e.parties || []).includes(requester);
          return mine ? e : { ...e, payload: { redacted: true } };
        });
        return send(200, { events: out, nextCursor: String(idx + slice.length), total: events.length, auth: auth ? 'owner' : 'public', spoofed: spoofed ? 'requester_without_proof_ignored' : undefined });
      }
      // ---- Этап C: api-monitor (повторяющаяся услуга) ----
      if (u.pathname === '/monitors/create' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'monitor', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const mm = b.body?.monitor || {};
        const sub = mm.subscription || null;
        if (sub) {
          const badSub = validateSubscription(sub);
          if (badSub) return send(400, { error: 'bad_subscription', detail: badSub });
          if (sub.customer && String(sub.customer).toLowerCase() !== String(b.address).toLowerCase()) {
            return send(403, { error: 'foreign_subscription', hint: 'customer подписки должен совпадать с подписантом' });
          }
          if (Number(sub.cadence) !== Number(mm.periodMs)) return send(400, { error: 'cadence_mismatch', hint: 'cadence подписки и periodMs монитора должны совпадать' });
          if (Number(sub.maxCostPerPeriodAtomic) !== Number(mm.maxCostPerPeriodAtomic)) return send(400, { error: 'budget_mismatch' });
          if (sub.priceAtomicPerRun !== undefined && Number(sub.priceAtomicPerRun) !== Number(mm.priceAtomicPerRun)) return send(400, { error: 'price_mismatch' });
        }
        const deny = isPrivateTarget(mm.targetUrl || '');
        if (deny) return send(400, { error: deny, hint: 'SSRF-защита: внутренние и служебные адреса запрещены' });
        if (!Number.isInteger(mm.periodMs) || mm.periodMs < 1000) return send(400, { error: 'bad_period', hint: 'periodMs целое >= 1000' });
        if (!Number.isInteger(mm.priceAtomicPerRun) || mm.priceAtomicPerRun < 0) return send(400, { error: 'bad_price' });
        if (!Number.isInteger(mm.maxCostPerPeriodAtomic) || mm.maxCostPerPeriodAtomic < mm.priceAtomicPerRun) return send(400, { error: 'bad_maxCost', hint: 'лимит периода не покрывает цену одного запуска; это лимит стоимости заказов, не резерв AGT' });
        if (Number(mm.expiresAt) <= Date.now()) return send(400, { error: 'monitor_expired' });
        const monitorId = String(mm.monitorId || crypto.createHash('sha256').update([b.address, mm.targetUrl, String(b.nonce)].join('|')).digest('hex').slice(0, 12));
        if (monitors[monitorId]) { const res = { ok: true, monitor: monitors[monitorId], replay: true }; usedNonce.set(key, { digest: v.digest, result: res }); return send(200, res); }
        monitors[monitorId] = {
          monitorId, owner: b.address, provider: mm.provider || b.address, targetUrl: mm.targetUrl,
          periodMs: mm.periodMs, expiresAt: mm.expiresAt, priceAtomicPerRun: mm.priceAtomicPerRun,
          maxCostPerPeriodAtomic: mm.maxCostPerPeriodAtomic,
          maxConcurrentRuns: Math.min(4, Math.max(1, mm.maxConcurrentRuns || 1)),
          paused: false, canceled: false, createdAt: Date.now(), lastIndex: -1,
          // Снимок обязательств: правка подписки после создания не меняет уже принятые условия
          subscription: sub ? JSON.parse(JSON.stringify(sub)) : null,
          acceptanceRules: sub ? sub.acceptanceRules : null,
          cancellationRules: sub ? sub.cancellationRules : null,
          renewalPolicy: sub ? sub.renewalPolicy : null,
        };
        persistMarket();
        emit('monitor.created', monitorId, '1', 'parties', { targetUrl: mm.targetUrl }, [b.address]);
        const res = { ok: true, monitor: monitors[monitorId] };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      if (u.pathname === '/monitors/tick' && req.method === 'POST') {
        const vTick = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'mtick', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!vTick.ok) return send(401, vTick);
        const nowMs = Number((b.body && b.body.nowMs) || b.nowMs || Date.now());
        const mon = monitors[(b.body && b.body.monitorId) || b.monitorId];
        if (!mon) return send(404, { error: 'monitor_not_found' });
        if (b.address !== mon.owner && b.address !== mon.provider) return send(403, { error: 'foreign_monitor' });
        if (mon.canceled) return send(409, { error: 'monitor_canceled' });
        if (mon.paused) return send(200, { ok: true, ran: [], note: 'paused — будущие запуски остановлены' });
        const due = monitorDue(mon, nowMs);
        const ran = [];
        const result = (b.body && b.body.result) || null;
        for (const pi of due.indices) {
          const runId = `${mon.monitorId}|${pi}`;
          const existing = runs.find((r) => r.runId === runId);
          if (existing) { ran.push({ runId, replay: true, state: existing.state }); continue; }
          if (pi < due.current) {
            // Пропущенный период: фиксируем факт, но не выставляем счёт и не создаём заказ.
            runs.push({ runId, monitorId: mon.monitorId, periodIndex: pi, assignmentId: null, state: 'missed', costAtomic: 0, createdAt: Date.now(), targetStatus: null, checkerStatus: null, evidence: null });
            emit('monitor.missed', runId, '1', 'parties', { periodIndex: pi }, [mon.owner, mon.provider]);
            ran.push({ runId, skipped: 'missed_period' });
            continue;
          }
          // Потолок периода здесь не нужен и не проверяется: при создании монитора
          // гарантировано maxCostPerPeriodAtomic >= priceAtomicPerRun (bad_maxCost),
          // а на период приходится не более одного оплачиваемого запуска
          // (runId = monitorId|periodIndex, существующий перехватывается выше).
          // Прежняя ветка «spent + price > cap» была недостижима и удалена.
          const active = runs.filter((r) => r.monitorId === mon.monitorId && r.state === 'open').length;
          if (active >= mon.maxConcurrentRuns) {
            // Лимит параллельных запусков: период не оплачивается, но остаётся
            // видимым в истории и в событиях — иначе он молча исчезает.
            runs.push({ runId, monitorId: mon.monitorId, periodIndex: pi, assignmentId: null, state: 'skipped', skipReason: 'max_concurrent', costAtomic: 0, createdAt: Date.now(), targetStatus: null, checkerStatus: null, evidence: null });
            emit('monitor.skipped', runId, '1', 'parties', { periodIndex: pi, reason: 'max_concurrent', active }, [mon.owner, mon.provider]);
            ran.push({ runId, skipped: 'max_concurrent', recorded: true });
            continue;
          }
          const assignmentId = crypto.createHash('sha256').update(['monitor', runId].join('|')).digest('hex').slice(0, 16);
          if (!orders[assignmentId]) orders[assignmentId] = { assignment: { assignmentId, offerId: 'api-monitor-v1', offerVersion: '1', offerSnapshotHash: 'monitor', customer: mon.owner, provider: mon.provider, input: { monitorId: mon.monitorId, periodIndex: pi, targetUrl: mon.targetUrl }, acceptanceMethod: (mon.acceptanceRules && mon.acceptanceRules.method) || 'human', state: 'open', createdAt: Date.now(), runId }, artifacts: [], acceptance: null };
          // Доступность цели и исправность проверяющего — РАЗНЫЕ поля: отчёт проверяющего
          // не доказывает, что цель работала, и наоборот. Приёмку это не заменяет.
          const targetStatus = result && result.targetStatus ? String(result.targetStatus).slice(0, 40) : null;
          const checkerStatus = result && result.checkerStatus ? String(result.checkerStatus).slice(0, 40) : null;
          runs.push({ runId, monitorId: mon.monitorId, periodIndex: pi, assignmentId, state: 'open', createdAt: Date.now(), costAtomic: mon.priceAtomicPerRun, targetStatus, checkerStatus, evidence: result && result.evidence ? String(result.evidence).slice(0, 500) : null });
          emit('monitor.run', runId, '1', 'parties', { assignmentId, targetStatus, checkerStatus }, [mon.owner, mon.provider]);
          ran.push({ runId, assignmentId, targetStatus, checkerStatus });
        }
        if (due.current >= 0) mon.lastIndex = Math.max(Number.isInteger(mon.lastIndex) ? mon.lastIndex : -1, due.current);
        persistMarket();
        return send(200, { ok: true, ran, budgetPerPeriodAtomic: mon.maxCostPerPeriodAtomic });
      }
      const mhist = u.pathname.match(/^\/monitors\/([A-Za-z0-9|_-]+)\/history$/);
      if (mhist && req.method === 'GET') {
        const mon = monitors[mhist[1]];
        if (!mon) return send(404, { error: 'monitor_not_found' });
        const auth = verifiedReader(u.searchParams, 'monitor', mhist[1]);
        if (!auth) return send(401, { error: 'auth_required', hint: 'история монитора приватна: приложите подпись read (requester+fromPub+signature+nonce+expiry)' });
        if (auth !== mon.owner && auth !== mon.provider) return send(403, { error: 'foreign_monitor' });
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
        const why = faucetCheck(to, amt);
        if (why) return send(why === 'bad_faucet' ? 400 : 429, { error: why, hint: 'лимиты крана: ≤1M за раз, ≤2M/день/адрес, ≤5/мин, общий бюджет; внешняя публикация — только с контролируемым доступом' });
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
        const auth = verifiedReader(u.searchParams, 'settlement', mset[1]);
        if (!auth) return send(401, { error: 'auth_required', hint: 'расчёт приватен: приложите подпись read' });
        if (auth !== s.payer && auth !== s.recipient) return send(403, { error: 'foreign_settlement' });
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
        const dsp = o.assignment.disputeId ? disputes[o.assignment.disputeId] : null;
        if (dsp && !dsp.resolved) return send(409, { error: 'disputed', hint: 'спор открыт: расчёт заморожен до решения независимого арбитра' });
        if (o.assignment.state !== 'accepted') return send(409, { error: 'no_obligation', hint: 'обязательство возникает только после приёмки (accept)' });
        if (b.address !== o.assignment.customer) return send(403, { error: 'foreign_settle' });
        if (o.assignment.kind === 'resource' && !o.assignment.billing?.finalized) {
          return send(409, { error: 'lease_open', hint: 'сначала закрывается аренда: оплата по измеренному потреблению, не по квоте' });
        }
        // Ресурс оплачивается по измеренному потреблению, остаток квоты не оплачивается.
        const amount = Number(o.assignment.kind === 'resource' ? o.assignment.billing.usedAtomic : (o.assignment.priceAtomic ?? 0));
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
          if (b.address !== s.payer && b.address !== s.recipient) return send(403, { error: 'foreign_settle' });
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
      // ---- Проход 4: модерация + метрики (операторский контур; деньги/артефакты/подписи не трогает) ----
      if (u.pathname === '/ops/metrics' && req.method === 'GET') {
        const orderStates = {}, settleStates = {};
        for (const o of Object.values(orders)) orderStates[o.assignment.state] = (orderStates[o.assignment.state] || 0) + 1;
        for (const s of Object.values(settlements)) settleStates[s.state] = (settleStates[s.state] || 0) + 1;
        return send(200, { offers: Object.keys(offers).length, hidden: Object.keys(moderation.hidden).length, suspended: Object.keys(moderation.suspended).length, disputes: Object.keys(disputes).length, disputesOpen: Object.values(disputes).filter((d) => !d.resolved).length, resources: Object.keys(resources).length, leases: Object.keys(leases).length, orders: orderStates, settlements: settleStates, events: events.length, monitors: Object.keys(monitors).length, runs: runs.length, complaintsOpen: moderation.complaints.filter((c) => c.status === 'open').length, decisions: moderation.decisions.length, genesis: GENESIS, test: true });
      }
      if (u.pathname === '/moderation/complaint' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'complain', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const { targetType, targetId, reason } = b.body || {};
        if (!targetType || !targetId || !reason) return send(400, { error: 'bad_complaint' });
        const c = { complaintId: 'c' + crypto.createHash('sha256').update([b.address, targetId, String(reason), String(b.nonce)].join('|')).digest('hex').slice(0, 10), targetType, targetId, reason: String(reason), by: b.address, at: Date.now(), status: 'open' };
        moderation.complaints.push(c); persistMod();
        emit('moderation.complaint', c.complaintId, '1', 'parties', { targetType, targetId }, [b.address]);
        return send(200, { ok: true, complaint: c, note: 'жалоба принята; урегулирование споров по оплате — после фиксации правил (проход 4 принимает, но не обещает исход)' });
      }
      if (u.pathname === '/moderation/decide' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'mdecide', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        if (!OPERATOR || b.address !== OPERATOR) return send(403, { error: 'foreign_operator', hint: 'решение принимает только оператор стенда' });
        const { complaintId, decision, reason } = b.body || {};
        const c = moderation.complaints.find((x) => x.complaintId === complaintId);
        if (!c) return send(404, { error: 'complaint_not_found' });
        if (c.status !== 'open') return send(409, { error: 'complaint_closed' });
        const before = { hidden: !!moderation.hidden[c.targetId], suspended: !!moderation.suspended[c.targetId] };
        if (decision === 'hide_offer') moderation.hidden[c.targetId] = true;
        else if (decision === 'unhide_offer') delete moderation.hidden[c.targetId];
        else if (decision === 'suspend_offer') moderation.suspended[c.targetId] = true;
        else if (decision === 'resume_offer') delete moderation.suspended[c.targetId];
        else if (decision !== 'dismiss') return send(400, { error: 'bad_decision' });
        c.status = 'decided'; c.decision = decision; c.decidedAt = Date.now(); c.decidedBy = b.address;
        const after = { hidden: !!moderation.hidden[c.targetId], suspended: !!moderation.suspended[c.targetId] };
        moderation.decisions.push({ who: b.address, what: decision + ':' + c.targetId, reason: String(reason || ''), at: Date.now(), before, after, complaintId });
        persistMod();
        emit('moderation.decision', complaintId, '1', 'public', { decision, targetId: c.targetId }, [b.address]);
        return send(200, { ok: true, complaint: c, before, after, note: 'административное решение; не является решением блокчейна; подписи/артефакты/расчёты не изменены' });
      }
      if (u.pathname === '/moderation/history' && req.method === 'GET') {
        const auth = verifiedReader(u.searchParams, 'moderation', 'history');
        if (!OPERATOR || !auth || auth !== OPERATOR) return send(403, { error: 'foreign_operator', hint: 'операторская история только с подписью read владельца OPERATOR' });
        return send(200, { complaints: moderation.complaints, decisions: moderation.decisions });
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, queue, genesis: GENESIS, close: () => server.close() };
}
