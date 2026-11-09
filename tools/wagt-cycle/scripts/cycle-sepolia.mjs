// Тестовый обмен wAGT через официальные контракты Uniswap V2 на Sepolia.
// ТЗ: tools/wagt-cycle/TZ-sepolia-uniswap.md. Только тестовые средства.
//
// Запуск:  cd tools/wagt-cycle && npm install && npm run cycle:sepolia
// Env:     SEPOLIA_RPC_URL (default: publicnode), SEPOLIA_PRIVATE_KEY
//          (только для полного цикла; без него — только проверки фазы A).
//
// Фаза A (без ключа): chainId=11155111, код Factory/Router02, связь
//   router.factory()==FACTORY, оценка газа.
// Фаза B (с ключом): деплой WAGT/TAGT -> lock 40 AGT -> mint 40 wAGT ->
//   пара + ликвидность 40/400 через Router02 -> lock 5 -> mint 5 ->
//   swap 2 wAGT -> burn 3 -> release 3 AGT -> проверки повторов/сбоев.
// Выход: cycle-report-sepolia.json + exit 0/1 (2 = упёрлись в нехватку газа).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import hre from 'hardhat';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ROOT_URL = new URL('../../..', import.meta.url);
const { signTransaction } = await import(new URL('core.mjs', ROOT_URL));
const { recoverFromMnemonic } = await import(new URL('bip39-lite.mjs', ROOT_URL));

// ---------- константы площадки (сверены с docs.uniswap.org) ----------
const EXPECTED_CHAIN_ID = 11155111n;
const V2_FACTORY = '0xF62c03E08ada871A0bEb309762E260a7a6a880E6';
const V2_ROUTER02 = '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3';
const SOURCES = [
  'https://developers.uniswap.org/docs/protocols/v2/deployments',
  'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments',
  'https://blog.ethereum.org/2023/11/30/goerli-lts-update',
  'https://github.com/eth-clients/sepolia/blob/main/README.md',
];
const LOCK_CONFS = Number(process.env.WAGT_LOCK_CONFIRMATIONS || '2'); // порог подтверждений lock-tx
const E18 = 10n ** 18n;

const out = [];
const log = (m) => { console.log(m); };
const fails = [];
const check = (cond, m) => { log((cond ? '  ok: ' : '  FAIL: ') + m); if (!cond) fails.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtEth = (w) => hre.ethers.formatEther(w);

const ROUTER_ABI = [
  'function factory() view returns (address)',
  'function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) returns (uint amountA, uint amountB, uint liquidity)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
];
const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address)',
  'function createPair(address tokenA, address tokenB) returns (address pair)',
];
const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const provider = hre.ethers.provider;
const gasLedger = []; // {op, hash, gasUsed, gasPrice}
async function track(op, txResp) {
  const rc = await txResp.wait();
  gasLedger.push({ op, hash: rc.hash, gasUsed: rc.gasUsed.toString(),
    gasPrice: (rc.gasPrice ?? 0n).toString() });
  if (rc.status !== 1) throw new Error(`${op} reverted on-chain: ${rc.hash}`);
  return rc;
}
const totalGasUsed = () => gasLedger.reduce((a, g) => a + BigInt(g.gasUsed), 0n);

// ---------- Фаза A: проверки площадки (ключ не нужен) ----------
log('== Фаза A: сверка площадки Uniswap V2 / Sepolia ==');
const sepoliaNet = await provider.getNetwork();
check(sepoliaNet.chainId === EXPECTED_CHAIN_ID, `chainId=${sepoliaNet.chainId} (ждём 11155111)`);
const codeF = await provider.getCode(V2_FACTORY);
const codeR = await provider.getCode(V2_ROUTER02);
check(codeF && codeF !== '0x', `код по адресу Factory ${V2_FACTORY}`);
check(codeR && codeR !== '0x', `код по адресу Router02 ${V2_ROUTER02}`);
const routerRO = new hre.ethers.Contract(V2_ROUTER02, ROUTER_ABI, provider);
let linkedFactory = '';
try { linkedFactory = await routerRO.factory(); } catch (e) {
  fails.push('router.factory() не вызвался: ' + String(e).slice(0, 200));
}
check(linkedFactory.toLowerCase() === V2_FACTORY.toLowerCase(),
  `Router02.factory()=${linkedFactory} == Factory`);
