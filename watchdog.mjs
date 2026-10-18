#!/usr/bin/env node
// Liveness supervision: stale blocks or a slow miner do not justify killing a
// responsive node. Consensus/sync health belongs in diagnostics.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { isIP } from 'node:net';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHECK_EVERY_MS = 40_000;
const RESTART_COOLDOWN_MS = 3 * 60_000;
export function readTailnetBind(env = process.env, read = fs.readFileSync) {
  let configured = env.AGT_TS_BIND || env.AGT_TS_IP || '';
  if (!configured) {
    try { configured = read(path.join(ROOT, 'data-agtx', 'ts-bind.txt'), 'utf8'); } catch {}
  }
  const bind = String(configured).trim();
  return isIP(bind) && bind !== '0.0.0.0' && bind !== '::' ? bind : null;
}
const tailnetBind = readTailnetBind();
export const NODES = [
  { name: 'A (9335)', port: '9335', url: 'http://127.0.0.1:9335/life', wrapper: path.join(ROOT, 'run-node.cmd') },
  { name: 'B (9341)', port: '9341', url: 'http://127.0.0.1:9341/life', wrapper: path.join(ROOT, 'run-node2.cmd') },
  { name: 'C (9342)', port: '9342', url: 'http://127.0.0.1:9342/life', wrapper: path.join(ROOT, 'run-node3.cmd') },
  { name: 'TS (9336)', port: '9336', url: tailnetBind ? `http://${tailnetBind.includes(':') ? `[${tailnetBind}]` : tailnetBind}:9336/life` : null,
    wrapper: path.join(ROOT, 'run-node-ts.cmd'), configurationError: 'Set AGT_TS_BIND or data-agtx/ts-bind.txt to this host tailnet IP' },
];

// The deadline covers headers AND body. Destroying the request on timeout is
// essential: resolving alone leaves hanging sockets in every cycle.
export function requestJson(url, { timeoutMs = 5000, maxBytes = 4096 } = {}) {
  return new Promise((resolve) => {
    let req, res, timer, settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      res?.destroy();
      req?.destroy();
    };
    timer = setTimeout(() => finish({ status: 0, error: 'timeout' }), timeoutMs);
    try {
      const transport = new URL(url).protocol === 'https:' ? https : http;
      req = transport.get(url, { agent: false }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return finish({ status: res.statusCode, error: 'response_too_large' });
          chunks.push(chunk);
        });
        res.on('error', (err) => finish({ status: res.statusCode, error: err.message }));
        res.on('aborted', () => finish({ status: res.statusCode, error: 'response_aborted' }));
        res.on('end', () => {
          try { finish({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { finish({ status: res.statusCode, error: 'invalid_json' }); }
        });
      });
      req.on('error', (err) => finish({ status: 0, error: err.message }));
    } catch (err) { finish({ status: 0, error: err.message }); }
  });
}

export async function probeHealth(node, request = requestJson) {
  if (!node.url) return { alive: false, disabled: true, error: node.configurationError || 'node URL is not configured' };
  const url = new URL(node.url);
  url.pathname = '/health';
  url.search = '';
  let result = await request(url.href);
  // An explicit 404 alone selects the expensive legacy contract.
  const legacy = result.status === 404;
  if (legacy) result = await request(node.url);
  const body = result.body;
  if (!result.error && body && typeof body === 'object') {
    const overloaded = body.overloaded === true || body.shield?.overloaded === true;
    if (result.status === 503 && (overloaded || body.error === 'overloaded')) {
      return { alive: true, overloaded: true, blocks: body.blocks, tipAgeSec: body.tipAgeSec };
    }
    const valid = result.status === 200 && (legacy
      ? typeof body.alive === 'boolean' && typeof body.chainValid === 'boolean'
      : body.ok === true && body.service === 'agt-node');
    if (valid) return { alive: true, overloaded, chainValid: body.chainValid, blocks: body.blocks, tipAgeSec: body.tipAgeSec };
  }
  // A different/invalid HTTP 200 service on the configured port is not proof
  // that its process belongs to us. Surface it, do not taskkill that listener.
  return { alive: false, responsive: result.status === 200,
    error: result.error || `invalid_health_http_${result.status}` };
}

