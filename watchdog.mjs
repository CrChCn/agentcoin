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
  { name: 'G-SPORE (9340)', port: '9340', url: 'http://127.0.0.1:9340/life', wrapper: path.join(__dirname, 'run-node9340.cmd') },
  { name: 'H-SPORE (9344)', port: '9344', url: 'http://127.0.0.1:9344/life', wrapper: path.join(__dirname, 'run-node9344.cmd') },
  { name: 'I-SPORE (9345)', port: '9345', url: 'http://127.0.0.1:9345/life', wrapper: path.join(__dirname, 'run-node9345.cmd') },
  { name: 'J (9346)', port: '9346', url: 'http://127.0.0.1:9346/life', wrapper: path.join(__dirname, 'run-node9346.cmd') },
  { name: 'K (9347)', port: '9347', url: 'http://127.0.0.1:9347/life', wrapper: path.join(__dirname, 'run-node9347.cmd') },
]; // инцидент 2026-10-16: D/E/F умерли молча и караулились 2.5 ч — теперь под присмотром
// 2026-10-17: канарейки G/H/I — SPORE-ноды (AGIP-18 MVP: геном/физарум/метаболизм, AGT_SPORE=1)
// 2026-10-17: свежие J/K (9346/9347, data-n8/data-n9) — распределение нагрузки: новые пулы отсоса белька агентов со старых A/B/C.
const SICK_LIMIT = 5; // подряд живой-порт-но-мёртвый-/life → жёсткий рестарт (5 × 40с = ~3.3 мин)
const SHED_LIMIT = 15; // AGIP-19: подряд shedding (overloaded, но жива) — 15 тиков ≈ 10 мин, потом разово рестарт

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

// AGIP-19 (разгрузка): отличаем «живая, но перегружена» от «мёртвая».
// /health отвечает 503 {error: overloaded} с loopLag — рестарт это НЕ лечит
// (kill→spawn→загрузка 9-МБ цепи сам только продлевает шторм), поэтому считаем
// её живой до излёта по比我чому SHED_LIMIT.
function probeShed(url) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { resolve('timeout'); }, 6000);
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 4096) res.destroy(); });
      res.on('end', () => { clearTimeout(t); resolve(String(body).includes('overloaded') ? 'shedding' : 'ok'); });
    }).on('error', () => { clearTimeout(t); resolve('timeout'); });
  });
}

// AGIP-19: рестарт-шторм гасится растущим колдауном (идея PM2 exp_backoff):
// рестарт чаще чем раз в 10 мин → cooldown растёт ×1.5 до 4×; редкий — сброс в 1.
function escalateRestart(rec) {
  rec.cdMul = (Date.now() - rec.lastRestartAt < 10 * 60_000) ? Math.min(4, +(((rec.cdMul || 1) * 1.5).toFixed(1))) : 1;
  rec.lastRestartAt = Date.now();
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
    exec(`netstat -ano -p TCP | findstr ":${port} " | findstr LISTENING`, { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err || !String(stdout).trim()) return resolve(0);
      const parts = String(stdout).trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      resolve(Number.isFinite(pid) ? pid : 0);
    });
  });
}

