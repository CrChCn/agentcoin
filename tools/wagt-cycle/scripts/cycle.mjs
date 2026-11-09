// Тестовый цикл торговли AGT: lock AGT -> mint wAGT -> swap в пуле ->
// burn wAGT -> release AGT. Изолированная нода Agentcoin + локальная EVM
// (Hardhat in-process, chainId 31337). Только тестовые средства.
//
// Повтор:  cd tools/wagt-cycle && npm install && npm run cycle
// Выход:   cycle-report.json (адреса, хеши, сверки) + exit 0/1.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import hre from 'hardhat';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ROOT_URL = new URL('../../..', import.meta.url);
const { signTransaction, txDigest } = await import(new URL('core.mjs', ROOT_URL));
const { recoverFromMnemonic } = await import(new URL('bip39-lite.mjs', ROOT_URL));

const E18 = 10n ** 18n;
// Пороги зрелости (число подтверждений, env-переопределяемые):
// депозит AGT доступен для mint, когда tip-блоки - proofHeight >= MIN_AGT_CONF;
// burn wAGT разрешает release, когда evmTip - burnBlock >= MIN_EVM_CONF
// и событие burn — в канонической цепи. Откат, убравший подтверждённое
// событие, ОСТАНАВЛИВАЕТ направление (halt); снимается только вручную.
const MIN_AGT_CONF = Math.max(0, Number(process.env.WAGT_MIN_AGT_CONF || 2));
const MIN_EVM_CONF = Math.max(0, Number(process.env.WAGT_MIN_EVM_CONF || 2));
const routeHalt = { agt2evm: null, evm2agt: null }; // {reason, detail, at}
function haltRoute(dir, reason, detail) {
  routeHalt[dir] = { reason, detail: String(detail || '').slice(0, 200), at: new Date().toISOString() };
  log(`  HALT ${dir}: ${reason} (${routeHalt[dir].detail}) — новые операции остановлены`);
  return { halted: true, reason };
}
function operatorResetHalt(dir, why) {
  const prev = routeHalt[dir]; routeHalt[dir] = null;
  log(`  operator: halt ${dir} снят вручную (${why}), было: ${prev?.reason || '—'}`);
}
const out = [];
const log = (m) => { out.push(m); console.log(m); };
const fails = [];
const check = (cond, m) => { log((cond ? '  ok: ' : '  FAIL: ') + m); if (!cond) fails.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// ---------- изолированная нода Agentcoin ----------
async function startAgtNode(dataDir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'node.mjs'), String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGT_DATA_DIR: dataDir, AGT_BIND: '127.0.0.1',
      AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0',
      AGT_IDENTITY_ROLE: 'replica', AGT_IDENTITY_AUDIENCE: `wagt-cycle:${port}` },
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs = (logs + c.toString()).slice(-8000); });
  child.stderr.on('data', (c) => { logs = (logs + c.toString()).slice(-8000); });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('agentcoin node exited: ' + logs);
    try {
      const r = await fetch(origin + '/life', { signal: AbortSignal.timeout(3000) });
      if (r.status === 200) return { child, origin,
        stop: async () => { if (child.exitCode !== null) return;
          const ended = new Promise((r) => child.once('exit', r));
          child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref?.();
          await ended; } };
    } catch {}
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('agentcoin node not ready: ' + logs);
}

