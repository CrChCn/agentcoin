#!/usr/bin/env node
/* accept-AGIP-6.mjs — исполняемый критерий приёмки AGIP-6 (шаги 14/15/16).
   Запуск: node test/accept-AGIP-6.mjs [http://127.0.0.1:9343] [--ladder]
   Песочница: полный цикл эскроу с комиссией казны + сайт + кэш.
   --ladder: read-only проверка выбранной ноды; AGT_MONITOR_TARGETS_FILE задаёт JSON [{name,url}].
   Exit: 0 зелёный / 1 FAIL. */
import { spawn, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = (process.argv.find(a => a.startsWith('http')) || 'http://127.0.0.1:9343').replace(/\/$/, '');
const LADDER = process.argv.includes('--ladder');
const fails = [], ok = m => console.log('  ok: ' + m);
const sleep = ms => new Promise(s => setTimeout(s, ms));

async function j(m, p, body = null, base = BASE, to = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), to);
  try {
    const r = await fetch(base + p, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    let b = {}; try { b = await r.json(); } catch {}
    return { status: r.status, body: b, text: b };
  } catch { return { status: 0, body: {} }; }
  finally { clearTimeout(t); }
}
async function raw(p, base = BASE, to = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), to);
  try { const r = await fetch(base + p, { signal: ctl.signal }); return { status: r.status, text: await r.text() }; }
  catch { return { status: 0, text: '' }; }
  finally { clearTimeout(t); }
}

// ---- 0. синтаксис ----
for (const f of ['node.mjs', 'digest.mjs']) {
  try { execSync(`node --check ${f}`, { cwd: process.cwd(), stdio: 'pipe' }); ok(`${f}: синтаксис ok`); }
  catch (e) { fails.push(`${f}: syntax FAIL`); }
}

async function ensureNewCode(port) {
  for (let i = 0; i < 3; i++) { const r = await j('GET', '/jobs/state'); if (r.status === 200) return true; await sleep(2000); }
  if (LADDER) return false;
  console.log('  .. restarter sandbox → код новой ноды');
  try { execSync(`powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force }"`, { stdio: 'pipe' }); } catch {}
  await sleep(2500);
  spawn(process.execPath, ['node.mjs', String(port)], { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, AGT_DATA_DIR: 'data-sandbox' } }).unref();
  await sleep(3000);
  for (let i = 0; i < 20; i++) { const l = await j('GET', '/life'); if (l.status === 200) break; await sleep(2000); }
  const r = await j('GET', '/jobs/state');
  return r.status === 200;
}

