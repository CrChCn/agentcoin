/* bridge-policy-divergence — ответы на 3 вопроса владельца (изолированно, без сети).
   Доказывает кодом: порог vault — политика отдельных нод, а не общесетевое правило.
   Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Blockchain, createWallet, signTransaction, txDigest, validateBlockAgainstChain, chainWork } from '../core.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-polA-'));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-polB-'));
const enforcing = new Blockchain(dirA);
const lax = new Blockchain(dirB);

const vault = createWallet('vault-operator');
const attestor = createWallet('attestor-1');
const user = createWallet('user');

// Финансируем vault одинаково: копаем на адрес vault на обеих нодах (изолированные цепи).
for (let i = 0; i < 3; i++) { enforcing.mineOnce(vault.address); lax.mineOnce(vault.address); }

// Политика федерации — ТОЛЬКО на enforcing-ноде:
const policy = { treasury: vault.address, signers: [attestor.address], requires: 2 };
enforcing.treasuryPolicyFn = () => policy;
lax.treasuryPolicyFn = null; // оператор отключил / никогда не включал

function singleSigTx() {
  const tx = { from: vault.address, fromPub: vault.pub, to: user.address, amount: 5, nonce: Date.now() + Math.floor(Math.random() * 1e9), ts: Math.floor(Date.now() / 1000), memo: 'bridge_release:v1:test' };
  tx.signature = signTransaction(tx, vault.privKey);
  return tx;
}

// Вопрос 2 (мемпул): оператор без политики тратит один — enforcing отвергает, lax принимает.
{
  const tx1 = singleSigTx();
  const rE = enforcing.addTransaction(JSON.parse(JSON.stringify(tx1)));
  eq(rE.ok, false, 'В2-мемпул: enforcing отвергает расход без sig2');
  eq(rE.reason, 'treasury_needs_2sig', 'В2-мемпул: причина treasury_needs_2sig');
  const rL = lax.addTransaction(JSON.parse(JSON.stringify(tx1)));
  eq(rL.ok, true, 'В2-мемпул: нода без политики принимает единоличную трату');
}

// Вопрос 1: цепь с большим весом, содержащая расход без sig2.
// Общий префикс: клонируем цепь enforcing в lax (иначе prevHash разойдётся).
// Затем на lax строим более тяжёлый форк с единоличной тратой и предлагаем enforcing.
let forkBlocks;
{
  lax.chain = JSON.parse(JSON.stringify(enforcing.chain));
  lax.invalidateTxCache();
  const tx = singleSigTx();
  lax.addTransaction(tx);
  lax.mineOnce(vault.address);
  const tip = lax.chain[lax.chain.length - 1];
  eq(tip.txs.some((t) => t.from === vault.address && !t.sig2), true, 'форк-цепь содержит единоличную трату vault');
  // Кандидат тяжелее: добываем ещё блоки поверх, чтобы candWork > ourWork на enforcing.
  lax.mineOnce(vault.address);
  lax.mineOnce(vault.address);
  const d = enforcing.blockCount();
  forkBlocks = lax.chain.slice(d);
  eq(forkBlocks.length > 0, true, 'есть блоки-кандидаты для adoptFork');
  eq(forkBlocks[0].height, d, 'форк начинается с высоты расхождения');
  const before = enforcing.blockCount();
  const r = enforcing.adoptFork(JSON.parse(JSON.stringify(forkBlocks)), d);
  eq(r.ok, false, 'В1: enforcing-нода ОТВЕРГАЕТ более тяжёлую цепь с расходом без sig2');
  eq(String(r.reason || '').includes('treasury_needs_2sig'), true, 'В1: причина — treasury-правило в блоке');
  eq(enforcing.blockCount(), before, 'В1: цепь enforcing не изменилась');
  // Та же цепь на ноде без политики — принимается (расхождение политик = развилка сети).
  const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-polC-'));
  const lax2 = new Blockchain(dirC);
  for (let i = 0; i < d; i++) lax2.mineOnce(vault.address); // догоняем высоту тем же темпом
  lax2.treasuryPolicyFn = null;
  const r2 = lax2.adoptFork(JSON.parse(JSON.stringify(forkBlocks)), d);
  // lax2 имеет другую историю балансов, поэтому adopt может упасть по балансу, а не по политике;
  // ключевое — причина НЕ связана с sig2: политика её не требует.
  if (r2.ok) ok('В1-контроль: нода без политики тяжёлую цепь принимает');
  else eq(String(r2.reason).includes('tx_treasury_needs_2sig'), false, 'В1-контроль: без политики отказа по sig2 нет');
}

// Вопрос 3: политика — условие группы нод, а не общесетевое правило.
// Доказательство кодом: validateBlockAgainstChain без opts.treasury цепь принимает,
// с opts.treasury — отвергает. Один и тот же блок, разные решения.
{
  const tx = singleSigTx();
  // строим блок вручную через lax-ноду (политики нет — блок валиден для неё)
  const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-polD-'));
  const builder = new Blockchain(dirD);
  for (let i = 0; i < 2; i++) builder.mineOnce(vault.address);
  builder.treasuryPolicyFn = null;
  builder.addTransaction(JSON.parse(JSON.stringify(tx)));
  builder.mineOnce(vault.address);
  const blk = JSON.parse(JSON.stringify(builder.chain[builder.chain.length - 1]));
  const prefix = builder.chain.slice(0, blk.height);
  const reasonWith = validateBlockAgainstChain(blk, prefix, { treasury: policy });
  const reasonWithout = validateBlockAgainstChain(blk, prefix, { treasury: null });
  eq(reasonWith, 'tx_treasury_needs_2sig', 'В3: с политикой тот же блок — отказ');
  eq(reasonWithout, null, 'В3: без политики тот же блок — валиден');
}

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('bridge-policy-divergence: ALL GREEN — vault кастодиален, порог держится политикой нод, не консенсусом');