const jpost = async (origin, p, b) => {
  const r = await fetch(origin + p, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b), signal: AbortSignal.timeout(15000) });
  let body = {};
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
};
const jget = async (origin, p) => {
  const r = await fetch(origin + p, { signal: AbortSignal.timeout(15000) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function mineTo(origin, miner, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const m = await jpost(origin, '/mine', { miner });
    if (m.status === 200) return m.body;
    await sleep(400);
  }
  throw new Error('mine failed: ' + JSON.stringify((await jpost(origin, '/mine', { miner })).body).slice(0, 160));
}
async function agtTip() { const l = await jget(origin, '/life'); return Number(l.body.blocks); }
async function agtBalance(origin, address) {
  const b = await jpost(origin, '/balance', { address });
  const v = b.body.balanceMGNT ?? b.body.balance;
  return Number(v);
}
function signAgtTx(from, fromPub, privKey, to, amount, memo) {
  const tx = { from, fromPub, to, amount, nonce: Date.now() + Math.floor(Math.random() * 999),
    ts: Math.floor(Date.now() / 1000), memo };
  tx.signature = signTransaction(tx, privKey);
  tx.txid = txDigest(tx);
  return tx;
}

log('== wAGT trade cycle (test funds only) ==');
const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wagt-cycle-'));
const dataDir = path.join(workdir, 'agt-data');
const port = await freePort();
let node = await startAgtNode(dataDir, port);
const origin = node.origin;
log(`agentcoin node: ${origin} datadir=${dataDir}`);

// --- кошельки: пользователь, хранилище (vault), LP-спонсор ---
async function mkWallet(label) {
  const r = await jpost(origin, '/wallet/create', { label });
  if (r.status !== 201 && r.status !== 200) throw new Error('wallet/create failed: ' + JSON.stringify(r.body).slice(0, 200));
  const words = String(r.body.mnemonic || '');
  const rec = words ? recoverFromMnemonic(words, label).wallet : {};
  return { address: r.body.address, pub: r.body.pub || rec.pub,
    privKey: r.body.privKey || rec.privKey };
}
const user = await mkWallet('wagt-user');
const vault = await mkWallet('wagt-vault');
const sink = await mkWallet('wagt-sink'); // получатель coinbase: балансы user/vault меняются только целевыми tx
log(`user=${user.address} vault=${vault.address}`);
await mineTo(origin, user.address); // разовый прогрев: дальше все печати — на sink
check(await agtBalance(origin, user.address) > 0, `coinbase пользователю (bal=${await agtBalance(origin, user.address)})`);

// --- LOCK #1 (ликвидность пула): 40 AGT -> vault (один coinbase=50) ---
const LOCK1 = 40, LOCK2 = 5;
async function lockAgt(fromW, to, amount, depositId) {
  const memo = `wagt-deposit:${depositId}`;
  const tx = signAgtTx(fromW.address, fromW.pub, fromW.privKey, to, amount, memo);
  const sub = await jpost(origin, '/tx', tx);
  if (sub.status !== 200 && sub.status !== 201) throw new Error('lock submit failed: ' + JSON.stringify(sub.body).slice(0, 200));
  await mineTo(origin, sink.address);
  const proof = await jget(origin, '/txproof/' + tx.txid);
  return { tx, proofOk: proof.status === 200, height: proof.body?.height };
}
const dep1 = 'dep-' + Date.now().toString(16) + '-liq';
const L1 = await lockAgt(user, vault.address, LOCK1, dep1);
check(L1.proofOk, `lock#1 ${LOCK1} AGT в блоке #${L1.height}, txid=${L1.tx.txid.slice(0, 16)}…`);
check(await agtBalance(origin, vault.address) === LOCK1, `vault держит ${LOCK1} AGT`);

// ---------- EVM: деплой ----------
log('compiling + deploying EVM contracts…');
await hre.run('compile');
const [bridge, lp, trader] = await hre.ethers.getSigners();
const WAGT = await hre.ethers.getContractFactory('WAGT', bridge);
const wagt = await WAGT.deploy(bridge.address);
await wagt.waitForDeployment();
const TAGT = await hre.ethers.getContractFactory('TAGT', bridge);
const tagt = await TAGT.deploy();
await tagt.waitForDeployment();
const Pool = await hre.ethers.getContractFactory('TestPool', bridge);
const pool = await Pool.deploy(await wagt.getAddress(), await tagt.getAddress());
await pool.waitForDeployment();
const A = {
  wagt: await wagt.getAddress(), tagt: await tagt.getAddress(), pool: await pool.getAddress(),
  bridge: bridge.address, lp: lp.address, trader: trader.address,
};
log(`WAGT=${A.wagt} TAGT=${A.tagt} POOL=${A.pool}`);

// --- MINT #1 против lock#1 (релейер сверяет цепь, идемпотентность по depositId) ---
const ledger = {}; // depositId -> {agtTxid, amount, mintTx}
async function relayMint(depositId, agtTxid, amountAgt, to) {
  if (routeHalt.agt2evm) return { halted: true, reason: routeHalt.agt2evm.reason };
  if (ledger[depositId]) return { duplicate: true, mintTx: ledger[depositId].mintTx };
  // сверка с цепью: lock-tx входит в запечатанный блок (txproof 200) И набрал порог.
  // До порога — отказ lock_immature (не очередь, не mint): реорг ещё может унести событие.
  const proof = await jget(origin, '/txproof/' + agtTxid);
  if (proof.status !== 200 || typeof proof.body?.height !== 'number')
    return { notMature: true, reason: 'lock_event_missing' };
  const depth = (await agtTip()) - proof.body.height;
  if (depth < MIN_AGT_CONF) return { notMature: true, reason: 'lock_immature', depth };
  const t = await wagt.mint(to, BigInt(amountAgt) * E18,
    hre.ethers.id(depositId), agtTxid);
  const rc = await t.wait();
  ledger[depositId] = { agtTxid, amount: amountAgt, mintTx: rc.hash };
  return { duplicate: false, mintTx: rc.hash };
}
// Ворота release: burn должен быть зрел (порог EVM) и присутствовать в канонической
// цепи. Исчезнувшее событие (откат после выдачи) — halt направления: новые операции
// по маршруту останавливаются, причина фиксируется для разбора.
async function relayReleaseGate(burnTxHash) {
  if (routeHalt.evm2agt) return { halted: true, reason: routeHalt.evm2agt.reason };
  const rc = await hre.ethers.provider.getTransactionReceipt(burnTxHash);
  if (!rc || Number(rc.status) !== 1) return haltRoute('evm2agt', 'burn_event_vanished', burnTxHash.slice(0, 18));
  const tip = await hre.ethers.provider.getBlockNumber();
  const depth = tip - rc.blockNumber;
  if (depth < MIN_EVM_CONF) return { notMature: true, reason: 'burn_immature', depth };
  return { mature: true, blockNumber: rc.blockNumber, depth };
}
// до порога: mint недоступен (lock_immature), после добора блоков — доступен
const M1early = await relayMint(dep1, L1.tx.txid, LOCK1, lp.address);
check(M1early.notMature === true && M1early.reason === 'lock_immature',
  `mint до порога ${MIN_AGT_CONF} отклонён (lock_immature, depth=${M1early.depth})`);
for (let i = 0; i < MIN_AGT_CONF; i++) await mineTo(origin, sink.address);
const M1 = await relayMint(dep1, L1.tx.txid, LOCK1, lp.address);
check(!M1.duplicate && M1.mintTx, `mint#1 ${LOCK1} wAGT <- deposit ${dep1}, evmTx=${M1.mintTx.slice(0, 18)}…`);
// повтор того же депозита — двойного выпуска нет
const M1dup = await relayMint(dep1, L1.tx.txid, LOCK1, lp.address);
check(M1dup.duplicate === true, 'релейер отклонил повтор deposit#1 (no double mint, off-chain)');
let replayReverted = false;
try {
  await (await wagt.mint(lp.address, BigInt(LOCK1) * E18, hre.ethers.id(dep1), L1.tx.txid)).wait();
} catch (e) { replayReverted = /deposit_replayed/.test(String(e).slice(0, 300)); }
check(replayReverted, 'контракт отклонил повтор deposit#1 (deposit_replayed, on-chain)');

// --- ликвидность пула: 40 wAGT + 400 tAGT (1:10) ---
await (await tagt.faucet(lp.address, 400n * E18)).wait();
await (await wagt.connect(lp).approve(A.pool, 40n * E18)).wait();
await (await tagt.connect(lp).approve(A.pool, 400n * E18)).wait();
await (await pool.connect(lp).addLiquidity(40n * E18, 400n * E18)).wait();
const [r0, r1] = [await pool.reserve0(), await pool.reserve1()];
check(r0 === 40n * E18 && r1 === 400n * E18, `пул: 40 wAGT / 400 tAGT (x*y=k)`);

// --- LOCK #2 (пользователь): 25 AGT -> vault; MINT #2 -> trader ---
const dep2 = 'dep-' + Date.now().toString(16) + '-trade';
const L2 = await lockAgt(user, vault.address, LOCK2, dep2);
check(L2.proofOk, `lock#2 ${LOCK2} AGT, txid=${L2.tx.txid.slice(0, 16)}…`);
for (let i = 0; i < MIN_AGT_CONF; i++) await mineTo(origin, sink.address);
const M2 = await relayMint(dep2, L2.tx.txid, LOCK2, trader.address);
check(!M2.duplicate, `mint#2 ${LOCK2} wAGT трейдеру, evmTx=${M2.mintTx.slice(0, 18)}…`);

// --- SWAP: 10 wAGT -> tAGT ---
const SWAP_IN = 2n * E18;
await (await wagt.connect(trader).approve(A.pool, SWAP_IN)).wait();
const expectedOut = await pool.quoteOut(await pool.reserve0(), await pool.reserve1(), SWAP_IN);
const stx = await pool.connect(trader).swapExactIn(A.wagt, SWAP_IN, 0, trader.address);
const src = await stx.wait();
const tagtBal = await tagt.balanceOf(trader.address);
check(tagtBal === expectedOut && tagtBal > 0, `swap 2 wAGT -> ${hre.ethers.formatUnits(tagtBal, 18)} tAGT (V2-формула, evmTx=${src.hash.slice(0, 18)}…)`);

// --- BURN остатка wAGT (15) -> RELEASE 15 AGT из vault ---
const wBal = await wagt.balanceOf(trader.address);
check(wBal === 3n * E18, `остаток трейдера ровно 3 wAGT (5-2)`);
const btx = await wagt.connect(trader).burn(wBal, user.address);
const brc = await btx.wait();
log(`burn 3 wAGT, evmTx=${brc.hash.slice(0, 18)}…`);
for (let i = 0; i < MIN_EVM_CONF; i++) await hre.network.provider.send('evm_mine', []);
const Gmain = await relayReleaseGate(brc.hash);
check(Gmain.mature === true, `burn зрел после порога ${MIN_EVM_CONF} (depth=${Gmain.depth}) — release разрешён`);
const userBefore = await agtBalance(origin, user.address);
const relTx = signAgtTx(vault.address, vault.pub, vault.privKey, user.address, 3, `wagt-release:${brc.hash}`);
const relSub = await jpost(origin, '/tx', relTx);
check(relSub.status === 200 || relSub.status === 201, `release 3 AGT, txid=${relTx.txid.slice(0, 16)}…`);
await mineTo(origin, sink.address);
check(await agtBalance(origin, user.address) === userBefore + 3, 'пользователь получил 3 AGT обратно');

// --- инвариант backing: vault == totalSupply wAGT ---
const vaultBal = await agtBalance(origin, vault.address);
const supply = await wagt.totalSupply();
const supplyAgt = Number(supply / E18);
check(vaultBal === LOCK1 + LOCK2 - 3 && supplyAgt === vaultBal,
  `резерв сходится: vault=${vaultBal} AGT == wAGT supply=${supplyAgt}`);

// --- R: откаты до/после порога + остановка маршрута (B1) ---
// R0: событие AGT отсутствует — отказ без mint.
const Rres = {};
const R0 = await relayMint('dep-bogus-' + Date.now().toString(16), '00'.repeat(32), 1, trader.address);
Rres.agtMissingRefused = R0.notMature === true && R0.reason === 'lock_event_missing';
check(Rres.agtMissingRefused, 'R0 неизвестный lock-tx → lock_event_missing, mint нет');
// R1: свежий lock 1 AGT — до порога отказ, после добора блоков — mint.
// Круговой возврат (burn+release следом), чтобы инвариант не сдвинулся.
const depR = 'dep-' + Date.now().toString(16) + '-reorg';
const LR = await lockAgt(user, vault.address, 1, depR);
const R1early = await relayMint(depR, LR.tx.txid, 1, trader.address);
Rres.agtGateBeforeThreshold = R1early.notMature === true && R1early.reason === 'lock_immature';
check(Rres.agtGateBeforeThreshold, `R1 до порога ${MIN_AGT_CONF}: lock_immature (depth=${R1early.depth})`);
for (let i = 0; i < MIN_AGT_CONF; i++) await mineTo(origin, sink.address);
const R1 = await relayMint(depR, LR.tx.txid, 1, trader.address);
check(!R1.duplicate && R1.mintTx, `R1 после порога: mint 1 wAGT (${(R1.mintTx || '').slice(0, 18)}…)`);
// R2: burn -> зрелость -> откат EVM (evm_revert) стирает подтверждённое событие -> halt.
const evm = hre.ethers.provider;
const snapR = await evm.send('evm_snapshot', []);
const bR = await (await wagt.connect(trader).burn(E18, user.address)).wait();
for (let i = 0; i < MIN_EVM_CONF; i++) await evm.send('evm_mine', []);
const GRmature = await relayReleaseGate(bR.hash);
Rres.evmGateMatured = GRmature.mature === true;
check(Rres.evmGateMatured, `R2 burn зрел после порога ${MIN_EVM_CONF} (depth=${GRmature.depth})`);
await evm.send('evm_revert', [snapR]); // откат ПОСЛЕ порога: подтверждённое событие исчезло
const GRgone = await relayReleaseGate(bR.hash);
Rres.reorgHaltedRoute = GRgone.halted === true && GRgone.reason === 'burn_event_vanished';
check(Rres.reorgHaltedRoute, 'R2 после отката: burn_event_vanished, направление остановлено');
const GRagain = await relayReleaseGate(bR.hash);
check(GRagain.halted === true, 'R2 новые release по маршруту блокированы halt');
check(routeHalt.agt2evm === null, 'R2 halt затронул только evm2agt (mint-направление открыто)');
// Разбор завершён (стенд): halt снимается ТОЛЬКО вручную, событие пересоздаётся заново.
operatorResetHalt('evm2agt', 'стенд R2: причина разобрана');
const userR0 = await agtBalance(origin, user.address);
const bR2 = await (await wagt.connect(trader).burn(E18, user.address)).wait();
for (let i = 0; i < MIN_EVM_CONF; i++) await evm.send('evm_mine', []);
const GR2 = await relayReleaseGate(bR2.hash);
Rres.haltResetRecovered = GR2.mature === true;
check(Rres.haltResetRecovered, 'R2 после сброса halt: burn зрел, release разрешён');
const relR = signAgtTx(vault.address, vault.pub, vault.privKey, user.address, 1, `wagt-release:${bR2.hash}`);
const relRsub = await jpost(origin, '/tx', relR);
check(relRsub.status === 200 || relRsub.status === 201, `R2 release 1 AGT, txid=${relR.txid.slice(0, 16)}…`);
await mineTo(origin, sink.address);
check(await agtBalance(origin, user.address) === userR0 + 1, 'R2 пользователь получил 1 AGT обратно');
const vaultBalR = await agtBalance(origin, vault.address);
const supplyR = Number((await wagt.totalSupply()) / E18);
check(vaultBalR === vaultBal && supplyR === supplyAgt, `R-инвариант: vault=${vaultBalR} == supply=${supplyR} (как до R)`);

// --- рестарт ноды: баланс резерва сходится ---
await node.stop();
node = await startAgtNode(dataDir, port);
check(await agtBalance(node.origin, vault.address) === vaultBal,
  `после рестарта vault=${await agtBalance(node.origin, vault.address)} AGT (было ${vaultBal})`);
check((await jpost(node.origin, '/balance', { address: user.address })).status === 200, 'нода отвечает после рестарта');
await node.stop();

// --- отчёт ---
const report = {
  evmChainId: 31337,
  contracts: A,
  agt: { user: user.address, vault: vault.address,
    lockTx1: L1.tx.txid, lockTx2: L2.tx.txid, releaseTx: relTx.txid },
  evmTx: { mint1: M1.mintTx, mint2: M2.mintTx, swap: src.hash, burn: brc.hash },
  amounts: { lock1: LOCK1, lock2: LOCK2, swapInWagt: '2', burnWagt: '3', releaseAgt: 3 },
  checks: { replayBlockedOffchain: true, replayBlockedOnchain: replayReverted,
    minAgtConf: MIN_AGT_CONF, minEvmConf: MIN_EVM_CONF, ...Rres,
    reserveAfterRestart: vaultBal, wagtSupply: supplyAgt, backingInvariant: vaultBal === supplyAgt },
};
await fs.promises.writeFile(path.join(ROOT, 'tools', 'wagt-cycle', 'cycle-report.json'),
  JSON.stringify(report, null, 2));
log('report: tools/wagt-cycle/cycle-report.json');
if (fails.length) { console.error(`\nWAGT-CYCLE: FAIL (${fails.length}): ${fails.join('; ')}`); process.exit(1); }
log('\nWAGT-CYCLE: OK — lock/mint/swap/burn/release, replay заблокирован, резерв сошёлся.');
process.exitCode = 0;