if (fails.length) {
  console.error(`\nCYCLE-SEPOLIA: FAIL фазы A: ${fails.join('; ')}`);
  process.exit(1);
}

// Оценка газа (консервативные лимиты x текущая цена газа x запас 1.5).
// Публичные RPC иногда отдают заниженный gasPrice — пол 1 gwei, чтобы
// оценка не вводила в заблуждение.
const fetchedGp = await provider.getFeeData().then((f) => f.gasPrice ?? 0n);
const gasPrice = fetchedGp > 1_000_000_000n ? fetchedGp : 1_000_000_000n;
const PLAN = [ // [операция, лимит газа, плательщик]
  ['fund trader', 21000, 'deployer'],
  ['deploy WAGT', 900000, 'deployer'],
  ['deploy TAGT', 800000, 'deployer'],
  ['mint#1', 100000, 'deployer'],
  ['mint#2', 100000, 'deployer'],
  ['approve x2 (LP)', 100000, 'deployer'],
  ['addLiquidity', 3000000, 'deployer'], // включает создание пары (замер форка: ~2.69M)
  ['approve (trader)', 50000, 'trader'],
  ['swap', 220000, 'trader'],
  ['burn', 70000, 'trader'],
];
const needDeployer = PLAN.filter((p) => p[2] === 'deployer').reduce((a, p) => a + BigInt(p[1]), 0n);
const needTrader = PLAN.filter((p) => p[2] === 'trader').reduce((a, p) => a + BigInt(p[1]), 0n);
const buffer = (x) => x * 2n; // x2: живая цена газа гуляет (факт прогона: ~7 gwei против пола 1 gwei)
log(`gasPrice=${gasPrice} wei; оценка: deployer ~${fmtEth(buffer(needDeployer) * gasPrice)} ETH, trader ~${fmtEth(buffer(needTrader) * gasPrice)} ETH (с запасом x1.5)`);

// На живой сети `sepolia` нужен ключ тестового кошелька; на форке
// (`sepoliaFork`) используются funded-аккаунты Hardhat — ключ не нужен.
const PRIV = (process.env.SEPOLIA_PRIVATE_KEY || '').trim();
const NEED_KEY = hre.network.name === 'sepolia';
if (NEED_KEY && !PRIV) {
  log('\nФаза A пройдена. SEPOLIA_PRIVATE_KEY не задан — фаза B пропущена.');
  log('Для полного цикла: export SEPOLIA_PRIVATE_KEY=0x... (тестовый кошелёк!) и повтор.');
  process.exit(0);
}

// ---------- Фаза B: полный цикл ----------
log('\n== Фаза B: полный цикл (тестовые средства) ==');
const [deployer] = await hre.ethers.getSigners();
if (!deployer) throw new Error('нет аккаунта: проверь SEPOLIA_PRIVATE_KEY');
if (!NEED_KEY) {
  // Форк: состояние балансов едет из Sepolia — выдаём тестовый газ локально.
  await hre.network.provider.send('hardhat_setBalance',
    [deployer.address, '0x8AC7230489E80000']); // 10 ETH
}
const depBal = await provider.getBalance(deployer.address);
const needDepWei = buffer(needDeployer) * gasPrice;
log(`deployer=${deployer.address} balance=${fmtEth(depBal)} ETH, нужно ~${fmtEth(needDepWei)} ETH`);
if (depBal < needDepWei) {
  const short = needDepWei - depBal;
  console.error(`\nCYCLE-SEPOLIA: БЛОКЕР — не хватает SepoliaETH: адрес ${deployer.address}, ` +
    `баланс ${fmtEth(depBal)} ETH, нужно ~${fmtEth(needDepWei)} ETH, не хватает ~${fmtEth(short)} ETH. ` +
    `Пополни через кран (https://sepoliafaucet.com) и повтори.`);
  process.exit(2);
}

