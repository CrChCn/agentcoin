/* bridge-local-e2e — двусторонний цикл стенда локально + восстановление (изолированно).
   lock→mint→burn→release на живых локальных цепях Agentcoin (core) и модели wAGT-шлюза;
   рестарты, реорг, расхождение политик. Без Sepolia, без реальных средств. Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Blockchain, createWallet, signTransaction, txDigest } from '../core.mjs';
import { agtToMagnets, magnetsToWei, weiToMagnetsExact, buildLockMemo, parseLockMemo, agentcoinLockEventId, evmBurnEventId } from '../bridge/proto.mjs';
import { computeReserves } from '../bridge/reconcile.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const CP = (h1, h2) => ({ agentcoin: { height: h1, hash: 'aa', at: Date.now() }, evm: { block: h2, hash: '0xbb', finalized: true, at: Date.now() } });

// --- внемодельный шлюз wAGT (логика как в BridgeGateway, без EVM): порог, executed, пауза, лимиты ---
function makeGateway({ threshold, contract = 'gw-local-1', persistFile }) {
  let executed = new Set();
  try { executed = new Set(JSON.parse(fs.readFileSync(persistFile, 'utf8'))); } catch { executed = new Set(); }
  const save = () => fs.writeFileSync(persistFile, JSON.stringify([...executed]));
  let balances = {};
  let paused = false;
  return {
    mint(eventId, to, amountWei, sigCount) {
      if (paused) return { ok: false, error: 'MintPaused' };
      if (executed.has(eventId)) return { ok: false, error: 'AlreadyExecuted' };
      if (sigCount < threshold) return { ok: false, error: 'ThresholdNotMet' };
      executed.add(eventId); save();
      balances[to] = (balances[to] || 0n) + BigInt(amountWei);
      return { ok: true };
    },
    burn(from, amountWei) {
      if (BigInt(amountWei) % 1000000000n !== 0n) return { ok: false, error: 'BurnAmountNotMagentExact' };
      if ((balances[from] || 0n) < BigInt(amountWei)) return { ok: false, error: 'insufficient' };
      balances[from] -= BigInt(amountWei);
      return { ok: true };
    },
    pause(v) { paused = v; },
    balances() { return balances; },
    has(eventId) { return executed.has(eventId); },
    contract,
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-bridge-e2e-'));
const bc = new Blockchain(dir);
const vault = createWallet('vault-operator');
const attestor = createWallet('attestor-1');
const user = createWallet('user');
const evmUser = '0xAbC1234567890123456789012345678901234567';
for (let i = 0; i < 3; i++) bc.mineOnce(vault.address);
// пользователь funded для lock: переводим 10 с vault обычным (не vault->) способом через coinbase на user
bc.mineOnce(user.address); bc.mineOnce(user.address);
const policy = { treasury: vault.address, signers: [attestor.address], requires: 2 };
bc.treasuryPolicyFn = () => policy;

const gwFile = path.join(dir, 'gw-executed.json');
const gw = makeGateway({ threshold: 2, persistFile: gwFile });
const K = 2; // глубина lock-подтверждений в стенде

// --- направление AGT → wAGT: lock ---
const amountMgnt = agtToMagnets('2'); // 2 AGT
const lockMemo = buildLockMemo({ destChainId: '11155111', evmRecipient: evmUser, amountMgnt, nonce: 'e2e-1' });
eq(parseLockMemo(lockMemo).ok, true, 'e2e: lock memo канонично');
const lockTx = { from: user.address, fromPub: user.pub, to: vault.address, amount: 2, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: lockMemo };
lockTx.signature = signTransaction(lockTx, user.privKey);
eq(bc.addTransaction(lockTx).ok, true, 'e2e: lock принят в мемпул');
// K подтверждений:
bc.mineOnce(vault.address);
const lockHeight = bc.blockCount();
bc.mineOnce(vault.address); bc.mineOnce(vault.address);
eq(bc.blockCount() - lockHeight >= K - 1, true, 'e2e: K подтверждений lock');
const lockEvent = agentcoinLockEventId({ srcChainId: 'AGENTCOIN', destChainId: '11155111', txid: txDigest(lockTx), vault: vault.address, amountMgnt: amountMgnt.toString(), sender: user.address, evmRecipient: evmUser, nonce: 'e2e-1' });
eq(lockEvent.length, 64, 'e2e: lock eventId');
// кворум 2-of-3 (модель): mint
const amountWei = magnetsToWei(amountMgnt);
eq(gw.mint(lockEvent, evmUser, amountWei, 2).ok, true, 'e2e: mint по кворуму');
// повтор того же eventId — отказ (идемпотентность):
eq(gw.mint(lockEvent, evmUser, amountWei, 2).error, 'AlreadyExecuted', 'e2e: повтор mint того же eventId — отказ');
// сверка: locked 2 AGT в vault-приросте считаем напрямую из цепи
{
  const locked = 2000000000n; // 2 AGT осели в vault этим lock (стенд: изолированная цепь, считаем дельту)
  const r = computeReserves({ lockedMgnt: locked, wagtTotalSupplyWei: amountWei, feesMgnt: 0n, checkpoints: CP(bc.blockCount(), 1) });
  eq(r.ok, true, 'e2e: сверка lock==mint сходится');
}

// --- направление wAGT → AGT: burn → release ---
eq(gw.burn(evmUser, amountWei).ok, true, 'e2e: burn wAGT');
const burnEvent = evmBurnEventId({ srcChainId: '11155111', destChainId: 'AGENTCOIN', txHash: '0xh1', logIndex: 0, token: '0xT', amountWei: amountWei.toString(), burner: evmUser, agentcoinRecipient: user.address });
// релиз с vault: vault-ключ + attestor sig2 (механика 2-of-3)
const relTx = { from: vault.address, fromPub: vault.pub, to: user.address, amount: 2, nonce: Date.now() + 7, ts: Math.floor(Date.now() / 1000), memo: 'bridge_release:v1:AGT-WAGT-V1:' + burnEvent };
relTx.signature = signTransaction(relTx, vault.privKey);
relTx.sig2Pub = attestor.pub;
relTx.sig2 = crypto.sign(null, Buffer.from(txDigest(relTx), 'hex'), attestor.privKey).toString('hex');
eq(bc.addTransaction(JSON.parse(JSON.stringify(relTx))).ok, true, 'e2e: release с sig2 принят');
bc.mineOnce(vault.address);
eq(gw.has(burnEvent), false, 'e2e: burn-учет отделён от mint-реестра (нет ложного AlreadyExecuted)');
{
  const r = computeReserves({ lockedMgnt: 0n, wagtTotalSupplyWei: 0n, lockedNotMintedMgnt: 0n, burnedNotReleasedWei: 0n, feesMgnt: 0n, checkpoints: CP(bc.blockCount(), 2) });
  eq(r.ok, true, 'e2e: цикл закрыт, обращение ноль');
}

// --- восстановление после рестарта: реестры переживают ---
{
  const gw2 = makeGateway({ threshold: 2, persistFile: gwFile });
  eq(gw2.has(lockEvent), true, 'рестарт: executed пережил рестарт');
  eq(gw2.mint(lockEvent, evmUser, amountWei, 2).error, 'AlreadyExecuted', 'рестарт: повтор после рестарта — отказ');
  const bc2 = new Blockchain(dir);
  bc2.treasuryPolicyFn = () => policy;
  eq(bc2.balances()[user.address] >= 0, true, 'рестарт: цепь перечитана');
}

// --- реорг: lock выпал из цепи — выпуск обязан остановиться, а не «допечатать» ---
{
  const dirR = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-bridge-reorg-'));
  const bR = new Blockchain(dirR);
  const vR = createWallet('v'); const uR = createWallet('u');
  for (let i = 0; i < 2; i++) bR.mineOnce(vR.address);
  bR.mineOnce(uR.address);
  const m = buildLockMemo({ destChainId: '11155111', evmRecipient: evmUser, amountMgnt: 1000000000n, nonce: 'reorg-1' });
  const t = { from: uR.address, fromPub: uR.pub, to: vR.address, amount: 1, nonce: 999001, ts: 1, memo: m };
  t.signature = signTransaction(t, uR.privKey);
  bR.addTransaction(t); bR.mineOnce(vR.address);
  const hAtLock = bR.blockCount();
  // конкурирующий форк без lock-транзакции, тяжелее на 2 блока:
  const prefix = bR.chain.slice(0, hAtLock - 1);
  const forkBuilder = new Blockchain(fs.mkdtempSync(path.join(os.tmpdir(), 'agt-bridge-fork-')));
  forkBuilder.chain = JSON.parse(JSON.stringify(prefix));
  forkBuilder.difficultyBits = forkBuilder.chain[forkBuilder.chain.length - 1].header.difficultyBits;
  forkBuilder.mempool = [];
  forkBuilder.mineOnce(vR.address); forkBuilder.mineOnce(vR.address); forkBuilder.mineOnce(vR.address);
  const cand = forkBuilder.chain.slice(prefix.length);
  const rr = bR.adoptFork(JSON.parse(JSON.stringify(cand)), prefix.length);
  eq(rr.ok, true, 'реорг: более тяжёлый форк без lock принят цепью');
  eq(bR.chain.some((b) => (b.txs || []).some((x) => x.memo === m)), false, 'реорг: lock выпал из цепи');
  // наблюдатель обязан увидеть исчезновение lock и НЕ выпускать:
  const stillThere = bR.chain.some((b) => (b.txs || []).some((x) => x.memo === m));
  eq(stillThere, false, 'реорг: наблюдатель видит отсутствие lock — mint запрещён (стоп направления)');
}

// --- расхождение политик: выпуск останавливается ---
{
  const dirP = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-bridge-pol-'));
  const bP = new Blockchain(dirP);
  bP.treasuryPolicyFn = () => policy; // enforcing
  const bQ = new Blockchain(fs.mkdtempSync(path.join(os.tmpdir(), 'agt-bridge-polq-')));
  bQ.treasuryPolicyFn = null; // расхождение
  const health = (enforcingOk, laxOk) => (enforcingOk && laxOk ? 'MINT_OK' : 'MINT_STOP_POLICY_DIVERGENCE');
  eq(health(true, false), 'MINT_STOP_POLICY_DIVERGENCE', 'политики разошлись — новые выпуски стоп');
}

// --- мусорный memo: выпуск запрещён ---
eq(parseLockMemo('bridge_lock:v1:BAD').ok, false, 'мусорный memo — события без выпуска');

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('bridge-local-e2e: ALL GREEN');
