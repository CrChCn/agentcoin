// R-08/R-09 приёмка: pay-URI (encode/validate + негативы) и квитанция (positive + tamper).
// Без живых нод: синтетическая chain в tmp dataDir; никаких ключей оператора.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../core.mjs';
import { encode, validateUri } from '../tools/pay-uri.mjs';

const gHash = core.sha256d('r089-genesis');

test('R-08: URI encode/validate + негативы', () => {
  const w = core.createWallet('r8payee');
  const uri = encode({ to: w.address, amount: 1.5, genesisHash: gHash, invoiceId: 'INV-42', memo: 'тест' });
  assert.match(uri, /^agtpay:v1\?/);
  const v = validateUri(uri, gHash);
  assert.equal(v.ok, true, JSON.stringify(v).slice(0, 160));
  assert.equal(v.amount, 1.5);
  assert.equal(v.invoiceId, 'INV-42');
  assert.equal(v.memo, 'тест');
  // субмагентная сумма → reject
  const sub = `agtpay:v1?n=AGENTCOIN&g=${gHash.slice(0, 16)}&to=${core.createWallet('r8x').address}&a=0.0000000007&id=x`;
  assert.equal(validateUri(sub).ok, false, 'субмагентная сумма отвергнута');
  // неканонический получатель
  const badAddr = `agtpay:v1?n=AGENTCOIN&g=${gHash.slice(0, 16)}&to=hXXbad&a=1&id=x`;
  assert.equal(validateUri(badAddr).ok, false);
  // просрочка
  const exp = `agtpay:v1?n=AGENTCOIN&g=${gHash.slice(0, 16)}&to=${w.address}&a=1&id=x&exp=${Math.floor(Date.now() / 1000) - 10}`;
  assert.equal(validateUri(exp).ok, false, 'просроченный инвойс отвергнут');
  // чужой genesis-pin (expected full ≠ префикс uri)
  const other = core.sha256d('OTHER-NET');
  const v2 = validateUri(uri, other);
  assert.equal(v2.ok, false, 'чужой genesis-pin отвергнут');
  assert.match(v2.error, /genesis_prefix_mismatch/);
});

// ---- R-09: квитанция на синтетической цепи ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-rcpt-'));
const bc = new core.Blockchain(tmp);
const miner = core.createWallet('rcpt-miner');
const rx = core.createWallet('rcpt-rx');
bc.mineOnce(miner.address); // баланс 50
const tx = { from: miner.address, fromPub: miner.pub, to: rx.address, amount: 5, nonce: 1001, ts: Math.floor(Date.now() / 1000), memo: 'rcpt-test' };
tx.signature = core.signTransaction(tx, miner.privKey);
tx.txid = core.txDigest(tx);
const r = bc.addTransaction(tx);
if (!r.ok) { console.error('fixture tx rejected: ' + JSON.stringify(r)); process.exit(9); }
const blk = bc.mineOnce(miner.address);
if (!blk || blk.rejected) { console.error('fixture mine rejected: ' + JSON.stringify(blk)); process.exit(9); }
const block = bc.chain[bc.chain.length - 1];
const txIndex = block.txs.findIndex(t => t.txid === tx.txid);

// строим merkle-ветку ровно как node.mjs /txproof
let level = block.txs.map(t => t.txid);
let idx = txIndex;
const branch = [];
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) {
    const a = level[i], b = level[i + 1] || a;
    next.push(core.sha256d(a + b));
  }
  const partnerIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
  const partner = partnerIdx < level.length ? level[partnerIdx] : level[idx];
  branch.push({ hash: partner, side: idx % 2 === 0 ? 'right' : 'left' });
  idx = Math.floor(idx / 2);
  level = next;
}
const invoice = { payee: rx.address, amount: 5 };
const receipt = {
  version: 1, network: core.networkChainId(), genesisHash: bc.genesisHeader ? core.computeBlockHash(bc.genesisHeader) : tx.txid,
  txid: tx.txid, tx, height: block.height, blockHash: block.hash, txIndex, merkleBranch: branch,
  header: { version: block.header.version, prevHash: block.header.prevHash, merkleRoot: block.header.merkleRoot, timestamp: block.header.timestamp, difficultyBits: block.header.difficultyBits, nonce: block.header.nonce, chainId: block.header.chainId },
};

// прогон verify-receipt как child (тот же контракт, что и у внешнего пользователя)
import { spawnSync } from 'node:child_process';
function runVerifier(receiptObj, extraArgs = []) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agt-vr-')), 'r.json');
  fs.writeFileSync(f, JSON.stringify(receiptObj, null, 2));
  const p = spawnSync(process.execPath, [path.join(process.cwd(), 'tools', 'verify-receipt.mjs'), f, ...extraArgs], { encoding: 'utf8', env: { ...process.env } });
  return { code: p.status, out: String(p.stdout || '') + String(p.stderr || '') };
}

test('R-09: честная квитанция верифицируется (merkle+blockHash+PoW+подпись+txid)', () => {
  const r1 = runVerifier({ ...receipt, ...invoice });
  assert.equal(r1.code, 0, r1.out.slice(0, 400));
  assert.match(r1.out, /RECEIPT VERIFIED/);
  assert.match(r1.out, /merkle: txid → merkleRoot включён/);
  assert.match(r1.out, /подпись v1 валидна/);
});

test('R-09: tampers — сумма, адрес, ветка, merkleRoot, высота', () => {
  // подмена суммы квитанции к оплачиваемой
  const rA = runVerifier({ ...receipt, ...invoice, amount: 6 });
  assert.equal(rA.code, 1);
  assert.match(rA.out, /tx\.amount=5 ≠ 6/);
  // подмена получателя
  const other = core.createWallet('r9other');
  const rB = runVerifier({ ...receipt, ...invoice, payee: other.address });
  assert.equal(rB.code, 1);
  assert.match(rB.out, /tx\.to=.*≠ payee/);
  // повреждение merkle-ветки
  const rC = runVerifier({ ...receipt, ...invoice, merkleBranch: [...receipt.merkleBranch.slice(0, -1), { ...receipt.merkleBranch[receipt.merkleBranch.length - 1], hash: core.sha256d('crowbar') }] });
  assert.equal(rC.code, 1);
  assert.match(rC.out, /merkle root mismatch/);
  // чужой header (ткань PoW/merkle): меняем nonce → blockHash неканоничен
  const rD = runVerifier({ ...receipt, ...invoice, header: { ...receipt.header, nonce: receipt.header.nonce + 1 } });
  assert.equal(rD.code, 1);
  assert.match(rD.out, /blockHash recomputed=|PoW не соответствует/);
});

test('R-09: tamper tx-контента (напр., amount) ломает merkle/txid даже при «правильном» txid-поле в квитанции', () => {
  const rE = runVerifier({ ...receipt, ...invoice, tx: { ...tx, amount: 4 } });
  assert.equal(rE.code, 1);
  assert.match(rE.out, /txid не соответствует каноническому digest tx/);
});
