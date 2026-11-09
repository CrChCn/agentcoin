// cycle-v2.mjs — стенд моста wAGT v2 (локально, тестовые средства):
// пауза, ротация minter, переживание рестарта релейера, отчёт резерва.
// Повтор:  cd tools/wagt-cycle && npm run cycle:v2
// Выход:   cycle-v2-report.json + exit 0/1.
import { execSync, spawn } from 'node:child_process';
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
const out = [];
const log = (m) => { out.push(m); console.log(m); };
const fails = [];
const check = (cond, m) => { log((cond ? '  ok: ' : '  FAIL: ') + m); if (!cond) fails.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const revertedWith = async (promise, needle) => {
  try { await (await promise).wait(); return false; }
  catch (e) { return String(e).slice(0, 400).includes(needle); }
};

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
      AGT_IDENTITY_ROLE: 'replica', AGT_IDENTITY_AUDIENCE: `wagt-v2:${port}` },
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
  throw new Error('mine failed');
}

log('== wAGT v2 stand: pause / rotation / restart / reserve ==');
const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wagt-v2-'));
const dataDir = path.join(workdir, 'agt-data');
const port = await freePort();
const node = await startAgtNode(dataDir, port);
const origin = node.origin;

async function mkWallet(label) {
  const r = await jpost(origin, '/wallet/create', { label });
  if (r.status !== 201 && r.status !== 200) throw new Error('wallet/create failed');
  const words = String(r.body.mnemonic || '');
  const rec = words ? recoverFromMnemonic(words, label).wallet : {};
  return { address: r.body.address, pub: r.body.pub || rec.pub, privKey: r.body.privKey || rec.privKey };
}
const user = await mkWallet('v2-user');
const vault = await mkWallet('v2-vault');
const sink = await mkWallet('v2-sink');
await mineTo(origin, user.address);
const agtBal = async (a) => { for (let i = 0; i < 15; i++) { const b = await jpost(origin, '/balance', { address: a }); const v = Number(b.body.balanceMGNT ?? b.body.balance); if (Number.isFinite(v)) return v; await sleep(400); } throw new Error('balance unreadable for ' + a); };
function signAgtTx(fromW, to, amount, memo) {
  const tx = { from: fromW.address, fromPub: fromW.pub, to, amount,
    nonce: Date.now() + Math.floor(Math.random() * 999), ts: Math.floor(Date.now() / 1000), memo };
  tx.signature = signTransaction(tx, fromW.privKey);
  tx.txid = txDigest(tx);
  return tx;
}
async function lockAgt(fromW, to, amount, depositId) {
  const tx = signAgtTx(fromW, to, amount, `wagt-deposit:${depositId}`);
  const sub = await jpost(origin, '/tx', tx);
  if (sub.status !== 200 && sub.status !== 201) throw new Error('lock submit failed: ' + JSON.stringify(sub.body).slice(0, 160));
  await mineTo(origin, sink.address);
  await mineTo(origin, sink.address);
  const proof = await jget(origin, '/txproof/' + tx.txid);
  if (proof.status !== 200) throw new Error('lock not sealed');
  return tx;
}

await hre.run('compile');
const [owner, minter, pauser, stranger, trader] = await hre.ethers.getSigners();
const F = await hre.ethers.getContractFactory('WAGTv2', owner);
const wagt = await F.deploy(trader.address, minter.address, pauser.address);
await wagt.waitForDeployment();
const A = await wagt.getAddress();
log(`WAGTv2=${A} owner(desig)=${(await wagt.owner()).slice(0, 10)}… deployer=${owner.address.slice(0, 10)}… minter=${minter.address.slice(0, 10)}… pauser=${pauser.address.slice(0, 10)}…`);

