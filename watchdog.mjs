#!/usr/bin/env node
/* ============================================================
   AGENTCOIN watchdog — чтобы сайт не падал, пока оператор спит.
   Каждые CHECK_EVERY сек проверяет ноды (HTTP /life с таймаутом).
   Кто не отвечает N раз подряд — нода перезапускается своей
   обёрткой run-node*.cmd (как в штатном порядке, с своими логами).
   Перезапуски пишутся в data/watchdog.json (счётчики + колдаун).
   Запуск: node watchdog.mjs   (фоном, навсегда)
   ============================================================ */
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';

const __dirname = path.dirname(process.argv[1] || '.');
const CHECK_EVERY_MS = 40_000;
const FAIL_LIMIT = 2;          // 2 подряд неудачи → рестарт
const RESTART_COOLDOWN_MS = 3 * 60_000;
const HTTP_OPTIONS = { port: 0 };

// цель: name, url, wrapper (абс. путь .cmd), неоходимо ли tailscale-биндинг
const NODES = [
  { name: 'A (9335)', url: 'http://127.0.0.1:9335/life', wrapper: path.join(__dirname, 'run-node.cmd') },
  { name: 'B (9341)', url: 'http://127.0.0.1:9341/life', wrapper: path.join(__dirname, 'run-node2.cmd') },
  { name: 'C (9342)', url: 'http://127.0.0.1:9342/life', wrapper: path.join(__dirname, 'run-node3.cmd') },
  { name: 'TS (9336)', url: `http://${process.env.AGT_TS_IP || '100.96.7.15'}:9336/life`, wrapper: path.join(__dirname, 'run-node-ts.cmd') },
];

const stateFile = path.join(__dirname, 'data', 'watchdog.json');
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { nodes: {}, startedAt: new Date().toISOString() }; } }
const state = loadState();
for (const n of NODES) if (!state.nodes[n.name]) state.nodes[n.name] = { fails: 0, restarts: 0, lastRestartAt: 0, lastAliveAt: 0 };
function save() { try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch {} }
function log(m) { console.log(`[watchdog ${new Date().toISOString()}] ${m}`); }

function probe(url) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { resolve(false); }, 5000);
    http.get(url, (res) => { res.resume(); clearTimeout(t); resolve(res.statusCode === 200); })
      .on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function launchWrapper(wrapper) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `cmd /c "${wrapper}"`
      : wrapper;
    exec(cmd, { cwd: __dirname, windowsHide: true }, () => resolve());
  });
}

async function cycle() {
  for (const n of NODES) {
    const rec = state.nodes[n.name];
    const ok = await probe(n.url);
    if (ok) { rec.fails = 0; rec.lastAliveAt = Date.now(); continue; }
    rec.fails += 1;
    log(`${n.name} не отвечает (${rec.fails}/${FAIL_LIMIT}, url ${n.url})`);
    if (rec.fails >= FAIL_LIMIT && Date.now() - rec.lastRestartAt > RESTART_COOLDOWN_MS) {
      rec.fails = 0; rec.restarts += 1; rec.lastRestartAt = Date.now();
      log(`RESTART ${n.name} → ${n.wrapper} (всего рестартов: ${rec.restarts})`);
      launchWrapper(n.wrapper).then(() => save());
    }
  }
  save();
}
log('сторож вышел на пост. Цели: ' + NODES.map(n => n.name).join(', '));
save();
await cycle();
setInterval(() => { cycle(); }, CHECK_EVERY_MS);
