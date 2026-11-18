#!/usr/bin/env node
/* Stage B: каталог, заказ, артефакт, приёмка (api-check-v1). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStand } from '../sdk/js/stand-server.mjs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';
import { addressFromPub } from '../core.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + name + (extra ? ' — ' + extra : '')); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtm-'));
const stand = await createStand(tmp);
const J = (n) => path.join(tmp, n + '.json');
const mk = (p) => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pub = k.publicKey.export({ type: 'spki', format: 'pem' });
  const addr = addressFromPub(pub);
  const w = path.join(tmp, p + '.json');
  fs.writeFileSync(w, JSON.stringify({ address: addr, public_key_pem: pub, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { addr, w };
};
const prov = mk('prov'), cust = mk('cust'), other = mk('oth');
const cp = (o, w, j) => makeClient({ node: stand.url, address: o.addr, walletFile: w, journalFile: j });
const offer = {
  offerId: 'api-check-demo', version: '1', provider: prov.addr, title: 'Проверка API: статус и хеш тела',
  skills: ['api-check'], acceptedInputFormats: ['application/json'], producedOutputFormats: ['application/json'],
  inputSchema: { url: 'string', expectStatus: 'number' }, outputSchema: { url: 'string', status: 'number' },
  acceptance: { method: 'human', rules: 'customer compares status' },
  priceAtomic: 1000, expiresAt: Date.now() + 3600000, license: 'result-research-only',
  deadline: '24h', limits: 'stand only',
};
// 1. публикация + поиск без ручного просмотра сайта
{
  const c = cp(prov, prov.w, J('p1'));
  const r = await c.publishOffer(prov.addr, offer);
  ok(r.ok === true, 'публикация предложения');
  const f = makeClient({ node: stand.url, journalFile: J('pub') });
  const s = await f.searchOffers({ skill: 'api-check', maxPriceAtomic: 2000, format: 'application/json' });
  ok(Array.isArray(s.offers) && s.offers.some(o => o.offerId === 'api-check-demo'), 'внешний агент находит услугу поиском');
  const s2 = await f.searchOffers({ skill: 'api-check', maxPriceAtomic: 10 });
  ok(!s2.offers.some(o => o.offerId === 'api-check-demo'), 'фильтр цены отсекает');
}
// 2. заказ идемпотентен: повтор не создаёт новую сделку
let aid;
{
  const c = cp(cust, cust.w, J('o1'));
  const r1 = await c.createOrder(cust.addr, 'api-check-demo', { url: 'https://x', expectStatus: 200 }, 'idem-1');
  ok(r1.ok && r1.result.assignment.assignmentId, 'заказ создан, средства не двигались');
  aid = r1.result.assignment.assignmentId;
  const snap1 = r1.result.assignment.offerSnapshotHash;
  const c2 = cp(cust, cust.w, J('o1'));
  const r2 = await c2.createOrder(cust.addr, 'api-check-demo', { url: 'https://x', expectStatus: 200 }, 'idem-1');
  ok(r2.replay === true && r2.result.assignment.assignmentId === aid, 'повтор — то же обязательство (replay)');
  // правка оффера = новая версия; существующий заказ хранит старый снимок
  const c3 = cp(prov, prov.w, J('p2'));
  await c3.publishOffer(prov.addr, { ...offer, version: '2', priceAtomic: 2000 });
  const g = makeClient({ node: stand.url, journalFile: J('g') });
  const ord = await g.getOrder(aid, cust.addr);
  ok(ord.assignment.offerSnapshotHash === snap1 && ord.assignment.offerVersion === '1', 'сделка хранит снимок v1 после правки оффера');
}
// 3. артефакт: хеш по содержимому; чужой provider запрещён; изменение = новая версия
{
  const content = Buffer.from(JSON.stringify({ url: 'https://x', status: 200 })).toString('base64');
  const bytes = Buffer.from(content, 'base64');
  const h = crypto.createHash('sha256').update(bytes).digest('hex');
  const art = { artifactId: 'a1', attemptId: 't1', contentHash: h, mediaType: 'application/json', sizeBytes: bytes.length, location: 'inline', accessPolicy: 'parties', createdAt: Date.now(), producerSignature: 'sig' };
  const c = cp(prov, prov.w, J('a1'));
  const r = await c.submitArtifact(prov.addr, aid, art, content);
  ok(r.ok === true, 'артефакт принят (хеш сошёлся)');
  const co = cp(other, other.w, J('a2'));
  const rf = await co.submitArtifact(other.addr, aid, { ...art, artifactId: 'ax' }, content);
  ok(rf.ok === false, 'чужой provider сдать не может');
  const bad = await c.submitArtifact(prov.addr, aid, { ...art, artifactId: 'a2' }, Buffer.from('other').toString('base64'));
  ok(bad.ok === false, 'битый хеш отвергнут');
  const priv = await (makeClient({ node: stand.url, journalFile: J('pv') })).getOrder(aid, other.addr);
  ok(priv.artifacts[0].content === undefined, 'приватный результат не публикуется посторонним');
}
// 4. приёмка: принимает только customer; повтор — тот же исход
{
  const co = cp(other, other.w, J('f1'));
  const rf = await co.acceptOrder(other.addr, aid, 'ok');
  ok(rf.ok === false, 'чужой accept запрещён');
  const c = cp(cust, cust.w, J('ac1'));
  const r1 = await c.acceptOrder(cust.addr, aid, 'accepted: status matches');
  ok(r1.ok === true && r1.result.assignment.state === 'accepted', 'customer принял результат');
  const c2 = cp(cust, cust.w, J('ac1'));
  const r2 = await c2.acceptOrder(cust.addr, aid, 'accepted: status matches');
  ok(r2.replay === true, 'повтор accept — тот же исход без дубля');
}
console.log(`\nитог: ${pass} PASS, ${fail} FAIL`);
stand.close();
process.exit(fail ? 1 : 0);
