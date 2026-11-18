#!/usr/bin/env node
/* Проход 3: два агента, один подтверждённый тестовый расчёт. Модель: обязательство
   возникает только после приёмки; хранитель — тестовая книга стенда (не эскроу,
   средства не удерживаются ончейн-механизмом); сумма/получатель/сеть/назначение
   привязаны к заказу; повтор безопасен; единственность платежа проверяется. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStand } from '../sdk/js/stand-server.mjs';
import { addressFromPub } from '../core.mjs';

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log('ok ' + n + ' ' + m); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-ecoD-'));
const stand = await createStand(tmp);
const { makeClient } = await import('../sdk/js/agentcoin-sdk.mjs');
const mkW = () => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pub = k.publicKey.export({ type: 'spki', format: 'pem' });
  const addr = addressFromPub(pub);
  const wf = path.join(tmp, addr.slice(0, 8) + '.json');
  fs.writeFileSync(wf, JSON.stringify({ address: addr, public_key_pem: pub, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { addr, wf };
};
const B = mkW(), A = mkW();
const cB = makeClient({ node: stand.url, address: B.addr, walletFile: B.wf, journalFile: path.join(tmp, 'jB.json') });
const cA = makeClient({ node: stand.url, address: A.addr, walletFile: A.wf, journalFile: path.join(tmp, 'jA.json') });
// B публикует api-check-v1 по 500
const base = { offerId: 'api-check-v1', version: '1', provider: B.addr, title: 'Проверка API', skills: ['api-check'], acceptedInputFormats: ['application/json'], producedOutputFormats: ['application/json'], inputSchema: {}, outputSchema: {}, acceptance: { method: 'human' }, priceAtomic: 500, expiresAt: Date.now() + 3600000, license: 'test' };
ok((await cB.publishOffer(B.addr, base)).ok, 'B published api-check-v1 price 500');
// A заработал тестовые единицы через кран стенда (не mainnet)
ok((await cA.faucet(A.addr, 10000)).ok, 'A funded 10000 TEST');
// A заказал услугу B
const ord = await cA.createOrder(A.addr, 'api-check-v1', { url: 'https://example/api' }, 'pay-run-1');
ok(ord.ok, 'A created order');
const aid = ord.result.assignment.assignmentId;
// до приёмки обязательства нет
const pre = await cA.createSettlement(A.addr, aid);
ok(!pre.ok && pre.error === 'no_obligation', 'no obligation before accept');
// B сдал артефакт, A принял
const payload = JSON.stringify({ url: 'https://example/api', status: 200 });
const hb = crypto.createHash('sha256').update(Buffer.from(payload)).digest('hex');
ok((await cB.submitArtifact(B.addr, aid, { artifactId: 'r1', attemptId: 't1', contentHash: hb, mediaType: 'application/json', sizeBytes: Buffer.byteLength(payload), accessPolicy: 'parties', createdAt: Date.now(), producerSignature: 'sig' }, Buffer.from(payload).toString('base64'))).ok, 'B submitted artifact');
ok((await cA.acceptOrder(A.addr, aid, 'accepted')).ok, 'A accepted result');
// обязательство: сумма/получатель/сеть/назначение привязаны
const ob = await cA.createSettlement(A.addr, aid);
ok(ob.ok && ob.result.settlement.amountAtomic === 500, 'obligation 500 created');
ok(ob.result.settlement.recipient === B.addr && ob.result.settlement.payer === A.addr, 'payer/recipient bound');
ok(ob.result.settlement.network === 'AGENTCOIN-stand' && ob.result.settlement.purpose === aid, 'network+purpose bound');
ok(ob.result.settlement.state === 'obligation', 'stage obligation');
// повтор создания — тот же платёж, без дубля
const ob2 = await cA.createSettlement(A.addr, aid);
ok(ob2.ok && ob2.result.settlement.paymentId === ob.result.settlement.paymentId, 're-create replays same payment');
// отправка
const snd = await cA.sendSettlement(A.addr, aid);
ok(snd.ok && snd.result.settlement.state === 'sent' && snd.result.settlement.txid, 'sent with txid');
const balA1 = await cA.testBalance(A.addr);
ok(balA1.balanceTestAtomic === 9500, 'A debited once (10000-500), got ' + balA1.balanceTestAtomic);
// повтор отправки — тот же исход, без второго списания
await cA.sendSettlement(A.addr, aid);
const balA2 = await cA.testBalance(A.addr);
ok(balA2.balanceTestAtomic === 9500, 're-send no double debit');
// подтверждение
const cf = await cB.confirmSettlement(B.addr, aid);
ok(cf.ok && cf.result.settlement.state === 'confirmed', 'confirmed');
const balB = await cB.testBalance(B.addr);
ok(balB.balanceTestAtomic === 500, 'B credited 500 once, got ' + balB.balanceTestAtomic);
// отмена после отправки запрещена
const cx = await cA.cancelSettlement(A.addr, aid);
ok(!cx.ok, 'cancel after send refused');
// спор после подтверждения фиксируется, но выплату не отменяет
const dp = await cA.disputeSettlement(A.addr, aid, 'проверка после оплаты');
ok(dp.ok && dp.result.settlement.state === 'confirmed', 'post-confirm dispute recorded, payment stands');
// чужой не читает расчёт
const stranger = await cA.getSettlement(aid, 'STRANGER');
ok(stranger.error === 'foreign_settlement', 'private settlement hidden from stranger');
// рестарт: платёж и балансы восстановлены, повтор подтверждает тот же результат
stand.close();
await new Promise((r) => setTimeout(r, 200));
const stand2 = await createStand(tmp);
const cA2 = makeClient({ node: stand2.url, address: A.addr, walletFile: A.wf, journalFile: path.join(tmp, 'jA.json') });
const re = await cA2.getSettlement(aid, A.addr);
ok(re.settlement?.state === 'confirmed', 'restart restores confirmed payment');
const cf2 = await cA2.confirmSettlement(A.addr, aid);
ok(cf2.ok && cf2.result.settlement.state === 'confirmed', 're-confirm replays single payment');
stand2.close();
console.log(`ecosphere-D PASS ${n}/${n}`);
console.log(JSON.stringify({ assignmentId: aid, paymentId: 'pay-' + aid, amountAtomic: 500, payer: A.addr.slice(0, 12) + '…', recipient: B.addr.slice(0, 12) + '…' }));