// ---- режим ladder: только read-only витрина проверки на живых нодах ----
if (LADDER) {
  const configured = process.env.AGT_MONITOR_TARGETS_FILE
    ? JSON.parse(readFileSync(process.env.AGT_MONITOR_TARGETS_FILE, 'utf8'))
    : [{name:'selected-node', url:BASE}];
  if (!Array.isArray(configured) || !configured.length || configured.length > 16) throw new Error('invalid monitor targets');
  const targets = configured.map(row => {
    if (!row || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 64 || typeof row.url !== 'string') throw new Error('invalid monitor target');
    const u = new URL(row.url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('invalid monitor URL');
    return [row.name, u.origin];
  });
  const tips = [];
  for (const [name, u] of targets) {
    const js = await j('GET', '/jobs/state', null, u);
    const sd = await j('GET', '/stats-data', null, u);
    const life = await j('GET', '/life', null, u);
    if (js.status === 200 && sd.status === 200 && life.status === 200) ok(`выбранная нода ${name}: /jobs/state + /stats-data + /life живы`);
    else fails.push(`${name}: jobs=${js.status} stats-data=${sd.status} life=${life.status}`);
    tips.push(life.body?.tipHash || null);
  }
  const set = new Set(tips);
  if (tips.every(t => typeof t === 'string' && t.length > 0) && set.size === 1) ok(`единый наблюдаемый tip ${tips[0].slice(0, 14)}… на ${targets.length} настроенных нодах`);
  else fails.push('наблюдаемые tip не сходятся или недоступны: ' + JSON.stringify(tips));
  if (process.env.AGT_PUBLIC_URL) {
    const u = new URL(process.env.AGT_PUBLIC_URL);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('invalid AGT_PUBLIC_URL');
    const live = await raw('/life', u.origin).then(r => r.status === 200);
    if (live) ok('явно заданная публичная точка отвечает 200');
    else fails.push('явно заданная публичная точка не отвечает');
  }
} else {
  if (!(await ensureNewCode(new URL(BASE).port))) fails.push('/jobs/state не отвечает даже после рестарта песочницы');
  // ---- 1. витрина/кэш/сайт ----
  {
    const sd = await j('GET', '/stats-data');
    if (sd.status === 200 && typeof sd.body.blocks === 'number') ok(`/stats-data: blocks=${sd.body.blocks}, chainValid=${sd.body.chainValid}`);
    else fails.push(`/stats-data: ${sd.status} ${JSON.stringify(sd.body).slice(0, 100)}`);
    const js = await j('GET', '/jobs/state');
    if (js.status === 200 && js.body.stats && typeof js.body.stats.total === 'number') ok(`/jobs/state: total=${js.body.stats.total} open=${js.body.stats.open} paid=${js.body.stats.paid} fees=${js.body.stats.feesAGT}`);
    else fails.push(`/jobs/state: ${js.status}`);
    const e1 = await j('GET', '/escrow/state');
    if (e1.status === 200 && Array.isArray(e1.body.escrows)) ok('/escrow/state через кэш: 200');
    else fails.push('/escrow/state: ' + e1.status);
    const idx = await raw('/index'); const jb = await raw('/jobs');
    if (idx.status === 200 && jb.status === 200) ok('сайт: /index + /jobs страницы отдаются');
    else fails.push(`сайт: index=${idx.status} jobs=${jb.status}`);
  }
  // ---- 2. РАЗ батарея: полный цикл эскроу с комиссией казны ----
  {
    const mk = await j('POST', '/wallet/create');
    if (mk.status !== 201) { fails.push('wallet/create: ' + mk.status); rw(); }
  }
  function rw() { return; }
  {
    const ws = Object.values(JSON.parse(readFileSync(path.join(process.cwd(), 'data-sandbox', 'wallets.json'), 'utf8')));
    if (ws.length < 1) fails.push('песочница: wallets.json пуст');
    // employer = свежий кошелёк, worker = ещё один свежий
    const wr1 = await j('POST', '/wallet/create');
    const walletsRaw = () => {
      try { const d = JSON.parse(readFileSync(path.join(process.cwd(), 'data-sandbox', 'wallets.json'), 'utf8')); return Object.entries(d); } catch { return []; }
    };
    let entries = walletsRaw();
    const [emp, wor] = [entries[entries.length - 2], entries[entries.length - 1]];
    ok('кошельки созданы: employer=' + emp[0].slice(0, 12) + '… worker=' + wor[0].slice(0, 12) + '…');
    // faucet
    const fa = await j('POST', '/faucet/drip', { address: emp[0] });
    if (fa.status !== 201 && fa.status !== 200) ok(`faucet: ${fa.status} (${(fa.body.error || '')}) — известное условие песочницы, funding покрывается майнинг-наградой (employer = майнер)`);
    else ok('faucet employer: drip прошёл');
    // упакуй faucet tx блоком
    await j('POST', '/mine', { miner: emp[0] });
    const bal0 = await j('POST', '/balance', { address: emp[0] });
    ok('баланс employer после faucet+mine: ' + JSON.stringify(bal0.body && bal0.body.balance));
    // escrow create amount 0.3
    const ec = await j('POST', '/escrow/create', { employer: emp[0], worker: wor[0], amount: 0.3, taskHash: 'a'.repeat(24), deadlineSec: 600 });
    if (ec.status !== 201) fails.push('escrow/create: ' + ec.status + ' ' + JSON.stringify(ec.body).slice(0, 120));
    else ok(`escrow/create: escId=${ec.body.escId}, amount=0.3`);
    // switch nodes to make the funds mine
    await j('POST', '/mine', { miner: emp[0] });
    // claim worker
    const cl = await j('POST', '/escrow/claim', { escId: ec.body.escId, taskHash: 'a'.repeat(24), workerAddress: wor[0] });
    if (cl.status !== 200) fails.push('escrow/claim: ' + cl.status + ' ' + JSON.stringify(cl.body).slice(0, 120));
    else ok('escrow/claim: receipt подписан');
    // payout BOMBE
    const po = await j('POST', '/escrow/payout', { escId: ec.body.escId, employerAddress: emp[0], workerReceiptSig: cl.body.receiptSig, workerPub: cl.body.workerPub });
    if (po.status === 201 && po.body.fee) {
      if (po.body.fee.ok) ok(`payout: готов, комиссия казны ${po.body.fee.amount} AGT (txid ${po.body.fee.txid})`);
      else ok(`payout подготовлен, но fee не прошла (${(po.body && po.body.fee && po.body.fee.reason) || '?'}) — GUI честно`);
    } else fails.push('escrow/payout: ' + po.status + ' ' + JSON.stringify(po.body).slice(0, 160));
    // упакуйте tx: /mine может коммитить асинхронно — терпеливо поллим /jobs/state?fresh=1
    for (let i = 0; i < 3; i++) await j('POST', '/mine', { miner: emp[0] });
    let js = null;
    for (let i = 0; i < 18; i++) {
      await sleep(5000);
      if (i && i % 2 === 0) await j('POST', '/mine', { miner: emp[0] }); // дожимаем коммит
      js = await j('GET', '/jobs/state?fresh=1');
      if ((js.body.history || []).some(h => h.escId === ec.body.escId)) break;
    }
    const hist = (js.body.history || []).find(h => h.escId === ec.body.escId);
    const thisFee = (js.body.fees || []).find(f => f.escId === ec.body.escId);
    if (hist && hist.status === 'paid') ok(`джобборд: джоб ${ec.body.escId.slice(0, 8)} из цепи: paid, paidOut=${hist.paidOut}`);
    else fails.push('джобборд: paid-джоб не найден в /jobs/state цепи: ' + JSON.stringify((js.body.history || []).slice(-2)).slice(0, 160));
    if (thisFee) ok(`комиссия казны on-chain: ${thisFee.amount} AGT (txid ${thisFee.txid.slice(0, 12)})`);
    else fails.push('комиссия казны: memo escfee не найден в /jobs/state феях');
    const fe2 = thisFee ? await j('POST', '/balance', { address: (await j('GET', '/info')).body ? null : null }) : null;
    // казна в /stats-data
    const sd = await j('GET', '/stats-data');
    if (sd.status === 200) ok('витрина: казна=' + (sd.body.treasury ?? '?') + ', paidJobs=' + sd.body.paidJobs);
    else fails.push('stats-data после выплат: ' + sd.status);
  }
}

console.log('');
if (fails.length) { console.log(`FAIL (${fails.length}):`); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('GREEN: AGIP-6 приёмка пройдена');
