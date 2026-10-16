#!/usr/bin/env node
/* accept-AGIP-5.mjs — исполняемый критерий приёмки AGIP-5 (docs/AGIP-5.md).
   Запуск:
     node test/accept-AGIP-5.mjs [http://127.0.0.1:9343]              — песочница
     node test/accept-AGIP-5.mjs http://127.0.0.1:9342 --ladder       — доже лестницу ROLLOUT (9342→9341→9335→9336)
   Exit-код: 0 = зелёный; 1 = FAIL (не съесть никто).
*/
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://127.0.0.1:9343').replace(/\/$/, '');
const LADDER = process.argv.includes('--ladder');
const fails = [];
const ok = (m) => console.log('  ok: ' + m);

function sleep(ms) { return new Promise(s => setTimeout(s, ms)); }
async function j(m, p, body = null, base = BASE, timeoutMs = 10_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base + p, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    let b = {}; try { b = await r.json(); } catch {}
    return { status: r.status, body: b };
  } catch { return { status: 0, body: {} }; }
  finally { clearTimeout(t); }
}

// ---- 0. синтаксис новых файлов (как делает CI) ----
for (const f of ['uptime.mjs']) {
  try { execSync(`node --check ${f}`, { cwd: process.cwd(), stdio: 'pipe' }); ok(`${f}: синтаксис ok`); }
  catch (e) { fails.push(`${f}: node --check FAIL ${String(e.stdout || e.message).slice(0, 200)}`); }
}

// ---- 1. /ops/watchdog/state на таргете; если нода ещё на старом коде — рестартаем (песочница only) ----
async function ensureEndpoint(port) {
  for (let i = 0; i < 3; i++) {
    const r = await j('GET', '/ops/watchdog/state');
    if (r.status === 200 && r.body && typeof r.body.nodes === 'object') return true;
    await sleep(2000);
  }
  if (!LADDER) {
    console.log('  ..  таргет на старом коде — рестарт песочницы с новым node.mjs');
    try { execSync(`powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force }"`, { stdio: 'pipe' }); } catch {}
    await sleep(2000);
    spawn(process.execPath, ['node.mjs', String(port)], {
      cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, AGT_DATA_DIR: 'data-sandbox' },
    }).unref();
    await sleep(3000);
    for (let i = 0; i < 20; i++) {
      const l = await j('GET', '/life');
      if (l.status === 200) break;
      await sleep(2000);
    }
  }
  const r = await j('GET', '/ops/watchdog/state');
  if (r.status === 200 && r.body && typeof r.body.nodes === 'object') { ok('/ops/watchdog/state: 200, nodes-объект отдан'); return true; }
  fails.push(`/ops/watchdog/state: статус ${r.status} (не 200) — AGIP-5 код не активен`);
  return false;
}
await ensureEndpoint(new URL(BASE).port);

// ---- 2. health-мысле: повторные GET стабильны; read-only трогает только данные watchdog'а ----
const st1 = await j('GET', '/ops/watchdog/state');
if (st1.status === 200) {
  if (st1.body.checkedAt && st1.body.startedAt !== undefined) ok('формат объекта: nodes/startedAt/checkedAt на месте');
  else fails.push('формат /ops/watchdog/state неполный: ' + JSON.stringify(st1.body).slice(0, 120));
} else fails.push('второй GET /ops/watchdog/state → ' + st1.status);

// ---- 3. монитор против живой ноды: тревога НЕ появляется; exit 0 ----
const tmp = mkdtempSync(path.join(os.tmpdir(), 'agip5-'));
const sender = 'AGT1accept5uptimebot000000000000000000000000';
async function feedCount(kind) {
  const r = await j('GET', '/community/feed?limit=200');
  return ((r.body.messages || []).filter(m => m.sender === sender && String(m.text).includes(kind))).length;
}
async function runUptime(urls, extra = {}) {
  const env = {
    ...process.env, AGT_URLS: urls, AGT_CHAT_URL: BASE, AGT_STATE_FILE: path.join(tmp, 'state.json'),
    AGT_DOWN_AFTER_SEC: String(extra.downAfterSec ?? 90), AGT_ALERT_SENDER: sender,
  };
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['uptime.mjs', '--once'], { cwd: process.cwd(), env, windowsHide: true });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 60_000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  return r;
}
{
  const beforeDown = await feedCount('🚨 [uptime]');
  const r = await runUptime(BASE);
  const afterDown = await feedCount('🚨 [uptime]');
  if (r.code === 0) ok(`монитор на живой ноде: exit 0 (лог: ${(r.out || '').split('\\n').filter(Boolean).slice(-1)[0] || '-'})`);
  else fails.push(`монитор на живой ноде: exit ${r.code}: ${(r.out || '').slice(0, 200)}`);
  if (afterDown === beforeDown) ok('монитор на живой ноде: ложной тревоги нет');
  else fails.push(`монитор на живой ноде: ложная тревога в чате (${beforeDown} → ${afterDown})`);
}