async function cycle() {
  // AGIP-23 (анти-CPU-шторм): максимум ОДНА реанимация за цикл — каждая = полная
  // загрузка 9-МБ chain.json (CPU-спайк). Инцидент: несколько RESTART за цикл =
  // ферма топит сама себя и разваливается. Пропущенные ноды догоняю со следующих циклов.
  let respawnsThisCycle = 0;
  for (const n of NODES) {
    const rec = state.nodes[n.name];
    const ok = await probe(n.url);
    if (ok) { rec.fails = 0; rec.shed = 0; rec.cdMul = 1; rec.lastAliveAt = Date.now(); continue; }
    rec.fails += 1;
    log(`${n.name} не отвечает (${rec.fails}/${FAIL_LIMIT}, url ${n.url})`);
    const cooldown = RESTART_COOLDOWN_MS * (rec.cdMul || 1); // AGIP-19: эскалация
    if (rec.fails >= FAIL_LIMIT && Date.now() - rec.lastRestartAt > cooldown) {
      const owner = await portOwnerPid(n.port);
      if (owner) {
        const shed = await probeShed(`http://127.0.0.1:${n.port}/health`);
        if (shed === 'shedding') {
          // ЖИВАЯ, НО ПЕРЕГРУЖЕНА: не спавню дубликат и не убиваю — это безрезультатный
          // рестарт-шторм. Жду до SHED_LIMIT, потом разово откапываю жёстким рестартом.
          rec.fails = 0; rec.shed = (rec.shed || 0) + 1;
          log(`${n.name}: /life таймаут, но /health=overloaded — жду без рестарта (shed ${rec.shed}/${SHED_LIMIT})`);
          if (rec.shed >= SHED_LIMIT) {
            rec.restarts += 1; escalateRestart(rec);
            if (respawnsThisCycle >= 1) { rec.shed = 0; log(`${n.name}: HARD-RESTART отложен — одна реанимация за цикл (AGIP-23)`); }
            else {
              respawnsThisCycle++;
              log(`HARD-RESTART ${n.name} (застряла в shedding): taskkill pid ${owner} → подъём обёрткой (всего рестартов: ${rec.restarts})`);
              exec(`taskkill /PID ${owner} /F`, { windowsHide: true }, () => {});
              launchWrapper(n.wrapper).then(() => save());
            }
          }
        } else {
          rec.sick = (rec.sick || 0) + 1;
          log(`${n.name}: /life мёртв, но порт ${n.port} слушает pid ${owner} — не спавню дубликат (sick ${rec.sick}/${SICK_LIMIT})`);
          if (rec.sick >= SICK_LIMIT) {
            rec.sick = 0; rec.restarts += 1; escalateRestart(rec);
            if (respawnsThisCycle >= 1) { log(`${n.name}: HARD-RESTART отложен — одна реанимация за цикл (AGIP-23)`); }
            else {
              respawnsThisCycle++;
              log(`HARD-RESTART ${n.name}: taskkill pid ${owner} → подъём обёрткой (всего рестартов: ${rec.restarts})`);
              exec(`taskkill /PID ${owner} /F`, { windowsHide: true }, () => {});
              launchWrapper(n.wrapper).then(() => save());
            }
          }
        }
      } else {
        // AGIP-19: на перегруженной машине netstat иногда отдаёт пусто (таймаут exec —
        // 5с), а порт на самом деле слушает живой-but-overloaded процесс → спавн стал
        // бы EADDRINUSE-клоном (инцидент «18 клонов»). Перепроверяем перед спавном.
        await new Promise((r) => setTimeout(r, 3000));
        const owner2 = await portOwnerPid(n.port);
        if (owner2) {
          rec.sick = (rec.sick || 0) + 1; rec.fails = 0;
          log(`${n.name}: повторный netstat нашёл pid ${owner2} — порт всё же слушает, не спавню дубликат (sick ${rec.sick}/${SICK_LIMIT})`);
        } else if (respawnsThisCycle >= 1) {
          rec.fails = 0;
          log(`${n.name}: RESTART отложен — одна реанимация за цикл (AGIP-23)`);
        } else {
          rec.sick = 0; rec.fails = 0; rec.restarts += 1; escalateRestart(rec);
          respawnsThisCycle++;
          log(`RESTART ${n.name} → ${n.wrapper} (всего рестартов: ${rec.restarts})`);
          launchWrapper(n.wrapper).then(() => save());
        }
      }
    }
  }
  save();
}
log('сторож вышел на пост. Цели: ' + NODES.map(n => n.name).join(', '));
save();
await cycle();
setInterval(() => { cycle(); }, CHECK_EVERY_MS);
