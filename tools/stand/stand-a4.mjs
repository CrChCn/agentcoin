#!/usr/bin/env node
/* stand-a4.mjs — A4: недельные выплаты операторам пиров (отдельный бюджет).
   Стенд: два тестовых оператора, лимиты 10 AGT/оператор/неделя, 20 AGT суммарно.
   Ключ: operator_id + period. Журнал write-ahead: intent+подписанная tx ДО отправки.
   Фазы: p1 выплата; p2 повтор расчёта (идемпотентность); p3 параллельные экземпляры
   (lock-файл, второй только сверяется); p4 краш после отправки → recover (тот же txid);
   p5 нулевой бюджет и превышение лимита (отказы без tx); p6 ручной дубль → аудит ловит.
   Итог: stand-a4-results.json + ops-weekly-registry.json. */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { signTransaction, txDigest } from '../../core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const MGNT = 1_000_000_000;
const PER_OP = 10 * MGNT, WEEK_TOTAL = 20 * MGNT;
const PERIOD = '2026-W45';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pickPort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

// подготовленные недельные измерения (стенд): расчёт + обоснование на оператора
const MEASUREMENTS = [
  { opId: 'op-hetzner', intervalsOnline: 168, intervalsTotal: 168, wsPeersMin: 2, blocksRelayed: 1240, awardAgt: 10,
    why: 'онлайн 168/168 ч, WS-пиры ≥2, релей 1240 блоков — полный лимит' },
  { opId: 'op-do', intervalsOnline: 141, intervalsTotal: 168, wsPeersMin: 1, blocksRelayed: 700, awardAgt: 6,
    why: 'онлайн 141/168 ч (84%), релей 700 блоков — частичная выплата 6/10' },
];

function journal(path_, lockPath) {
  const load = () => { try { return JSON.parse(fs.readFileSync(path_, 'utf8')); } catch { return { intents: {}, refusals: [] }; } };
  const save = j => fs.writeFileSync(path_, JSON.stringify(j, null, 1));
  // crash-safe lock: мёртвый PID прежнего владельца (упал без unlock) — забираем
  const lock = () => {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return true; } catch {}
    try {
      const pid = Number(fs.readFileSync(lockPath, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (!alive) { try { fs.unlinkSync(lockPath); } catch {} }
      else return false;
    } catch { return false; }
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
  };
  const unlock = () => { try { fs.unlinkSync(lockPath); } catch {} };
  return { load, save, lock, unlock };
}

// расчёт+намерения (идемпотентно: готовые ключи не пересоздаёт)
function compute(j, measurements, budgetTotal, period) {
  const decisions = [];
  let planned = 0;
  for (const m of measurements) {
    const key = `${m.opId}|${period}`;
    const amountMinor = Math.round(m.awardAgt * MGNT);
    if (j.intents[key]) { decisions.push({ key, action: 'skip_exists', status: j.intents[key].status }); continue; }
    if (budgetTotal <= 0) { j.refusals.push({ key, reason: 'zero_budget', at: Date.now() }); decisions.push({ key, action: 'refused', reason: 'zero_budget' }); continue; }
    if (amountMinor > PER_OP) { j.refusals.push({ key, reason: 'per_op_over_limit', at: Date.now() }); decisions.push({ key, action: 'refused', reason: 'per_op_over_limit' }); continue; }
    if (planned + amountMinor > budgetTotal || planned + amountMinor > WEEK_TOTAL) { j.refusals.push({ key, reason: 'over_budget', at: Date.now() }); decisions.push({ key, action: 'refused', reason: 'over_budget' }); continue; }
    planned += amountMinor;
    j.intents[key] = { key, opId: m.opId, period, amountMinor, why: m.why, status: 'computed', at: Date.now() };
    decisions.push({ key, action: 'computed', amountMinor });
  }
  return decisions;
}
function signIntent(j, fund, key) {
  const it = j.intents[key];
  if (!it || it.txid) return it;
  const tx = { from: fund.address, fromPub: fund.pub, to: it.to, amount: it.amountMinor / MGNT, nonce: Date.now() + Object.keys(j.intents).length, ts: Math.floor(Date.now() / 1000), memo: `payout-stand:${key}` };
  tx.txid = txDigest(tx); tx.signature = signTransaction(tx, fund.priv);
  it.tx = tx; it.txid = tx.txid; it.status = 'intended';
  return it;
}
async function execute(j, save, fund, api, keys, crashAfterSubmit) {
  const out = [];
  for (const key of keys) {
    const it = j.intents[key];
    if (!it || !it.txid || it.status === 'paid' || it.status === 'submitted') { out.push({ key, action: 'skip_' + (it?.status || 'missing') }); continue; }
    const r = await api('/tx', { method: 'POST', body: it.tx });
    if (r.status !== 200 && r.status !== 201) { it.status = 'failed'; it.reason = r.body?.error || r.status; out.push({ key, action: 'submit_failed', detail: it.reason }); continue; }
    it.status = 'submitted'; save(j);
    out.push({ key, action: 'submitted', txid: it.txid });
    if (crashAfterSubmit) process.exit(1); // сбой до отметки paid
  }
  return out;
}
async function reconcile(j, save, api) {
  // сверка с цепью: submitted/intended без ончейн-следа → повторить ТУ ЖЕ tx (тот же txid)
  const blocks = (await api('/blocks?from=0')).body.blocks || [];
  const onchain = new Map();
  for (const b of blocks) for (const t of (b.txs || [])) if (t?.txid) onchain.set(t.txid, b.height ?? b.header?.height);
  const out = [];
  for (const it of Object.values(j.intents)) {
    if (it.status !== 'submitted' && it.status !== 'intended') continue;
    if (it.txid && onchain.has(it.txid)) { it.status = 'paid'; it.block = onchain.get(it.txid); out.push({ key: it.key, action: 'marked_paid', block: it.block }); }
    else if (it.status === 'submitted') { const r = await api('/tx', { method: 'POST', body: it.tx }); out.push({ key: it.key, action: 'resubmitted_same_txid', status: r.status }); }
  }
  save(j);
  return out;
}
async function audit(j, api, fundAddr) {
  const blocks = (await api('/blocks?from=0')).body.blocks || [];
  const byKey = {};
  for (const b of blocks) for (const t of (b.txs || [])) {
    const m = /^payout-stand:(.+)$/.exec(t.memo || '');
    if (m && t.from === fundAddr) { byKey[m[1]] = byKey[m[1]] || new Set(); byKey[m[1]].add(t.txid); }
  }
  const viol = [];
  for (const [key, it] of Object.entries(j.intents)) {
    const txids = [...(byKey[key] || [])];
    if ((it.status === 'paid' || it.status === 'submitted') && txids.length !== 1) viol.push(`${key}: выплат ${txids.length}, ожидалась 1`);
    if (txids.length > 1) viol.push(`${key}: РАЗНЫЕ txid на один ключ: ${txids.join(',')}`);
  }
  return { viol, byKey: Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, [...v]])) };
}

