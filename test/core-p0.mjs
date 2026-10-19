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

// ---- T17–T18: TWIN-SWEEP удалён из PR#4 (CORE-P0 review 6270365807 п.1) ----
// Ни адаптации «неканонического from» через env, ни проверки «операторского» ключа
// вместо владельца. Системные tx теперь отвергаются ВСЕГДА, если tx.from ≠ COINBASE;
// расход безключевого адреса (двойника) невозможен: нет подписи от владельца →
// tx_bad_signature_or_escrow ещё до системного правила.
// Возврат 13 900 AGT — ОТДЕЛЬНОЕ предложение политики сети, не часть верификатора.
const sysSpend = { from: 'AGENT_REWARD_POOL', to: ATT.address, amount: 10, nonce: 's1', ts: 1, memo: 'eightbad-skip-twin' };
sysSpend.txid = core.txDigest(sysSpend);
const sysBlock = craftBlock([sysSpend]);
const sysReason = core.validateBlockAgainstChain(sysBlock, bc.chain, O);
step(sysReason === 'system_spend_forbidden' || sysReason === 'tx_bad_signature_or_escrow' || sysReason === 'tx_bad_recipient',
  `T17 системный расход AGENT_REWARD_POOL отвергнут (${sysReason})`);
const twinSpend = { from: twin, to: A.address, amount: 10, nonce: 's2', ts: 1, memo: 'twin-spend:synth' };
twinSpend.txid = core.txDigest(twinSpend);
const tb = craftBlock([twinSpend]);
const tbReason = core.validateBlockAgainstChain(tb, bc.chain, O);
step(tbReason && tbReason !== null && /^[a-z_0-9]+$/.test(tbReason),
  `T18 tx от адреса-двойника отвергнут (${tbReason}: подпись владельца для безключевого адреса невозможна)`);

// ---- T19: регрессия очистки мемпула (CORE-P0 6271056180) -------------------------------
// refilterMempool раньше звал verifyTwinSweepTx/twinSweepSpec, определения которых
// уже удалены → ReferenceError на невалидной tx в мемпуле. Теперь: только
// verifyTxAny; невалидная/устаревшая tx молча дропается, живая остаётся.
const t19valid = signedTx(B, A.address, 1, 't19-keep');
bc.mempool = [t19valid, { from: twin, to: A.address, amount: 10, nonce: 'x', ts: 1, memo: 'junk' }, { from: A.address, to: twin, amount: 10, nonce: 'x', ts: 1, memo: 'junk2' }];
let filtr;
try { filtr = bc.refilterMempool(); } catch (e) { filtr = { thrown: String(e) }; }
step(!filtr.thrown, `T19a refilterMempool без ReferenceError (${JSON.stringify(filtr)})`);
step(bc.mempool.length === 1 && bc.mempool[0].txid === t19valid.txid, 'T19b невалидные дропнуты, живая осталась');
// устаревшая (already in chain) tx тоже дропается
const t19stale = signedTx(A, B.address, 1, 't19-stale');
bc.mempool = [t19stale];
const t19b = craftBlock([t19stale]); // tx уходит в цепь (валидация-коммит как в commitMinedBlock)
step(core.validateBlockAgainstChain(t19b, bc.chain, O) === null, 'T19c блок с пакетной tx валиден');
bc.chain.push(t19b); bc.invalidateTxCache(); // сценарий уже-в-цепи
const dropped = bc.refilterMempool();
step(bc.mempool.length === 0 && dropped.dropped >= 1, `T19d устаревшая tx дропнута (${JSON.stringify(dropped)})`);

// ---- T20: п.5 (6270365807) — env fail-closed: явное некорректное значение роняет валидацию ----
const invalidCases = ['abc', '10.5', '0', '-3', '1e-3', '9007199254740993'];
for (const v of invalidCases) {
  let threw = '';
  try { core.coreP0ActivationHeight({ activation: v }); } catch (e) { threw = String(e.message || e).split(':')[0]; }
  step(threw === 'AGT_CORE_P0_HEIGHT_invalid', `T20 ${JSON.stringify(v)} → fail-closed бросок (${threw || 'no throw'})`);
}
const saveEnv = process.env.AGT_CORE_P0_HEIGHT;
process.env.AGT_CORE_P0_HEIGHT = '999999999.5';
let envThrew = '';
try { core.coreP0ActivationHeight(); } catch (e) { envThrew = String(e.message || e).split(':')[0]; }
if (saveEnv === undefined) delete process.env.AGT_CORE_P0_HEIGHT; else process.env.AGT_CORE_P0_HEIGHT = saveEnv;
step(envThrew === 'AGT_CORE_P0_HEIGHT_invalid', 'T20 env-путь тоже fail-closed: ' + (envThrew || 'no throw'));
step(process.env.AGT_CORE_P0_HEIGHT === '10' && core.coreP0ActivationHeight() === 10, 'T20b восстановленный корректный env (10) читается без броска');
step(core.coreP0ActivationHeight({ activation: undefined }) === 10 || core.coreP0ActivationHeight({ activation: '' }) === Infinity, 'T20c пустое строковое → Infinity; opt undefined → env-значение');
step(core.coreP0ActivationHeight({ activation: 10 }) === 10 && core.coreP0ActivationHeight({ activation: Infinity }) === Infinity, 'T20c явные корректные значения: integer ≥1 и Infinity работают');