// ---- 4. монитор против МЁРТВОГО порта: тревога появляется; повторный прогон — дедуп ----
{
  const dead = 'http://127.0.0.1:9499';
  const r1 = await runUptime(dead, { downAfterSec: 1 });
  const afterDown1 = await feedCount('🚨 [uptime]');
  if (afterDown1 >= 1) ok('мёртвый порт: тревога 🚨 [uptime] появилась в чате');
  else fails.push(`мёртвый порт: тревоги нет (exit ${r1.code}, out ${(r1.out || '').slice(0, 200)})`);
  const r2 = await runUptime(dead, { downAfterSec: 1 });
  const afterDown2 = await feedCount('🚨 [uptime]');
  if (afterDown2 === afterDown1) ok('мёртвый порт: повторный прогон — новых тревог нет (дедуп 55 мин)');
  else fails.push(`мёртвый порт: дедуп не сработал (${afterDown1} → ${afterDown2})`);
}

// ---- 5. выздоровление: ВВЕДЁННЫЙ down-стейт на живой цели → ✅ [uptime] жив ----
{
  const statePath = path.join(tmp, 'state.json');
  const downSince = Date.now() - 20_000;
  writeFileSync(statePath, JSON.stringify({ urls: { [BASE]: { downSince, everUp: true, lastAlertAt: Date.now() - 10_000 } } }));
  const r = await runUptime(BASE, { downAfterSec: 90 });
  const recov = await feedCount('✅ [uptime]');
  if (recov >= 1) ok('выздоровление: сообщение ✅ [uptime] появилось в чате');
  else fails.push(`выздоровление: ✅ нет в чате (exit ${r.code}, out ${(r.out || '').slice(0, 200)})`);
}

// ---- 6. лестница ROLLOUT (--ladder): 9342 → 9341 → 9335 → 9336 — рестарт + новый endpoint ----
if (LADDER) {
  const ladder = [
    { port: 9342, wrapper: 'run-node3.cmd', name: 'C:9342 canary' },
    { port: 9341, wrapper: 'run-node2.cmd', name: 'B:9341' },
    { port: 9335, wrapper: 'run-node.cmd', name: 'A:9335 public' },
    { port: 9336, wrapper: 'run-node-ts.cmd', name: 'TS:9336 tailnet' },
  ];
  for (const n of ladder) {
    console.log(`  .. лестница: ${n.name} → рестарт обёрткой ${n.wrapper}`);
    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File data-agents/launch-node.ps1 -Wrapper ${n.wrapper} -KillPort ${n.port}`, { cwd: process.cwd(), stdio: 'pipe', timeout: 120_000 });
    } catch (e) { fails.push(`лестница ${n.name}: рестарт не прошёл ${String(e.message).slice(0, 120)}`); }
    let life = false, ep = false;
    for (let i = 0; i < 40 && !(life && ep); i++) {
      await sleep(3000);
      if (!life) { const l = await j('GET', '/life', null, `http://127.0.0.1:${n.port}`); life = l.status === 200; }
      if (life && !ep) { const r = await j('GET', '/ops/watchdog/state', null, `http://127.0.0.1:${n.port}`); ep = r.status === 200 && typeof r.body.nodes === 'object'; }
    }
    if (life && ep) ok(`лестница: ${n.name} — /life 200 + /ops/watchdog/state 200`);
    else fails.push(`лестница: ${n.name} — life=${life} endpoint=${ep} (нода не поднялась или код не активен)`);
  }
  // финальная сверка: единый tip на четырёх живых нодах
  const tips = {};
  for (const p of [9335, 9341, 9342, 9336]) {
    const l = await j('GET', '/life', null, `http://127.0.0.1:${p}`);
    tips[p] = { tip: l.body?.tipHash || null, valid: l.body?.chainValid === true, blocks: l.body?.blocks ?? 0 };
  }
  const set = new Set(Object.values(tips).map(t => t.tip));
  if (set.size === 1 && [...Object.values(tips)].every(t => t.valid)) ok(`единый tip ${[...set][0].slice(0, 14)}… на всех 4 нодах, chainValid=true`);
  else fails.push('tip не сходится: ' + JSON.stringify(tips));
} else {
  console.log('  --: лестница не запрошена (передай флаг --ladder после зелёной песочницы)');
}

// ---- финал ----
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log('');
if (fails.length) { console.log(`FAIL (${fails.length}):`); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('GREEN: AGIP-5 приёмка пройдена');
process.exit(0);
