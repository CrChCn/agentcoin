/* bridge-vault-2of3 — доказательство механизма vault 2-of-3 (У1), локально, без сети.
   Показывает: (а) расход с vault без второй подписи отвергается; (б) подпись НЕ из
   allowlist отвергается; (в) vault-ключ + 1 подпись аттестора — принимается и ходит
   в блок; (г) БЕЗ политики (policy=null) тот же ключ тратит единолично — т.е.
   контроль даёт привязка политики на проверяющих нодах, а не сам ключ.
   Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Blockchain, createWallet, signTransaction, txDigest } from '../core.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-vault-'));
const bc = new Blockchain(dir);

const vault = createWallet('vault-operator');
const attestor = createWallet('attestor-1');
const stranger = createWallet('stranger');
const user = createWallet('user');

// финансируем vault: coinbase прямо на адрес оператора vault
for (let i = 0; i < 3; i++) bc.mineOnce(vault.address);
if (!((bc.balances()[vault.address] || 0) > 100)) fails.push('vault не профинансирован');

// привязка политики: федерация обязана держать ИДЕНТИЧНУЮ политику на своих нодах
const policy = { treasury: vault.address, signers: [attestor.address], requires: 2 };
bc.treasuryPolicyFn = () => policy;

function releaseTx() {
  const tx = { from: vault.address, fromPub: vault.pub, to: user.address, amount: 5, nonce: Date.now() + Math.floor(Math.random() * 1e6), ts: Math.floor(Date.now() / 1000), memo: 'bridge_release:v1:AGT-WAGT-V1:' + 'ab'.repeat(32) };
  tx.signature = signTransaction(tx, vault.privKey);
  return tx;
}

// (а) один ключ оператора — отказ
let r = bc.addTransaction(releaseTx());
eq(r.ok, false, 'а: релиз без sig2 отклонён');
eq(r.reason, 'treasury_needs_2sig', 'а: причина treasury_needs_2sig');

// (б) вторая подпись чужим ключом — отказ
{
  const tx = releaseTx();
  tx.sig2Pub = stranger.pub;
  tx.sig2 = crypto.sign(null, Buffer.from(txDigest(tx), 'hex'), stranger.privKey).toString('hex');
  r = bc.addTransaction(tx);
  eq(r.ok, false, 'б: sig2 не из allowlist отклонён');
}

// (в) vault-ключ + аттестор — принято и упаковано в блок
{
  const tx = releaseTx();
  tx.sig2Pub = attestor.pub;
  tx.sig2 = crypto.sign(null, Buffer.from(txDigest(tx), 'hex'), attestor.privKey).toString('hex');
  r = bc.addTransaction(tx);
  eq(r.ok, true, 'в: 2 подписи приняты в мемпул');
  const before = bc.balances()[user.address] || 0;
  bc.mineOnce(vault.address);
  eq((bc.balances()[user.address] || 0) - before, 5, 'в: релиз дошёл в блоке');
}

// (г) контрольная: без политики тот же ключ тратит единолично (У1 — честная оговорка)
{
  bc.treasuryPolicyFn = null;
  const tx = releaseTx();
  r = bc.addTransaction(tx);
  eq(r.ok, true, 'г: без политики оператор тратит один (кастодиальный факт зафиксирован)');
}

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('bridge-vault-2of3: ALL GREEN');