// null = failed inspection; 0 = successful inspection found no listener.
export function parsePortOwner(stdout, port) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0]?.toUpperCase() !== 'TCP' || fields[3] !== 'LISTENING') continue;
    if (fields[1]?.slice(fields[1].lastIndexOf(':') + 1) !== String(port)) continue;
    const pid = Number(fields[4]);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
  }
  return 0;
}

function portOwnerPid(port) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : parsePortOwner(stdout, port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function killPidAwaitFree(pid, port) {
  const current = await portOwnerPid(port);
  if (current === 0) return true;
  if (current !== pid) return false;
  const killed = await new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: 10_000, windowsHide: true }, (err) => resolve(!err));
  });
  if (!killed) return false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await portOwnerPid(port) === 0) return true;
  }
  return false;
}

export function launchWrapper(wrapper, { spawnFn = spawn, exists = fs.existsSync, log = () => {} } = {}) {
  if (!exists(wrapper)) { log(`wrapper отсутствует: ${wrapper}`); return Promise.resolve(false); }
  let adminToken = null;
  try { adminToken = fs.readFileSync(path.join(ROOT, 'data-agtx', 'admin-token.txt'), 'utf8').trim() || null; } catch {}
  const env = adminToken ? { ...process.env, AGT_ADMIN_TOKEN: adminToken } : process.env;
  return new Promise((resolve) => {
    try {
      const child = spawnFn(process.platform === 'win32' ? 'cmd' : wrapper,
        process.platform === 'win32' ? ['/c', wrapper] : [],
        { cwd: ROOT, windowsHide: true, env, detached: true, stdio: 'ignore' });
      // ENOENT is normally asynchronous, outside try/catch.
      child.once('error', (err) => { log(`wrapper не запустился: ${err.message}`); resolve(false); });
      child.once('spawn', () => { child.unref?.(); log(`wrapper запущен: ${wrapper} (pid ${child.pid})`); resolve(true); });
    } catch (err) { log(`wrapper не запустился: ${err.message}`); resolve(false); }
  });
}

function cpuLoadPct() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'],
      { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        const value = Number(String(stdout).trim());
        resolve(!err && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);
      });
  });
}