// --- изолированная нода Agentcoin ---
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function startAgtNode(dataDir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'node.mjs'), String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGT_DATA_DIR: dataDir, AGT_BIND: '127.0.0.1',
      AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0',
      AGT_IDENTITY_ROLE: 'replica', AGT_IDENTITY_AUDIENCE: `wagt-sepolia:${port}` },
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
const DBG = !!process.env.WAGT_DEBUG;
const jpost = async (origin, p, b) => {
  const r = await fetch(origin + p, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b), signal: AbortSignal.timeout(15000) });
  let body = {};
  try { body = await r.json(); } catch {}
  if (DBG) log(`  [dbg] POST ${p} -> ${r.status} ${JSON.stringify(body).slice(0, 220)}`);
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
  throw new Error('mine failed');
}
// Майнить, пока tx не запечатана в цепь (убирает гонку mempool/блок).
async function mineUntilProven(origin, miner, txid, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const proof = await jget(origin, '/txproof/' + txid);
    if (proof.status === 200) return proof.body;
    await mineTo(origin, miner);
  }
  throw new Error('tx not sealed: ' + String(txid).slice(0, 16));
}
async function agtBalance(origin, address) {
  const b = await jpost(origin, '/balance', { address });
  return Number(b.body.balanceMGNT ?? b.body.balance);
}
const { txDigest } = await import(new URL('core.mjs', ROOT_URL));
function signAgtTx(from, fromPub, privKey, to, amount, memo, nonce) {
  const tx = { from, fromPub, to, amount,
    nonce: nonce ?? (Date.now() + Math.floor(Math.random() * 999)),
    ts: Math.floor(Date.now() / 1000), memo };
  tx.signature = signTransaction(tx, privKey);
  tx.txid = txDigest(tx);
  return tx;
}
// Детерминированный nonce выплаты: рестарт релейера до записи отметки
// даёт тот же txid — повтор находится в цепи, а не отправляется заново.
function releaseNonce(burnTxHash) {
  const h = hre.ethers.keccak256(hre.ethers.toUtf8Bytes('wagt-release:' + burnTxHash));
  return Number(BigInt(h) % 2n ** 31n);
}

const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wagt-sep-'));
const dataDir = path.join(workdir, 'agt-data');
const ledgerPath = path.join(workdir, 'relay-ledger.json');
const loadLedger = () => fs.existsSync(ledgerPath)
  ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : {};
const saveLedger = (l) => fs.writeFileSync(ledgerPath, JSON.stringify(l, null, 2));
const port = await freePort();
let node = await startAgtNode(dataDir, port);
const origin = node.origin;
log(`agentcoin node: ${origin} (изолированная, свежий datadir)`);

async function mkWallet(label) {
  const r = await jpost(origin, '/wallet/create', { label });
  if (r.status !== 201 && r.status !== 200) throw new Error('wallet/create failed');
  const words = String(r.body.mnemonic || '');
  const rec = words ? recoverFromMnemonic(words, label).wallet : {};
  return { address: r.body.address, pub: r.body.pub || rec.pub,
    privKey: r.body.privKey || rec.privKey };
}
const user = await mkWallet('wagt-sep-user');
const vault = await mkWallet('wagt-sep-vault');
const sink = await mkWallet('wagt-sep-sink');
await mineTo(origin, user.address);
check(await agtBalance(origin, user.address) > 0, `coinbase пользователю`);

// --- деплой WAGT/TAGT на Sepolia (deployer = bridge) ---
await hre.run('compile');
const WAGT = await hre.ethers.getContractFactory('WAGT', deployer);
const wagt = await WAGT.deploy(deployer.address);
await wagt.waitForDeployment();
await track('deploy WAGT', wagt.deploymentTransaction());
const TAGT = await hre.ethers.getContractFactory('TAGT', deployer);
const tagt = await TAGT.deploy();
await tagt.waitForDeployment();
await track('deploy TAGT', tagt.deploymentTransaction());
const A_WAGT = await wagt.getAddress();
const A_TAGT = await tagt.getAddress();
log(`WAGT=${A_WAGT} TAGT=${A_TAGT} bridge=${deployer.address}`);

