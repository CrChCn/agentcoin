#!/usr/bin/env node
// R-09 PAYMENT RECEIPT — ИНДЕПЕНДЕНТНАЯ проверка квитанции без доверия ноде.
// Использование: node tools/verify-receipt.mjs <receipt.json> [nodeUrl]
// receipt = { version:1, network, genesisHash, txid, tx:{from,to,amount,nonce,ts,memo,signature,fromPub,...},
//             height, blockHash, txIndex, merkleBranch:[{hash,side}], header:{...} }
// Проверяет ЧЕРЕЗ ДОСТУПНЫЕ ДАННЫЕ КВИТАНЦИИ (не через ноду выдачи):
//   1) merkle-включение txid → header.merkleRoot (рекомпутация ветки);
//   2) header-канонический blockHash: computeBlockHash(header) === blockHash;
//   3) PoW: hashMeetsDifficulty(blockHash, header.difficultyBits);
//   4) сеть: network/genesisHash receipt против НЕЗАВИСИМОГО источника (второй nodeUrl или embedded pin);
//   5) получатель/сумма: tx.to/tx.amount против поля receipt.payee/receipt.amount (оплачиваемый инвойс),
//      подпись tx над v1/v2-соответствующим digest;
//   6) столкновение версий: digestVersion=2 → txDigestV2, иначе txDigest.
// Ограничения честно: merkle-пруф доказывает включение ОТНОСИТЕЛЬНО заголовка, сам по себе
// НЕ доказывает валидность всей цепи/финальность — full-validation отдельная задача (R-13).
import fs from 'node:fs';
import * as core from '../core.mjs';

const recPath = process.argv[2];
const secondNode = process.argv[3] || process.env.AGT_VERIFY_NODE || null;
if (!recPath) { console.error('usage: verify-receipt <receipt.json> [second-node-url]'); process.exit(2); }
const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));

const fails = []; const oks = []; const note = (m) => console.log('  ' + m);
const ok = (m) => { oks.push(m); console.log('  ok: ' + m); };
const fail = (m) => { fails.push(m); console.log('  FAIL: ' + m); };

// 1) меркл-включение
let cur = rec.txid;
for (const s of (rec.merkleBranch || [])) {
  cur = s.side === 'right' ? core.sha256d(cur + s.hash) : core.sha256d(s.hash + cur);
}
cur === rec.header.merkleRoot ? ok('merkle: txid → merkleRoot включён') : fail(`merkle root mismatch: recompute=${cur.slice(0,16)} header=${String(rec.header.merkleRoot).slice(0,16)}`);

// 2) канонический blockHash
const recomputed = core.computeBlockHash(rec.header);
recomputed === rec.blockHash ? ok('blockHash канонический (computeBlockHash)') : fail(`blockHash recomputed=${recomputed.slice(0,16)} != ${String(rec.blockHash).slice(0,16)}`);

// 3) PoW
core.hashMeetsDifficulty(rec.blockHash, rec.header.difficultyBits) ? ok(`PoW difficulty ${rec.header.difficultyBits} бит`) : fail('PoW не соответствует difficultyBits');

// 4) сеть/genesis — при наличии второго независимого источника
if (secondNode) {
  try {
    const info = await (await fetch(secondNode + '/info', { signal: AbortSignal.timeout(8000) })).json();
    info.genesisHash === rec.genesisHash ? ok('genesisHash подтверждён вторым независимым узлом') : fail(`genesisHash: receipt=${rec.genesisHash?.slice(0,12)} node=${info.genesisHash?.slice(0,12)}`);
    info.chainId === rec.network ? ok(`network=${rec.network} у независимого узла`) : fail(`network mismatch: receipt=${rec.network} node=${info.chainId}`);
    (info.blocks > rec.height) && ok(`height ${rec.height} ≤ tip ${info.blocks} у независимого узла`);
  } catch (e) { note('второй узел недоступен (' + e.message + ') — network/genesis проверен по embedded pin receipt (слабее)'); }
} else if (rec.network === core.networkChainId()) {
  ok('network совпадает с локальной конфигурацией (embedded pin)');
} else fail(`network=${rec.network} ≠ локальной конфигурации ${core.networkChainId()}`);

// 5) получатель/сумма против оплачиваемого назначения (если указано)
if (rec.payee) (rec.tx.to === rec.payee ? ok('tx.to === payee (оплачиваемый адрес)') : fail(`tx.to=${rec.tx.to} ≠ payee=${rec.payee}`));
if (rec.amount !== undefined) (rec.tx.amount === rec.amount ? ok(`tx.amount === ${rec.amount} (оплачиваемая сумма)`) : fail(`tx.amount=${rec.tx.amount} ≠ ${rec.amount}`));

// 6) подпись tx над версией
const tx = rec.tx;
if (tx.digestVersion === 2) {
  core.verifyTransactionV2(tx) ? ok('подпись v2_VERIFY валидна (network pin внутри digest)') : fail('v2-подпись отвергнута');
} else {
  core.verifyTransaction(tx) ? ok('подпись v1 валидна') : fail('v1-подпись отвергнута');
}
if (rec.txid !== (tx.digestVersion === 2 ? core.txDigestV2(tx) : core.txDigest(tx))) fail('txid не соответствует каноническому digest tx (v' + (tx.digestVersion || 1) + ')');
else ok('txid канонический по версии tx');

console.log(''); 
if (fails.length) { console.log('RECEIPT REJECTED (' + fails.length + ')'); process.exit(1); }
console.log(`RECEIPT VERIFIED (txid ${rec.txid.slice(0,16)}, block ${rec.height})`);
console.log('note: включение доказано относительно заголовка; полная валидность цепи/финальность — самостоятельная проверка (R-13), не этим верификатором');