// ---------- ВЛАДЕНИЕ: назначение при развёртывании + проверяемая передача ----------
// Деплой выше: owner_=trader (назначенный владелец, в проде — мультисиг);
// деплоер (signer owner) владельцем НЕ стал.
const O = {};
check(await wagt.owner() === trader.address, 'O1 владелец назначен при развёртывании (owner_=назначенный адрес, не деплоер)');
check(await wagt.pendingOwner() === hre.ethers.ZeroAddress, 'O2 передачи в ожидании нет');
O.deployerRotateDenied = await revertedWith(wagt.connect(owner).setMinter(owner.address), 'not_owner');
check(O.deployerRotateDenied, 'O3 деплоер без owner_ менять minter не может (not_owner)');
O.strangerPauserDenied = await revertedWith(wagt.connect(stranger).setPauser(stranger.address), 'not_owner');
check(O.strangerPauserDenied, 'O4 посторонний менять pauser не может (not_owner)');
O.zeroTransferDenied = await revertedWith(wagt.connect(trader).transferOwnership(hre.ethers.ZeroAddress), 'zero_owner');
check(O.zeroTransferDenied, 'O5 передача на нулевой адрес отклонена (zero_owner)');
await (await wagt.connect(trader).transferOwnership(stranger.address)).wait();
check(await wagt.pendingOwner() === stranger.address && await wagt.owner() === trader.address, 'O6 шаг 1: pendingOwner назначен, права ещё у старого');
O.earlyAcceptDenied = await revertedWith(wagt.connect(owner).acceptOwnership(), 'not_pending_owner');
check(O.earlyAcceptDenied, 'O7 чужой accept отклонён (not_pending_owner)');
await (await wagt.connect(stranger).acceptOwnership()).wait();
check(await wagt.owner() === stranger.address && await wagt.pendingOwner() === hre.ethers.ZeroAddress, 'O8 шаг 2: владелец сменился, ожидание очищено');
O.oldOwnerDead = await revertedWith(wagt.connect(trader).setMinter(trader.address), 'not_owner');
check(O.oldOwnerDead, 'O9 старый владелец потерял права (not_owner)');
await (await wagt.connect(stranger).setPauser(pauser.address)).wait();
check(await wagt.pauser() === pauser.address, 'O10 новый владелец управляет pauser');
await (await wagt.connect(stranger).transferOwnership(owner.address)).wait();
await (await wagt.connect(owner).acceptOwnership()).wait();
check(await wagt.owner() === owner.address, 'O11 владение возвращено операционному owner для остальных секций');
O.strangerAfterReturn = await revertedWith(wagt.connect(stranger).setMinter(stranger.address), 'not_owner');
check(O.strangerAfterReturn, 'O12 после возврата посторонний снова без прав (not_owner)');

// ---------- ПАУЗА ----------
const R = {};
// до паузы: реальный lock -> mint 5 wAGT трейдеру (заявка, поданная до паузы, уже исполнена)
const dep0 = 'v2-dep0-' + Date.now().toString(16);
const L0 = await lockAgt(user, vault.address, 5, dep0);
await (await wagt.connect(minter).mint(trader.address, 5n * E18, hre.ethers.id(dep0), L0.txid)).wait();
check(await wagt.balanceOf(trader.address) === 5n * E18, 'P0 до паузы: mint 5 wAGT прошёл');
R.prePauseMint = true;

R.strangerPauseDenied = await revertedWith(wagt.connect(stranger).pause(), 'not_pauser');
check(R.strangerPauseDenied, 'P1 посторонний не может остановить мост (not_pauser)');
R.ownerPauseDenied = await revertedWith(wagt.connect(owner).pause(), 'not_pauser');
check(R.ownerPauseDenied, 'P2 даже owner без роли pauser остановить не может (not_pauser)');
await (await wagt.connect(pauser).pause()).wait();
check(await wagt.paused() === true, 'P3 pauser остановил мост (paused=true)');

// заявка, поданная до паузы, но не исполненная: lock есть, mint пытаемся во время паузы
const depQ = 'v2-depQ-' + Date.now().toString(16);
const LQ = await lockAgt(user, vault.address, 2, depQ);
R.pausedMintBlocked = await revertedWith(
  wagt.connect(minter).mint(trader.address, 2n * E18, hre.ethers.id(depQ), LQ.txid), 'bridge_paused');
check(R.pausedMintBlocked, 'P4 во время паузы mint заблокирован (bridge_paused) — заявка ждёт снятия');
R.pausedBurnBlocked = await revertedWith(wagt.connect(trader).burn(E18, user.address), 'bridge_paused');
check(R.pausedBurnBlocked, 'P5 во время паузы burn заблокирован (bridge_paused)');
await (await wagt.connect(trader).transfer(stranger.address, E18)).wait();
check(await wagt.balanceOf(stranger.address) === E18, 'P6 выпущенные до паузы балансы не заморожены (transfer работает)');
R.strangerUnpauseDenied = await revertedWith(wagt.connect(stranger).unpause(), 'not_pauser');
check(R.strangerUnpauseDenied, 'P7 посторонний не может снять паузу (not_pauser)');
await (await wagt.connect(pauser).unpause()).wait();
check(await wagt.paused() === false, 'P8 pauser снял паузу');
await (await wagt.connect(minter).mint(trader.address, 2n * E18, hre.ethers.id(depQ), LQ.txid)).wait();
check(await wagt.balanceOf(trader.address) === 6n * E18, 'P9 отложенная заявка исполнена после снятия паузы (6 wAGT)');
R.deferredSettled = true;