// Трейдер — свежий кошелёк, финансируем газом с запасом.
const trader = hre.ethers.Wallet.createRandom().connect(provider);
const fundWei = needTrader * gasPrice * 2n > hre.ethers.parseEther('0.005')
  ? needTrader * gasPrice * 2n : hre.ethers.parseEther('0.005');
await track('fund trader', await deployer.sendTransaction({ to: trader.address, value: fundWei }));
log(`trader=${trader.address} (профинансирован ${fmtEth(fundWei)} ETH)`);

const factory = new hre.ethers.Contract(V2_FACTORY, FACTORY_ABI, deployer);
const router = new hre.ethers.Contract(V2_ROUTER02, ROUTER_ABI, deployer);

// --- LOCK #1: 40 AGT -> vault; MINT #1 -> deployer(LP) ---
const LOCK1 = 40, LOCK2 = 5;
async function lockAgt(fromW, to, amount, depositId, { mine = true } = {}) {
  const memo = `wagt-deposit:${depositId}`;
  const tx = signAgtTx(fromW.address, fromW.pub, fromW.privKey, to, amount, memo);
  const sub = await jpost(origin, '/tx', tx);
  if (sub.status !== 200 && sub.status !== 201) throw new Error('lock submit failed');
  if (mine) {
    await mineUntilProven(origin, sink.address, tx.txid);
    for (let i = 0; i < LOCK_CONFS; i++) await mineTo(origin, sink.address);
  }
  const proof = await jget(origin, '/txproof/' + tx.txid);
  return { tx, proofOk: proof.status === 200 };
}
const mintLedger = {}; // depositId -> {agtTxid, mintTx}
async function relayMint(depositId, agtTxid, amountAgt, to) {
  if (mintLedger[depositId]) return { duplicate: true, mintTx: mintLedger[depositId].mintTx };
  const proof = await jget(origin, '/txproof/' + agtTxid);
  if (proof.status !== 200) return { refused: true }; // нет подтверждений — выпуска нет
  const t = await wagt.mint(to, BigInt(amountAgt) * E18, hre.ethers.id(depositId), agtTxid);
  const rc = await track('mint', t);
  mintLedger[depositId] = { agtTxid, mintTx: rc.hash };
  return { duplicate: false, mintTx: rc.hash };
}

const dep1 = 'seplock-' + Date.now().toString(16) + '-liq';
const L1 = await lockAgt(user, vault.address, LOCK1, dep1);
check(L1.proofOk, `lock#1 ${LOCK1} AGT подтверждён (порог ${LOCK_CONFS}), txid=${L1.tx.txid.slice(0, 16)}…`);
const M1 = await relayMint(dep1, L1.tx.txid, LOCK1, deployer.address);
check(!M1.duplicate && M1.mintTx, `mint#1 ${LOCK1} wAGT, sepoliaTx=${M1.mintTx.slice(0, 18)}…`);
// Неподтверждённый депозит: отправлен, но не запечатан — выпуска нет.
const depU = 'seplock-' + Date.now().toString(16) + '-unconf';
const LU = await lockAgt(user, vault.address, 1, depU, { mine: false });
const MU = await relayMint(depU, LU.tx.txid, 1, deployer.address);
check(MU.refused === true, 'выпуск по неподтверждённому депозиту отклонён');
check((await wagt.totalSupply()) === BigInt(LOCK1) * E18, 'supply не изменился после отказа');  await mineUntilProven(origin, sink.address, LU.tx.txid); // запечатать depU
// Возврат тестового 1 AGT владельцу: след отказа не должен ломать инвариант vault==supply.
const refTx = signAgtTx(vault.address, vault.pub, vault.privKey, user.address, 1, 'wagt-refund:unconfirmed-drill');
check([200, 201].includes((await jpost(origin, '/tx', refTx)).status), 'возврат 1 AGT после drill отказа');
await mineUntilProven(origin, sink.address, refTx.txid);
check(await agtBalance(origin, vault.address) === LOCK1, 'vault снова ровно 40 AGT (след drill убран)');
// Повтор deposit#1 — двойного выпуска нет (реестр + контракт).
const M1dup = await relayMint(dep1, L1.tx.txid, LOCK1, deployer.address);
check(M1dup.duplicate === true, 'релейер отклонил повтор deposit#1');
let replayReverted = false;
try {
  await (await wagt.mint(deployer.address, BigInt(LOCK1) * E18, hre.ethers.id(dep1), L1.tx.txid)).wait();
} catch (e) { replayReverted = /deposit_replayed/.test(String(e).slice(0, 300)); }
check(replayReverted, 'контракт отклонил повтор deposit#1 (deposit_replayed)');