const OUT = path.join(REPO, 'docs', 'a-topology', 'stand-a4-results.json');
const R = { startedAt: new Date().toISOString(), period: PERIOD, limits: { PER_OP: PER_OP / MGNT, WEEK_TOTAL: WEEK_TOTAL / MGNT }, steps: [] };
const step = (n, ok, d) => { R.steps.push({ name: n, ok, detail: d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };

async function bootNode() {
  const port = await pickPort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-a4-'));
  const dataDir = path.join(root, 'data');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(root, 'boot.json'), '{"bootstrap":[]}');
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BOOTSTRAP_FILE: path.join(root, 'boot.json'),
    AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: token, AGT_BIND: '127.0.0.1', AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' };
  for (const k of ['AGT_CORE_P0_HEIGHT', 'AGT_TX_DIGEST_V2_HEIGHT', 'AGT_MGNT_HEIGHT', 'AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT']) delete env[k];
  const child = spawn(process.execPath, [path.join(REPO, 'node.mjs'), String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  const api = async (route, { method = 'GET', body } = {}) => {
    const r = await fetch(url + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  for (let i = 0; i < 200 && child.exitCode === null; i++) {
    try { if ((await api('/identity/meta')).status === 200) return { url, api, child, root }; } catch {}
    await sleep(150);
  }
  throw new Error('node not ready');
}

async function workerMain() {
  // argv: --worker journal nodeUrl fundJson period [--crash]
  const args = process.argv.slice(3);
  const opsArg = args[args.length - 1];
  const [JPATH, URL, FUNDJSON, period] = args;
  const flag = args.includes('--crash') ? '--crash' : null;
  const fund = JSON.parse(FUNDJSON);
  const api = async (route, { method = 'GET', body } = {}) => {
    const r = await fetch(URL + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const J = journal(JPATH, JPATH + '.lock');
  if (!J.lock()) { // второй экземпляр: только сверка, без отправок
    const j = J.load(); const rec = await reconcile(j, J.save, api);
    console.log(JSON.stringify({ mode: 'reconcile_only', rec }));
    process.exit(0);
  }
  try {
    const j = J.load();
    const ops = JSON.parse(opsArg || 'null') || null; // измерения последним аргументом
    const dec = compute(j, ops.measurements, ops.budget, period);
    for (const op of ops.measurements) {
      const key = `${op.opId}|${period}`;
      if (j.intents[key] && !j.intents[key].to) j.intents[key].to = op.address;
      if (j.intents[key] && !j.intents[key].txid) signIntent(j, fund, key);
    }
    J.save(j);
    const out = await execute(j, J.save, fund, api, Object.keys(j.intents), flag === '--crash');
    console.log(JSON.stringify({ mode: 'worker', dec, out }));
  } finally { J.unlock(); }
}

async function main() {
  if (process.argv[2] === '--worker') return workerMain();
  const REG = path.join(REPO, 'docs', 'a-topology', 'ops-weekly-registry.json');
  let node;
  try {
    node = await bootNode();
    const { api } = node;
    const fw = (await api('/wallet/create', { method: 'POST', body: { label: 'ops-fund' } })).body;
    const fund = { address: fw.address, pub: fw.pub, priv: fw.privKey };
    for (let i = 0; i < 3; i++) await api('/mine', { method: 'POST', body: { miner: fund.address } });
    const ops = [];
    for (const m of MEASUREMENTS) {
      const w = (await api('/wallet/create', { method: 'POST', body: { label: m.opId } })).body;
      ops.push({ ...m, address: w.address });
    }
    const JPATH = path.join(node.root, 'ops-weekly.json');
    const runWorker = (extra = []) => spawnSync(process.execPath, [process.argv[1], '--worker', JPATH, node.url, JSON.stringify(fund), PERIOD, ...extra, JSON.stringify({ measurements: ops, budget: WEEK_TOTAL })], { encoding: 'utf8', timeout: 120000 });
    const mine2 = async () => { await api('/mine', { method: 'POST', body: { miner: fund.address } }); await api('/mine', { method: 'POST', body: { miner: fund.address } }); };
    const J = journal(JPATH, JPATH + '.lock');
    const bal = async a => Number((await api('/balance', { method: 'POST', body: { address: a } })).body.balance);

    // p1: расчёт + выплата
    let wout = runWorker();
    step('p1 выплата 10 + 6 за неделю', wout.status === 0, (wout.stdout || '').slice(0, 200));
    await mine2();
    let j = J.load(); let rec = await reconcile(j, J.save, api);
    step('p1.2 обе выплаты подтверждены', rec.filter(x => x.action === 'marked_paid').length === 2, JSON.stringify(rec).slice(0, 200));
    const b0 = [await bal(ops[0].address), await bal(ops[1].address)];
    step('p1.3 балансы 10 / 6', b0[0] === 10 && b0[1] === 6, b0.join('/'));

    // p2: повтор расчёта и выплаты за тот же период
    wout = runWorker();
    j = J.load();
    const aud1 = await audit(j, api, fund.address);
    step('p2 повтор: новых tx нет, выплат по-прежнему по 1', wout.status === 0 && aud1.viol.length === 0, (wout.stdout || '').slice(0, 160));

    // p3: параллельные экземпляры
    const c1 = spawn(process.execPath, [process.argv[1], '--worker', JPATH, node.url, JSON.stringify(fund), PERIOD, JSON.stringify({ measurements: ops, budget: WEEK_TOTAL })], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const c2 = spawn(process.execPath, [process.argv[1], '--worker', JPATH, node.url, JSON.stringify(fund), PERIOD, JSON.stringify({ measurements: ops, budget: WEEK_TOTAL })], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const [e1, e2] = await Promise.all([new Promise(r => c1.on('close', (code) => r({ code, out: '' }))), new Promise(r => c2.on('close', (code) => r({ code, out: '' })))]);
    j = J.load();
    const aud3 = await audit(j, api, fund.address);
    step('p3 параллельные экземпляры: оба exit 0, дублей нет', e1.code === 0 && e2.code === 0 && aud3.viol.length === 0, `exit=${e1.code}/${e2.code}`);

    // p4: краш после отправки (новый период, чтобы был что отправлять)
    const PERIOD2 = '2026-W46';
    const runWorkerP2 = (extra = []) => spawnSync(process.execPath, [process.argv[1], '--worker', JPATH, node.url, JSON.stringify(fund), PERIOD2, ...extra, JSON.stringify({ measurements: ops, budget: WEEK_TOTAL })], { encoding: 'utf8', timeout: 120000 });
    const crash = runWorkerP2(['--crash']);
    step('p4.0 воркер упал после отправки', crash.status !== 0, `exit=${crash.status}`);
    await mine2();
    j = J.load();
    rec = await reconcile(j, J.save, api);
    const paid46a = rec.filter(x => x.action === 'marked_paid');
    step('p4.1 recover нашёл отправленную tx (тот же txid), новой не создал', paid46a.length === 1 && !rec.some(x => x.action === 'resubmitted_same_txid'), JSON.stringify(rec).slice(0, 220));
    // добивка: повторный запуск досылает оставшееся намерение (op-do|W46)
    const cont = runWorkerP2();
    step('p4.2 продолжение завершилось', cont.status === 0, (cont.stdout || '').slice(0, 160));
    await mine2();
    j = J.load();
    rec = await reconcile(j, J.save, api);
    const paid46b = j.intents ? Object.values(j.intents).filter(i => i.key.endsWith(PERIOD2) && i.status === 'paid').length : 0;
    step('p4.3 обе выплаты W46 подтверждены, повторных отправок нет', paid46b === 2 && !rec.some(x => x.action === 'resubmitted_same_txid'), `paid=${paid46b}`);
    const aud4 = await audit(j, api, fund.address);
    step('p4.4 аудит: по ключу ровно 1 выплата', aud4.viol.length === 0, aud4.viol.join('; ') || 'ok');

    // p5: нулевой бюджет и превышение
    {
      const jj = { intents: {}, refusals: [] };
      const d0 = compute(jj, ops, 0, '2026-W47');
      const big = ops.map(o => ({ ...o, awardAgt: o.opId === 'op-hetzner' ? 10 : 11 }));
      const d1 = compute({ intents: {}, refusals: [] }, big, WEEK_TOTAL, '2026-W47');
      const refused0 = d0.every(d => d.action === 'refused' && d.reason === 'zero_budget');
      const refused1 = d1.some(d => d.reason === 'over_budget' || d.reason === 'per_op_over_limit');
      step('p5 отказы без транзакций: zero_budget и over_limit', refused0 && refused1, JSON.stringify([...d0, ...d1]).slice(0, 200));
      R.refusals = { zero_budget: d0, over_limit: d1 };
    }

    // p6: ручной дубль мимо журнала → аудит обязан поймать
    {
      const dupTx = { from: fund.address, fromPub: fund.pub, to: ops[0].address, amount: 10, nonce: Date.now() + 99999, ts: Math.floor(Date.now() / 1000), memo: `payout-stand:${ops[0].opId}|${PERIOD}` };
      dupTx.txid = txDigest(dupTx); dupTx.signature = signTransaction(dupTx, fund.priv);
      await api('/tx', { method: 'POST', body: dupTx });
      await mine2();
      j = J.load();
      const aud = await audit(j, api, fund.address);
      const caught = aud.viol.some(v => v.includes('РАЗНЫЕ txid'));
      // убираем тестовый дубль из рассмотрения: это доказательство, что аудит ловит
      step('p6 аудит выявил ручной дубль с другим txid', caught, aud.viol.join('; ').slice(0, 200));
      R.auditCatchesManualDouble = caught;
    }

    // реестр
    j = J.load();
    const blocks = (await api('/blocks?from=0')).body.blocks || [];
    const heightOf = txid => { const b = blocks.find(b => (b.txs || []).some(t => t.txid === txid)); return b ? (b.height ?? b.header?.height) : null; };
    const registry = { period: [PERIOD, PERIOD2], budget: { perOp: PER_OP / MGNT, total: WEEK_TOTAL / MGNT }, entries: [] };
    for (const it of Object.values(j.intents)) {
      registry.entries.push({ key: it.key, op: it.opId, amountAgt: it.amountMinor / MGNT, txid: it.txid, block: heightOf(it.txid), status: it.status, why: it.why });
    }
    fs.writeFileSync(REG, JSON.stringify(registry, null, 1));
    step('p7 реестр сдан', registry.entries.length === 4 && registry.entries.every(e => e.block != null), `entries=${registry.entries.length}`);
    R.registry = REG;
  } catch (e) {
    step('harness', false, String(e.message || e).slice(0, 300));
    R.error = String(e.stack || e).slice(0, 800);
  } finally {
    try { node.child.kill('SIGKILL'); } catch {}
  }
  R.finishedAt = new Date().toISOString();
  R.passed = R.steps.filter(s => s.ok).length; R.failed = R.steps.filter(s => !s.ok).length;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
  console.log(`ИТОГ A4: ${R.passed} pass / ${R.failed} fail → ${OUT}`);
  process.exit(R.failed ? 1 : 0);
}

main();
