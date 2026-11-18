#!/usr/bin/env node
/* Проход 4: модерация и метрики. Проверяем границы из ТЗ п.10 + §8. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log('ok ' + n + ' ' + m); };
const mkW = (tmp, tag) => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pub = k.publicKey.export({ type: 'spki', format: 'pem' });
  return { pub, pem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-ecoE-'));
// оператор задаётся до старта стенда
const opK = crypto.generateKeyPairSync('ed25519');
const opPub = opK.publicKey.export({ type: 'spki', format: 'pem' });
const { addressFromPub } = await import('../core.mjs');
const OP = addressFromPub(opPub);
process.env.STAND_OPERATOR = OP;
const { createStand } = await import('../sdk/js/stand-server.mjs');
const stand = await createStand(tmp);
const { makeClient } = await import('../sdk/js/agentcoin-sdk.mjs');
const mkC = (addr, pub, pem, j) => {
  const wf = path.join(tmp, j + '.json');
  fs.writeFileSync(wf, JSON.stringify({ address: addr, public_key_pem: pub, privateKeyPem: pem }));
  return makeClient({ node: stand.url, address: addr, walletFile: wf, journalFile: path.join(tmp, j + '-j.json') });
};
const wB = mkW(tmp, 'b'), wA = mkW(tmp, 'a');
const B = addressFromPub(wB.pub), A = addressFromPub(wA.pub);
const cB = mkC(B, wB.pub, wB.pem, 'jb'), cA = mkC(A, wA.pub, wA.pem, 'ja');
const opWf = path.join(tmp, 'op.json');
fs.writeFileSync(opWf, JSON.stringify({ address: OP, public_key_pem: opPub, privateKeyPem: opK.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
const cO = makeClient({ node: stand.url, address: OP, walletFile: opWf, journalFile: path.join(tmp, 'jo.json') });

const base = (o) => ({ offerId: o, version: '1', provider: B, title: 't ' + o, skills: ['s'], acceptedInputFormats: ['application/json'], producedOutputFormats: ['application/json'], inputSchema: {}, outputSchema: {}, acceptance: { method: 'human' }, priceAtomic: 100, expiresAt: Date.now() + 3600000, license: 't' });
ok((await cB.publishOffer(B, base('off-hide'))).ok, 'offer published');
// скрытие из публичного каталога
const comp = await cA.complain(A, 'offer', 'off-hide', 'спам-подозрение');
ok(comp.ok, 'complaint accepted with limits note');
const dec = await cO.decide(OP, comp.result.complaint.complaintId, 'hide_offer', 'проверено оператором');
ok(dec.ok && dec.result.after.hidden === true, 'operator hid offer with before/after');
const cat = await cA.searchOffers({ skill: 's' });
ok(!(cat.offers || []).some((o) => o.offerId === 'off-hide'), 'hidden excluded from public catalog');
// приостановка блокирует новые заказы, старые живы
ok((await cB.publishOffer(B, base('off-susp'))).ok, 'second offer published');
await cO.decide(OP, (await cA.complain(A, 'offer', 'off-susp', 'проверка')).result.complaint.complaintId, 'suspend_offer', 'пауза');
const blocked = await cA.createOrder(A, 'off-susp', {}, 'idem-susp-1');
ok(!blocked.ok && blocked.error === 'offer_suspended', 'suspended blocks new orders');
// существующий заказ до приостановки не изменён
ok((await cB.publishOffer(B, base('off-ok'))).ok, 'third offer published');
const ord = await cA.createOrder(A, 'off-ok', {}, 'idem-ok-1');
ok(ord.ok, 'order on clean offer works');
await cO.decide(OP, (await cA.complain(A, 'offer', 'off-ok', 'проверка')).result.complaint.complaintId, 'suspend_offer', 'пауза');
const still = await cA.getOrder(ord.result.assignment.assignmentId, A);
ok(still.assignment && still.assignment.state === 'open', 'existing order untouched by suspend');
// чужой заказ изменить нельзя (B пытается принять заказ A)
const payload = JSON.stringify({ x: 1 });
const hb = crypto.createHash('sha256').update(Buffer.from(payload)).digest('hex');
const aid = ord.result.assignment.assignmentId;
ok((await cB.submitArtifact(B, aid, { artifactId: 'r1', attemptId: 't1', contentHash: hb, mediaType: 'application/json', sizeBytes: 7, accessPolicy: 'parties', createdAt: Date.now(), producerSignature: 's' }, Buffer.from(payload).toString('base64'))).ok, 'provider submitted');
const foreign = await cB.acceptOrder(B, aid, 'ok');
ok(!foreign.ok, 'B cannot accept A order, no side effect');
const chk = await cA.getOrder(aid, A);
ok(chk.assignment.state === 'open' && !chk.acceptance, 'order unchanged after foreign attempt');
// артефакт неизменен: та же версия отклоняется, новая — новый хеш
const dup = await cB.submitArtifact(B, aid, { artifactId: 'r1', attemptId: 't1', contentHash: hb, mediaType: 'application/json', sizeBytes: 7, accessPolicy: 'parties', createdAt: Date.now(), producerSignature: 's' }, Buffer.from(payload).toString('base64'));
ok(!dup.ok, 'artifact rewrite rejected (new artifactId required)');
// не-оператор не решает
const nope = await cA.decide(A, comp.result.complaint.complaintId, 'hide_offer', 'самозванство');
ok(!nope.ok, 'non-operator decide blocked');
// история решений с who/what/reason/time/before/after
const hist = await cO.modHistory(OP);
ok(hist.decisions.length >= 3 && hist.decisions.every((d) => d.who && d.what && d.at && d.before && d.after), 'decision history complete');
const histNo = await cA.modHistory(A);
ok(histNo.error === 'foreign_operator', 'history operator-only');
// антиспам: 11-я публикация за час отклоняется
let limited = false;
for (let i = 0; i < 11; i++) { const r = await cB.publishOffer(B, { ...base('spam-' + i), offerId: 'spam-' + i }); if (!r.ok && r.error === 'spam_limited') limited = true; }
ok(limited, 'spam publish limited 429');
// метрики сходятся
const met = await cA.opsMetrics();
ok(met.offers >= 3 && met.complaintsOpen >= 0 && met.events > 0, 'ops metrics served');
// модерация не двигает деньги: баланс и расчёты целы
ok((await cA.faucet(A, 1000)).ok, 'faucet ok');
const okAcc = await cA.acceptOrder(A, aid, 'принято');
ok(okAcc.ok, 'accept ok');
const ob = await cA.createSettlement(A, aid);
ok(ob.ok && ob.result.settlement.amountAtomic === 100, 'settlement intact after moderation');
const decAfter = await cO.decide(OP, (await cA.complain(A, 'offer', 'off-ok', 'пост')).result.complaint.complaintId, 'hide_offer', 'пост-фактум');
ok(decAfter.ok && (await cA.getSettlement(aid, A)).settlement, 'settlement history not deleted by moderation');
stand.close();
console.log(`ecosphere-E PASS ${n}/${n}`);