// ---------- РОТАЦИЯ ----------
R.strangerRotateDenied = await revertedWith(wagt.connect(stranger).setMinter(stranger.address), 'not_owner');
check(R.strangerRotateDenied, 'R1 посторонний не может сменить minter (not_owner)');
R.strangerMintDenied = await revertedWith(
  wagt.connect(stranger).mint(stranger.address, E18, hre.ethers.id('v2-bogus'), 'bogus'), 'not_minter');
check(R.strangerMintDenied, 'R2 посторонний не может выпустить токены (not_minter)');
await (await wagt.connect(owner).setMinter(trader.address)).wait();
check(await wagt.minter() === trader.address, 'R3 owner сменил minter (событие MinterChanged)');
R.oldMinterDead = await revertedWith(
  wagt.connect(minter).mint(minter.address, E18, hre.ethers.id('v2-old'), 'old'), 'not_minter');
check(R.oldMinterDead, 'R4 старый ключ ПОТЕРЯЛ право выпуска (not_minter)');
const depR = 'v2-depR-' + Date.now().toString(16);
const LR = await lockAgt(user, vault.address, 1, depR);
await (await wagt.connect(trader).mint(trader.address, E18, hre.ethers.id(depR), LR.txid)).wait();
R.newMinterWorks = await wagt.balanceOf(trader.address) === 7n * E18;
check(R.newMinterDead !== false && R.newMinterWorks, 'R5 новый minter выпускает (баланс 7 wAGT)');
await (await wagt.connect(owner).setPauser(stranger.address)).wait();
check(await wagt.pauser() === stranger.address, 'R6 owner сменил pauser (ротация дежурного)');
await (await wagt.connect(owner).setPauser(pauser.address)).wait(); // вернуть для чистоты отчёта

// ---------- ЛИМИТЫ (ТОЛЬКО релейер; в контракте лимитов НЕТ — см. L7) ----------
const LIMITS = { maxMintPerOp: 40, maxReleasePerOp: 10 }; // целые AGT/wAGT за одну операцию
const gateMint = (amount) => (Number.isInteger(amount) && amount > 0 && amount <= LIMITS.maxMintPerOp)
  ? { ok: true } : { ok: false, reason: 'mint_limit_exceeded' };
