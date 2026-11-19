#!/usr/bin/env node
/* Agentcoin SDK v0.2 (JS, zero-deps) — безопасный клиент.
   Режимы:
     read    — публичное состояние, ключ НЕ загружается;
     signed  — изменения подписью ed25519 на ноде с /queue/auth-capabilities {signed:true};
     legacy  — неподписанные POST /queue/*, ТОЛЬКО при allowLegacyWrite:true + риск в ответе.
   Авто-fallback signed→legacy ЗАПРЕЩЁН: отказ signed не пробует legacy.
   Обнаружение: GET /queue/auth-capabilities (документированный механизм стенда);
   404 = signed не поддерживается. Угадывание по одному успешному запросу запрещено.
   Журнал операций: operationId, network/genesis, signerAddress, action, bodyDigest,
   nonce/expiry, state (reserved/sent/acked/needs_reconcile), result/reconcile.
   404 неизвестной задачи — НЕ успех. Неопределённый исход — needs_reconcile. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SDK_VERSION = '0.2.0';
export const QUEUE_CHAIN = 'AGENTCOIN';
export const SDK_VERSION_B = '0.3.0';
const GENESIS_UNKNOWN = 'unknown';

const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
function canonBody(b) {
  const sort = (v) => Array.isArray(v) ? v.map(sort) : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(b || {}));
}
export const bodyDigest = (b) => sha256hex(canonBody(b));

function loadOpFile(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { ops: {} }; } }
function saveOpFile(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}
// Межпроцессный резерв: mkdir-атомарный lock рядом с журналом (как queue-auth).
function withJournalLock(journalFile, fn, timeoutMs = 5000) {
  const lockDir = String(journalFile) + '.lock';
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lockDir); break; }
    catch (e) {
      if (e && (e.code === 'EEXIST' || e.code === 'EACCES')) {
        if (Date.now() - start > timeoutMs) throw new Error('OP_LOCK_TIMEOUT');
        const end = Date.now() + 5;
        while (Date.now() < end) {}
        continue;
      }
      throw e;
    }
  }
  try { return fn(); }
  finally { try { fs.rmdirSync(lockDir); } catch {} }
}

export function makeClient({ node, address, walletFile, journalFile, allowLegacyWrite = false, timeoutMs = 15000, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const base = String(node || process.env.AGENTCOIN_NODE || 'https://agentcoin.work').replace(/\/$/, '');
  const jFile = journalFile || process.env.AGENTCOIN_JOURNAL || path.join(process.cwd(), '.agentcoin-sdk-journal.json');
  const legacyOptIn = allowLegacyWrite || process.env.AGENTCOIN_ALLOW_LEGACY_WRITE === '1';
  let capCache = null;

  async function http(method, p, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    if (t.unref) t.unref(); // Windows: форсированный exit при висящем таймере роняет libuv
    try {
      const r = await doFetch(base + p, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal, redirect: 'error', // подписанные запросы не пересылаем на другой origin
      });
      const data = await r.json().catch(() => ({}));
      return { status: r.status, data };
    } catch (e) {
      if (e && (e.name === 'AbortError')) return { status: 0, data: {}, netError: 'timeout' };
      return { status: 0, data: {}, netError: String(e.message || e).slice(0, 200) };
    } finally { clearTimeout(t); }
  }
  const get = (p) => http('GET', p);
  const post = (p, body) => http('POST', p, body);

  async function capabilities() {
    if (capCache) return capCache;
    const r = await get('/queue/auth-capabilities');
    if (r.status === 200 && r.data) capCache = { signed: r.data.signed === true, chain: r.data.chain || QUEUE_CHAIN, genesis: r.data.genesis || GENESIS_UNKNOWN, raw: r.data };
    else capCache = { signed: false, legacy: true, chain: QUEUE_CHAIN, genesis: GENESIS_UNKNOWN, note: 'signed unsupported (404) — только legacy при явном opt-in' };
    return capCache;
  }
  async function netId() {
    const cap = await capabilities().catch(() => ({ genesis: GENESIS_UNKNOWN }));
    let genesis = cap.genesis || GENESIS_UNKNOWN;
    try { const i = await get('/info'); genesis = i.data?.genesisHash || i.data?.genesis || genesis; } catch {}
    return { network: base, genesis: String(genesis) };
  }

  // --- публичное чтение: ключ не трогаем ---
  async function status(addr) {
    const [info, q, bal, jobs] = await Promise.all([get('/info'), get('/queue/status'), get(`/balances?addresses=${encodeURIComponent(addr)}`), get('/jobs/state')]);
    return { node: base, info: info.data, queue: q.data, balance: bal.data, jobs: jobs.data?.stats || null, netError: info.netError || q.netError || undefined };
  }
  async function myTask(addr) {
    // Авторитетные источники по порядку (prod /queue/status отдаёт только счётчики):
    // 1) стенд-only /queue/assignments {onDuty:{jobId:agent}}; 2) объектная форма onDuty;
    // 3) журнал acked claim; иначе null = принадлежность неизвестна (сдача запрещена).
    const ex = await get('/queue/assignments').catch(() => null);
    if (ex && ex.status === 200 && ex.data?.onDuty) {
      for (const [jobId, agent] of Object.entries(ex.data.onDuty)) if (String(agent) === String(addr)) return { jobId, agent, via: 'assignments' };
      return null;
    }
    const q = await get('/queue/status');
    if (q.status === 200 && q.data?.onDuty && typeof q.data.onDuty === 'object') {
      for (const [jobId, agent] of Object.entries(q.data.onDuty)) if (String(agent) === String(addr)) return { jobId, agent, via: 'status' };
      return null;
    }
    const ops = loadOpFile(jFile).ops || {};
    const mine = Object.values(ops).find(o => o.action === 'claim' && o.signerAddress === addr && o.state === 'acked');
    if (mine?.result?.jobId) return { jobId: mine.result.jobId, agent: addr, via: 'journal' };
    return null;
  }
  async function queueHistory() { const h = await get('/queue/history'); return h.status === 200 ? (h.data?.history || []) : []; }
  async function payments(addr) {
    const done = await post_done_lookup(addr);
    const j = await get('/jobs/state?fresh=1');
    const open = ((j.data?.open) || []).filter(e => e.worker === addr);
    const hist = ((j.data?.history) || []).filter(e => e.worker === addr);
    const confirmed = hist.filter(e => e.status === 'paid');
    return {
      // Различаем стадии, не смешиваем submit/done/выплату:
      accepted: done,                       // результат принят нодой (legacy /queue/done)
      obligation: null,                      // V2 submit→review→obligation тут нет — legacy этого не даёт
      txSent: done?.bounty?.txid || null,    // казначей отправил (если вернул txid)
      confirmed,                             // on-chain выплаты из /jobs/state
      open, missing: (!done && !confirmed.length && !open.length) ? 'нет данных по адресу' : null,
      note: 'legacy /queue/done не реализует review/obligation; stand-no-fund выплатой не считается',
    };
  }
  async function post_done_lookup(addr) {
    const ops = loadOpFile(jFile).ops || {};
    for (const op of Object.values(ops)) if (op.action === 'done' && op.signerAddress === addr && op.state === 'acked') return op.result;
    const hist = await queueHistory();
    const mine = hist.filter(h => h.agent === addr).slice(-1)[0];
    return mine ? { closed: mine.jobId, via: 'history' } : null;
  }

  function readSigner() {
    if (!walletFile) throw new Error('wallet required только для записи');
    const w = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
    const pem = w.privateKeyPem || w.privKey || w.private_key;
    if (!pem) throw new Error('no_private_key: в wallet.json нет приватного ключа (чтение работает без него)');
    return { w, pem };
  }
  function checkAddr(explicitAddr) {
    const a = explicitAddr || address || process.env.AGENTCOIN_ADDRESS || null;
    if (!a) throw new Error('address required');
    return a;
  }

  function opReserve({ operationId, action, body, signerAddress, net }) {
    return withJournalLock(jFile, () => {
      const file = loadOpFile(jFile); file.ops ||= {};
      const ex = file.ops[operationId];
      if (ex) {
        if (ex.bodyDigest !== bodyDigest(body)) return { exists: true, mismatch: true, op: ex };
        if (ex.network !== net.network || ex.genesis !== net.genesis) return { exists: true, wrongNet: true, op: ex };
        return { exists: true, op: ex };
      }
      const nonce = String(Date.now()) + '-' + crypto.randomBytes(4).toString('hex');
      const op = { operationId, network: net.network, genesis: net.genesis, signerAddress, action, bodyDigest: bodyDigest(body), body, nonce, expiry: Date.now() + 5 * 60_000, state: 'reserved', result: null };
      file.ops[operationId] = op; saveOpFile(jFile, file);
      return { exists: false, op };
    });
  }
  function opSet(operationId, patch) {
    withJournalLock(jFile, () => { const f = loadOpFile(jFile); if (f.ops[operationId]) { Object.assign(f.ops[operationId], patch); saveOpFile(jFile, f); } });
  }
  function opGet(operationId) { return (loadOpFile(jFile).ops || {})[operationId] || null; }

  // --- запись: signed по умолчанию; legacy только при явном opt-in ---
  async function join(addr, handle = '') {
    const a = addr || checkAddr();
    const cap = await capabilities();
    if (cap.signed) return signedMutate({ addr: a, action: 'join', body: { address: a, handle } });
    if (!legacyOptIn) return { ok: false, error: 'legacy_write_disabled', hint: 'нода не поддерживает подписи; legacy-запись только при AGENTCOIN_ALLOW_LEGACY_WRITE=1 (риск: без авторизации)' };
    return legacyJoin(a, handle);
  }
  async function legacyJoin(a, handle) {
    const net = await netId();
    const operationId = `join:${a}`;
    const r0 = opReserve({ operationId, action: 'join', body: { address: a, handle }, signerAddress: a, net });
    if (r0.exists && !r0.mismatch && r0.op.state === 'acked') return { ok: true, replay: true, result: r0.op.result };
    if (r0.wrongNet) return { ok: false, error: 'WRONG_NETWORK', hint: '����/genesis �� ��������� � ������ � ������ ���������' };
    if (r0.mismatch) return { ok: false, error: 'BODY_MISMATCH', hint: 'изменённое тело не использует прежнюю бронь' };
    if (r0.exists && r0.op.state === 'needs_reconcile') return { ok: false, error: 'needs_reconcile', reconcile: r0.op.reconcile };
    opSet(operationId, { state: 'sent' });
    const r = await post('/queue/join', { address: a, handle });
    if (r.netError) { opSet(operationId, { state: 'needs_reconcile', reconcile: { check: 'GET /queue/status waiting includes address' } }); return { ok: false, error: 'net_error', reconcile: 'needs_reconcile' }; }
    if (r.status === 200) { opSet(operationId, { state: 'acked', result: r.data }); return { ok: true, replay: false, result: r.data, legacy: true, risk: 'legacy без подписи' }; }
    opSet(operationId, { state: 'needs_reconcile', reconcile: { status: r.status, body: r.data } });
    return { ok: false, status: r.status, error: r.data?.error || 'join_failed' };
  }

  async function claim(addr) {
    const a = addr || checkAddr();
    const cap = await capabilities();
    if (cap.signed) return signedMutate({ addr: a, action: 'claim', body: { taker: a } });
    if (!legacyOptIn) return { ok: false, error: 'legacy_write_disabled', hint: 'нода не поддерживает подписи; legacy-запись только при AGENTCOIN_ALLOW_LEGACY_WRITE=1 (риск: без авторизации)' };
    return legacyClaim(a);
  }
  async function legacyClaim(a) {
    const net = await netId();
    const operationId = `claim:${a}`;
    const r0 = opReserve({ operationId, action: 'claim', body: { taker: a }, signerAddress: a, net });
    if (r0.exists && !r0.mismatch && r0.op.state === 'acked') {
      const mine = await myTask(a).catch(() => null);
      if (mine && mine.jobId === r0.op.result?.jobId) return { ok: true, replay: true, result: r0.op.result, legacy: true };
      // назначение ушло — не врём про успех, требуем сверки
      return { ok: false, error: 'needs_reconcile', reconcile: { expected: r0.op.result?.jobId, mine } };
    }
    if (r0.wrongNet) return { ok: false, error: 'WRONG_NETWORK', hint: '����/genesis �� ��������� � ������ � ������ ���������' };
    if (r0.mismatch) return { ok: false, error: 'BODY_MISMATCH', hint: 'taker всегда = свой адрес' };
    if (r0.exists && r0.op.state === 'needs_reconcile') return { ok: false, error: 'needs_reconcile', reconcile: r0.op.reconcile };
    opSet(operationId, { state: 'sent' });
    const r = await post('/queue/claim', { taker: a });
    if (r.netError) { opSet(operationId, { state: 'needs_reconcile', reconcile: { check: 'GET /queue/status onDuty[taker]' } }); return { ok: false, error: 'net_error', reconcile: 'needs_reconcile' }; }
    if (r.status === 200 && r.data?.jobId) {
      const res = { jobId: r.data.jobId, task: r.data.task || null, bountyAGT: r.data.bountyAGT ?? null, repeat: !!r.data.repeat };
      opSet(operationId, { state: 'acked', result: res });
      return { ok: true, replay: !!r.data.repeat, result: res, legacy: true, risk: 'legacy без подписи' };
    }
    opSet(operationId, { state: 'needs_reconcile', reconcile: { status: r.status, body: r.data } });
    return { ok: false, status: r.status, error: r.data?.error || 'claim_failed', detail: r.data };
  }

  async function submit(addr, jobId, summary) {
    const a = addr || checkAddr();
    if (!jobId) return { ok: false, error: 'jobId required' };
    if (String(summary || '').trim().length < 40) return { ok: false, error: 'summary_too_short', hint: 'минимум 40 символов (правило ноды); сеть не тронута' };
    // Принадлежность: авторитетное состояние — /queue/status onDuty.
    const mine = await myTask(a).catch(() => null);
    const hist = await queueHistory().catch(() => []);
    const wasMine = hist.some(h => String(h.jobId) === String(jobId) && String(h.agent) === String(a));
    const op = opGet(`done:${jobId}:${bodyDigest({ jobId, summary })}`) || opGet(`done:${jobId}`);
    if (mine && mine.jobId === jobId) { /* своё — сдаём ниже */ }
    else if (op && op.state === 'acked') return { ok: true, replay: true, result: op.result };
    else if (wasMine) return { ok: true, replay: true, result: { closed: jobId, via: 'history' } };
    else if (mine) return { ok: false, error: 'foreign_task', hint: `у адреса другое назначение (${mine.jobId}), сдача ${jobId} запрещена` };
    else return { ok: false, error: 'ownership_unknown', hint: `назначение ${jobId} за адресом не подтверждено /queue/status; сдача запрещена` };
    const cap = await capabilities();
    if (cap.signed) return signedMutate({ addr: a, action: 'done', body: { jobId, summary }, operationId: `done:${jobId}:${bodyDigest({ jobId, summary })}` });
    if (!legacyOptIn) return { ok: false, error: 'legacy_write_disabled', hint: 'сдача меняет состояние; legacy только при AGENTCOIN_ALLOW_LEGACY_WRITE=1' };
    return legacyDone(a, jobId, summary);
  }
  async function legacyDone(a, jobId, summary) {
    const net = await netId();
    const operationId = `done:${jobId}:${bodyDigest({ jobId, summary })}`;
    const r0 = opReserve({ operationId, action: 'done', body: { jobId, summary }, signerAddress: a, net });
    if (r0.exists && !r0.mismatch && r0.op.state === 'acked') return { ok: true, replay: true, result: r0.op.result };
    if (r0.wrongNet) return { ok: false, error: 'WRONG_NETWORK', hint: '����/genesis �� ��������� � ������ � ������ ���������' };
    if (r0.mismatch) return { ok: false, error: 'BODY_MISMATCH', hint: 'изменённое summary — новая операция, прежняя бронь не используется' };
    if (r0.exists && r0.op.state === 'needs_reconcile') return { ok: false, error: 'needs_reconcile', reconcile: r0.op.reconcile };
    // alias-бронь: тот же jobId с другим текстом — не переиспользуем результат
    opSet(operationId, { state: 'sent' });
    const r = await post('/queue/done', { jobId, summary });
    if (r.netError) { opSet(operationId, { state: 'needs_reconcile', reconcile: { check: `GET /queue/history jobId=${jobId}` } }); return { ok: false, error: 'net_error', reconcile: 'needs_reconcile' }; }
    if (r.status === 200) { opSet(operationId, { state: 'acked', result: { ...r.data, legacy: true } }); return { ok: true, replay: false, result: r.data, legacy: true, risk: 'legacy без подписи; выплата отдельно в payments()' }; }
    // 404 здесь — НЕ успех: задача неизвестна/маршрут/потеря состояния.
    opSet(operationId, { state: 'needs_reconcile', reconcile: { status: r.status, body: r.data, hint: '404 ≠ успех: сверь /queue/status и /queue/history' } });
    return { ok: false, status: r.status, error: r.data?.error || 'done_failed', reconcile: 'needs_reconcile' };
  }

  async function signedMutate({ addr, action, body, operationId }) {
    let signer;
    try { signer = readSigner(); } catch (e) { return { ok: false, error: 'signer_unavailable', hint: String(e.message || e) }; }
    // Адрес из ключа сверяем с настроенным (core.mjs каноника).
    try {
      const { addressFromPub } = await import('../../core.mjs');
      const crypto2 = await import('node:crypto');
      const pubPem = signer.w.public_key_pem || signer.w.pub;
      if (pubPem) {
        const derived = addressFromPub(pubPem);
        if (derived.toLowerCase() !== String(addr).toLowerCase()) return { ok: false, error: 'ADDRESS_MISMATCH', hint: 'адрес из ключа ≠ настроенный адрес' };
        void crypto2;
      }
    } catch (e) { return { ok: false, error: 'signer_verify_failed', hint: String(e.message || e).slice(0, 160) }; }
    const net = await netId();
    if (net.genesis && !String(net.genesis).includes('unknown')) { /* сеть зафиксирована в операции */ }
    const opId = operationId || `${action}:${addr}:${bodyDigest(body)}`;
    const r0 = opReserve({ operationId: opId, action, body, signerAddress: addr, net });
    if (r0.exists && !r0.mismatch && r0.op.state === 'acked') return { ok: true, replay: true, result: r0.op.result };
    if (r0.mismatch) return { ok: false, error: 'BODY_MISMATCH' };
    if (r0.exists && r0.op.state === 'needs_reconcile') return { ok: false, error: 'needs_reconcile', reconcile: r0.op.reconcile };
    const { signAction } = await import('../../queue-auth.mjs');
    let sig;
    try { sig = signAction(signer.pem, { action, body, nonce: r0.op.nonce, expiry: r0.op.expiry }); }
    catch (e) { opSet(opId, { state: 'needs_reconcile', reconcile: { error: 'sign_failed' } }); return { ok: false, error: 'sign_failed', hint: 'ошибка дешифрования/подписи прекращает действие' }; }
    opSet(opId, { state: 'sent' });
    const fromPub = signer.w.public_key_pem || signer.w.pub || '';
    const r = await post(`/queue/signed/${action}`, { address: addr, fromPub, signature: sig.signature, action, body, nonce: r0.op.nonce, expiry: r0.op.expiry, chain: QUEUE_CHAIN });
    if (r.netError) { opSet(opId, { state: 'needs_reconcile', reconcile: { check: 'reconcile via status/history' } }); return { ok: false, error: 'net_error', reconcile: 'needs_reconcile' }; }
    if (r.status === 200) { opSet(opId, { state: 'acked', result: r.data }); return { ok: true, replay: false, result: r.data }; }
    if (r.status >= 400 && r.status < 500) {
      withJournalLock(jFile, () => { const f = loadOpFile(jFile); if (f.ops[opId]) { delete f.ops[opId]; saveOpFile(jFile, f); } });
      return { ok: false, status: r.status, error: r.data?.error || 'signed_failed' };
    }
    opSet(opId, { state: 'needs_reconcile', reconcile: { status: r.status, body: r.data } });
    return { ok: false, status: r.status, error: r.data?.error || 'signed_failed' };
  }

  // ---- Stage B: каталог и заказы (чтение публичное, мутации подписанные) ----
  async function searchOffers({ skill, maxPriceAtomic, format } = {}) {
    const q = new URLSearchParams();
    if (skill) q.set('skill', skill);
    if (maxPriceAtomic !== undefined) q.set('maxPriceAtomic', String(maxPriceAtomic));
    if (format) q.set('format', format);
    const r = await get('/catalog/offers?' + q.toString());
    return r.data;
  }
  async function signedMarket({ addr, action, body, endpoint, operationId }) {
    let signer;
    try { signer = readSigner(); } catch (e) { return { ok: false, error: 'signer_unavailable', hint: String(e.message || e) }; }
    try {
      const { addressFromPub } = await import('../../core.mjs');
      const pubPem = signer.w.public_key_pem || signer.w.pub;
      if (pubPem) {
        const derived = addressFromPub(pubPem);
        if (derived.toLowerCase() !== String(addr).toLowerCase()) return { ok: false, error: 'ADDRESS_MISMATCH', hint: 'адрес из ключа ≠ настроенный адрес' };
      }
    } catch (e) { return { ok: false, error: 'signer_verify_failed', hint: String(e.message || e).slice(0, 160) }; }
    const net = await netId();
    const opId = operationId || `${action}:${addr}:${bodyDigest(body)}`;
    const r0 = opReserve({ operationId: opId, action, body, signerAddress: addr, net });
    if (r0.wrongNet) return { ok: false, error: 'WRONG_NETWORK', hint: 'сеть/genesis не совпадают с бронью' };
    if (r0.exists && !r0.mismatch && r0.op.state === 'acked') return { ok: true, replay: true, result: r0.op.result };
    if (r0.mismatch) return { ok: false, error: 'BODY_MISMATCH' };
    if (r0.exists && r0.op.state === 'needs_reconcile') return { ok: false, error: 'needs_reconcile', reconcile: r0.op.reconcile };
    const { signAction } = await import('../../queue-auth.mjs');
    let sig;
    try { sig = signAction(signer.pem, { action, body, nonce: r0.op.nonce, expiry: r0.op.expiry }); }
    catch { opSet(opId, { state: 'needs_reconcile', reconcile: { error: 'sign_failed' } }); return { ok: false, error: 'sign_failed' }; }
    opSet(opId, { state: 'sent' });
    const fromPub = signer.w.public_key_pem || signer.w.pub || '';
    const r = await post(endpoint, { address: addr, fromPub, signature: sig.signature, action, body, nonce: r0.op.nonce, expiry: r0.op.expiry, chain: QUEUE_CHAIN });
    if (r.netError) { opSet(opId, { state: 'needs_reconcile', reconcile: { check: endpoint } }); return { ok: false, error: 'net_error', reconcile: 'needs_reconcile' }; }
    if (r.status === 200) { opSet(opId, { state: 'acked', result: r.data }); return { ok: true, replay: false, result: r.data }; }
    if (r.status >= 400 && r.status < 500) {
      // Детерминированный отказ без изменения состояния: бронь снимаем, повтор разрешён свежими данными.
      withJournalLock(jFile, () => { const f = loadOpFile(jFile); if (f.ops[opId]) { delete f.ops[opId]; saveOpFile(jFile, f); } });
      return { ok: false, status: r.status, error: r.data?.error || action + '_failed', detail: r.data };
    }
    opSet(opId, { state: 'needs_reconcile', reconcile: { status: r.status, body: r.data } });
    return { ok: false, status: r.status, error: r.data?.error || action + '_failed', detail: r.data };
  }
  const publishOffer = (addr, offer) => signedMarket({ addr, action: 'publish', body: { offer }, endpoint: '/catalog/publish', operationId: `publish:${offer.offerId}:${offer.version}` });
  const createOrder = (addr, offerId, input, idempotencyKey, offerVersion) => signedMarket({ addr, action: 'order', body: { offerId, offerVersion, input, idempotencyKey }, endpoint: '/orders/create', operationId: `order:${addr}:${offerId}:${idempotencyKey || bodyDigest({ offerId, input })}` });
  const submitArtifact = (addr, assignmentId, artifact, contentB64) => signedMarket({ addr, action: 'artifact', body: { assignmentId, artifact, content: contentB64 }, endpoint: '/orders/submit-artifact', operationId: `artifact:${assignmentId}:${artifact.artifactId}` });
  const acceptOrder = (addr, assignmentId, verdict) => signedMarket({ addr, action: 'accept', body: { assignmentId, verdict }, endpoint: '/orders/accept', operationId: `accept:${assignmentId}:${bodyDigest({ assignmentId, verdict })}` });
  async function readProof(requester, resource, id) {
    if (!requester || !walletFile) return '';
    try {
      const signer = readSigner();
      if (String(signer.w.address || '').toLowerCase() !== String(requester).toLowerCase()) {
        try {
          const { addressFromPub } = await import('../../core.mjs');
          const pub = signer.w.public_key_pem || signer.w.pub || '';
          if (pub && addressFromPub(pub).toLowerCase() !== String(requester).toLowerCase()) return '';
        } catch { return ''; }
      }
      const { signAction } = await import('../../queue-auth.mjs');
      const nonce = String(Date.now()) + '-' + crypto.randomBytes(4).toString('hex');
      const expiry = Date.now() + 5 * 60_000;
      const body = { resource: String(resource), id: String(id || ''), requester: String(requester) };
      const sig = signAction(signer.pem, { action: 'read', body, nonce, expiry });
      const q = new URLSearchParams({ requester: String(requester), fromPub: signer.w.public_key_pem || signer.w.pub || '', signature: sig.signature, nonce, expiry: String(expiry) });
      return '?' + q.toString();
    } catch { return ''; }
  }
  const getOrder = async (assignmentId, requester) => {
    let suffix = '';
    if (requester) {
      const proof = await readProof(requester, 'order', assignmentId);
      suffix = proof || ('?requester=' + encodeURIComponent(requester));
    }
    return (await get(`/orders/${assignmentId}${suffix}`)).data;
  };
  // ---- Этап C: события с курсором + api-monitor ----
  const getEvents = async ({ cursor = '0', limit = 20, requester = '' } = {}) => {
    const q = new URLSearchParams({ cursor: String(cursor), limit: String(limit) });
    if (requester) {
      const proof = await readProof(requester, 'events', String(cursor));
      if (proof) {
        const r = await get('/events?' + q.toString() + '&' + proof.slice(1));
        return { ...r.data, _status: r.status, at: Date.now() };
      }
      q.set('requester', requester);
    }
    const r = await get('/events?' + q.toString());
    return { ...r.data, _status: r.status, at: Date.now() };
  };
  const createMonitor = (addr, monitor) => signedMarket({ addr, action: 'monitor', body: { monitor }, endpoint: '/monitors/create', operationId: `monitor:${addr}:${monitor.monitorId || bodyDigest(monitor)}` });
  // Подписка (§6): тот же монитор, но обязательства сторон зафиксированы в subscription.
  const createSubscription = (addr, sub) => {
    if (!sub || typeof sub !== 'object') return Promise.resolve({ ok: false, error: 'subscription_required' });
    return createMonitor(addr, {
      monitorId: sub.serviceId,
      targetUrl: sub.targetUrl,
      provider: sub.provider,
      periodMs: sub.cadence,
      expiresAt: sub.periodEnd,
      priceAtomicPerRun: sub.priceAtomicPerRun,
      maxCostPerPeriodAtomic: sub.maxCostPerPeriodAtomic,
      maxConcurrentRuns: sub.maxConcurrentRuns || 4,
      subscription: sub,
    });
  };
  // Тик подписан: стенд принимает только подписанный mtick (иначе 401).
  // Сигнатура совместима со старой: tickMonitor(monitorId, nowMs, result[, addr]).
  // Адрес берётся из makeClient({address}) — ключ всё равно из walletFile.
  // Ответ плоский: { ok, ran, budgetPerPeriodAtomic, replay }.
  const tickMonitor = async (monitorId, nowMs, result, addrOverride) => {
    const a = addrOverride || address || process.env.AGENTCOIN_ADDRESS;
    if (!a) return { ok: false, error: 'address_required', hint: 'makeClient({address}) или 4-й аргумент' };
    const r = await signedMarket({
      addr: a,
      action: 'mtick',
      body: { monitorId, nowMs: nowMs || Date.now(), result: result || null },
      endpoint: '/monitors/tick',
      operationId: `mtick:${monitorId}:${nowMs || 'now'}`,
    });
    return r.ok ? { ok: true, replay: !!r.replay, ...(r.result || {}) } : r;
  };
  const monitorHistory = async (monitorId, requester) => {
    let suffix = '';
    if (requester) suffix = (await readProof(requester, 'monitor', monitorId)) || ('?requester=' + encodeURIComponent(requester));
    return (await get(`/monitors/${encodeURIComponent(monitorId)}/history${suffix}`)).data;
  };
  const pauseMonitor = (addr, monitorId, paused) => signedMarket({ addr, action: 'mpause', body: { monitorId, paused: !!paused }, endpoint: '/monitors/pause', operationId: `mpause:${monitorId}:${paused ? '1' : '0'}:${addr}` });
  const cancelMonitor = (addr, monitorId) => signedMarket({ addr, action: 'mcancel', body: { monitorId }, endpoint: '/monitors/cancel', operationId: `mcancel:${monitorId}:${addr}` });
  // ---- Проход 3: тестовый расчёт TEST-AGT (стенд; не эскроу, не mainnet) ----
  const faucet = async (addr, amountAtomic) => (await post('/settlements/faucet', { address: addr, amountAtomic })).data;
  const testBalance = async (addr) => (await get(`/settlements/balances?address=${encodeURIComponent(addr)}`)).data;
  const getSettlement = async (assignmentId, requester) => {
    let suffix = '';
    if (requester) suffix = (await readProof(requester, 'settlement', assignmentId)) || ('?requester=' + encodeURIComponent(requester));
    return (await get(`/settlements/${assignmentId}${suffix}`)).data;
  };
  const createSettlement = (addr, assignmentId) => signedMarket({ addr, action: 'settle', body: { assignmentId }, endpoint: '/settlements/create', operationId: `settle:${assignmentId}:${addr}` });
  const sendSettlement = (addr, assignmentId) => signedMarket({ addr, action: 'ssend', body: { assignmentId }, endpoint: '/settlements/send', operationId: `ssend:${assignmentId}:${addr}` });
  const confirmSettlement = (addr, assignmentId) => signedMarket({ addr, action: 'sconfirm', body: { assignmentId }, endpoint: '/settlements/confirm', operationId: `sconfirm:${assignmentId}:${addr}` });
  const disputeSettlement = (addr, assignmentId, reason) => signedMarket({ addr, action: 'sdispute', body: { assignmentId, reason: String(reason || '') }, endpoint: '/settlements/dispute', operationId: `sdispute:${assignmentId}:${bodyDigest({ assignmentId, reason })}` });
  const cancelSettlement = (addr, assignmentId) => signedMarket({ addr, action: 'scancel', body: { assignmentId }, endpoint: '/settlements/cancel', operationId: `scancel:${assignmentId}:${addr}` });
  // ---- Проход 4: модерация + метрики ----
  const opsMetrics = async () => (await get('/ops/metrics')).data;
  const complain = (addr, targetType, targetId, reason) => signedMarket({ addr, action: 'complain', body: { targetType, targetId, reason }, endpoint: '/moderation/complaint', operationId: `complain:${addr}:${targetId}:${bodyDigest({ targetType, targetId, reason })}` });
  const decide = (addr, complaintId, decision, reason) => signedMarket({ addr, action: 'mdecide', body: { complaintId, decision, reason }, endpoint: '/moderation/decide', operationId: `mdecide:${complaintId}:${decision}` });
  const modHistory = async (addr) => {
    const suffix = (await readProof(addr, 'moderation', 'history')) || ('?requester=' + encodeURIComponent(addr));
    return (await get(`/moderation/history${suffix}`)).data;
  };

  return { base, status, myTask, payments, join, claim, submit, capabilities, searchOffers, publishOffer, createOrder, submitArtifact, acceptOrder, getOrder, getEvents, createMonitor, createSubscription, tickMonitor, monitorHistory, pauseMonitor, cancelMonitor, faucet, testBalance, getSettlement, createSettlement, sendSettlement, confirmSettlement, disputeSettlement, cancelSettlement, opsMetrics, complain, decide, modHistory, _journalFile: jFile };
}

export function shortAddr(a) { return String(a || '').slice(0, 10) + '…'; }