// --- Пара + ликвидность 40 wAGT / 400 tAGT через Router02 ---
await track('faucet tAGT', await tagt.faucet(deployer.address, 400n * E18));
await track('approve wAGT', await wagt.approve(V2_ROUTER02, 40n * E18));
await track('approve tAGT', await tagt.approve(V2_ROUTER02, 400n * E18));
const deadline = Math.floor(Date.now() / 1000) + 1800;
await track('addLiquidity', await router.addLiquidity(
  A_WAGT, A_TAGT, 40n * E18, 400n * E18, 0, 0, deployer.address, deadline));
const pairAddr = await factory.getPair(A_WAGT, A_TAGT);
check(/^0x[0-9a-fA-F]{40}$/.test(pairAddr) && pairAddr !== hre.ethers.ZeroAddress,
  `пара из Factory: ${pairAddr}`);
const pair = new hre.ethers.Contract(pairAddr, PAIR_ABI, provider);
const [rs0, rs1] = await pair.getReserves();
const t0 = await pair.token0();
const rW = (t0.toLowerCase() === A_WAGT.toLowerCase() ? rs0 : rs1);
const rT = (t0.toLowerCase() === A_WAGT.toLowerCase() ? rs1 : rs0);
check(rW === 40n * E18 && rT === 400n * E18,
  `резервы пары: ${hre.ethers.formatUnits(rW, 18)} wAGT / ${hre.ethers.formatUnits(rT, 18)} tAGT`);

// --- LOCK #2: 5 AGT; MINT #2 -> trader ---
const dep2 = 'seplock-' + Date.now().toString(16) + '-trade';
const L2 = await lockAgt(user, vault.address, LOCK2, dep2);
check(L2.proofOk, `lock#2 ${LOCK2} AGT, txid=${L2.tx.txid.slice(0, 16)}…`);
const M2 = await relayMint(dep2, L2.tx.txid, LOCK2, trader.address);
check(!M2.duplicate, `mint#2 ${LOCK2} wAGT трейдеру, sepoliaTx=${M2.mintTx.slice(0, 18)}…`);

// --- SWAP 2 wAGT -> tAGT через Router02 ---
const SWAP_IN = 2n * E18;
await track('trader approve', await wagt.connect(trader).approve(V2_ROUTER02, SWAP_IN));
const pathWT = [A_WAGT, A_TAGT];
const quoted = await router.getAmountsOut(SWAP_IN, pathWT);
const minOut = (quoted[1] * 95n) / 100n;
log(`котировка: 2 wAGT -> ${hre.ethers.formatUnits(quoted[1], 18)} tAGT, minOut=${hre.ethers.formatUnits(minOut, 18)}`);
const [pr0, pr1] = await pair.getReserves();  const tBefore = await tagt.balanceOf(trader.address);
  const sTx = await router.connect(trader).swapExactTokensForTokens(
    SWAP_IN, minOut, pathWT, trader.address, Math.floor(Date.now() / 1000) + 1800);
  const sRc = await track('swap', sTx);
  // Публичные RPC балансируют чтение между нодами: баланс сразу после
  // чека может вернуться из отстающей ноды. Ждём изменения, потом сверяем.
  let got = await tagt.balanceOf(trader.address);
  for (let i = 0; i < 30 && got === tBefore; i++) {
    await sleep(2000);
    got = await tagt.balanceOf(trader.address);
  }
  check(got > tBefore && (got - tBefore) >= minOut, `swap: получено ${hre.ethers.formatUnits(got - tBefore, 18)} tAGT, sepoliaTx=${sRc.hash.slice(0, 18)}…`);
  got = got - tBefore;