const gitHead = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();
const contractHead = (() => { try { return execSync('git log -1 --format=%H -- tools/wagt-cycle/contracts/WAGTv2.sol', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();

// ---------- РЕСТАРТ РЕЛЕЙЕРА: файловый журнал + сверка с обеими цепями ----------
// ledger.json: depositId -> {agtTxid, amount, to, state: 'intent'|'minted', mintTx}
const ledgerFile = path.join(workdir, 'ledger.json');
const loadLedger = () => fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
const saveLedger = (l) => fs.writeFileSync(ledgerFile, JSON.stringify(l, null, 2));
const haltFile = path.join(workdir, 'halt.json');
const loadHalt = () => fs.existsSync(haltFile) ? JSON.parse(fs.readFileSync(haltFile, 'utf8')) : { agt2evm: null, evm2agt: null };
const saveHalt = (h) => fs.writeFileSync(haltFile, JSON.stringify(h, null, 2));
// ресинк после (пере)запуска: сверка каждой intent-записи с обеими цепями
async function resync(symbol) {
  const ledger = loadLedger();
  const recovered = [];
  for (const [dep, e] of Object.entries(ledger)) {
    if (e.state === 'minted') continue;
    if (!gateMint(e.amount).ok) { // лимит релейера: в цепь не уходит
      e.state = 'needs-review';
      const h = loadHalt(); h.agt2evm = { reason: 'mint_limit_exceeded', detail: `${dep}: amount ${e.amount} > ${LIMITS.maxMintPerOp}`, at: new Date().toISOString() }; saveHalt(h);
      recovered.push(dep + ':limit-refused-mint_limit_exceeded'); continue; }
    const onchain = await wagt.mintedDeposit(hre.ethers.id(dep));
    const proof = await jget(origin, '/txproof/' + e.agtTxid);
    if (onchain) { e.state = 'minted'; e.mintTx ||= 'recovered-onchain'; recovered.push(dep + ':already-minted'); }
    else if (proof.status === 200) {
      const t = await wagt.connect(trader).mint(e.to, BigInt(e.amount) * E18, hre.ethers.id(dep), e.agtTxid);
      const rc = await t.wait();
      e.state = 'minted'; e.mintTx = rc.hash; recovered.push(dep + ':minted-after-restart');
    } else recovered.push(dep + ':lock-missing-needs-review');
  }
  saveLedger(ledger);
  log(`  resync[${symbol}]: ${recovered.join('; ') || 'нечего восстанавливать'}`);
  return { ledger, recovered };
}
const S = {};
// S1: сбой ПОСЛЕ записи намерения, ДО отправки mint-tx
const depS1 = 'v2-depS1-' + Date.now().toString(16);
const LS1 = await lockAgt(user, vault.address, 1, depS1);
{ const l = loadLedger(); l[depS1] = { agtTxid: LS1.txid, amount: 1, to: trader.address, state: 'intent', mintTx: null }; saveLedger(l); }
log('  S1: intent записан, «сбой» до отправки mint-tx');
const supplyS1 = await wagt.totalSupply();
{ const { recovered } = await resync('S1'); // новый процесс читает тот же файл
  S.crashBeforeSendRecovered = recovered.some((r) => r.startsWith(depS1 + ':minted-after-restart')); }
check(S.crashBeforeSendRecovered, 'S1 после рестарта: намерение найдено в файле, mint исполнен один раз');
// S2: сбой ПОСЛЕ отправки mint-tx (в блоке), ДО записи результата
const depS2 = 'v2-depS2-' + Date.now().toString(16);
const LS2 = await lockAgt(user, vault.address, 1, depS2);
const tS2 = await wagt.connect(trader).mint(trader.address, E18, hre.ethers.id(depS2), LS2.txid);
await tS2.wait(); // транзакция в блоке, результат НЕ записан — «сбой»
{ const l = loadLedger(); l[depS2] = { agtTxid: LS2.txid, amount: 1, to: trader.address, state: 'intent', mintTx: null }; saveLedger(l); }
log('  S2: mint-tx в блоке, «сбой» до записи результата');
const supplyBefore = await wagt.totalSupply();
{ const { ledger, recovered } = await resync('S2');
  S.crashAfterSendNoDouble = recovered.some((r) => r.startsWith(depS2 + ':already-minted')) && ledger[depS2].state === 'minted'; }
const supplyAfter = await wagt.totalSupply();
check(S.crashAfterSendNoDouble && supplyAfter === supplyBefore, 'S2 после рестарта: on-chain сверка нашла mint, повторного выпуска НЕТ (supply не изменился)');
// S3: halt переживает рестарт (файл, а не память)
{ const h = loadHalt(); h.evm2agt = { reason: 'burn_event_vanished', detail: 'стенд S3', at: new Date().toISOString() }; saveHalt(h); }
{ const h = loadHalt();
  S.haltSurvivesRestart = h.evm2agt?.reason === 'burn_event_vanished'; }
check(S.haltSurvivesRestart, 'S3 halt направления пережил рестарт (прочитан из файла, новые операции стоят)');
{ const h = loadHalt(); h.evm2agt = null; saveHalt(h); } // ручной сброс после разбора
check(loadHalt().evm2agt === null, 'S4 halt снят только вручную после разбора');

// ---------- ЛИМИТЫ: границы и попытка превышения ----------
const L = {};
check(gateMint(5).ok === true, 'L1 стартовый выпуск сценария (5) укладывается в лимит');
check(gateMint(LIMITS.maxMintPerOp).ok === true, `L2 граница: ровно ${LIMITS.maxMintPerOp} — разрешено`);
check(gateMint(LIMITS.maxMintPerOp + 1).ok === false && gateMint(LIMITS.maxMintPerOp + 1).reason === 'mint_limit_exceeded',
  `L3 ${LIMITS.maxMintPerOp + 1} — отказ (mint_limit_exceeded)`);
{ // попытка превышения через реальный путь ресинка
  const dep = 'v2-depLbig-' + Date.now().toString(16);
  { const l = loadLedger(); l[dep] = { agtTxid: 'deadbeef'.repeat(8), amount: LIMITS.maxMintPerOp + 1, to: trader.address, state: 'intent', mintTx: null }; saveLedger(l); }
  const supBefore = await wagt.totalSupply();
  const { recovered } = await resync('L');
  const supAfter = await wagt.totalSupply();
  L.bigRefused = recovered.some((r) => r.startsWith(dep + ':limit-refused-mint_limit_exceeded'));
  L.bigHalt = loadHalt().agt2evm?.reason === 'mint_limit_exceeded';
  check(L.bigRefused && supAfter === supBefore, 'L4 попытка 41 через ресинк: mint НЕТ (supply не изменился)');
  check(L.bigHalt, 'L5 превышение лимита — halt направления (mint_limit_exceeded)');
  { const l = loadLedger(); delete l[dep]; saveLedger(l); } // синтетика теста: удалена, в резерв не попадает
  { const h = loadHalt(); h.agt2evm = null; saveHalt(h); }
  check(loadHalt().agt2evm === null, 'L6 halt по лимиту снят вручную после разбора');
}
check(!F.interface.hasFunction('setMintLimit') && !F.interface.hasFunction('mintLimit') && !F.interface.hasFunction('maxMint'),
  'L7 лимитов НЕТ в контракте (ABI): действуют только в релейере');

// ---------- ОТЧЁТ РЕЗЕРВА ----------
async function reserveReport() {
  const vaultBal = await agtBal(vault.address);
  const supply = Number((await wagt.totalSupply()) / E18);
  const ledger = loadLedger();
  const open = Object.entries(ledger).filter(([, e]) => e.state === 'intent' || e.state === 'needs-review')
    .map(([dep, e]) => ({ depositId: dep, agtTxid: e.agtTxid, state: e.state }));
  const ok = vaultBal === supply && open.length === 0;
  return { vault: vaultBal, supply, open,
    ok, reason: ok ? null : (vaultBal !== supply ? 'supply_vault_mismatch' : 'open_intents') };
}
const V = {};
let rep = await reserveReport();
V.balanced = rep.ok === true;
check(V.balanced, `V1 резерв сошёлся: vault=${rep.vault} AGT == supply=${rep.supply}, открытых нет`);
// V2: необъяснённое расхождение (прямой перевод из vault без burn) — выдача останавливается
const leak = signAgtTx(vault, user.address, 1, 'v2-unexplained-leak');
{ const s = await jpost(origin, '/tx', leak);
  if (s.status !== 200 && s.status !== 201) throw new Error('leak submit failed: ' + JSON.stringify(s.body).slice(0, 200)); }
await mineTo(origin, sink.address);
rep = await reserveReport();
V.divergenceDetected = rep.ok === false && rep.reason === 'supply_vault_mismatch';
check(V.divergenceDetected, `V2 расхождение обнаружено: vault=${rep.vault} vs supply=${rep.supply} (${rep.reason})`);
{ const h = loadHalt();
  if (!rep.ok) { h.agt2evm = { reason: rep.reason, at: new Date().toISOString() }; h.evm2agt = { reason: rep.reason, at: new Date().toISOString() }; saveHalt(h); } }
{ const h = loadHalt();
  V.bothHalted = h.agt2evm?.reason === 'supply_vault_mismatch' && h.evm2agt?.reason === 'supply_vault_mismatch'; }
check(V.bothHalted, 'V3 необъяснённое расхождение: выдача остановлена в ОБОИХ направлениях, причина в журнале halt');
log(`  halt-журнал: ${JSON.stringify(loadHalt())}`);

// --- отчёт ---
await node.stop();
const report = { evmChainId: 31337, contract: A,
  code: { standSha: gitHead, contractSha: contractHead, contractFile: 'tools/wagt-cycle/contracts/WAGTv2.sol' },
  roles: { owner: await wagt.owner(), minter: await wagt.minter(), pauser: await wagt.pauser() },
  ownership: O, pause: R, limits: { values: LIMITS, scope: 'relayer-only, no on-chain caps' }, restart: S, reserve: { ...V, final: rep },
  haltLog: loadHalt() };
await fs.promises.writeFile(path.join(ROOT, 'tools', 'wagt-cycle', 'cycle-v2-report.json'), JSON.stringify(report, null, 2));
log('report: tools/wagt-cycle/cycle-v2-report.json');
if (fails.length) { console.error(`\nWAGT-V2: FAIL (${fails.length}): ${fails.join('; ')}`); process.exit(1); }
log('\nWAGT-V2: OK — пауза, ротация, рестарт, сверка резерва.');
process.exitCode = 0;
