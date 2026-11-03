#!/usr/bin/env node
/* miner-watchdog.mjs — сторож свежести цепи AGT (профессиональная версия).
   Что делает:
     1) Каждые 60 с опрашивает /life нод node1/2/3.
     2) Если tip протух (fresh:false при age > STALE_SEC) — запускает тонкий
        майнер miner-client.mjs против node1, если он ещё не запущен.
     3) Если майнер-процесс умер (лок/heartbeat), тоже перезапускает.
     4) Пишет журнал data/miner-watchdog.log, дублирует в console.
   Параметры через env: WD_NODES (csv), WD_SCAN_SEC, WD_STALE_SEC.
   Запуск: node tools/miner-watchdog.mjs   (из корня agentcoin-audit)
'use strict'; */
// 2026-11-03: статус каждой проверки пишется в журнал — контроль и алертинг по логу.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..', 'agentcoin');
const LOG = path.join(ROOT, 'data', 'miner-watchdog.log');
const MINER_ROOT_DATA = path.join(ROOT, 'data-miner-node1');
const NODES = (process.env.WD_NODES || 'node1,node2,node3').split(',').map(s => s.trim()).filter(Boolean);
const SCAN_SEC = Number(process.env.WD_SCAN_SEC || 60);
const STALE_SEC = Number(process.env.WD_STALE_SEC || 300);
const MINER_URL = process.env.WD_MINER_URL || 'https://node1.agentcoin.work';

fs.mkdirSync(path.dirname(LOG), { recursive: true });
function log(line) {
  const row = `[wd ${new Date().toISOString().slice(11, 19)}] ${line}`;
  console.log(row);
  fs.appendFileSync(LOG, row + '\n');
}

function minerAlive() {
  try {
    const lock = path.join(MINER_ROOT_DATA, 'lock');
    const pid = Number(fs.readFileSync(lock, 'utf8') || 0);
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch { return false; }
}

function startMiner() {
  log('стартую тонкий майнер против ' + MINER_URL);
  const child = spawn(process.execPath, [path.join(REPO, 'miner-client.mjs'), MINER_URL], {
    cwd: REPO,
    env: { ...process.env, AGT_MINER_DATA: MINER_ROOT_DATA },
    detached: true,
    stdio: ['ignore', path.join(MINER_ROOT_DATA, 'miner.log'), path.join(MINER_ROOT_DATA, 'miner.log')],
  });
  child.on('error', e => log('ошибка спавна майнера: ' + e.message));
}

async function checkNode(name) {
  try {
    const r = await fetch(`https://${name}.agentcoin.work/life`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { name, status: 'http_' + r.status };
    const j = await r.json();
    return { name, h: j.blocks, age: j.tipAgeSec, fresh: !!j.fresh, valid: j.chainValid, tips: j.tips || [] };
  } catch (e) {
    return { name, status: 'fetch_err', err: e.message };
  }
}

const staleSince = new Map(); // name → timestamp начала stale

async function loop() {
  const results = await Promise.all(NODES.map(checkNode));
  const now = Date.now();
  for (const r of results) {
    const wasFresh = r.fresh === true;
    if (!wasFresh) {
      if (!staleSince.has(r.name)) staleSince.set(r.name, now);
    } else staleSince.delete(r.name);
  }
  const summary = results.map(r => `${r.name}:h${r.h ?? '-'}:${r.status || (r.age + 'с' + (r.fresh === false ? ' stale' : ''))}`).join(' ');
  const maxStale = Math.max(0, ...[...staleSince.values()].map(t => Math.round((now - t) / 1000)));
  if (results.every(r => r.fresh === true)) {
    log('цепь свежая: ' + summary);
  } else if (maxStale >= STALE_SEC) {
    if (!minerAlive()) {
      log(`stale ${maxStale}с и майнер не жив — поднимаю. ${summary}`);
      fs.mkdirSync(MINER_ROOT_DATA, { recursive: true });
      startMiner();
    } else {
      log(`stale ${maxStale}с, майнер жив — ждём его PoW. ${summary}`);
    }
  } else {
    log('цепь не свежая, но менее ' + STALE_SEC + 'с — наблюдение. ' + summary);
  }

}

log(`watchdog запущен: ноды ${NODES.join(', ')}, скан ${SCAN_SEC}с, порог stale ${STALE_SEC}с, майнер → ${MINER_URL}`);
await loop();
setInterval(loop, SCAN_SEC * 1000);
