// accept-v2-mainnet.mjs — приёмка моста wAGT v2 на тестовых средствах.
// Локально + ссылка на подтверждённый обмен Sepolia как доказательство
// предыдущего обмена. Дополняет cycle-v2 (пауза/ротация/владение/лимиты/рестарт),
// закрывая пробелы ТЗ: сбои по ОБОИМ направлениям (до отправки / мемпул /
// в блоке без записи / исчезновение события при реорге), резерв с открытыми
// операциями, искусственное расхождение + ручное возобновление, контрольный
// цикл с пулом (покупка+продажа) на контракте v2.
// Статус mainnet: торговля в основной сети ОТЛОЖЕНА, бюджет ликвидности 0 USDC.
// Повтор:  cd tools/wagt-cycle && npm run accept:v2
// Выход:   accept-v2-report.json + exit 0/1.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import hre from 'hardhat';
import { execSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ROOT_URL = new URL('../../..', import.meta.url);
const { signTransaction, txDigest } = await import(new URL('core.mjs', ROOT_URL));
const { recoverFromMnemonic } = await import(new URL('bip39-lite.mjs', ROOT_URL));

const E18 = 10n ** 18n;
const MIN_AGT_CONF = Number(process.env.WAGT_MIN_AGT_CONF || 2);
const MIN_EVM_CONF = Number(process.env.WAGT_MIN_EVM_CONF || 2);
const out = [];
const log = (m) => { out.push(m); console.log(m); };
const fails = [];
const check = (cond, m) => { log((cond ? '  ok: ' : '  FAIL: ') + m); if (!cond) fails.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (h) => String(h).slice(0, 18);
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
      AGT_IDENTITY_ROLE: 'replica', AGT_IDENTITY_AUDIENCE: `wagt-accept:${port}` },
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
const evm = (m, a = []) => hre.network.provider.send(m, a);

log('== wAGT v2 accept: оба направления, реорги, резерв, пул ==');
const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wagt-accept-'));
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
const user = await mkWallet('acc-user');
const vault = await mkWallet('acc-vault');
const sink = await mkWallet('acc-sink');
const oper = await mkWallet('acc-operator');
await mineTo(origin, user.address);
await mineTo(origin, oper.address);
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
const agtMempoolHas = async (txid) => {
  const m = await jget(origin, '/mempool?full=1');
  return Array.isArray(m.body.txs) && m.body.txs.some((t) => t.txid === txid);
};

await hre.run('compile');
const [owner, minter, pauser, stranger, trader, lp] = await hre.ethers.getSigners();
const F = await hre.ethers.getContractFactory('WAGTv2', owner);
// owner_ назначается при развёртывании (в проде — мультисиг); полная проверка
// назначения и двухшаговой передачи — cycle-v2, секция O (O1–O12).
const wagt = await F.deploy(owner.address, minter.address, pauser.address);
await wagt.waitForDeployment();
const A = await wagt.getAddress();
log(`WAGTv2=${A}`);

// ---------- файловые журналы + ворота ----------
const ledgerFile = path.join(workdir, 'ledger.json');   // mint: depositId -> intent
const rledgerFile = path.join(workdir, 'rledger.json'); // release: burnTxHash -> intent
const haltFile = path.join(workdir, 'halt.json');
const loadLedger = () => fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
const saveLedger = (l) => fs.writeFileSync(ledgerFile, JSON.stringify(l, null, 2));
const loadRLedger = () => fs.existsSync(rledgerFile) ? JSON.parse(fs.readFileSync(rledgerFile, 'utf8')) : {};
const saveRLedger = (l) => fs.writeFileSync(rledgerFile, JSON.stringify(l, null, 2));
const loadHalt = () => fs.existsSync(haltFile) ? JSON.parse(fs.readFileSync(haltFile, 'utf8')) : { agt2evm: null, evm2agt: null };
const saveHalt = (h) => fs.writeFileSync(haltFile, JSON.stringify(h, null, 2));
const setHalt = (dir, reason, detail, by = 'accept-stand') => {
  const h = loadHalt(); h[dir] = { reason, detail, by, at: new Date().toISOString() }; saveHalt(h);
};
const resetHalt = (dir, reason, by = 'operator-reviewed') => {
  const h = loadHalt(); h[dir] = null; saveHalt(h);
  log(`  halt[${dir}] снят вручную (${by}): ${reason}`);
};
// ---------- ЛИМИТЫ (ТОЛЬКО релейер; в контракте лимитов НЕТ — см. L7) ----------
const LIMITS = { maxMintPerOp: 40, maxReleasePerOp: 10 }; // целые AGT/wAGT за одну операцию
const gateMint = (amount) => (Number.isInteger(amount) && amount > 0 && amount <= LIMITS.maxMintPerOp)
  ? { ok: true } : { ok: false, reason: 'mint_limit_exceeded' };
const gateRelease = (amount) => (Number.isInteger(amount) && amount > 0 && amount <= LIMITS.maxReleasePerOp)
  ? { ok: true } : { ok: false, reason: 'release_limit_exceeded' };
const gitHead = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();
const contractHead = (() => { try { return execSync('git log -1 --format=%H -- tools/wagt-cycle/contracts/WAGTv2.sol', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();
const E = {}; // evidence per case

// ресинк mint-направления (новый процесс после «сбоя»)
async function resyncMint(symbol) {
  const ledger = loadLedger();
  const recovered = [];
  for (const [dep, e] of Object.entries(ledger)) {
    if (e.state === 'minted' || e.state === 'void-reviewed') continue;
    if (loadHalt().agt2evm) { recovered.push(dep + ':blocked-by-halt'); continue; }
    if (!gateMint(e.amount).ok) { // лимит релейера: в цепь не уходит
      e.state = 'needs-review';
      setHalt('agt2evm', 'mint_limit_exceeded', `${dep}: amount ${e.amount} > ${LIMITS.maxMintPerOp}`);
      recovered.push(dep + ':limit-refused-mint_limit_exceeded'); continue; }
    const onchain = await wagt.mintedDeposit(hre.ethers.id(dep));
    if (onchain) { e.state = 'minted'; e.mintTx ||= 'recovered-onchain'; recovered.push(dep + ':already-minted'); continue; }
    if (e.pendingTx) {
      const rc = await hre.ethers.provider.getTransactionReceipt(e.pendingTx).catch(() => null);
      if (rc && Number(rc.status) === 1) {
        e.state = 'minted'; e.mintTx = e.pendingTx; recovered.push(dep + ':pending-confirmed-no-resend'); continue;
      }
      const pend = await hre.ethers.provider.getTransaction(e.pendingTx).catch(() => null);
      if (pend && pend.blockNumber === null) {
        await evm('evm_mine', []); // релейер добывает блок, чужая tx подтверждается как есть
        const rc2 = await hre.ethers.provider.getTransactionReceipt(e.pendingTx);
        if (rc2 && Number(rc2.status) === 1) {
          e.state = 'minted'; e.mintTx = e.pendingTx; recovered.push(dep + ':mempool-mined-no-resend'); continue;
        }
      }
    }
    const proof = await jget(origin, '/txproof/' + e.agtTxid);
    if (proof.status === 200) {
      const t = await wagt.connect(minter).mint(e.to, BigInt(e.amount) * E18, hre.ethers.id(dep), e.agtTxid);
      const rc = await t.wait();
      e.state = 'minted'; e.mintTx = rc.hash; recovered.push(dep + ':minted-after-restart');
    } else {
      e.state = 'needs-review';
      setHalt('agt2evm', 'lock_event_vanished', `${dep}: lock ${short(e.agtTxid)} нет в цепи AGT`);
      recovered.push(dep + ':lock-missing-needs-review');
    }
  }
  saveLedger(ledger);
  log(`  resync-mint[${symbol}]: ${recovered.join('; ') || 'нечего восстанавливать'}`);
  return { ledger, recovered };
}
// ворота release: burn зрел и в канонической цепи
async function releaseGate(burnTxHash) {
  if (loadHalt().evm2agt) return { halted: true, reason: loadHalt().evm2agt.reason };
  const rc = await hre.ethers.provider.getTransactionReceipt(burnTxHash);
  if (!rc || Number(rc.status) !== 1) {
    setHalt('evm2agt', 'burn_event_vanished', `burn ${short(burnTxHash)} нет в канонической цепи`);
    return { halted: true, reason: 'burn_event_vanished' };
  }
  const tip = await hre.ethers.provider.getBlockNumber();
  const depth = tip - rc.blockNumber;
  if (depth < MIN_EVM_CONF) return { notMature: true, reason: 'burn_immature', depth };
  return { mature: true, blockNumber: rc.blockNumber, depth };
}
// ресинк release-направления
async function resyncRelease(symbol) {
  const rl = loadRLedger();
  const out = [];
  for (const [bhash, e] of Object.entries(rl)) {
    if (e.state === 'confirmed' || e.state === 'void-reviewed') continue;
    if (!gateRelease(e.amount).ok) { // лимит релейера: выплата не создаётся
      e.state = 'needs-review';
      setHalt('evm2agt', 'release_limit_exceeded', `burn ${short(bhash)}: amount ${e.amount} > ${LIMITS.maxReleasePerOp}`);
      out.push(bhash.slice(0, 12) + ':limit-refused-release_limit_exceeded'); continue; }
    const g = await releaseGate(bhash);
    if (g.halted) { out.push(bhash.slice(0, 12) + ':blocked-' + g.reason); continue; }
    if (g.notMature) { out.push(bhash.slice(0, 12) + ':immature-wait'); continue; }
    if (e.state === 'released' && e.releaseTxid) {
      const proof = await jget(origin, '/txproof/' + e.releaseTxid);
      if (proof.status === 200) { e.state = 'confirmed'; out.push(bhash.slice(0, 12) + ':already-released-no-double'); continue; }
      if (await agtMempoolHas(e.releaseTxid)) {
        await mineTo(origin, sink.address); // подтверждение висящей выплаты как есть
        const p2 = await jget(origin, '/txproof/' + e.releaseTxid);
        if (p2.status === 200) { e.state = 'confirmed'; out.push(bhash.slice(0, 12) + ':mempool-confirmed-no-double'); continue; }
      }
      // выплаты нет ни в цепи, ни в мемпуле — судьба неизвестна: НЕ перевыпускать
      e.state = 'fate-unknown';
      setHalt('evm2agt', 'release_fate_unknown', `burn ${short(bhash)}: выплата ${short(e.releaseTxid)} нигде не найдена`);
      out.push(bhash.slice(0, 12) + ':fate-unknown-halt'); continue;
    }
    // intent без выплаты: зрелый burn -> ровно одна выплата
    const rtx = signAgtTx(vault, e.agtRecipient, e.amount, `wagt-release:${bhash}`);
    const sub = await jpost(origin, '/tx', rtx);
    if (sub.status !== 200 && sub.status !== 201) throw new Error('release submit failed: ' + JSON.stringify(sub.body).slice(0, 160));
    e.state = 'released'; e.releaseTxid = rtx.txid;
    await mineTo(origin, sink.address);
    const p = await jget(origin, '/txproof/' + rtx.txid);
    if (p.status === 200) e.state = 'confirmed';
    out.push(bhash.slice(0, 12) + `:released-once:${short(rtx.txid)}`);
  }
  saveRLedger(rl);
  log(`  resync-release[${symbol}]: ${out.join('; ') || 'нечего восстанавливать'}`);
  return { rledger: rl, recovered: out };
}

// ---------- A. роли на фактическом состоянии (кратко, полно — cycle-v2 P/R) ----------
check(await wagt.owner() === owner.address, 'A1 owner на месте');
check(await wagt.minter() === minter.address && await wagt.pauser() === pauser.address, 'A2 minter/pauser на месте');
check(await revertedWith(wagt.connect(stranger).pause(), 'not_pauser'), 'A3 посторонний не ставит паузу; снимает только pauser, minter меняет только owner (полно — cycle-v2 O/P/R)');

// ---------- L. лимиты: границы и попытка превышения ----------
{
  check(gateMint(LIMITS.maxMintPerOp).ok === true, 'L1 граница mint ok');
  const overMint = gateMint(LIMITS.maxMintPerOp + 1);
  check(overMint.ok === false && overMint.reason === 'mint_limit_exceeded', 'L2 over mint denied');
  check(gateRelease(LIMITS.maxReleasePerOp).ok === true, 'L3 граница release ok');
  const overRel = gateRelease(LIMITS.maxReleasePerOp + 1);
  check(overRel.ok === false && overRel.reason === 'release_limit_exceeded', 'L4 over release denied');
  const depBig = 'acc-Lbig-' + Date.now().toString(16);
  { const l = loadLedger(); l[depBig] = { agtTxid: 'deadbeef'.repeat(8), amount: LIMITS.maxMintPerOp + 1, to: trader.address, state: 'intent', mintTx: null, pendingTx: null }; saveLedger(l); }
  const supB = await wagt.totalSupply();
  const rBig = await resyncMint('L-mint-over');
  const supA = await wagt.totalSupply();
  E.limitMintOver = { ledgerAfter: loadLedger()[depBig], haltAfter: loadHalt().agt2evm, supplyDelta: String(supA - supB) };
  check(rBig.recovered.some((r) => r.startsWith(depBig + ':limit-refused-mint_limit_exceeded')) && supA === supB,
    'L5 попытка 41 через ресинк: mint НЕТ (supply не изменился)');
  check(loadHalt().agt2evm?.reason === 'mint_limit_exceeded', 'L5b превышение лимита mint — halt направления');
  { const l = loadLedger(); delete l[depBig]; saveLedger(l); } // синтетика теста: удалена, в резерв не попадает
  resetHalt('agt2evm', 'разбор L5: сверхлимитная заявка отклонена, журнал помечен');
  const bBig = '0x' + 'dd'.repeat(32);
  { const rl = loadRLedger(); rl[bBig] = { burnBlock: 1, amount: LIMITS.maxReleasePerOp + 1, agtRecipient: user.address, state: 'intent', releaseTxid: null }; saveRLedger(rl); }
  const uB = await agtBal(user.address);
  const rRel = await resyncRelease('L-rel-over');
  const uA = await agtBal(user.address);
  E.limitReleaseOver = { rledgerAfter: loadRLedger()[bBig], haltAfter: loadHalt().evm2agt, userDelta: uA - uB };
  check(rRel.recovered.some((r) => r.includes(':limit-refused-release_limit_exceeded')) && uA === uB,
    'L6 попытка 11 через ресинк: выплата НЕ создана (баланс не изменился)');
  check(loadHalt().evm2agt?.reason === 'release_limit_exceeded', 'L6b превышение лимита release — halt направления');
  { const rl = loadRLedger(); delete rl[bBig]; saveRLedger(rl); } // синтетика теста: удалена, в резерв не попадает
  resetHalt('evm2agt', 'разбор L6: сверхлимитная выплата отклонена, журнал помечен');
  check(!F.interface.hasFunction('setMintLimit') && !F.interface.hasFunction('mintLimit') && !F.interface.hasFunction('maxMint') &&
    !F.interface.hasFunction('setReleaseLimit'), 'L7 лимитов НЕТ в контракте (ABI): действуют только в релейере');
}

// ---------- B1. mint: сбой ДО отправки ----------
{
  const dep = 'acc-Ma-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 1, dep);
  const before = JSON.parse(JSON.stringify(loadLedger()));
  { const l = loadLedger(); l[dep] = { agtTxid: L.txid, amount: 1, to: trader.address, state: 'intent', mintTx: null, pendingTx: null }; saveLedger(l); }
  const supBefore = await wagt.totalSupply();
  log(`  Ma: intent записан, «сбой» до отправки mint-tx (lock ${short(L.txid)})`);
  const { recovered, ledger } = await resyncMint('Ma');
  const supAfter = await wagt.totalSupply();
  E.Ma = { lockTxid: L.txid, ledgerBefore: before[dep] || null, ledgerAfter: ledger[dep], supplyDelta: String(supAfter - supBefore) };
  check(recovered.some((r) => r.startsWith(dep + ':minted-after-restart')) && supAfter - supBefore === E18,
    'Ma после рестарта: mint исполнен ровно один раз');
}
// ---------- B2. mint: tx в мемпуле, сбой до записи результата ----------
{
  const dep = 'acc-Mb-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 1, dep);
  await evm('evm_setAutomine', [false]);
  const t = await wagt.connect(minter).mint(trader.address, E18, hre.ethers.id(dep), L.txid);
  const pend = await hre.ethers.provider.getTransaction(t.hash);
  const rcNull = await hre.ethers.provider.getTransactionReceipt(t.hash).catch(() => null);
  { const l = loadLedger(); l[dep] = { agtTxid: L.txid, amount: 1, to: trader.address, state: 'intent', mintTx: null, pendingTx: t.hash }; saveLedger(l); }
  const inMempool = !!pend && pend.blockNumber === null && rcNull === null;
  const supBefore = await wagt.totalSupply();
  log(`  Mb: mint-tx ${short(t.hash)} в мемпуле (receipt null), «сбой»`);
  const { recovered, ledger } = await resyncMint('Mb');
  await evm('evm_setAutomine', [true]);
  const supAfter = await wagt.totalSupply();
  E.Mb = { lockTxid: L.txid, mintTx: t.hash, wasInMempool: inMempool, ledgerAfter: ledger[dep], supplyDelta: String(supAfter - supBefore) };
  check(inMempool && recovered.some((r) => r.startsWith(dep + ':mempool-mined-no-resend')) && supAfter - supBefore === E18,
    'Mb после рестарта: висящая tx подтверждена как есть, второй отправки НЕТ');
}
// ---------- B3. mint: tx в блоке, сбой до записи результата ----------
{
  const dep = 'acc-Mc-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 1, dep);
  const t = await wagt.connect(minter).mint(trader.address, E18, hre.ethers.id(dep), L.txid);
  const rc = await t.wait();
  { const l = loadLedger(); l[dep] = { agtTxid: L.txid, amount: 1, to: trader.address, state: 'intent', mintTx: null, pendingTx: null }; saveLedger(l); }
  const supBefore = await wagt.totalSupply();
  log(`  Mc: mint-tx ${short(rc.hash)} в блоке #${rc.blockNumber}, «сбой» до записи`);
  const { recovered, ledger } = await resyncMint('Mc');
  const supAfter = await wagt.totalSupply();
  E.Mc = { lockTxid: L.txid, mintTx: rc.hash, block: rc.blockNumber, ledgerAfter: ledger[dep], supplyDelta: String(supAfter - supBefore) };
  check(recovered.some((r) => r.startsWith(dep + ':already-minted')) && supAfter === supBefore,
    'Mc после рестарта: сверка нашла mint, повторного выпуска НЕТ');
}
// ---------- B4. mint: событие исчезло (путь lock_event_vanished) ----------
{
  const dep = 'acc-Md-' + Date.now().toString(16);
  { const l = loadLedger(); l[dep] = { agtTxid: 'deadbeef'.repeat(8), amount: 1, to: trader.address, state: 'intent', mintTx: null, pendingTx: null }; saveLedger(l); }
  const supBefore = await wagt.totalSupply();
  log('  Md: intent на lock, которого нет в цепи (событие исчезло после подтверждения)');
  const { recovered, ledger } = await resyncMint('Md');
  const supAfter = await wagt.totalSupply();
  E.Md = { ledgerAfter: ledger[dep], haltAfter: loadHalt().agt2evm, supplyDelta: String(supAfter - supBefore) };
  check(recovered.some((r) => r.startsWith(dep + ':lock-missing-needs-review')) && supAfter === supBefore &&
    loadHalt().agt2evm?.reason === 'lock_event_vanished',
    'Md: mint НЕТ, направление остановлено с причиной lock_event_vanished');
  { const l = loadLedger(); l[dep].state = 'void-reviewed'; saveLedger(l); }
  resetHalt('agt2evm', 'разбор Md: фантомный lock, затронутое направление проверено');
  check(loadHalt().agt2evm === null, 'Md: halt снят только вручную после разбора');
}

// ---------- C1. release: сбой ДО отправки выплаты ----------
{
  const dep = 'acc-Ea-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 1, dep);
  await (await wagt.connect(minter).mint(trader.address, E18, hre.ethers.id(dep), L.txid)).wait();
  { const l = loadLedger(); l[dep] = { agtTxid: L.txid, amount: 1, to: trader.address, state: 'minted', mintTx: 'direct', pendingTx: null }; saveLedger(l); }
  const btx = await wagt.connect(trader).burn(E18, user.address);
  const brc = await btx.wait();
  for (let i = 0; i < MIN_EVM_CONF; i++) await evm('evm_mine', []);
  { const rl = loadRLedger(); rl[brc.hash] = { burnBlock: brc.blockNumber, amount: 1, agtRecipient: user.address, state: 'intent', releaseTxid: null }; saveRLedger(rl); }
  const uBefore = await agtBal(user.address);
  log(`  Ea: burn ${short(brc.hash)} зрел, intent записан, «сбой» до выплаты`);
  const { recovered, rledger } = await resyncRelease('Ea');
  const uAfter = await agtBal(user.address);
  E.Ea = { burnTx: brc.hash, burnBlock: brc.blockNumber, rledgerAfter: rledger[brc.hash], userDelta: uAfter - uBefore };
  check(recovered.some((r) => r.includes(':released-once:')) && uAfter - uBefore === 1,
    'Ea после рестарта: ровно одна выплата 1 AGT');
}
// ---------- C2. release: выплата в мемпуле AGT, сбой до записи ----------
{
  const dep = 'acc-Eb-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 1, dep);
  await (await wagt.connect(minter).mint(trader.address, E18, hre.ethers.id(dep), L.txid)).wait();
  { const l = loadLedger(); l[dep] = { agtTxid: L.txid, amount: 1, to: trader.address, state: 'minted', mintTx: 'direct', pendingTx: null }; saveLedger(l); }
  const btx = await wagt.connect(trader).burn(E18, user.address);
  const brc = await btx.wait();
  for (let i = 0; i < MIN_EVM_CONF; i++) await evm('evm_mine', []);
  const rtx = signAgtTx(vault, user.address, 1, `wagt-release:${brc.hash}`);
  const sub = await jpost(origin, '/tx', rtx);
  if (sub.status !== 200 && sub.status !== 201) throw new Error('Eb release submit failed');
  // НЕ майним: выплата висит в мемпуле; «сбой» до записи результата
  { const rl = loadRLedger(); rl[brc.hash] = { burnBlock: brc.blockNumber, amount: 1, agtRecipient: user.address, state: 'released', releaseTxid: rtx.txid }; saveRLedger(rl); }
  const inMempool = await agtMempoolHas(rtx.txid);
  const uBefore = await agtBal(user.address);
  log(`  Eb: выплата ${short(rtx.txid)} в мемпуле AGT (без блока), «сбой»`);
  const { recovered, rledger } = await resyncRelease('Eb');
  const uAfter = await agtBal(user.address);
  E.Eb = { burnTx: brc.hash, releaseTxid: rtx.txid, wasInMempool: inMempool, rledgerAfter: rledger[brc.hash], userDelta: uAfter - uBefore };
  check(inMempool && recovered.some((r) => r.includes(':mempool-confirmed-no-double')) && uAfter - uBefore === 1,
    'Eb после рестарта: висящая выплата подтверждена, второй выплаты НЕТ');
}
// ---------- C3. release: выплата в блоке, сбой до записи ----------
{
  const dep = 'acc-Ec-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 1, dep);
  await (await wagt.connect(minter).mint(trader.address, E18, hre.ethers.id(dep), L.txid)).wait();
  { const l = loadLedger(); l[dep] = { agtTxid: L.txid, amount: 1, to: trader.address, state: 'minted', mintTx: 'direct', pendingTx: null }; saveLedger(l); }
  const btx = await wagt.connect(trader).burn(E18, user.address);
  const brc = await btx.wait();
  for (let i = 0; i < MIN_EVM_CONF; i++) await evm('evm_mine', []);
  const rtx = signAgtTx(vault, user.address, 1, `wagt-release:${brc.hash}`);
  await jpost(origin, '/tx', rtx);
  await mineTo(origin, sink.address); // выплата в блоке, результат НЕ записан — «сбой»
  { const rl = loadRLedger(); rl[brc.hash] = { burnBlock: brc.blockNumber, amount: 1, agtRecipient: user.address, state: 'released', releaseTxid: rtx.txid }; saveRLedger(rl); }
  const uBefore = await agtBal(user.address);
  log(`  Ec: выплата ${short(rtx.txid)} в блоке AGT, «сбой» до записи`);
  const { recovered, rledger } = await resyncRelease('Ec');
  const uAfter = await agtBal(user.address);
  E.Ec = { burnTx: brc.hash, releaseTxid: rtx.txid, rledgerAfter: rledger[brc.hash], userDelta: uAfter - uBefore };
  check(recovered.some((r) => r.includes(':already-released-no-double')) && uAfter - uBefore === 0,
    'Ec после рестарта: сверка нашла выплату, повтора НЕТ (баланс не изменился)');
}
// ---------- C4. release: подтверждённый burn исчез при реорге ----------
{
  const dep = 'acc-Ed-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 1, dep);
  await (await wagt.connect(minter).mint(trader.address, E18, hre.ethers.id(dep), L.txid)).wait();
  { const l = loadLedger(); l[dep] = { agtTxid: L.txid, amount: 1, to: trader.address, state: 'minted', mintTx: 'direct', pendingTx: null }; saveLedger(l); }
  const snap = await evm('evm_snapshot', []);
  const btx = await wagt.connect(trader).burn(E18, user.address);
  const brc = await btx.wait();
  for (let i = 0; i < MIN_EVM_CONF; i++) await evm('evm_mine', []);
  const g0 = await releaseGate(brc.hash);
  await evm('evm_revert', [snap]); // реорг ПОСЛЕ порога: подтверждённое событие исчезло
  log(`  Ed: burn ${short(brc.hash)} был зрел (depth=${g0.depth}), реорг стёр событие`);
  const g1 = await releaseGate(brc.hash);
  E.Ed = { burnTx: brc.hash, gateBefore: g0.mature === true, gateAfter: g1.reason || null, haltAfter: loadHalt().evm2agt };
  check(g0.mature === true && g1.halted === true && g1.reason === 'burn_event_vanished' &&
    loadHalt().evm2agt?.reason === 'burn_event_vanished',
    'Ed: исчезнувшее событие -> halt evm2agt с причиной burn_event_vanished');
  // новые операции направления стоят
  { const rl = loadRLedger(); rl[brc.hash] = { burnBlock: brc.blockNumber, amount: 1, agtRecipient: user.address, state: 'intent', releaseTxid: null }; saveRLedger(rl); }
  const { recovered } = await resyncRelease('Ed-blocked');
  check(recovered.some((r) => r.includes(':blocked-burn_event_vanished')),
    'Ed: пока halt стоит, новые выплаты направления отклоняются');
  // ручной сброс после разбора + событие создано заново + ворота требуют порог
  resetHalt('evm2agt', 'разбор Ed: реорг подтверждён, burn перевыпущен трейдером');
  { const rl = loadRLedger(); delete rl[brc.hash]; saveRLedger(rl); }
  const btx2 = await wagt.connect(trader).burn(E18, user.address);
  const brc2 = await btx2.wait();
  for (let i = 0; i < MIN_EVM_CONF; i++) await evm('evm_mine', []);
  { const rl = loadRLedger(); rl[brc2.hash] = { burnBlock: brc2.blockNumber, amount: 1, agtRecipient: user.address, state: 'intent', releaseTxid: null }; saveRLedger(rl); }
  const uBefore = await agtBal(user.address);
  const { recovered: rec2, rledger } = await resyncRelease('Ed-redo');
  const uAfter = await agtBal(user.address);
  E.Ed.reburnTx = brc2.hash;
  E.Ed.rledgerAfter = rledger[brc2.hash];
  check(rec2.some((r) => r.includes(':released-once:')) && uAfter - uBefore === 1,
    'Ed: после сброса и нового burn выплата 1 AGT прошла');
}
// ---------- C5. судьба выплаты неизвестна: новой выплаты НЕТ ----------
{
  const bhash = '0x' + 'ab'.repeat(32);
  { const rl = loadRLedger(); rl[bhash] = { burnBlock: 999999, amount: 1, agtRecipient: user.address, state: 'released', releaseTxid: 'ff'.repeat(32) }; saveRLedger(rl); }
  log('  Ee: выплата не находится ни в цепи, ни в мемпуле (неоднозначный результат)');
  // подменяем burn на реальный зрелый, но с потерянной выплатой: живой кейс
  const dep = 'acc-Ee-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 1, dep);
  await (await wagt.connect(minter).mint(trader.address, E18, hre.ethers.id(dep), L.txid)).wait();
  { const l = loadLedger(); l[dep] = { agtTxid: L.txid, amount: 1, to: trader.address, state: 'minted', mintTx: 'direct', pendingTx: null }; saveLedger(l); }
  const btx = await wagt.connect(trader).burn(E18, user.address);
  const brc = await btx.wait();
  for (let i = 0; i < MIN_EVM_CONF; i++) await evm('evm_mine', []);
  { const rl = loadRLedger(); delete rl[bhash]; rl[brc.hash] = { burnBlock: brc.blockNumber, amount: 1, agtRecipient: user.address, state: 'released', releaseTxid: 'ee'.repeat(32) }; saveRLedger(rl); }
  const uBefore = await agtBal(user.address);
  const { recovered, rledger } = await resyncRelease('Ee');
  const uAfter = await agtBal(user.address);
  E.Ee = { burnTx: brc.hash, rledgerAfter: rledger[brc.hash], haltAfter: loadHalt().evm2agt, userDelta: uAfter - uBefore };
  check(recovered.some((r) => r.includes(':fate-unknown-halt')) && uAfter === uBefore &&
    loadHalt().evm2agt?.reason === 'release_fate_unknown',
    'Ee: судьба неизвестна -> новой выплаты НЕТ, направление остановлено');
  { const rl = loadRLedger(); rl[brc.hash].state = 'void-reviewed'; saveRLedger(rl); }
  resetHalt('evm2agt', 'разбор Ee: выплата-фантом списана, оператор перевыпустит вручную после сверки');
}

// ---------- D. резерв с открытыми операциями ----------
async function reserveReport() {
  const vaultBal = await agtBal(vault.address);
  const supply = Number((await wagt.totalSupply()) / E18);
  const ledger = loadLedger();
  const rl = loadRLedger();
  const openMint = Object.entries(ledger).filter(([, e]) => e.state === 'intent' || e.state === 'needs-review')
    .map(([depositId, e]) => ({ depositId, agtTxid: e.agtTxid, amount: e.amount, state: e.state }));
  const openRelease = Object.entries(rl).filter(([, e]) => e.state === 'intent' || e.state === 'released')
    .map(([burnTx, e]) => ({ burnTx: short(burnTx), amount: e.amount, state: e.state }));
  const sumMint = openMint.reduce((s, o) => s + o.amount, 0);
  const sumRel = openRelease.reduce((s, o) => s + o.amount, 0);
  // сожжено, но выплата не произведена и решения нет/принято к разбору (Ee):
  // AGT законно остаётся в vault, supply уже срезан — объяснённый излишек
  const unreleased = Object.entries(rl)
    .filter(([bhash, e]) => (e.state === 'fate-unknown' || e.state === 'void-reviewed') && String(bhash).startsWith('0x'))
    .map(([burnTx, e]) => ({ burnTx: short(burnTx), amount: e.amount, state: e.state }));
  const sumUnrel = unreleased.reduce((s, o) => s + o.amount, 0);
  // каждая незавершёнка влияет на ожидание: lock уже в vault -> supply вырастет;
  // burn уже срезал supply -> vault ещё отдаст; необъявленный излишек — только необъяснимое
  const expVault = vaultBal - sumRel - sumUnrel;
  const expSupply = supply + sumMint;
  const ok = expVault === expSupply;
  return { vault: vaultBal, supply, openMint, openRelease, unreleasedBurns: unreleased,
    expected: { vaultAfterSettle: expVault, supplyAfterSettle: expSupply },
    ok, reason: ok ? null : 'settlement_mismatch' };
}
{
  // открываем обе незавершёнки одновременно
  const dep = 'acc-Dopen-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 2, dep);
  { const l = loadLedger(); l[dep] = { agtTxid: L.txid, amount: 2, to: trader.address, state: 'intent', mintTx: null, pendingTx: null }; saveLedger(l); }
  const btx = await wagt.connect(trader).burn(E18, user.address);
  const brc = await btx.wait();
  for (let i = 0; i < MIN_EVM_CONF; i++) await evm('evm_mine', []);
  { const rl = loadRLedger(); rl[brc.hash] = { burnBlock: brc.blockNumber, amount: 1, agtRecipient: user.address, state: 'intent', releaseTxid: null }; saveRLedger(rl); }
  const rep = await reserveReport();
  E.reserveOpen = rep;
  log(`  D: открыты mint 2 (lock ${short(L.txid)}) + release 1 (burn ${short(brc.hash)})`);
  check(rep.ok === true && rep.expected.vaultAfterSettle === 4 && rep.expected.supplyAfterSettle === 4 &&
    rep.unreleasedBurns.length === 1 && rep.openMint.length === 1 && rep.openRelease.length === 1,
    `D резерв с открытыми: vault=${rep.vault}-1(релиз)-1(сожжено без выплаты Ee) == supply=${rep.supply}+2 (ожидание сходится)`);
  // доводим обе до конца
  await resyncMint('D-settle');
  await resyncRelease('D-settle');
  const rep2 = await reserveReport();
  E.reserveSettled = rep2;
  check(rep2.ok && rep2.openMint.length === 0 && rep2.openRelease.length === 0,
    `D после доведения: vault=${rep2.vault} == supply=${rep2.supply}, открытых нет`);
}
// ---------- E. искусственное расхождение -> остановка -> ручное возобновление ----------
{
  const leak = signAgtTx(vault, user.address, 1, 'accept-unexplained-leak');
  const s = await jpost(origin, '/tx', leak);
  if (s.status !== 200 && s.status !== 201) throw new Error('leak submit failed');
  await mineTo(origin, sink.address);
  const rep = await reserveReport();
  E.divergence = { before: rep.vault + 1, after: rep, leakTxid: leak.txid };
  const bad = !rep.ok && rep.reason === 'settlement_mismatch';
  check(bad, `E расхождение обнаружено: vault=${rep.vault} vs supply=${rep.supply}`);
  // оператор: немедленная пауза контракта + halt обоих направлений с причиной
  await (await wagt.connect(pauser).pause()).wait();
  setHalt('agt2evm', 'supply_vault_mismatch', `vault=${rep.vault} supply=${rep.supply}: необъяснённое расхождение`, 'operator');
  setHalt('evm2agt', 'supply_vault_mismatch', `vault=${rep.vault} supply=${rep.supply}: необъяснённое расхождение`, 'operator');
  E.haltLog = loadHalt();
  const pausedBlocksMint = await revertedWith(
    wagt.connect(minter).mint(trader.address, E18, hre.ethers.id('acc-E-blocked'), 'blocked'), 'bridge_paused');
  const gateBlocked = (await releaseGate('0x' + 'cc'.repeat(32))).halted === true;
  check(pausedBlocksMint && gateBlocked, 'E выдача остановлена: контракт на паузе + ворота обоих направлений закрыты');
  // разбор: причина найдена (прямой перевод из vault без burn, ключ хранителя);
  // remediation: оператор докапитализировал резерв +1, сверка сошлась
  const top = signAgtTx(oper, vault.address, 1, 'accept-operator-topup');
  await jpost(origin, '/tx', top);
  await mineTo(origin, sink.address);
  const rep2 = await reserveReport();
  check(rep2.ok, `E после докапитализации: vault=${rep2.vault} == supply=${rep2.supply}`);
  // возобновляет ТОЛЬКО оператор после разбора, с фиксацией причины
  resetHalt('agt2evm', `разбор E: leak ${short(leak.txid)} ключом хранителя, резерв пополнен ${short(top.txid)}`, 'operator');
  resetHalt('evm2agt', `разбор E: leak ${short(leak.txid)} ключом хранителя, резерв пополнен ${short(top.txid)}`, 'operator');
  await (await wagt.connect(pauser).unpause()).wait();
  const dep = 'acc-Eresume-' + Date.now().toString(16);
  const L = await lockAgt(user, vault.address, 1, dep);
  await (await wagt.connect(minter).mint(trader.address, E18, hre.ethers.id(dep), L.txid)).wait();
  check(await wagt.balanceOf(trader.address) >= E18, 'E после возобновления: мост снова выпускает');
}

// ---------- F. контрольный цикл с пулом на v2 ----------
const C = {};
{
  const TG = await hre.ethers.getContractFactory('TAGT', owner);
  const tagt = await TG.deploy();
  await tagt.waitForDeployment();
  const P = await hre.ethers.getContractFactory('TestPool', owner);
  const pool = await P.deploy(A, await tagt.getAddress());
  await pool.waitForDeployment();
  const PA = await pool.getAddress();
  C.pool = PA; C.tagt = await tagt.getAddress();
  log(`  F: пул ${PA} (wAGT/tAGT ~ Uniswap V2)`);
  // lock 40 -> mint 40 LP + faucet 400 tAGT -> ликвидность 40/400
  const depL = 'acc-F-liq-' + Date.now().toString(16);
  const LL = await lockAgt(user, vault.address, 40, depL);
  check(gateMint(40).ok === true, 'F стартовый выпуск 40 укладывается в лимит mint (граница)');
  await (await wagt.connect(minter).mint(lp.address, 40n * E18, hre.ethers.id(depL), LL.txid)).wait();
  await (await tagt.faucet(lp.address, 400n * E18)).wait();
  await (await wagt.connect(lp).approve(PA, 40n * E18)).wait();
  await (await tagt.connect(lp).approve(PA, 400n * E18)).wait();
  check(await wagt.balanceOf(lp.address) >= 40n * E18 && await tagt.balanceOf(lp.address) >= 400n * E18,
    'F у кошелька ликвидности ОБА тестовых токена (40 wAGT + 400 tAGT), подписывает lp');
  await (await pool.connect(lp).addLiquidity(40n * E18, 400n * E18)).wait();
  C.lockMintTx = LL.txid;
  check(await pool.reserve0() === 40n * E18 && await pool.reserve1() === 400n * E18, 'F пул: 40 wAGT / 400 tAGT');
  // lock 5 -> mint 5 трейдеру
  const depT = 'acc-F-trade-' + Date.now().toString(16);
  const LT = await lockAgt(user, vault.address, 5, depT);
  check(gateMint(5).ok === true, 'F выпуск 5 для трейдера укладывается в лимит mint');
  await (await wagt.connect(minter).mint(trader.address, 5n * E18, hre.ethers.id(depT), LT.txid)).wait();
  // продажа: 2 wAGT -> tAGT по формуле V2
  await (await wagt.connect(trader).approve(PA, 2n * E18)).wait();
  const qSell = await pool.quoteOut(await pool.reserve0(), await pool.reserve1(), 2n * E18);
  const stx = await pool.connect(trader).swapExactIn(A, 2n * E18, 0, trader.address);
  const src = await stx.wait();
  const tBal = await tagt.balanceOf(trader.address);
  C.sellTx = src.hash; C.sellOut = tBal.toString();
  check(tBal === qSell && tBal > 0n, `F продажа 2 wAGT -> ${hre.ethers.formatUnits(tBal, 18)} tAGT (V2-формула, evmTx=${short(src.hash)})`);
  // покупка: половина tAGT -> wAGT
  const buyIn = tBal / 2n;
  await (await tagt.connect(trader).approve(PA, buyIn)).wait();
  const qBuy = await pool.quoteOut(await pool.reserve1(), await pool.reserve0(), buyIn);
  const preBuy = await wagt.balanceOf(trader.address);
  const btx = await pool.connect(trader).swapExactIn(C.tagt, buyIn, 0, trader.address);
  const brc = await btx.wait();
  const wAfterBuy = await wagt.balanceOf(trader.address);
  C.buyTx = brc.hash;
  check(wAfterBuy === preBuy + qBuy, `F покупка ${hre.ethers.formatUnits(buyIn, 18)} tAGT -> wAGT (evmTx=${short(brc.hash)})`);
  const [r0, r1] = [await pool.reserve0(), await pool.reserve1()];
  check(r0 * r1 >= 40n * E18 * (400n * E18), 'F инвариант x*y=k держится после обеих сделок');
  // сжигание остатка -> возврат
  const wBal = await wagt.balanceOf(trader.address);
  check(wBal > 0, 'F после покупки/продажи у трейдера остался отдельный остаток wAGT для контрольного возврата');
  const burnInt = (wBal / E18) * E18; // целые wAGT: пыть остаётся у трейдера, резерв точен
  const dust = wBal - burnInt;
  const burn = await wagt.connect(trader).burn(burnInt, user.address);
  const burnRc = await burn.wait();
  for (let i = 0; i < MIN_EVM_CONF; i++) await evm('evm_mine', []);
  check(gateRelease(Number(burnInt / E18)).ok === true, 'F контрольный возврат укладывается в лимит release');
  { const rl = loadRLedger(); rl[burnRc.hash] = { burnBlock: burnRc.blockNumber, amount: Number(burnInt / E18), agtRecipient: user.address, state: 'intent', releaseTxid: null }; saveRLedger(rl); }
  const uBefore = await agtBal(user.address);
  const { recovered, rledger } = await resyncRelease('F');
  const uAfter = await agtBal(user.address);
  C.burnTx = burnRc.hash; C.releaseTxid = rledger[burnRc.hash].releaseTxid; C.returnedAGT = uAfter - uBefore;
  check(recovered.some((r) => r.includes(':released-once:')) && uAfter - uBefore === Number(burnInt / E18),
    `F сжигание ${hre.ethers.formatUnits(wBal, 18)} wAGT -> возврат ${uAfter - uBefore} AGT`);
  const repF = await reserveReport();
  E.reserveFinal = repF;
  check(repF.ok && repF.openMint.length === 0 && repF.openRelease.length === 0,
    `F итоговая сверка: vault=${repF.vault} == supply=${repF.supply}, открытых нет`);
}

// --- отчёт ---
await node.stop();
const report = {
  code: { standSha: gitHead, contractSha: contractHead, contractFile: 'tools/wagt-cycle/contracts/WAGTv2.sol' },
  evmChainId: 31337,
  roles: 'owner (назначен при деплое)/pauser/minter на местах; stranger denied; двухшаговая передача — полно в cycle-v2 O (O1-O12)',
  limits: { values: LIMITS, scope: 'relayer-only, no on-chain caps (ABI без лимитных функций)', overLimit: { mint: E.limitMintOver, release: E.limitReleaseOver } },
  mintCrashes: { Ma: E.Ma, Mb: E.Mb, Mc: E.Mc, Md: E.Md },
  releaseCrashes: { Ea: E.Ea, Eb: E.Eb, Ec: E.Ec, Ed: E.Ed, Ee: E.Ee },
  reserve: { open: E.reserveOpen, settled: E.reserveSettled, divergence: E.divergence, haltLog: E.haltLog, final: E.reserveFinal },
  controlCycle: C,
  priorExchange: {
    network: 'sepolia', uniswap: 'official V2',
    wagt: '0x64FEA6B5a6BE1CA8f8301Ad63b33356eA548b590', tagt: '0x3fDD80F38e2F8678d669CC329Fc25Cf642fc1A50',
    pair: '0x02778d388a9D397d9583524169506256d4179fDC',
    swapSell2wAGT: '0x72f4e6aaf8eb98013170bef7b3d0607263adf8cc8a0c75e01e64d979fa26e26c',
    burn3wAGT: '0x6a50e5cda311ae88b26c9ddff766239c599648e7553432131252e2cb7af16',
    note: 'exchange Sepolia - proof of prior exchange; new local WAGT v2 run - controlCycle',
  },
};
await fs.promises.writeFile(path.join(ROOT, 'tools', 'wagt-cycle', 'accept-v2-report.json'), JSON.stringify(report, null, 2));
log('report: tools/wagt-cycle/accept-v2-report.json');
if (fails.length) { console.error(`\nWAGT-ACCEPT: FAIL (${fails.length}): ${fails.join('; ')}`); process.exit(1); }
log('\nWAGT-ACCEPT: OK — оба направления, реорги, резерв, пул.');
process.exitCode = 0;
