#!/usr/bin/env node
/* guard-main.mjs — сторож установленной ноды (служба AgentcoinGuard).
   Опрашивает локальный /info. Если нода не отвечает несколько проверок подряд,
   перезапускает службу AgentcoinNode через sc.exe. Пульт (GUI) не трогает.
   Аргументы:
     --service=NAME      имя службы ноды (по умолчанию AgentcoinNode)
     --api-host=HOST     адрес API (по умолчанию 127.0.0.1)
     --api=PORT          порт API (по умолчанию 9333)
     --interval=SEC      период проверки (по умолчанию 15)
     --fail=N            сколько неудач подряд до перезапуска (по умолчанию 3)
     --restart-limit=N   не больше N перезапусков за 10 минут (по умолчанию 3)
     --log-file=FILE     файл журнала
     --once              одна проверка и выход (диагностика)
*/
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => args.includes(name);

const serviceName = opt('service', process.env.AGENTNET_SERVICE_NAME || 'AgentcoinNode');
const apiHost = opt('api-host', '127.0.0.1');
const apiPort = Number(opt('api', 9333));
const intervalMs = Math.max(1000, Number(opt('interval', 15)) * 1000);
const failLimit = Math.max(1, Number(opt('fail', 3)));
const restartLimit = Math.max(1, Number(opt('restart-limit', 3)));
const restartWindowMs = 10 * 60 * 1000;
const restartTimes = [];
const logFile = opt('log-file', process.env.AGENTNET_GUARD_LOG || '');
const once = flag('--once');

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 8 * 1024 * 1024) {
      try { fs.renameSync(logFile, `${logFile}.1`); } catch { /* не критично */ }
    }
    fs.appendFileSync(logFile, `${text}\n`);
  } catch { /* журнал не должен ронять сторожа */ }
}

function sc(argsList) {
  return new Promise((resolve) => {
    execFile('sc.exe', argsList, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err ? err.message : '') });
    });
  });
}

async function probe() {
  try {
    const res = await fetch(`http://${apiHost}:${apiPort}/info`, {
      signal: AbortSignal.timeout(4000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const info = await res.json();
    return { ok: info && info.state === 'running', reason: info && info.state, info };
  } catch (e) {
    return { ok: false, reason: e.code || e.message };
  }
}

let failures = 0;
let restarts = 0;

async function tick() {
  const r = await probe();
  if (r.ok) {
    if (failures > 0) log(`нода отвечает снова (было ${failures} неудач)`);
    failures = 0;
    return;
  }
  failures++;
  log(`нода не отвечает (${failures}/${failLimit}): ${r.reason}`);
  if (failures < failLimit) return;
  failures = 0;
  const now = Date.now();
  while (restartTimes.length && now - restartTimes[0] > restartWindowMs) restartTimes.shift();
  if (restartTimes.length >= restartLimit) {
    log(`перезапуск отложен: ${restartTimes.length} за 10 мин (лимит ${restartLimit}), ждём окно`);
    return;
  }
  restartTimes.push(now);
  restarts++;
  log(`перезапуск службы ${serviceName} (всего ${restarts})`);
  const stop = await sc(['stop', serviceName]);
  if (!stop.ok) log(`sc stop: ${stop.stderr.trim() || 'ошибка'}`);
  await new Promise((r2) => setTimeout(r2, 4000));
  const start = await sc(['start', serviceName]);
  log(start.ok ? `служба ${serviceName} запущена` : `sc start: ${start.stderr.trim() || 'ошибка'}`);
}

if (once) {
  const r = await probe();
  log(JSON.stringify({ service: serviceName, api: `http://${apiHost}:${apiPort}`, ...r }));
  process.exit(r.ok ? 0 : 1);
}

log(`сторож запущен: ${serviceName} через http://${apiHost}:${apiPort}/info каждые ${intervalMs / 1000} с`);
let stopped = false;
const stop = () => { stopped = true; log('сторож остановлен'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopped) {
  await tick();
  await new Promise((r) => setTimeout(r, intervalMs));
}