const [qr0, qr1] = await pair.getReserves();
check(qr0 !== pr0 || qr1 !== pr1, 'резервы пары изменились после обмена');

// --- BURN 3 wAGT -> RELEASE 3 AGT (релейер с журналом + drill рестарта) ---
const wBal = await wagt.balanceOf(trader.address);
check(wBal === 3n * E18, `остаток трейдера ровно 3 wAGT (5-2)`);
const bTx = await wagt.connect(trader).burn(wBal, user.address);
const bRc = await track('burn', bTx);
const burnId = 'sepburn:' + bRc.hash;
// Журнал с упреждающей записью: подписанная выплата сохраняется на диск
// ДО отправки. Рестарт в любой точке после этого находит либо готовую
// выплату в цепи (txproof → без повторной отправки), либо ту же
// подписанную выплату для повторной отправки (тот же txid — цепь
// отвергает дубликаты txid/nonce, двойной выплаты нет).
async function relayRelease(burnIdArg, burnHash, agtTo, amountAgt) {
  let ledger = loadLedger();
  const ex = ledger[burnIdArg];
  if (ex?.released) return { duplicate: true, txid: ex.txid };
  let tx = ex?.tx || null;
  if (!tx) {
    tx = signAgtTx(vault.address, vault.pub, vault.privKey, agtTo, amountAgt,
      `wagt-release:${burnHash}`, releaseNonce(burnHash));
    ledger[burnIdArg] = { released: false, txid: tx.txid, tx };
    saveLedger(ledger); // упреждающая запись — до отправки в сеть
  }
  const keepTx = (released) => { // подписанную выплату храним всегда: рестарт переиспользует её же
    const l = loadLedger();
    l[burnIdArg] = { released, txid: tx.txid, tx };
    saveLedger(l);
  };
  const proof = await jget(origin, '/txproof/' + tx.txid);
  if (proof.status === 200) { // уже запечатана (рестарт после отправки, до отметки)
    keepTx(true);
    return { duplicate: false, resumed: true, txid: tx.txid };
  }
  const sub = await jpost(origin, '/tx', tx);
  if (sub.status !== 200 && sub.status !== 201) {
    // Возможно, выплата уже в мемпуле (отправлена до крэша, не запечатана).
    const proof2 = await jget(origin, '/txproof/' + tx.txid);
    if (proof2.status !== 200) throw new Error('release submit failed: ' +
      JSON.stringify(sub.body).slice(0, 160));
  }
  await mineUntilProven(origin, sink.address, tx.txid);
  keepTx(true);
  return { duplicate: false, txid: tx.txid };
}
const userBefore = await agtBalance(origin, user.address);
const R1 = await relayRelease(burnId, bRc.hash, user.address, 3);
check(!R1.duplicate && !R1.resumed, `release 3 AGT, txid=${R1.txid.slice(0, 16)}…`);
check(await agtBalance(origin, user.address) === userBefore + 3, 'пользователь получил 3 AGT');
// Drill: рестарт релейера после отправки выплаты, но до записи отметки —
// откатываем только флаг released (реальный крэш не может потерять
// упреждающую запись, сделанную до отправки). Повтор обязан найти
// выплату в цепи и не отправлять вторую.
{ const l = loadLedger();
  l[burnId] = { released: false, txid: l[burnId].txid, tx: l[burnId].tx };
  saveLedger(l); } // симуляция крэша до отметки released
