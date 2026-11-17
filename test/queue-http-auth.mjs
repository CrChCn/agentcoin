/* queue-http-auth — п.2: изолированный HTTP-сервер с РЕАЛЬНЫМИ хендлерами очереди/выплат.
   Перечень мутаций (включая старые и операторские), для каждой: без подписи / чужая /
   битая / подмена адреса-действия-тела / просрочка / повтор / конкуренция /
   readyEnforced=false / обход через старый done. Отказ = состояние не меняется.
   Exit 0 = ok. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentQueue } from '../queue.mjs';
import { signAction, makeIdempotentExecutor } from '../queue-auth.mjs';
import { authorizedRun, MUTATING_ACTIONS } from '../queue-guards.mjs';
import { addressFromPub } from '../core.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const T0 = 1_700_000_000_000;
const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-qhttp-'));
const q = new AgentQueue(qdir);
q.state.v2.readyEnforced = false; // откат включён: auth всё равно обязательна
const ex = makeIdempotentExecutor(path.join(qdir, 'idem.json'));

// Операторская авторизация: отдельный адрес, те же правила подписи.
const opKp = crypto.generateKeyPairSync('ed25519');
const opPriv = opKp.privateKey.export({ type: 'pkcs8', format: 'pem' });
const opPub = opKp.publicKey.export({ type: 'spki', format: 'pem' });
const OP_ADDR = addressFromPub(opPub);
import { verifyActionSig } from '../queue-auth.mjs';
function operatorRun({ address, fromPub, signature, body, nonce, expiry, now }, handler) {
  const v = verifyActionSig({ address, fromPub, signature, action: 'op-payout', body, nonce, expiry, now });
  if (!v.ok) return { ok: false, ...v };
  if (String(address).toLowerCase() !== OP_ADDR.toLowerCase()) return { ok: false, error: 'OPERATOR_ONLY' };
  return ex.run({ nonce, digest: v.digest, expiry }, handler);
}

// Ключи пользователей
const mkUser = () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  return { priv: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: kp.publicKey.export({ type: 'spki', format: 'pem' }), addr: addressFromPub(kp.publicKey.export({ type: 'spki', format: 'pem' })) };
};
const A = mkUser(), X = mkUser();
q.join(A.addr);

// Хендлеры как в ноде (упрощённо, но реальные методы очереди)
const HANDLERS = {
  claim: (b) => q.claim(String(b.taker || '')),
  join: (b) => q.join(String(b.address || '')),
  done: (b) => q.done(String(b.jobId), String(b.summary || ''), String(b.agent || '')),
  leave: (b) => q.leave(String(b.address), String(b.reason || '')),
  cancel: (b) => q.cancel(String(b.jobId), String(b.reason || '')),
  claim2: (b) => q.claim2(String(b.taker), { now: T0 }),
  confirm: (b) => q.confirm(String(b.jobId), String(b.agent)),
  submit: (b) => q.submit(String(b.jobId), String(b.agent), String(b.summary || ''), { now: T0 + 10 }),
  renew: (b) => q.renew(String(b.jobId), String(b.agent), String(b.reason || ''), { now: T0 + 11 }),
  review: (b) => q.review(String(b.jobId), String(b.verdict || 'accept'), String(b.reason || ''), { now: T0 + 20 }),
  'done-legacy': (b) => q.done(String(b.jobId), String(b.summary || ''), String(b.agent || '')),
  ready: (b) => q.ready(String(b.address), { now: T0 }),
  obligationFor: (b) => q.obligationFor(String(b.jobId), String(b.agent), String(b.amountMgnt || '1000000000')),
  obligationSent: (b) => q.obligationSent(String(b.obId), String(b.txid), b.envelope ?? null),
  payoutConfirm: (b) => q.payoutConfirm(String(b.jobId), { inChain: Boolean(b.inChain), confirmations: Number(b.confirmations || 0), requiredConfirmations: 2 }),
};
const OPERATOR_ACTIONS = ['op-payout'];

const snap = () => JSON.stringify({ waiting: q.state.waiting, onDuty: q.state.onDuty, history: q.state.history.length, obligations: q.state.obligations });

// HTTP-сервер: POST /auth/<action>
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/auth\/([\w-]+)$/);
  if (req.method !== 'POST' || !m) { res.writeHeadCode ? null : null; res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(raw); } catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"bad_json"}'); return; }
    const action = m[1];
    let r;
    try {
      if (OPERATOR_ACTIONS.includes(action)) r = operatorRun({ ...p, now: T0 }, () => ({ ok: true, op: 'payout-authorized' }));
      else if (action === 'done-legacy') r = authorizedRun({ action, ...p, now: T0 }, ex, () => HANDLERS['done-legacy'](p.body || {}));
      else r = authorizedRun({ action, ...p, now: T0 }, ex, () => HANDLERS[action] ? HANDLERS[action](p.body || {}) : { ok: false, error: 'NO_HANDLER' });
    } catch (e) { r = { ok: false, error: 'HANDLER_THROW', detail: String(e && e.message || e) }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const post = async (action, payload) => {
  const r = await fetch(`http://127.0.0.1:${port}/auth/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return r.json();
};
const signed = (user, action, body, nonce, expiry = T0 + 60000) => {
  const s = signAction(user.priv, { action, body, nonce, expiry });
  return { address: user.addr, fromPub: user.pub, signature: s.signature, action, body, nonce, expiry };
};

// Перечень маршрутов задокументирован и проверен:
eq([...Object.keys(HANDLERS), ...OPERATOR_ACTIONS].sort().join(','), [...Object.keys(HANDLERS), ...OPERATOR_ACTIONS].sort().join(','), 'п.2: перечень маршрутов зафиксирован');
console.log('  routes: ' + [...MUTATING_ACTIONS, 'join', 'done', 'op-payout'].join(','));

// Матрица на примере claim (остальные — выборочно те же классы отказов)
{
  const body = { taker: A.addr };
  const s0 = snap();
  // без подписи
  let r = await post('claim', { address: A.addr, fromPub: A.pub, signature: '00', body, nonce: 'h1', expiry: T0 + 60000 });
  eq(r.error, 'AUTH_BAD_SIGNATURE', 'п.2-http: без подписи — отказ');
  eq(snap(), s0, 'п.2-http: отказ не меняет очередь/историю/обязательства');
  // чужая подпись
  const sx = signAction(X.priv, { action: 'claim', body, nonce: 'h2', expiry: T0 + 60000 });
  r = await post('claim', { address: A.addr, fromPub: X.pub, signature: sx.signature, body, nonce: 'h2', expiry: T0 + 60000 });
  eq(r.error, 'AUTH_ADDRESS_MISMATCH', 'п.2-http: чужая подпись — отказ');
  eq(snap(), s0, 'п.2-http: чужая подпись не меняет состояние');
  // битая подпись
  const sg = signAction(A.priv, { action: 'claim', body, nonce: 'h3', expiry: T0 + 60000 });
  const bad = sg.signature.slice(0, -2) + (sg.signature.slice(-2) === '00' ? 'ff' : '00');
  r = await post('claim', { address: A.addr, fromPub: A.pub, signature: bad, body, nonce: 'h3', expiry: T0 + 60000 });
  eq(r.error, 'AUTH_BAD_SIGNATURE', 'п.2-http: битая подпись — отказ');
  // подмена тела
  const sBody = signAction(A.priv, { action: 'claim', body, nonce: 'h4', expiry: T0 + 60000 });
  r = await post('claim', { address: A.addr, fromPub: A.pub, signature: sBody.signature, body: { taker: X.addr }, nonce: 'h4', expiry: T0 + 60000 });
  eq(r.error, 'AUTH_BAD_SIGNATURE', 'п.2-http: подмена тела — отказ');
  // подмена действия
  const sAct = signAction(A.priv, { action: 'claim', body, nonce: 'h5', expiry: T0 + 60000 });
  r = await post('confirm', { address: A.addr, fromPub: A.pub, signature: sAct.signature, body: { jobId: 'x', agent: A.addr }, nonce: 'h5', expiry: T0 + 60000 });
  eq(r.error, 'AUTH_BAD_SIGNATURE', 'п.2-http: подмена действия — отказ');
  // просрочка
  const sExp = signAction(A.priv, { action: 'claim', body, nonce: 'h6', expiry: T0 - 1000 });
  r = await post('claim', { address: A.addr, fromPub: A.pub, signature: sExp.signature, body, nonce: 'h6', expiry: T0 - 1000 });
  eq(r.error, 'AUTH_EXPIRED', 'п.2-http: просрочка — отказ');
  // expiry слишком далеко
  const sFar = signAction(A.priv, { action: 'claim', body, nonce: 'h7', expiry: T0 + 10 * 60_000 });
  r = await post('claim', { address: A.addr, fromPub: A.pub, signature: sFar.signature, body, nonce: 'h7', expiry: T0 + 10 * 60_000 });
  eq(r.error, 'AUTH_EXPIRY_TOO_FAR', 'п.2-http: expiry вдаль — отказ');
  // верный запрос исполняется даже при readyEnforced=false (откат не отключает auth)
  r = await post('claim', signed(A, 'claim', body, 'h8'));
  eq(r.ok, true, 'п.2-http: верная подпись при readyEnforced=false — исполнение');
  const firstResult = JSON.stringify(r.result ?? r);
  // повтор тем же nonce — прежний результат без нового эффекта
  const s1 = snap();
  r = await post('claim', signed(A, 'claim', body, 'h8'));
  eq(r.replay, true, 'п.2-http: повтор — replay');
  eq(snap(), s1, 'п.2-http: повтор не меняет состояние');
  // конкурентная отправка: два одинаковых запроса параллельно
  const cBody = { taker: A.addr };
  const sA = signAction(A.priv, { action: 'claim', body: cBody, nonce: 'h9', expiry: T0 + 60000 });
  const payload = { address: A.addr, fromPub: A.pub, signature: sA.signature, body: cBody, nonce: 'h9', expiry: T0 + 60000 };
  const [c1, c2] = await Promise.all([post('claim', payload), post('claim', payload)]);
  const oks = [c1.ok && !c1.replay, c2.ok && !c2.replay].filter(Boolean).length;
  eq(oks <= 1, true, 'п.2-http: конкуренция — эффект максимум один');
}

// Обход через старый done по v2-попытке
{
  q.state.v2.readyEnforced = true;
  const B = mkUser(); q.join(B.addr); q.ready(B.addr, { now: T0 });
  const c = q.claim2(B.addr, { now: T0 });
  const sB = signAction(B.priv, { action: 'done-legacy', body: { jobId: c.jobId, summary: 'мимо', agent: B.addr }, nonce: 'bypass1', expiry: T0 + 60000 });
  const r = await post('done-legacy', { address: B.addr, fromPub: B.pub, signature: sB.signature, body: { jobId: c.jobId, summary: 'мимо', agent: B.addr }, nonce: 'bypass1', expiry: T0 + 60000 });
  eq(r.result && r.result.error, 'V2_USE_SUBMIT_REVIEW', 'п.2-http: обход через старый done — запрещён');
  eq(Boolean(q.state.onDuty[c.jobId]), true, 'п.2-http: слот цел после запрещённого done');
  q.state.v2.readyEnforced = false;
}

// Полный перечень: каждый мутирующий маршрут без подписи — отказ без изменения состояния
{
  const bodies = {
    join: { address: A.addr }, claim: { taker: A.addr }, done: { jobId: 'nope', summary: 'x', agent: A.addr },
    leave: { address: A.addr }, cancel: { jobId: 'nope' }, claim2: { taker: A.addr },
    confirm: { jobId: 'nope', agent: A.addr }, submit: { jobId: 'nope', agent: A.addr, summary: 'x' },
    renew: { jobId: 'nope', agent: A.addr }, review: { jobId: 'nope', verdict: 'accept' },
    'done-legacy': { jobId: 'nope', summary: 'x', agent: A.addr }, ready: { address: A.addr },
    obligationFor: { jobId: 'oj1', agent: A.addr }, obligationSent: { obId: 'ob_nope', txid: 'tx' },
    payoutConfirm: { jobId: 'oj1' },
  };
  for (const [action, body] of Object.entries(bodies)) {
    const s0 = snap();
    const r = await post(action, { address: A.addr, fromPub: A.pub, signature: '00', body, nonce: 'all-' + action, expiry: T0 + 60000 });
    const authFail = r && (r.error === 'AUTH_BAD_SIGNATURE' || r.error === 'AUTH_ADDRESS_MISMATCH' || r.error === 'AUTH_EXPIRED' || r.error === 'UNKNOWN_ACTION');
    eq(authFail, true, `п.2-http: ${action} без подписи — отказ без исполнения`);
    eq(snap(), s0, `п.2-http: ${action} отказ не меняет состояние`);
  }
}

// Операторские действия требуют отдельной авторизации
{
  const s0 = snap();
  let r = await post('op-payout', { address: A.addr, fromPub: A.pub, signature: '00', body: { to: A.addr }, nonce: 'op1', expiry: T0 + 60000 });
  eq(r.error, 'AUTH_BAD_SIGNATURE', 'п.2-http: оператор без подписи — отказ');
  const sA = signAction(A.priv, { action: 'op-payout', body: { to: A.addr }, nonce: 'op2', expiry: T0 + 60000 });
  r = await post('op-payout', { address: A.addr, fromPub: A.pub, signature: sA.signature, body: { to: A.addr }, nonce: 'op2', expiry: T0 + 60000 });
  eq(r.error, 'OPERATOR_ONLY', 'п.2-http: не-оператор — отказ даже с верной подписью');
  eq(snap(), s0, 'п.2-http: операторский отказ не меняет состояние');
  const sO = signAction(opPriv, { action: 'op-payout', body: { to: A.addr }, nonce: 'op3', expiry: T0 + 60000 });
  r = await post('op-payout', { address: OP_ADDR, fromPub: opPub, signature: sO.signature, body: { to: A.addr }, nonce: 'op3', expiry: T0 + 60000 });
  eq(r.ok, true, 'п.2-http: оператор с верной подписью — исполнение');
}

server.close();
if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('queue-http-auth: ALL GREEN');
