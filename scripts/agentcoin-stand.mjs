#!/usr/bin/env node
/* Изолированный стенд среза: общие хендлеры stand-server + полный проход
   внешнего агента (status→join→claim→submit→payments, повтор после рестарта).
   Сохраняет обезличенный журнал в evidence/. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStand } from '../sdk/js/stand-server.mjs';
import { addressFromPub } from '../core.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-stand-'));
const stand = await createStand(tmp);
const log = [];
const step = (name, obj) => { log.push({ step: name, result: obj }); console.log(`\n[${name}]:`); console.log(JSON.stringify(obj, null, 1).slice(0, 900)); };

// кошелёк стенда (только для этого прогона, в tmp)
const k = crypto.generateKeyPairSync('ed25519');
const pubPem = k.publicKey.export({ type: 'spki', format: 'pem' });
const addr = addressFromPub(pubPem);
const walletFile = path.join(tmp, 'wallet.json');
fs.writeFileSync(walletFile, JSON.stringify({ address: addr, public_key_pem: pubPem, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
const { makeClient } = await import('../sdk/js/agentcoin-sdk.mjs');
const J = path.join(tmp, 'journal.json');
const c = makeClient({ node: stand.url, address: addr, walletFile, journalFile: J });

step('status-readonly', await c.status(addr));
step('join', await c.join(addr, 'stand-agent'));
const cl = await c.claim(addr); step('claim-own-task', cl);
step('claim-repeat', await c.claim(addr));
step('my_task', await c.myTask(addr));
if (cl.ok) {
  const summary = 'Стендовый отчёт: очередь и джобборд сошлись, повторы идемпотентны, чужой ключ отвергнут.';
  step('submit', await c.submit(addr, cl.result.jobId, summary));
  step('submit-repeat-after-response-loss', await c.submit(addr, cl.result.jobId, summary));
}
step('payments-stages', await c.payments(addr));
// рестарт: новый клиент тот же журнал — без нового эффекта
const c2 = makeClient({ node: stand.url, address: addr, walletFile, journalFile: J });
step('restart-claim-replay', await c2.claim(addr));

// ---- Stage B: услуга api-check-v1 (провайдер Б, заказчик А) ----
const mkW = (tag) => {
  const kk = crypto.generateKeyPairSync('ed25519');
  const pp = kk.publicKey.export({ type: 'spki', format: 'pem' });
  const aa = addressFromPub(pp);
  const wf = path.join(tmp, tag + '.json');
  fs.writeFileSync(wf, JSON.stringify({ address: aa, public_key_pem: pp, privateKeyPem: kk.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { addr: aa, wf };
};
const B = mkW('provB'), A2 = mkW('custA');
const cB = makeClient({ node: stand.url, address: B.addr, walletFile: B.wf, journalFile: path.join(tmp, 'jB.json') });
const cA = makeClient({ node: stand.url, address: A2.addr, walletFile: A2.wf, journalFile: path.join(tmp, 'jA.json') });
const offerB = { offerId: 'api-check-v1', version: '1', provider: B.addr, title: 'Проверка API', skills: ['api-check'], acceptedInputFormats: ['application/json'], producedOutputFormats: ['application/json'], inputSchema: { url: 'string' }, outputSchema: { url: 'string', status: 'number' }, acceptance: { method: 'human', rules: 'customer compares' }, priceAtomic: 500, expiresAt: Date.now() + 3600000, license: 'research-only', deadline: '24h', limits: 'stand' };
step('B-publish', await cB.publishOffer(B.addr, offerB));
step('A-search-offers', await cA.searchOffers({ skill: 'api-check', maxPriceAtomic: 1000, format: 'application/json' }));
const ord = await cA.createOrder(A2.addr, 'api-check-v1', { url: 'https://example/api', expectStatus: 200 }, 'stand-idem-1');
step('A-create-order', ord);
if (ord.ok) {
  const aidB = ord.result.assignment.assignmentId;
  const payload = JSON.stringify({ url: 'https://example/api', status: 200, checkedAt: Date.now() });
  const hb = crypto.createHash('sha256').update(Buffer.from(payload)).digest('hex');
  const art = { artifactId: 'r1', attemptId: 't1', contentHash: hb, mediaType: 'application/json', sizeBytes: Buffer.byteLength(payload), location: 'inline', accessPolicy: 'parties', createdAt: Date.now(), producerSignature: 'sig' };
  step('B-submit-artifact', await cB.submitArtifact(B.addr, aidB, art, Buffer.from(payload).toString('base64')));
  step('A-accept', await cA.acceptOrder(A2.addr, aidB, 'accepted: status 200 matches'));
  step('A-accept-repeat', await cA.acceptOrder(A2.addr, aidB, 'accepted: status 200 matches'));
}

const evDir = path.join(process.cwd(), 'evidence');
fs.mkdirSync(evDir, { recursive: true });
const evFile = path.join(evDir, `agentcoin-sdk-pass-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const clean = JSON.parse(JSON.stringify(log, (kk, v) => /private|signature|pem|priv/i.test(kk) ? '[redacted]' : v));
fs.writeFileSync(evFile, JSON.stringify({ node: stand.url, genesis: stand.genesis, address: addr.slice(0, 10) + '…', log: clean }, null, 2));
console.log('\nжурнал: ' + evFile);
stand.close();
console.log('стенд: DONE');