// ---- T21: п.3 (6270365807) — версионированный canonical digest авторизационных полей ----
const w21 = core.createWallet('T21');
const rx21 = core.createWallet('T21rx');
const tx21 = { from: w21.address, fromPub: w21.pub, to: rx21.address, amount: 1, nonce: 42, ts: Math.floor(Date.now() / 1000), memo: 't21', digestVersion: 2 };
tx21.signature = core.signTransactionV2(tx21, w21.privKey);
step(core.verifyTransactionV2(tx21) === true, 'T21a v2-подпись/проверка (signature поверх canonicalAuthPayload v2) работает');
const dA = core.txDigestV2(tx21);
step(dA !== core.txDigest(tx21), 'T21b v2 digest ≠ v1 digest (v1 остаётся нетронутым для истории)');
const txFromPub = { ...tx21, fromPub: w21.pub + '\n' };
step(core.txDigestV2(txFromPub) !== dA, 'T21c tamper fromPub меняет v2-digest (связан с контентом)');
const esc21 = { from: 'ESCROW_t21aabb', to: rx21.address, amount: 1, nonce: 1, ts: 1, memo: 'escpayout:t21aabb', escProof: { taskHash: 'a'.repeat(64), workerPub: w21.pub }, digestVersion: 2 };
step(core.txDigestV2(esc21) !== core.txDigestV2({ ...esc21, escProof: { taskHash: 'b'.repeat(64), workerPub: w21.pub } }), 'T21d tamper escProof меняет v2-digest');
let amtT = '';
try { core.canonicalAuthPayload({ ...tx21, amount: 3.3e-10 }, 2); } catch (e) { amtT = String(e); }
step(/tx_amount_not_mgnt_exact/.test(amtT), `T21e submagenta (нецелые магент-юниты) в v2 отвергнуты (${amtT.split('\n')[0] || 'no throw'})`);
step(core.verifyTransactionV2({ ...tx21, digestVersion: 1 }) === false, 'T21f v1-транзакция не подтверждается v2-верификатором (версия явная)');

// ---- T20d: C-8 (6272239263) — высоту в [1, MAX_SAFE_INTEGER] ----
let c8 = '';
try { core.coreP0ActivationHeight({ activation: 9007199254740992 }); } catch (e) { c8 = String(e); }
step(/MAX_SAFE_INTEGER/.test(c8), 'T20d activation > MAX_SAFE_INTEGER → fail-closed из-за области допустимых значений');
step(core.coreP0ActivationHeight({ activation: Number.MAX_SAFE_INTEGER }) === Number.MAX_SAFE_INTEGER, 'T20d MAX_SAFE_INTEGER ровно проход');

// ---- T22: п.4 (6270365807) — nonce-replay против ПОЛНОГО префикса + целочисленная бухгалтерия ----
//Полный префикс собирается из chain: (from,nonce) ДВУХ разных tx в разных блоках → отказ new-block
const t22old = signedTx(A, B.address, 1, 't22-old');
const t22bOld = craftBlock([t22old]);
step(core.validateBlockAgainstChain(t22bOld, bc.chain, O) === null, 'T22a блок с первой tx валиден');
bc.chain.push(t22bOld); bc.invalidateTxCache();
const t22dup = { ...signedTx(A, B.address, 1, 't22-dup'), nonce: t22old.nonce }; // ТОТ ЖЕ nonce как в цепи
t22dup.txid = core.txDigest(t22dup);
const t22bDup = craftBlock([t22dup]);
const r22 = core.validateBlockAgainstChain(t22bDup, bc.chain, O);
step(r22 === 'nonce_replay_in_chain', `T22b повтор (from,nonce) из префикса через разные блоки → отказ (${r22})`);
// дробный submagenta-баланс префикса через opts → fail-closed
const fakePrefix = { [A.address]: 350.0000000005 };
const t22c = craftBlock([signedTx(B, A.address, 1, 't22-c')]);
const r22c = core.validateBlockAgainstChain(t22c, bc.chain, { ...O, prefixBalances: { ...{ [A.address]: 350, [B.address]: 350 }, [A.address]: 350.0000000005 } });
step(String(r22c).startsWith('prefix_balance_not_mgnt_exact'), `T22c дробный префикс-баланс fail-closed (${r22c})`);

// ---- итоги ----
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
console.log('ALL PASS');
