#!/usr/bin/env node
/* ============================================================
   auto-miner.mjs — фоновой майнер AGT (life-support системы)
   Простой цикл:
     1) проверяет /life — если chainValid=false, пишет тревогу
     2) майнит блок (solo, указанный miner), награда себе
     3) раз в час — push digest в чат сообщества (как админ-бот)
     4) пишет health-log.csv (календарь контроля)
   Запуск: node auto-miner.mjs [port] [minerAddress] [intervalSec]
   Планировщик: AGTAutoMiner (каждые 15 минут запуск с guard)
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.argv[2] || 9335;
const MINER = process.argv[3] || '';
const INTERVAL_SEC = Number(process.argv[4]) || 60; // по умолчанию 1 мин
const API = `http://127.0.0.1:${PORT}`;
const LOG_DIR = path.join(__dirname, 'data', 'autominer');
const HEALTH_LOG = path.join(LOG_DIR, 'health-log.csv');

function logLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + '\n');
}

async function api(method, p, body = null) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function tick(n) {
  const t0 = new Date();
  // 1) жизнь цепи
  const life = await api('GET', '/life');
  const alive = life.body?.fresh ?? life.body?.alive ?? false, fresh = life.body?.fresh, valid = life.body?.chainValid;
  // 2) майним блок (если miner указан)
  let mined = null;
  if (MINER) {
    const m = await api('POST', '/mine', { miner: MINER });
    if (m.status === 200) mined = { h: m.body.mined.height, hash: m.body.mined.hash.slice(0, 12), cloud: m.body.cloud?.cloudGB };
  }
  // 3) hourly digest (каждые 60 тиков ≈ час)
  let digestPosted = false;
  if (n % 60 === 0 && MINER) {
    const info = (await api('GET', '/info')).body;
    const tex = `⏰ Hourly digest: блоков ${info.blocks}, облако ${info.security ? '' : ''} - chain valid=${valid}, живой=${fresh}, banned=${info.security?.bannedCount ?? 'n/a'}. Двигаем, братья!`;
    await api('POST', '/community/send', { sender: MINER, senderHandle: 'administrator', text: tex });
    digestPosted = true;
  }
  // 4) health-log CSV
  logLine(HEALTH_LOG, `${t0.toISOString()},alive=${alive},fresh=${fresh},valid=${valid},block=${mined?.h ?? '-'},cloudGB=${mined?.cloud ?? '-'},digest=${digestPosted}`);
  console.log(`[${t0.toISOString().slice(11, 19)}] tick ${n}: alive=${alive} fresh=${fresh} valid=${valid} mined=${mined?.h ?? '-'} digest=${digestPosted}`);
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(HEALTH_LOG)) fs.writeFileSync(HEALTH_LOG, 'timestamp,alive,fresh,valid,block,cloudGB,digest\n');
  console.log(`auto-miner started: api=${API}, miner=${MINER || '(none)'}, interval=${INTERVAL_SEC}s`);
  let n = 0;
  while (true) {
    try { await tick(n++); } catch (e) { logLine(HEALTH_LOG, `${new Date().toISOString()},ERROR,${e.message}`); }
    await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
  }
}
main();
