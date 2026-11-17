/* queue-v2-isolated — приёмка QUEUE-V2-SPEC (изолированно; рабочая очередь НЕ тронута).
   Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentQueue } from '../queue.mjs';
import { signAction, verifyActionSig, makeNonceStore } from '../queue-auth.mjs';
import { addressFromPub } from '../core.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const T0 = Date.now();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-q2-'));
const q = new AgentQueue(dir);
q.state.v2.readyEnforced = true;

const A = 'AGTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'AGTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// --- 1. auth ---
const kp = crypto.generateKeyPairSync('ed25519');
const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = kp.publicKey.export({ type: 'spki', format: 'pem' });
const ADDR = addressFromPub(pub);
const base = { action: 'claim', body: { taker: ADDR }, nonce: 'n1', expiry: T0 + 60000 };
const s = signAction(priv, base);
eq(verifyActionSig({ address: ADDR, fromPub: pub, signature: s.signature, ...base, now: T0 }).ok, true, 'auth: верная подпись');
const pub2 = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
eq(verifyActionSig({ address: ADDR, fromPub: pub2, signature: s.signature, ...base, now: T0 }).error, 'AUTH_ADDRESS_MISMATCH', 'auth: чужой ключ');
eq(verifyActionSig({ address: ADDR, fromPub: pub, signature: s.signature, ...base, chain: 'OTHER', now: T0 }).error, 'AUTH_WRONG_CHAIN', 'auth: чужая сеть');
eq(verifyActionSig({ address: ADDR, fromPub: pub, signature: s.signature, ...base, expiry: T0 - 1, now: T0 }).error, 'AUTH_EXPIRED', 'auth: просрочка');
const ns = makeNonceStore(path.join(dir, 'nonces.json'));
eq(ns.use('n1', base.expiry), true, 'nonce: первое использование');
eq(ns.use('n1', base.expiry), false, 'nonce: повтор отклонён');
eq(makeNonceStore(path.join(dir, 'nonces.json')).use('n1', base.expiry), false, 'nonce: переживает рестарт');

// --- 2. readiness gate ---
q.join(A); q.join(B);
eq(q.claim2(A, { now: T0 }).error, 'READINESS_EXPIRED', 'голова без ready: отказ');
eq(q.ready(A, { now: T0 }).position, 1, 'ready: позиция головы');
const cA = q.claim2(A, { now: T0 });
eq(cA.ok, true, 'готовая голова: назначение');
eq(typeof cA.jobId, 'string', 'есть jobId');
eq(q.claim2(B, { now: T0 }).error, 'READINESS_EXPIRED', 'новая голова без ready: отказ');
eq(q.claim2(A, { now: T0 }).jobId, cA.jobId, 'повтор: то же назначение');
eq(q.claim2(A, { now: T0 }).repeat, true, 'повтор: флаг');

// --- 3. confirm-окно ---
eq(q.confirm(cA.jobId, B).error, 'NOT_YOUR_JOB', 'confirm чужого: отказ');
eq(q.confirm(cA.jobId, A).ok, true, 'confirm свой: ok');
const cB = (q.ready(B, { now: T0 }), q.claim2(B, { now: T0 }));
eq(cB.ok, true, 'B назначено');
const sw1 = q.sweepExpiries(T0 + q.V2.confirmWindow + 1);
eq(sw1.length, 1, 'sweep: одно истекшее confirm-окно');
eq(sw1[0][1], 'expired-unconfirmed', 'sweep: причина');
eq(q.submit(cB.jobId, B, 'поздно', { now: T0 + q.V2.confirmWindow + 2 }).error, 'ALREADY_EXPIRED-UNCONFIRMED', 'submit после истечения confirm: отказ');

// --- 4. submit вовремя замораживает; sweep submitted не трогает ---
eq(q.submit(cA.jobId, A, 'сделано вовремя, отчёт достаточной длины', { now: T0 + 1000 }).late, false, 'submit вовремя');
const sw2 = q.sweepExpiries(T0 + q.V2.execTtl + q.V2.lateGrace + 999999);
eq(sw2.find(([j]) => j === cA.jobId), undefined, 'sweep: сданное не истекает (задержка проверяющего не вредит)');

// --- 5. поздняя сдача в grace + после grace ---
const C = 'AGTCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
q.join(C); q.ready(C, { now: T0 });
const cC = q.claim2(C, { now: T0 });
q.confirm(cC.jobId, C);
eq(q.submit(cC.jobId, C, 'чуть опоздал', { now: T0 + q.V2.execTtl + 1000 }).late, true, 'submit в grace: late=true');
const D = 'AGTDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
q.join(D); q.ready(D, { now: T0 });
const cD = q.claim2(D, { now: T0 });
q.confirm(cD.jobId, D);
eq(q.submit(cD.jobId, D, 'сильно опоздал', { now: T0 + q.V2.execTtl + q.V2.lateGrace + 1 }).error, 'JOB_EXPIRED', 'submit после grace: истекло');
eq(q.submit(cD.jobId, D, 'ещё раз', { now: T0 + q.V2.execTtl + q.V2.lateGrace + 2 }).error, 'ALREADY_EXPIRED-UNSUBMITTED', 'повторный submit: тот же исход');

// --- 6. продление: один раз, до истечения ---
const E = 'AGTEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
q.join(E); q.ready(E, { now: T0 });
const cE = q.claim2(E, { now: T0 });
q.confirm(cE.jobId, E);
const rn = q.renew(cE.jobId, E, 'нужен день', { now: T0 + 1000 });
eq(rn.ok, true, 'renew: ok');
eq(rn.executeBy > T0 + q.V2.execTtl, true, 'renew: срок продлён');
eq(q.renew(cE.jobId, E, 'ещё', { now: T0 + 2000 }).error, 'RENEW_ONLY_ONCE', 'renew: второй раз отказ');
const F = 'AGTFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
q.join(F); q.ready(F, { now: T0 });
const cF = q.claim2(F, { now: T0 });
q.confirm(cF.jobId, F);
eq(q.renew(cF.jobId, F, 'поздно', { now: T0 + q.V2.execTtl + 1 }).error, 'ALREADY_EXPIRED', 'renew после истечения: отказ');

// --- 7. standby: просрочка готовности выводит из активной очереди ---
const H = 'AGTHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH';
q.join(H);
eq(q.sweepReadiness(T0 + q.V2.readyTtl + 1).includes(H), true, 'sweepReadiness: H в standby');
eq(q.state.waiting.includes(H), false, 'standby не блокирует очередь');
eq(q.ready(H, { now: T0 + q.V2.readyTtl + 2 }).position, q.state.waiting.length, 'возврат только в хвост');
eq(q.isReady(H, T0 + q.V2.readyTtl + 2), true, 'готовность действует');
// чтение не продлевает: позиция/статус — чистые геттеры без записи
const rBefore = q.state.readiness[H];
q.status(); q.isReady(H, T0 + q.V2.readyTtl + 3);
eq(q.state.readiness[H], rBefore, 'GET не продлевает готовность');

// --- 8. обязательства выплаты ---
const ob1 = q.obligationFor(cA.jobId, A, '2000000000');
eq(ob1.status, 'created', 'obligation: created');
eq(q.obligationFor(cA.jobId, A, '2000000000').repeat, true, 'obligation: идемпотентно');
eq(q.payoutDecision(cA.jobId).action, 'create', 'payout: решение create');
q.obligationSent(ob1.obId, 'txAAA');
eq(q.payoutDecision(cA.jobId).action, 'resend-same-txid-only', 'payout: отправлено, но нет в цепи — только повтор того же txid');
eq(q.payoutDecision(cA.jobId, new Set(['txAAA'])).action, 'adopt', 'payout: txid в цепи — только дописать');
eq(q.obligationSent(ob1.obId, 'txBBB').error, 'OB_ALREADY_SENT', 'payout: вторая отправка запрещена');
q.obligationSettled(ob1.obId);
eq(q.obligationSettled(ob1.obId).repeat, true, 'payout: повторный settle идемпотентен');
eq(q.payoutDecision(cA.jobId).action, 'skip', 'payout: исполнено — пропуск');

// --- 9. legacy grandfathered: без meta дедлайнов нет ---
q.state.onDuty.legacy1 = A;
delete q.state.meta.legacy1;
eq(q.confirm('legacy1', A).legacy, true, 'legacy confirm: мимо дедлайнов');
eq(q.submit('legacy1', A, 'x', { now: T0 + 10 ** 12 }).legacy, true, 'legacy submit: истечения нет');
delete q.state.onDuty.legacy1; q.save();
const sw3 = q.sweepExpiries(T0 + 10 ** 13);
eq(sw3.find(([j]) => j === 'legacy1'), undefined, 'sweep: legacy не тронут');
eq(sw3.length, 2, 'sweep: неподанные cE/cF истекли');

// --- 10. рестарт: новые поля целы ---
const q2 = new AgentQueue(dir);
eq(q2.state.waiting.includes(H), true, 'рестарт: waiting цело');
eq(Object.keys(q2.state.onDuty).length, Object.keys(q.state.onDuty).length, 'рестарт: onDuty цело');
eq(JSON.stringify(q2.state.meta[cA.jobId]), JSON.stringify(q.state.meta[cA.jobId]), 'рестарт: meta цело');
eq(JSON.stringify(q2.state.obligations), JSON.stringify(q.state.obligations), 'рестарт: obligations целы');
eq(q2.state.v2.readyEnforced, true, 'рестарт: флаг v2 цел');

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('queue-v2-isolated: ALL GREEN');
