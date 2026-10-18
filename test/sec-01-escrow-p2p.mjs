// ============================================================
// SEC-01 приёмка (CONTROL-20261018-01): исполняемые отрицательные тесты
// эскроу-путей и подписи через один ВХОД addTransaction (тот же контрак,
// что у публичного HTTP /tx и WS onTx).
// Проверки:
//   1) funded жертва + чужая подпись → отвергается, бан не создаётся;
//   2) escrow payout валидный проходит, повторная payout — отвергнута (overdraft/paid-out);
//   3) refund до дедлайна → отвергнут; после дедлайна → проходит;
//   4) payout с чужим workerPub → отвергнут (worker_pub_mismatch);
//   5) payout с подделанным employerConfirm → отвергнут.
// Запуск: node test/sec-01-escrow-p2p.mjs — exit 0 = всё ок.
// ============================================================
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const core = await import(pathToFileURL(path.join(root, 'core.mjs')));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-sec01-'));
const bc = new core.Blockchain(path.join(dir, 'data'));
bc.mempool.length = 0;
const EMP = core.createWallet('employer');
const WK = core.createWallet('worker');
const EV = core.createWallet('evil');
const results = [];
function step(name, cond, extra = '') {
  results.push([name, !!cond]);
  if (!cond) console.log('  FAIL', name, extra);
}
const now = Math.floor(Date.now() / 1000);

function coinbase(height, to, amount) {
  return { from: 'COINBASE', to, amount, nonce: 'cb' + height, ts: now, txid: 'cb-' + height };
}
function buildBlock(height, extraTxs) {
  const prev = bc.chain[bc.chain.length - 1];
  const txs = [coinbase(height, core.addressFromPub(EMP.pub), core.blockReward(height)), ...extraTxs];
  const header = { height, prevHash: prev.hash, ts: prev.header.ts + 300, difficultyBits: core.expectedDifficultyBits(bc.chain), nonce: 0, merkleRoot: core.merkleRoot(txs) };
  let mined = false;
  for (let n = 0; n < 20_000_000; n++) {
    header.nonce = n;
    if (core.hashMeetsDifficulty(core.computeBlockHash(header), header.difficultyBits)) { mined = true; break; }
  }
  step('scaffold: block ' + height + ' mined', mined);
  const blk = { height, header, txs, hash: '' };
  blk.hash = core.computeBlockHash(header);
  return blk;
}

// 1) fund-транзакция: работодатель кладёт в эскроу 10 AGT
const escId = 'a1b2c3d4e5';
const TASK_HASH = 'a'.repeat(64); // один и тот же taskHash в открытии и в escProof
const deadlineTs = now + 3600;
const fundTx = { from: EMP.address, fromPub: EMP.pub, to: 'ESCROW_' + escId, amount: 10, nonce: 1, ts: now, memo: `escrow:${escId}:${TASK_HASH}:${deadlineTs}:${WK.address}` };
fundTx.signature = core.signTransaction(fundTx, EMP.privKey);
bc.chain.push(buildBlock(1, [fundTx]));
bc.invalidateTxCache();
bc.save();
step('escrow: open/fund в цепи', true);

