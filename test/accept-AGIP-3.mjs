/* accept-AGIP-3.mjs — исполняемый критерий приёмки AGIP-3 (docs/AGIP-3.md).
   Запуск: node test/accept-AGIP-3.mjs http://127.0.0.1:9343
   ВНЕШНЯЯ верификация: скрипт сам вычисляет txid (sha256d по tx), сам сворачивает
   merkle-ветку и сам проверяет computeBlockHash — ноде верит только в данные, не в выводы.
   Exit-код: 0 = приёмка пройдена; 1 = FAIL. */
import { createHash } from 'node:crypto';
import { computeBlockHash } from '../core.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:9335';

const sha256d = (x) => createHash('sha256').update(createHash('sha256').update(x).digest()).digest('hex');
async function j(method, path, body = null) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let b = {};
  try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}

const fails = [];
const ok = (m) => console.log('  ok: ' + m);

// 1. два кошелька; баланс отправителя — coinbase от майнинга (не завязываемся на faucet-кошелёк)
const wA = await j('POST', '/wallet/create', { label: 'accept-agip3-A' });
const wB = await j('POST', '/wallet/create', { label: 'accept-agip3-B' });
if (!wA.body.address || !wB.body.address) fails.push('wallet create failed');
let warm = false;
for (let k = 0; k < 2 && !warm; k++) {
  const m = await j('POST', '/mine', { miner: wA.body.address });
  if (m.status === 200) warm = true;
  else if (!(m.status === 202 && m.body.error === 'mining_slice_exhausted')) { fails.push(`warmup mine: status=${m.status}`); break; }
}
if (!warm) fails.push('warmup coinbase not mined');
else ok('warmup: coinbase намайнен на отправителя');

// 2. подписанная tx через ноду; txid вычисляем САМИ (не верим ноде)
const sign = await j('POST', '/tx/sign', { fromAddress: wA.body.address, to: wB.body.address, amount: 0.1, memo: 'agip3-accept' });
if (sign.status !== 200 || !sign.body.signed) fails.push(`tx/sign: status=${sign.status}`);
const tx = sign.body.signed || {};
const selfTxid = txDigestSelf(tx);
ok(`tx подписана, txid вычислен извне: ${selfTxid.slice(0, 16)}…`);

function txDigestSelf(t) {
  // та же канонизация, что core.txDigest — только поля
  return sha256d(JSON.stringify({ from: t.from, to: t.to, amount: t.amount, nonce: t.nonce, ts: t.ts, memo: t.memo || '' }));
}

// 3. submit + mine (мемпул → блок)
const sub = await j('POST', '/tx', tx);
if (sub.status !== 200 && sub.status !== 201) fails.push(`POST /tx: status=${sub.status} body=${JSON.stringify(sub.body).slice(0, 120)}`);
else ok(`POST /tx: ${sub.status}`);

let mined = false;
for (let attempt = 1; attempt <= 3 && !mined; attempt++) {
  const m = await j('POST', '/mine', { miner: wA.body.address });
  if (m.status === 200) mined = true;
  else if (m.status === 202 && m.body.error === 'mining_slice_exhausted') { ok(`mine slice ${attempt}: сложность высокая — ретрай`); await new Promise(s => setTimeout(s, 300)); }
  else { fails.push(`POST /mine: status=${m.status} body=${JSON.stringify(m.body).slice(0, 160)}`); break; }
}
if (!mined) fails.push('block not mined in 3 attempts');
else ok('POST /mine: 200, блок закоммичен');

// 4. пруф от ноды — только данные
const pr = await j('GET', '/txproof/' + selfTxid);
if (pr.status !== 200) fails.push(`txproof: status=${pr.status} body=${JSON.stringify(pr.body).slice(0, 120)}`);

let root = selfTxid;
for (const step of (pr.body.merkleBranch || [])) {
  root = step.side === 'right' ? sha256d(root + step.hash) : sha256d(step.hash + root);
}
if (pr.status === 200) {
  if (root !== pr.body.header.merkleRoot) fails.push(`merkle recompute: ${root.slice(0, 12)}… != header.merkleRoot ${String(pr.body.header.merkleRoot).slice(0, 12)}…`);
  else ok('merkle recompute == header.merkleRoot');
  const h = computeBlockHash(pr.body.header);
  if (h !== pr.body.blockHash) fails.push(`computeBlockHash(header) ${h.slice(0, 12)}… != blockHash ${String(pr.body.blockHash).slice(0, 12)}…`);
  else ok(`computeBlockHash(header) == blockHash (block #${pr.body.height})`);
}

// 5. неизвестный txid → 404
const nf = await j('GET', '/txproof/' + 'f'.repeat(64));
if (nf.status !== 404) fails.push(`неизвестный txid: status=${nf.status} (ожидали 404)`);
else ok('неизвестный txid: 404');

if (fails.length) {
  console.error('AGIP-3 ACCEPT: FAIL на ' + BASE + ' → ' + fails.join('; '));
  process.exit(1);
}
console.log(`AGIP-3 ACCEPT: OK на ${BASE} (txid=${selfTxid.slice(0, 16)}…, block #${pr.body.height})`);
process.exitCode = 0;
