/* queue-atomic-auth — п.1–3 приёмки (изолированно). Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentQueue } from '../queue.mjs';
import { signAction, verifyActionSig, actionDigest, makeIdempotentExecutor } from '../queue-auth.mjs';
import { authorizedRun } from '../queue-guards.mjs';
import { addressFromPub } from '../core.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const T0 = 1_700_000_000_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-qa-'));

// ---------- п.1: атомарность nonce+действие, падение между эффектом и записью ----------
{
  const ex = makeIdempotentExecutor(path.join(dir, 'idem1.json'));
  const d = actionDigest({ action: 'claim', body: { taker: 'A' }, nonce: 'crash-1', expiry: T0 + 60000 });
  // reserve как при штатном входе:
  eq(ex.begin({ nonce: 'crash-1', digest: d, expiry: T0 + 60000 }).reserved, true, 'п.1: reserve до эффекта');
  // конкурент во время исполнения — без повторного эффекта:
  eq(ex.begin({ nonce: 'crash-1', digest: d, expiry: T0 + 60000 }).error, 'NONCE_PENDING_RETRY', 'п.1: конкурент видит pending, эффекта нет');
  // ИМИТАЦИЯ ПАДЕНИЯ: процесс убит после мутации очереди, до commit.
  // Перезапуск: новый экземпляр на том же файле видит pending и НЕ переисполняет:
  const exR = makeIdempotentExecutor(path.join(dir, 'idem1.json'));
  eq(exR.pendingList().includes('crash-1'), true, 'п.1: после рестарта pending сохранён');
  eq(exR.begin({ nonce: 'crash-1', digest: d, expiry: T0 + 60000 }).error, 'NONCE_PENDING_RETRY', 'п.1: повтор после падения — не переисполнение, а reconcile');
  // reconcile: фактическое состояние показало, что эффект НЕ успел — abort и только потом повтор разрешён как новый nonce;
  // если эффект успел — resolve с фактическим результатом.
  eq(exR.resolvePending('crash-1', { status: 'aborted' }).aborted, true, 'п.1: reconcile abort снимает бронь');
  eq(exR.begin({ nonce: 'crash-1', digest: d, expiry: T0 + 60000 }).reserved, true, 'п.1: после abort резерв возможен заново');
  exR.commit('crash-1', { jobId: 'recovered' });
  const exR2 = makeIdempotentExecutor(path.join(dir, 'idem1.json'));
  eq(exR2.begin({ nonce: 'crash-1', digest: d, expiry: T0 + 60000 }).replay, true, 'п.1: после commit — replay с результатом');
  // чужое тело тем же nonce — отказ даже в pending/done:
  const dOther = actionDigest({ action: 'claim', body: { taker: 'B' }, nonce: 'crash-1', expiry: T0 + 60000 });
  eq(exR2.begin({ nonce: 'crash-1', digest: dOther, expiry: T0 + 60000 }).error, 'NONCE_BODY_MISMATCH', 'п.1: чужое тело — mismatch');
  // конкурентный шторм: N попыток run() — эффект ровно один (однопоточно, но через begin-гонку):
  const exC = makeIdempotentExecutor(path.join(dir, 'idemC.json'));
  let calls = 0;
  const dC = actionDigest({ action: 'submit', body: { j: '1' }, nonce: 'storm', expiry: T0 + 60000 });
  for (let i = 0; i < 20; i++) exC.run({ nonce: 'storm', digest: dC, expiry: T0 + 60000 }, () => { calls++; return { n: 1 }; });
  eq(calls, 1, 'п.1: 20 повторов — эффект один');
}

// ---------- п.2: откат не отключает авторизацию; done не обходит v2 ----------
{
  const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-qrb-'));
  const q = new AgentQueue(qdir);
  q.state.v2.readyEnforced = false; // откат: readiness выключена
  const kp = crypto.generateKeyPairSync('ed25519');
  const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = kp.publicKey.export({ type: 'spki', format: 'pem' });
  const ADDR = addressFromPub(pub);
  const kpX = crypto.generateKeyPairSync('ed25519');
  const pubX = kpX.publicKey.export({ type: 'spki', format: 'pem' });
  const ex = makeIdempotentExecutor(path.join(qdir, 'idem.json'));
  // claim без подписи — отказ guard:
  eq(authorizedRun({ action: 'claim', address: ADDR, fromPub: pub, signature: '00', body: { taker: ADDR }, nonce: 'a1', expiry: T0 + 60000, now: T0 }, ex, () => q.claim2(ADDR)).error, 'AUTH_BAD_SIGNATURE', 'п.2: чужой/битый подпись — отказ без исполнения');
  // чужая подпись под чужой адрес — отказ:
  const sX = signAction(kpX.privateKey.export({ type: 'pkcs8', format: 'pem' }), { action: 'claim', body: { taker: ADDR }, nonce: 'a2', expiry: T0 + 60000 });
  eq(authorizedRun({ action: 'claim', address: ADDR, fromPub: pubX, signature: sX.signature, body: { taker: ADDR }, nonce: 'a2', expiry: T0 + 60000, now: T0 }, ex, () => q.claim2(ADDR)).error, 'AUTH_ADDRESS_MISMATCH', 'п.2: адрес/ключ mismatch — отказ');
  // верная подпись — исполнение даже при readyEnforced=false (auth не отключена):
  q.join(ADDR);
  const s = signAction(priv, { action: 'claim', body: { taker: ADDR }, nonce: 'a3', expiry: T0 + 60000 });
  const r = authorizedRun({ action: 'claim', address: ADDR, fromPub: pub, signature: s.signature, body: { taker: ADDR }, nonce: 'a3', expiry: T0 + 60000, now: T0 }, ex, () => q.claim2(ADDR, { now: T0 }));
  eq(r.ok, true, 'п.2: верная подпись исполняется при откате readiness');
  eq(typeof r.result.jobId, 'string', 'п.2: назначение выдано через guard');
  // replay того же nonce — тот же результат без нового эффекта:
  const r2 = authorizedRun({ action: 'claim', address: ADDR, fromPub: pub, signature: s.signature, body: { taker: ADDR }, nonce: 'a3', expiry: T0 + 60000, now: T0 }, ex, () => { throw new Error('must-not-run'); });
  eq(r2.replay, true, 'п.2: replay без исполнения');
  // старый done по v2-попытке — запрещён (обход submit→review закрыт):
  eq(q.done(r.result.jobId, 'мимо ревью', ADDR).error, 'V2_USE_SUBMIT_REVIEW', 'п.2: done по v2 без review — отказ');
  eq(Boolean(q.state.onDuty[r.result.jobId]), true, 'п.2: слот цел после запрещённого done');
  // legacy done по-прежнему работает (откат совместим):
  q.state.onDuty.legacy9 = ADDR;
  eq(q.done('legacy9', 'старое', ADDR).ok, true, 'п.2: legacy done работает');
}

// ---------- п.3: повтор теми же байтами; реорг после settled ----------
{
  const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-qpay-'));
  const q = new AgentQueue(qdir);
  q.state.v2.readyEnforced = true;
  const A = 'AGTQ' + '9'.repeat(36);
  q.join(A); q.ready(A, { now: T0 });
  const c = q.claim2(A, { now: T0 }); q.confirm(c.jobId, A);
  q.submit(c.jobId, A, 'ok', { now: T0 + 10 }); q.review(c.jobId, 'accept', 'ok', { now: T0 + 20 });
  const ob = q.obligationFor(c.jobId, A, '2000000000');
  const envelope = { from: 'vault', to: A, amount: 2, nonce: 1, sig: 'deadbeef'.repeat(8), txid: 'txBYTES' };
  q.obligationSent(ob.obId, 'txBYTES', envelope);
  // повтор — теми же байтами:
  const rb = q.payoutResendBytes(c.jobId);
  eq(rb.ok, true, 'п.3: resend возвращает байты');
  eq(JSON.stringify(rb.envelope), JSON.stringify(envelope), 'п.3: байты идентичны исходным');
  // settled только при цепи + K:
  eq(q.payoutConfirm(c.jobId, { inChain: true, confirmations: 1, requiredConfirmations: 2 }).error, 'NOT_ENOUGH_CONFIRMATIONS', 'п.3: 1 < K — не settled');
  eq(q.payoutConfirm(c.jobId, { inChain: true, confirmations: 2, requiredConfirmations: 2 }).ok, true, 'п.3: цепь + K — settled');
  // реорг выбил выплату: стоп, дефицит, ручное урегулирование, не автокансел:
  const rg = q.payoutConfirm(c.jobId, { inChain: false });
  eq(rg.error, 'PAYOUT_REORGED', 'п.3: реорг после settled — стоп');
  eq(q.state.obligations[c.jobId].status, 'reorged-needs-review', 'п.3: статус требует ручного разбора');
  eq(q.payoutDecision(c.jobId).action, 'stop-and-review', 'п.3: решение — stop-and-review, не create/skip');
}

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('queue-atomic-auth: ALL GREEN');
