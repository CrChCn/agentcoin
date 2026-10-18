// CORE-P0 (LEDGER-20261018-01, аудит 2026-10-18) — отрицательные и положительные
// тесты единого консенсус-верификатора validateBlockAgainstChain.
// Требования аудита (комментарий 6250846229): единая проверка submit/sync/fork/local,
// один coinbase, запрет произвольных системных расходов, digest по каноническому
// содержимому, chainId, конечные положительные суммы, последовательные balance/replay.
// Только синтетическая изолированная среда: одноразовый data-dir, никаких рабочик
// кошельков/нод/портов (MINER-GUARD/OPS-TEST требование).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as core from '../core.mjs';

process.env.AGT_CORE_P0_HEIGHT = '10'; // активация на h>=10: все исторические (h<10) — legacy, новые — строгие

let pass = 0; const fails = [];
function ok(label) { pass++; console.log(`  ok  ${label}`); }
function bad(label, extra = '') { fails.push(label); console.log(`FAIL  ${label}${extra ? ' :: ' + extra : ''}`); }
function step(cond, label, extra) { cond ? ok(label) : bad(label, extra); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-core-p0-'));
const bc = new core.Blockchain(tmp);
const A = core.createWallet('A');
const B = core.createWallet('B');
const ATT = core.createWallet('attacker');

// ---- сетап: 14 блоков, награда на A и на B (7+7) ----
for (let i = 0; i < 7; i++) bc.mineOnce(A.address);
for (let i = 0; i < 7; i++) bc.mineOnce(B.address);
const ACT = 10;
const H0 = bc.blockCount();
step(H0 === 15, `setup: 14 блоков + генезис (h=${H0})`);
step((bc.balances()[A.address] || 0) === 350, `setup: баланс A = 350 (${bc.balances()[A.address] || 0})`);
step(bc.tip()?.header?.chainId === core.CHAIN_ID, 'setup: coinbase-шаблон канонический, chainId в заголовке');
const tpl = bc.coinbaseTxTemplate();
step(tpl.txid === core.txDigest(tpl), 'setup: coinbaseTxTemplate.txid === txDigest (канонический txid)');
step(bc.coinbaseTxTemplate().to === 'AGENT_REWARD_POOL', 'setup: майнер перекрывает to у шаблона');

// ---- помощник: сконструировать следующий блок (как честный майнер) ----
function craftBlock(txList) {
  const height = bc.blockCount();
  const cb = { from: 'COINBASE', to: A.address, amount: core.blockReward(height), nonce: height, ts: Math.floor(Date.now() / 1000), memo: 'block ' + height };
  cb.txid = core.txDigest(cb);
  const txs = [...txList, cb];
  const header = {
    version: 1, prevHash: bc.tip().hash, merkleRoot: core.merkleRoot(txs),
    timestamp: Math.floor(Date.now() / 1000), difficultyBits: bc.nextDifficulty(), nonce: 0, chainId: core.CHAIN_ID,
  };
  while (true) {
    const h = core.computeBlockHash(header);
    if (core.hashMeetsDifficulty(h, header.difficultyBits)) return { height, hash: h, header, txs, miner: A.address };
    header.nonce++;
  }
}
function remineHash(header) {
  header.nonce = 0;
  while (true) {
    const h = core.computeBlockHash(header);
    if (core.hashMeetsDifficulty(h, header.difficultyBits)) return h;
    header.nonce++;
  }
}
function signedTx(w, to, amount, memo, overrides = {}) {
  const tx = { from: w.address, fromPub: w.pub, to, amount, nonce: Date.now() + Math.floor(Math.random() * 1e9), ts: Math.floor(Date.now() / 1000), memo: memo || '', ...overrides };
  tx.signature = core.signTransaction(tx, w.privKey);
  tx.txid = core.txDigest(tx);
  return tx;
}
const O = { activation: ACT };

// ---- T1: честный блок проходит ----
const good = craftBlock([signedTx(B, A.address, 1, 't1')]);
step(core.validateBlockAgainstChain(good, bc.chain, O) === null, 'T1 честный блок принят');

// ---- T2: второй coinbase (extra-эмиссия) отвергнут ----
const two = JSON.parse(JSON.stringify(good));
const cb2 = { from: 'COINBASE', to: ATT.address, amount: core.blockReward(good.height), nonce: 'extra', ts: good.header.timestamp, memo: 'block ' + good.height };
cb2.txid = core.txDigest(cb2);
two.txs.splice(1, 0, cb2);
two.header.merkleRoot = core.merkleRoot(two.txs);
two.hash = remineHash(two.header);
step(core.validateBlockAgainstChain(two, bc.chain, O) === 'multiple_coinbase',
  'T2 двойной coinbase отвергнут (multiple_coinbase): ' + core.validateBlockAgainstChain(two, bc.chain, O));
step(core.validateBlockAgainstChain(two, bc.chain, { activation: Infinity }) === null,
  'T2b в legacy-режиме (до активации) тот же блок проходит — историческая совместимость сохранена');

// ---- T3: системный расход AGENT_REWARD_POOL отвергнут ----
const sys = JSON.parse(JSON.stringify(good));
sys.txs.splice(0, 0, { from: 'AGENT_REWARD_POOL', to: ATT.address, amount: 100, nonce: 1, ts: 1, memo: 'evil' });
sys.header.merkleRoot = core.merkleRoot(sys.txs);
sys.hash = remineHash(sys.header);
step(core.validateBlockAgainstChain(sys, bc.chain, O) === 'system_spend_forbidden',
  'T3 расход AGENT_REWARD_POOL отвергнут: ' + core.validateBlockAgainstChain(sys, bc.chain, O));

// ---- T4: неканонический txid (merkle не доверяет переданному id) ----
const badTxid = JSON.parse(JSON.stringify(good));
const t4 = signedTx(B, ATT.address, 1, 't4');
t4.txid = 'deadbeef' + '0'.repeat(56);
badTxid.txs = [t4, ...badTxid.txs];
badTxid.header.merkleRoot = core.merkleRoot(badTxid.txs);
badTxid.hash = remineHash(badTxid.header);
step(core.validateBlockAgainstChain(badTxid, bc.chain, O) === 'txid_not_canonical',
  'T4 неканонический txid отвергнут: ' + core.validateBlockAgainstChain(badTxid, bc.chain, O));

// ---- T5: овердрафт внутри блока (последовательная бухгалтерия) ----
const over = craftBlock([signedTx(A, ATT.address, 1e9, 't5')]);
step(core.validateBlockAgainstChain(over, bc.chain, O) === 'insufficient_funds_block',
  'T5 овердрафт отвергнут: ' + core.validateBlockAgainstChain(over, bc.chain, O));

// ---- T6: дубль txid внутри блока ----
const dupTx = signedTx(B, A.address, 1, 't6');
const dup = craftBlock([dupTx, dupTx]);
step(core.validateBlockAgainstChain(dup, bc.chain, O) === 'duplicate_txid_block',
  'T6 дубль txid в блоке отвергнут: ' + core.validateBlockAgainstChain(dup, bc.chain, O));

// ---- T7: дубль (from, nonce) внутри блока ----
const n1 = signedTx(A, B.address, 2, 't7a');
const n2 = signedTx(A, ATT.address, 3, 't7b', { nonce: n1.nonce });
const dupn = craftBlock([n1, n2]);
step(core.validateBlockAgainstChain(dupn, bc.chain, O) === 'duplicate_nonce_block',
  'T7 дубль (from,nonce) в блоке отвергнут: ' + core.validateBlockAgainstChain(dupn, bc.chain, O));

// ---- T8: неверный chainId ----
const other = JSON.parse(JSON.stringify(good));
other.header.chainId = 'EVILCOIN';
other.hash = remineHash(other.header); // честный PoW над чужим chainId: хеш/PoW ок, chainId — нет
step(core.validateBlockAgainstChain(other, bc.chain, O) === 'chainId_mismatch',
  'T8 чужой chainId отвергнут: ' + core.validateBlockAgainstChain(other, bc.chain, O));

// ---- T9: replay txid из цепи ----
const rtx = signedTx(B, A.address, 2, 't9');
const b1 = craftBlock([rtx]);
step(core.validateBlockAgainstChain(b1, bc.chain, O) === null, 'T9a первый блок с tx принят');
const known = new Set([rtx.txid]); // как после приёмки b1 в цепь
const b2 = craftBlock([rtx]);
step(core.validateBlockAgainstChain(b2, bc.chain, { activation: ACT, knownTxids: known }) === 'tx_replay_in_chain',
  'T9b повтор оплаты тем же txid отвергнут (tx_replay_in_chain): ' + core.validateBlockAgainstChain(b2, bc.chain, { activation: ACT, knownTxids: known }));

// ---- T10: adoptFork строит несколько coinbase-блоков в "тяжёлом" форке ----
const cb3 = { from: 'COINBASE', to: ATT.address, amount: core.blockReward(bc.blockCount() + 1), nonce: bc.blockCount() + 1, ts: Math.floor(Date.now() / 1000), memo: 'block ' + (bc.blockCount() + 1) };
cb3.txid = core.txDigest(cb3);
const cb3b = { ...cb3, to: ATT.address, nonce: 'x' };
cb3b.txid = core.txDigest(cb3b);
const forkTxs = [cb3, cb3b];
const forkHeader = { version: 1, prevHash: bc.tip().hash, merkleRoot: core.merkleRoot(forkTxs), timestamp: Math.floor(Date.now() / 1000), difficultyBits: bc.nextDifficulty(), nonce: 0, chainId: core.CHAIN_ID };
let forkBlock = null;
for (let i = 0; ; i++) {
  const h = core.computeBlockHash(forkHeader);
  if (core.hashMeetsDifficulty(h, forkHeader.difficultyBits)) { forkBlock = { height: bc.blockCount(), hash: h, header: forkHeader, txs: forkTxs, miner: ATT.address }; break; }
  forkHeader.nonce++;
}
const forkResult = bc.adoptFork([forkBlock], bc.blockCount());
step(forkResult.ok === false && String(forkResult.reason).includes('multiple_coinbase'),
  `T10 форк с 2 coinbase отвергнут в adoptFork: ${forkResult.reason}`);
step(bc.blockCount() === 15, `T10b цепь не изменена (h=${bc.blockCount()})`);

// ---- T11: commitMinedBlock (путь тонкого майнера/пула) тоже напрямую под активацию ----
const mt = bc.mineTemplate(A.address);
mt.txs.push(cb2); // второй coinbase
mt.header.merkleRoot = core.merkleRoot(mt.txs);
mt.header.nonce = 0;
while (true) {
  const h = core.computeBlockHash(mt.header);
  if (core.hashMeetsDifficulty(h, mt.header.difficultyBits)) { mt.hash = h; break; }
  mt.header.nonce++;
}
const rejected = bc.commitMinedBlock(mt.header, mt.hash, mt.txs, A.address, 1);
step(rejected && rejected.rejected === 'multiple_coinbase', `T11 commit 2-coinbase отвергнут: ${rejected && rejected.rejected}`);
step(bc.blockCount() === 15, `T11b цепь не изменена (h=${bc.blockCount()})`);

// ---- T12: честный commit принимается (положительный сквозной, через /block/submit-вход) ----
const mt2 = bc.mineTemplate(B.address);
mt2.txs.push(signedTx(B, A.address, 1, 't12'));
mt2.header.merkleRoot = core.merkleRoot(mt2.txs);
mt2.header.nonce = 0;
while (true) {
  const h = core.computeBlockHash(mt2.header);
  if (core.hashMeetsDifficulty(h, mt2.header.difficultyBits)) { mt2.hash = h; break; }
  mt2.header.nonce++;
}
const accepted = bc.commitMinedBlock(mt2.header, mt2.hash, mt2.txs, B.address, 1);
step(!accepted || !accepted.rejected, `T12 честный thin-miner commit принят (h=${bc.blockCount()})`);
step(bc.balances()[A.address] === 351, `T12b баланс A=351 (${bc.balances()[A.address]})`);

// ---- T13: единый строгий проход validate(true) на синтетической цепи ----
const v = bc.validate(true);
step(v.ok === true && v.negativeBalances === 0, `T13 validate(true) ok, neg=${v.negativeBalances}, supply=${v.totalSupply}`);
const vf = bc.validate(false);
step(vf.ok === true, 'T13b validate(false) ok');

// ---- T14: эскроу-цикл сквозь строгий верификатор не сломан ----
const escId = '01' + Math.floor(Math.random() * 1e30).toString(16).slice(0, 22);
const deadline = Math.floor(Date.now() / 1000) + 3600;
const open = signedTx(B, 'ESCROW_' + escId, 5, `escrow:${escId}:${'a'.repeat(16)}:${deadline}:${A.address}`);
const u = bc.usableMempoolTxs.bind(bc);
bc.mempool = [open];
const crafted = craftBlock([]); // блок не содержит open — только проверяем, что payout БЕЗ open отвергается
bc.mempool = [];const pay = { from: 'ESCROW_' + escId, to: A.address, amount: 1, nonce: 1, ts: 1, memo: `escpayout:${escId}`, escProof: {} };
pay.txid = core.txDigest(pay);
const eblk = craftBlock([pay]);
const er = core.validateBlockAgainstChain(eblk, bc.chain, O);
step(er === 'tx_bad_signature_or_escrow' || String(er).startsWith('insufficient_funds_block'), `T14 payout без эскроу-open отвергнут: ${er}`);  step(typeof u === 'function', 'T14b usableMempoolTxs жив');

// ---- T15: MINER-GUARD — неканонический получатель coinbase (двойник 42 симв.) отвергнут ----
const twin = 'AGT11a01a612a422dff68f758eefbd9ab3a991439a'; // 42 символа, как h66…h609
step(twin.length === 42 && !core.isCanonicalAddress(twin), 'T15a двойник распознаётся как неканонический адрес');
const t15 = craftBlock([]);
const cbT15 = t15.txs[t15.txs.length - 1];
cbT15.to = twin;
cbT15.txid = core.txDigest(cbT15); // живой майнер пересчитал бы канонический txid — и всё равно отвергнут
t15.header.merkleRoot = core.merkleRoot(t15.txs);
t15.hash = remineHash(t15.header);
step(core.validateBlockAgainstChain(t15, bc.chain, O) === 'coinbase_bad_recipient',
  'T15b coinbase «двойнику» отвергнут: ' + core.validateBlockAgainstChain(t15, bc.chain, O));

// ---- T16: неканонический получатель обычной tx отвергнут (эскроу-tx исключение) ----
const t16 = craftBlock([]);
t16.txs = [signedTx(B, twin, 1, 't16'), ...t16.txs];
t16.header.merkleRoot = core.merkleRoot(t16.txs);
t16.hash = remineHash(t16.header);
step(core.validateBlockAgainstChain(t16, bc.chain, O) === 'tx_bad_recipient',
  'T16 неканонический to отвергнут: ' + core.validateBlockAgainstChain(t16, bc.chain, O));
step(core.validateBlockAgainstChain(t16, bc.chain, { activation: Infinity }) === null,
  'T16b в legacy-режиме тот же блок проходит (историческая совместимость)');

// ---- T17–T20: TWIN-SWEEP — миграция средств безключевого адреса оператору ----
// Синтетика: авторизующий ключ = B.pub, «безключевой» участник = B.address (у него
// есть баланс 350 после setup); правила сверяются через opts, не через env
const opAddr = A.address; // получатель миграции
const sweepSpec = { from: B.address, to: opAddr, authPub: B.pub };
function sweepTx(amount, signer) {
  const tx = { from: sweepSpec.from, fromPub: sweepSpec.authPub, to: sweepSpec.to,
    amount, nonce: Date.now() + Math.floor(Math.random() * 1e9), ts: Math.floor(Date.now() / 1000), memo: 'twin-sweep:)'.replace(':)', ':h66-h609') };
  tx.signature = core.signTransaction(tx, signer || B.privKey);
  tx.txid = core.txDigest(tx);
  return tx;
}
const s1 = core.validateBlockAgainstChain(craftBlock([sweepTx(350)]), bc.chain, { ...O, twinSweep: sweepSpec });
step(s1 === null, 'T17 sweep всего баланса принят подписью авторизующего ключа: ' + s1);
const sBad = core.validateBlockAgainstChain(craftBlock([sweepTx(350, A.privKey)]), bc.chain, { ...O, twinSweep: sweepSpec });
step(sBad === 'twin_sweep_invalid', 'T18 sweep ЧУЖОЙ подписью отвергнут: ' + sBad);
// повтор после вычерпывания: баланс 0 → недостаточно средств (одноразовость accounting'ем)
const s2 = core.validateBlockAgainstChain(craftBlock([sweepTx(50)]), bc.chain,
  { ...O, twinSweep: sweepSpec, prefixBalances: { [B.address]: 0 } });
step(s2 === 'insufficient_funds_block', 'T19 повторный sweep после вычерпывания отвергнут: ' + s2);
step(core.validateBlockAgainstChain(craftBlock([sweepTx(350)]), bc.chain, { ...O, twinSweep: { ...sweepSpec, to: twin } }) === 'twin_sweep_invalid',
  'T20 sweep на неканонический to отвергнут (invalid spec)');

// ---- итоги ----
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nCORE-P0: ${pass} ok, ${fails.length} fail`);
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
console.log('ALL PASS');
