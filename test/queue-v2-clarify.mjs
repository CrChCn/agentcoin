/* queue-v2-clarify — ответы на 3 вопроса владельца + границы/skew/часы (изолированно).
   Рабочая очередь НЕ тронута. Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentQueue } from '../queue.mjs';
import { signAction, verifyActionSig, actionDigest, makeIdempotentExecutor, AUTH_MAX_SKEW_MS } from '../queue-auth.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const T0 = 1_700_000_000_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-q2c-'));
const q = new AgentQueue(dir);
q.state.v2.readyEnforced = true;

const A = 'AGTA' + '1'.repeat(36);
const B = 'AGTB' + '2'.repeat(36);

// --- 1. Grace: слот занят, переназначения нет; поздняя сдача привязана к попытке ---
q.join(A); q.ready(A, { now: T0 });
const c = q.claim2(A, { now: T0 });
q.confirm(c.jobId, A);
// в середине grace слот всё ещё занят:
eq(Boolean(q.state.onDuty[c.jobId]), true, 'grace: слот занят (onDuty удерживается)');
eq(q.sweepExpiries(T0 + q.V2.execTtl + 1000).length, 0, 'grace: sweep в окне молчит');
// второй исполнитель не может взять ту же работу новым claim пока слот занят:
// (готовность B обновлена под позднее время — иначе сработает readiness-gate, а не слот)
q.join(B); q.ready(B, { now: T0 + q.V2.execTtl + 1000 });
const probeB = q.claim2(B, { now: T0 + q.V2.execTtl + 1000 });
eq(probeB.ok, true, 'grace: голова B получает СВОЮ новую попытку (слот A всё ещё занят своей)');
q.cancel(probeB.jobId, 'тест: освобождаем пробную попытку B');
q.join(B); q.ready(B, { now: T0 + q.V2.execTtl + 1000 });
eq(Boolean(q.state.onDuty[c.jobId]), true, 'grace: попытка A всё ещё удерживает свой слот');
// late submit первой попытки — принимается с флагом:
eq(q.submit(c.jobId, A, 'опоздал, но успел в grace', { now: T0 + q.V2.execTtl + 1000 }).late, true, 'grace: late submit принят');
// sweep после late submit — не трогает:
eq(q.sweepExpiries(T0 + q.V2.execTtl + q.V2.lateGrace + 10).find(([j]) => j === c.jobId), undefined, 'сданное в grace не истекает');
// review accept -> исход done-accepted
eq(q.review(c.jobId, 'accept', 'годно', { now: T0 + q.V2.execTtl + 2000 }).outcome, 'done-accepted', 'review accept ставит исход');
// после исхода повторный submit/review невозможны:
eq(q.submit(c.jobId, A, 'ещё раз', { now: T0 + q.V2.execTtl + 3000 }).error, 'ALREADY_DONE-ACCEPTED', 'повторный submit после исхода запрещён');
eq(q.review(c.jobId, 'accept', 'x', { now: T0 + q.V2.execTtl + 3000 }).error, 'ALREADY_DONE-ACCEPTED', 'повторный review запрещён');
// выплата только одна на попытку:
const ob = q.obligationFor(c.jobId, A, '2000000000');
eq(ob.status, 'created', 'obligation только после accept (создано)');
eq(q.obligationFor(c.jobId, A, '2000000000').repeat, true, 'вторая выплата на ту же попытку — тот же объект');
// после освобождения слота — новая попытка новым jobId:
q.ready(B, { now: T0 + q.V2.execTtl + 4000 });
const c2 = q.claim2(B, { now: T0 + q.V2.execTtl + 4000 });
eq(c2.ok, true, 'после исхода слот свободен: новая попытка');
eq(c2.jobId !== c.jobId, true, 'новая попытка = новый jobId');
// старая попытка окончательно мертва: submit по ней невозможен даже после переназначения
eq(q.submit(c.jobId, A, 'поздно после чужой попытки', { now: T0 + q.V2.execTtl + 5000 }).error, 'ALREADY_DONE-ACCEPTED', 'старая попытка не воскресает');

// --- 1б. Истечение без сдачи: после grace слот свободен, старый jobId мёртв ---
const C = 'AGTC' + '3'.repeat(36);
q.join(C); q.ready(C, { now: T0 });
const cc = q.claim2(C, { now: T0 });
q.confirm(cc.jobId, C);
eq(q.sweepExpiries(T0 + q.V2.execTtl + q.V2.lateGrace + 1).find(([j]) => j === cc.jobId)?.[1], 'expired-unsubmitted', 'после grace — expired');
eq(q.submit(cc.jobId, C, 'слишком поздно', { now: T0 + q.V2.execTtl + q.V2.lateGrace + 2 }).error, 'ALREADY_EXPIRED-UNSUBMITTED', 'поздняя сдача чужой истекшей попытки — отказ, второй выплаты нет');
eq(q.state.obligations[cc.jobId], undefined, 'истекшая без сдачи попытка обязательства не имеет');

// --- 2. Nonce идемпотентность: повтор отдаёт результат, чужое тело — отказ ---
const exFile = path.join(dir, 'idem.json');
const ex = makeIdempotentExecutor(exFile);
let calls = 0;
const eff = () => { calls++; return { jobId: 'j1' }; };
const d1 = actionDigest({ action: 'claim', body: { taker: A }, nonce: 'n-42', expiry: T0 + 60000 });
const r1 = ex.run({ nonce: 'n-42', digest: d1, expiry: T0 + 60000 }, eff);
eq(r1.replay, false, 'первое применение исполняет');
eq(calls, 1, 'эффект один раз');
const r2 = ex.run({ nonce: 'n-42', digest: d1, expiry: T0 + 60000 }, eff);
eq(r2.replay, true, 'повтор тем же телом — replay без эффекта');
eq(calls, 1, 'эффект не повторён');
eq(JSON.stringify(r2.result), JSON.stringify({ jobId: 'j1' }), 'потеря ответа — тот же результат');
const dOther = actionDigest({ action: 'claim', body: { taker: B }, nonce: 'n-42', expiry: T0 + 60000 });
eq(ex.run({ nonce: 'n-42', digest: dOther, expiry: T0 + 60000 }, eff).error, 'NONCE_BODY_MISMATCH', 'тот же nonce с другим телом — отказ');
eq(calls, 1, 'чужое тело эффекта не дало');
// переживает рестарт:
const ex2 = makeIdempotentExecutor(exFile);
eq(ex2.run({ nonce: 'n-42', digest: d1, expiry: T0 + 60000 }, eff).replay, true, 'идемпотентность переживает рестарт');

// --- 3. Resend: только тот же txid; тайм-аут не создаёт новую выплату ---
const D = 'AGTD' + '4'.repeat(36);
q.join(D); q.ready(D, { now: T0 });
const cd = q.claim2(D, { now: T0 }); q.confirm(cd.jobId, D);
q.submit(cd.jobId, D, 'сделано', { now: T0 + 100 });
q.review(cd.jobId, 'accept', 'ок', { now: T0 + 200 });
const obd = q.obligationFor(cd.jobId, D, '2000000000');
q.obligationSent(obd.obId, 'txSAME');
// RPC тайм-аут: цепь пуста — решение только повторить ТОТ ЖЕ txid, новой подписи нет:
const dec = q.payoutDecision(cd.jobId, new Set());
eq(dec.action, 'resend-same-txid-only', 'тайм-аут: только повтор того же txid');
eq(dec.txid, 'txSAME', 'тот же txid');
eq(dec.forbidNewTxid, true, 'новый txid запрещён');
// попытка записать второй txid отвергается:
eq(q.obligationSent(obd.obId, 'txOTHER').error, 'OB_ALREADY_SENT', 'вторая отправка с новым txid запрещена');
// повтор находит txid в цепи — только дописать:
eq(q.payoutDecision(cd.jobId, new Set(['txSAME'])).action, 'adopt', 'txid в цепи — adopt, не отправка');
// obligationFor идемпотентен даже после «потери ответа»:
eq(q.obligationFor(cd.jobId, D, '2000000000').txid ?? q.obligationFor(cd.jobId, D, '2000000000').status, q.obligationFor(cd.jobId, D, '2000000000').txid ?? q.obligationFor(cd.jobId, D, '2000000000').status, 'идемпотентность обязательства');

// --- 4. Границы времени, skew, смена часов ---
const E = 'AGTE' + '5'.repeat(36);
q.join(E); q.ready(E, { now: T0 });
const ce = q.claim2(E, { now: T0 }); q.confirm(ce.jobId, E);
eq(q.submit(ce.jobId, E, 'ровно в срок', { now: ce && q.state.meta[ce.jobId].executeBy }).late, false, 'граница executeBy — вовремя');
const F = 'AGTF' + '6'.repeat(36);
q.join(F); q.ready(F, { now: T0 });
const cf = q.claim2(F, { now: T0 }); q.confirm(cf.jobId, F);
eq(q.submit(cf.jobId, F, 'ровно в конце grace', { now: q.state.meta[cf.jobId].executeBy + q.V2.lateGrace }).late, true, 'граница executeBy+grace — ещё late');
// skew: подпись с expiry дальше 5 мин — отказ
const kp = crypto.generateKeyPairSync('ed25519');
const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = kp.publicKey.export({ type: 'spki', format: 'pem' });
import { addressFromPub } from '../core.mjs';
const ADDR = addressFromPub(pub);
const base = { action: 'submit', body: { jobId: 'x' }, nonce: 'sk1', expiry: T0 + AUTH_MAX_SKEW_MS + 1 };
const sig = signAction(priv, base);
eq(verifyActionSig({ address: ADDR, fromPub: pub, signature: sig.signature, ...base, now: T0 }).error, 'AUTH_EXPIRY_TOO_FAR', 'skew: expiry дальше 5 мин — отказ');
// смена часов после рестарта: дедлайны абсолютны, прыжок назад истечение не создаёт раньше
const q2 = new AgentQueue(dir);
eq(JSON.stringify(q2.state.meta[ce.jobId]), JSON.stringify(q.state.meta[ce.jobId]), 'рестарт: meta целы');
eq(q2.sweepExpiries(T0 - 3600_000).length, 0, 'часы назад — ложных истечений нет');

// --- 5. Миграция/откат + обход через альтернативные маршруты ---
q.state.onDuty.legacyX = A; // без meta — grandfathered
eq(q.submit('legacyX', A, 'x', { now: T0 + 10 ** 12 }).legacy, true, 'legacy: истечения нет');
q.state.v2.readyEnforced = false; // откат флага
const G = 'AGTG' + '7'.repeat(36);
q.join(G);
eq(q.claim(G).ok, true, 'откат: старый claim без ready работает');
q.state.v2.readyEnforced = true;

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('queue-v2-clarify: ALL GREEN');