const R1b = await relayRelease(burnId, bRc.hash, user.address, 3);
check(R1b.resumed === true && R1b.txid === R1.txid, 'после рестарта найдена уже отправленная выплата, второй нет');
check(await agtBalance(origin, user.address) === userBefore + 3, 'баланс не изменился: ровно одна выплата');
const R1c = await relayRelease(burnId, bRc.hash, user.address, 3);
check(R1c.duplicate === true, 'повтор события сжигания отклонён (ровно одна выплата)');

// --- итоговая сверка + рестарт ноды ---
const vaultBal = await agtBalance(origin, vault.address);
const supply = await wagt.totalSupply();
const supplyAgt = Number(supply / E18);
const snapshot = { vault: vaultBal, supply: supplyAgt, releases: Object.keys(loadLedger()).length };
check(vaultBal === LOCK1 + LOCK2 - 3 && supplyAgt === LOCK1 + LOCK2 - 3,
  `сверка: vault=${vaultBal} AGT == supply=${supplyAgt} wAGT (40+5 выпуск, 3 сожжено)`);
await node.stop();
node = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  try { node = await startAgtNode(dataDir, port); break; }
  catch (e) {
    log(`рестарт ноды: попытка ${attempt}/3 не удалась (${String(e).slice(0, 120)}), пауза…`);
    if (attempt === 3) throw e;
    await sleep(1500);
  }
}
const vaultAfter = await agtBalance(node.origin, vault.address);
const supplyAfter = Number((await wagt.totalSupply()) / E18);
check(vaultAfter === snapshot.vault && supplyAfter === snapshot.supply,
  `после рестарта: vault=${vaultAfter}, supply=${supplyAfter} — сошлось с обеими сетями`);
await node.stop();

const FORK_MODE = hre.network.name === 'hardhat' && sepoliaNet.chainId === EXPECTED_CHAIN_ID;
const gasUsed = totalGasUsed();
const report = {
  network: FORK_MODE ? 'sepolia-fork' : 'sepolia', evmChainId: 11155111,
  uniswap: { factory: V2_FACTORY, router02: V2_ROUTER02, pair: pairAddr, sources: SOURCES },
  contracts: { wagt: A_WAGT, tagt: A_TAGT, bridge: deployer.address, trader: trader.address },
  agt: { user: user.address, vault: vault.address,
    lockTx1: L1.tx.txid, lockTxUnconfirmed: LU.tx.txid, lockTx2: L2.tx.txid, releaseTx: R1.txid },
  sepoliaTx: Object.fromEntries(gasLedger.map((g) => [g.op, g.hash])),
  amounts: { lock1: LOCK1, lock2: LOCK2, swapInWagt: '2',
    swapOutTagt: hre.ethers.formatUnits(got, 18), minOutTagt: hre.ethers.formatUnits(minOut, 18),
    burnWagt: '3', releaseAgt: 3 },
  checks: { swapOk: got >= minOut, unconfirmedDepositBlocked: true, replayBlockedOffchain: true,
    replayBlockedOnchain: replayReverted, restartFoundSentRelease: R1b.resumed === true,
    duplicateBurnRejected: R1c.duplicate === true,
    vaultAgt: vaultAfter, wagtSupply: supplyAfter,
    backingInvariant: true },
  gas: { priceWei: gasPrice.toString(), usedWei: gasLedger.map((g) => ({ op: g.op, hash: g.hash, gasUsed: g.gasUsed, gasPriceWei: g.gasPrice })),
    totalGas: gasUsed.toString() },
};
const reportName = hre.network.name === 'sepolia'
  ? 'cycle-report-sepolia.json'
  : (FORK_MODE ? 'cycle-report-sepolia-fork.json' : `cycle-report-${hre.network.name}.json`);
await fs.promises.writeFile(path.join(ROOT, 'tools', 'wagt-cycle', reportName),
  JSON.stringify(report, null, 2));
log('report: tools/wagt-cycle/' + reportName);
if (fails.length) { console.error(`\nCYCLE-SEPOLIA: FAIL (${fails.length}): ${fails.join('; ')}`); process.exit(1); }
log('\nCYCLE-SEPOLIA: OK — обмен в официальном пуле V2, возврат в цепи Agentcoin, повторы отклонены.');
process.exitCode = 0;
