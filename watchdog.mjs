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
// цель: name, url, wrapper (абс. путь .cmd), неоходимо ли tailscale-биндинг
const NODES = [
  { name: 'A (9335)', port: '9335', url: 'http://127.0.0.1:9335/life', wrapper: path.join(__dirname, 'run-node.cmd') },
  { name: 'B (9341)', port: '9341', url: 'http://127.0.0.1:9341/life', wrapper: path.join(__dirname, 'run-node2.cmd') },
  { name: 'C (9342)', port: '9342', url: 'http://127.0.0.1:9342/life', wrapper: path.join(__dirname, 'run-node3.cmd') },
  { name: 'TS (9336)', port: '9336', url: `http://${process.env.AGT_TS_IP || '100.96.7.15'}:9336/life`, wrapper: path.join(__dirname, 'run-node-ts.cmd') },
  { name: 'D (9337)', port: '9337', url: 'http://127.0.0.1:9337/life', wrapper: path.join(__dirname, 'run-node9337.cmd') },
  { name: 'E (9338)', port: '9338', url: 'http://127.0.0.1:9338/life', wrapper: path.join(__dirname, 'run-node9338.cmd') },
  { name: 'F (9339)', port: '9339', url: 'http://127.0.0.1:9339/life', wrapper: path.join(__dirname, 'run-node9339.cmd') },
]; // инцидент 2026-10-16: D/E/F умерли молча и караулились 2.5 ч — теперь под присмотром
const SICK_LIMIT = 5; // подряд живой-порт-но-мёртвый-/life → жёсткий рестарт (5 × 40с = ~3.3 мин)

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
  // ТЗ-1 (аудит 2026-10-15): токен охраны деструктивных POST читаем из gitignored-файла
  // и пробрасываем в env ноды (работает и для обёрток, которые нельзя править прямоН и
  // и для будущих рестартов watchdog-ом). Без файла — env не трогаем, охрана неактивна.
  let adminToken = null;
  try { adminToken = fs.readFileSync(path.join(__dirname, 'data-agtx', 'admin-token.txt'), 'utf8').trim() || null; } catch { adminToken = null; }
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `cmd /c "${wrapper}"`
      : wrapper;
    const env = adminToken ? { ...process.env, AGT_ADMIN_TOKEN: adminToken } : process.env;
    exec(cmd, { cwd: __dirname, windowsHide: true, env }, () => resolve());
  });
}

// Инцидент 2026-10-15: watchdog при коротком провале /life (мгновенная перегрузка,
// 503 shedding) спавнил дубликат-обёртку — старый процесс продолжал держать порт,
// новый зомбировал на EADDRINUSE (глобал-guard ноды глотал ошибку) → 18 клонов.
// Правило: ЛИСТЕНЕР НА ПОРТУ ЕСТЬ → дубликат не спавним; устойчиво болен (>SICK_LIMIT)
// → по-настоящему убиваем владелеца порта и на следующем цикле поднимаем заново.
function portOwnerPid(port) {
  return new Promise((resolve) => {
    exec(`netstat -ano -p TCP | findstr ":${port} " | findstr LISTENING`, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err || !String(stdout).trim()) return resolve(0);
      const parts = String(stdout).trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      resolve(Number.isFinite(pid) ? pid : 0);
    });
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
      const owner = await portOwnerPid(n.port);
      if (owner) {
        rec.sick = (rec.sick || 0) + 1;
        log(`${n.name}: /life мёртв, но порт ${n.port} слушает pid ${owner} — не спавню дубликат (sick ${rec.sick}/${SICK_LIMIT})`);
        if (rec.sick >= SICK_LIMIT) {
          rec.sick = 0; rec.restarts += 1; rec.lastRestartAt = Date.now();
          log(`HARD-RESTART ${n.name}: taskkill pid ${owner} → подъём обёрткой (всего рестартов: ${rec.restarts})`);
          exec(`taskkill /PID ${owner} /F`, { windowsHide: true }, () => {});
          // поднимаем сразу: порт освободится за миг, обёртка стартует ноде заново
          launchWrapper(n.wrapper).then(() => save());
        }
      } else {
        rec.sick = 0; rec.fails = 0; rec.restarts += 1; rec.lastRestartAt = Date.now();
        log(`RESTART ${n.name} → ${n.wrapper} (всего рестартов: ${rec.restarts})`);
        launchWrapper(n.wrapper).then(() => save());
      }
    }
  }
  save();
}
log('сторож вышел на пост. Цели: ' + NODES.map(n => n.name).join(', '));
save();
await cycle();
setInterval(() => { cycle(); }, CHECK_EVERY_MS);