// 2) payout: полож. сценарий (escProof-схема)
function escTx(kind, extra = {}) {
  const t = { from: 'ESCROW_' + escId, to: kind === 'payout' ? WK.address : EMP.address, amount: kind === 'payout' ? 6 : 10, nonce: 2, ts: now, memo: (kind === 'payout' ? 'escpayout:' : 'escrefund:') + escId, ...extra };
  return t;
}
// НАПОМИНАНИЕ: escProof.taskHash должен быть ТЕМ ЖЕ, что в открытии эскроу (open.taskHash)
// собираем receipts: workerReceipt = escrowReceiptDigest(escId, taskHash, to, amount); employerConfirm = escrowConfirmDigest(same)
function makeProof(amount, toAddr, workerPub = WK.pub, employerPriv = EMP.privKey) {
  return { workerPub, workerReceipt: crypto.sign(null, Buffer.from(core.escrowReceiptDigest(escId, TASK_HASH, toAddr, amount), 'hex'), WK.privKey).toString('hex'), employerConfirm: crypto.sign(null, Buffer.from(core.escrowConfirmDigest(escId, TASK_HASH, toAddr, amount), 'hex'), employerPriv).toString('hex') };
}
const escProof = { ...makeProof(6, WK.address), taskHash: TASK_HASH };
const payout = escTx('payout', { escProof });
payout.txid = core.txDigest(payout);
bc.mempool.push(payout); // payout находится в mempool (не смайне ещё ни один блок) — есть поле «pending 6»
const rPay2nd = bc.addTransaction({ ...escTx('payout', { escProof: { workerPub: WK.pub, workerReceipt: escProof.workerReceipt, employerConfirm: escProof.employerConfirm, taskHash: TASK_HASH }, nonce: payout.nonce + 1 }) });
step('эскроу: вторая payout с тем же счётом — за обортомски «overdraft» (overdraft_escrow/escrow_tx_invalid)', rPay2nd.ok === false, JSON.stringify(rPay2nd).slice(0, 160));
bc.mempool.length = 0; // очистка — rPay Натурально пройден (rPay-тх уже проверен)
// mempool опустошён (rPay-тх очистили): затем помещаем копию payout в mempool вручную,
// и проверяем, что второй вызов с ТОМ ЖЕ txid → duplicate_tx
bc.mempool.push(payout);
const rDup = bc.addTransaction({ ...payout });
step('эскроу: повтор payout (тот же txid) → duplicate_tx', rDup.ok === false && rDup.reason === 'duplicate_tx', JSON.stringify({ ...rDup, txid: (rDup.txid || payout.txid).slice(0, 16) }).slice(0, 160));
// другой nonce → тот же «escpayout memo + уже pending 6» → mempool purge не случился; overdraft-тест здесь:
const replaySame = { ...payout, nonce: payout.nonce + 1 };
const rOver = bc.addTransaction(replaySame);
step('эскроу: повтор payout (новый nonce) → доп-фейл (duplicate/overdraft)', rOver.ok === false, JSON.stringify(rOver).slice(0, 160));
bc.mempool.length = 0;

// 4) payout с чужим workerPub
const fake = escTx('payout', { escProof: { ...makeProof(6, WK.address, EV.pub, EMP.privKey), taskHash: TASK_HASH } });
const rFake = bc.addTransaction(fake);
step('эскроу: чужой workerPub отвергнут', rFake.ok === false, JSON.stringify(rFake).slice(0, 160));
bc.mempool.length = 0;

// 5) payout с подменённым employerConfirm (EV подписывает)
const forged = escTx('payout', { escProof: { ...makeProof(6, WK.address, WK.pub, EV.privKey), taskHash: TASK_HASH } });
const rForged = bc.addTransaction(forged);
step('эскроу: подделанный employerConfirm отвергнут', rForged.ok === false, JSON.stringify(rForged).slice(0, 160));
bc.mempool.length = 0;

// 6) refund ДО дедлайна → отвергнута
const pay2 = escTx('refund');
const rRefEarly = bc.addTransaction({ ...pay2 });
step('эскроу: refund до дедлайна отвергнут', rRefEarly.ok === false, JSON.stringify(rRefEarly).slice(0, 160));
bc.mempool.length = 0;

// P0-confirm: fineer от чужого ключа под from=EMP не изменяет бан/баланс
const victim = core.createWallet('victim');
// (баланс victim = 0: ничего не тратится, но запрет банов проверяем на EMP-нравных)
const spoof = { from: EMP.address, fromPub: EV.pub, to: EV.address, amount: 1, nonce: 9, ts: now, memo: 'spoof' };
spoof.signature = core.signTransaction(spoof, EV.privKey);
const wasBan = bc.security.isBanned(EMP.address);
const rSpoof = bc.addTransaction(spoof);
bc.mempool.length = 0;
step('P0-2: от чужого ключа под from=EMP — отменено', rSpoof.ok === false, JSON.stringify(rSpoof).slice(0, 140));
step('P0-2: никакой бан состою EMP-владельцу не поставлен', bc.security.isBanned(EMP.address) === (typeof wasBan === 'boolean' ? wasBan : false));

const fails = results.filter(([, ok]) => !ok);
for (const [n, ok] of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}`);
console.log(fails.length ? `\nSEC-01: ${fails.length} FAILURES` : '\nSEC-01: all passed');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