// Importing this module never starts supervision, writes state or kills a PID.
export function createWatchdog({ nodes = NODES, state = { nodes: {} }, probe = probeHealth,
  owner = portOwnerPid, kill = killPidAwaitFree, launch = launchWrapper, cpu = cpuLoadPct,
  canLaunch = (node) => fs.existsSync(node.wrapper),
  now = Date.now, pause = sleep, save = () => {}, log = () => {}, failLimit = 2,
  sickLimit = 5, cooldownMs = RESTART_COOLDOWN_MS } = {}) {
  if (!state.nodes || typeof state.nodes !== 'object') state.nodes = {};
  for (const node of nodes) state.nodes[node.name] = {
    fails: 0, sick: 0, shed: 0, restarts: 0, lastRestartAt: 0, lastAliveAt: 0,
    ...(state.nodes[node.name] || {}),
  };
  let busy = false;
  async function cycle() {
    if (busy) return false;
    busy = true;
    try {
      // Bounded parallel HTTP, serialized restart decisions: at most one attempt.
      const checks = await Promise.all(nodes.map(async (node) => {
        try { return await probe(node); } catch (err) { return { alive: false, error: err.message }; }
      }));
      let attempted = false, cpuNow;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i], rec = state.nodes[node.name], check = checks[i];
        rec.lastCheckedAt = now();
        if (check.alive) {
          rec.fails = 0; rec.sick = 0; rec.lastAliveAt = now(); rec.lastProbeError = null;
          rec.shed = check.overloaded === true ? (rec.shed || 0) + 1 : 0;
          rec.blocks = Number.isFinite(check.blocks) ? check.blocks : null;
          rec.tipAgeSec = Number.isFinite(check.tipAgeSec) ? check.tipAgeSec : null;
          rec.stale = rec.tipAgeSec !== null && rec.tipAgeSec >= 300;
          rec.chainValid = typeof check.chainValid === 'boolean' ? check.chainValid : null;
          rec.status = check.overloaded ? 'overloaded' : check.chainValid === false ? 'chain_invalid' : rec.stale ? 'stale' : 'healthy';
          if (now() - rec.lastRestartAt >= 10 * 60_000) rec.cdMul = 1;
          continue; // Staleness/overload is visible, never a liveness restart.
        }
        rec.lastProbeError = check.error || 'unreachable';
        if (check.disabled) { rec.status = 'configuration_required'; rec.fails = 0; continue; }
        if (check.responsive) { rec.status = 'unexpected_health'; rec.fails = 0; continue; }
        rec.fails += 1; rec.status = 'unreachable';
        if (rec.fails < failLimit) continue;
        const lastAttempt = Math.max(rec.lastRestartAt || 0, rec.lastRestartAttemptAt || 0);
        if (lastAttempt && now() - lastAttempt < cooldownMs * (rec.cdMul || 1)) { rec.status = 'restart_cooldown'; continue; }
        let pid = await owner(node.port);
        if (pid === null || pid === undefined) { rec.status = 'owner_unknown'; continue; }
        if (pid) {
          rec.sick += 1;
          if (rec.sick < sickLimit) continue;
        } else {
          await pause(3000);
          pid = await owner(node.port);
          if (pid === null || pid === undefined) { rec.status = 'owner_unknown'; continue; }
          if (pid) { rec.sick += 1; rec.status = 'listener_detected'; continue; }
        }
        // Missing wrappers in a clean checkout must be diagnosed BEFORE we
        // terminate a process that we cannot then restore.
        if (!(await canLaunch(node))) { rec.status = 'wrapper_missing'; continue; }
        if (cpuNow === undefined) cpuNow = await cpu();
        if (attempted || (cpuNow !== null && cpuNow > 90)) { rec.status = 'restart_deferred'; continue; }
        attempted = true;
        if (pid && !(await kill(pid, node.port))) { rec.status = 'stop_failed'; continue; }
        const at = now();
        rec.lastRestartAttemptAt = at;
        rec.restartAttempts = (rec.restartAttempts || 0) + 1;
        const started = await launch(node.wrapper);
        if (!started) { rec.status = 'restart_failed'; log(`${node.name}: wrapper не запущен`); continue; }
        rec.cdMul = rec.lastRestartAt && at - rec.lastRestartAt < 10 * 60_000
          ? Math.min(4, Number(((rec.cdMul || 1) * 1.5).toFixed(1))) : 1;
        rec.lastRestartAt = at; rec.restarts += 1; rec.fails = 0; rec.sick = 0; rec.shed = 0;
        rec.status = 'starting';
        log(`${node.name}: wrapper запущен, ожидаю /health`);
      }
      state.checkedAt = new Date(now()).toISOString();
      save(state);
      return true;
    } finally { busy = false; }
  }
  return { state, cycle };
}

async function main() {
  const stateFile = path.join(ROOT, 'data', 'watchdog.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = { nodes: {} }; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = { nodes: {} };
  state.startedAt = new Date().toISOString();
  state.supervisorVersion = 2;
  const log = (msg) => console.log(`[watchdog ${new Date().toISOString()}] ${msg}`);
  const supervisor = createWatchdog({ state, log, launch: (wrapper) => launchWrapper(wrapper, { log }), save: (value) => {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify(value, null, 2));
      fs.renameSync(stateFile + '.tmp', stateFile);
    } catch (err) { log(`state не сохранён: ${err.message}`); }
  } });
  log('Цели: ' + NODES.map((node) => node.name).join(', ') + '; дешёвый /health, stale не вызывает рестарт');
  if (process.platform !== 'win32') log('Автозапуск .cmd поддерживается на Windows; без Windows PID inspection рестарты отключены');
  const run = () => supervisor.cycle().catch((err) => log(`ошибка цикла: ${err.message}`));
  await run();
  setInterval(run, CHECK_EVERY_MS);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
