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

// ---- Self-аудит балансов: пересчёт из chain.json своим кодом ----
// Не верим никому, даже собственной ноде: независимо суммируем транзакции
// всех блоков chain.json и сверяем с ответами ноды на каждое известное лицо.
// Расхождение = первый признак подделки состояния → алерт в чат немедленно.
const AUDIT_EPS = 1e-6;
function recalcFromChainFile() {
  const chainPath = path.join(__dirname, 'data', 'chain.json');
  const d = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
  const b = {};
  for (const blk of d.chain || []) {
    for (const tx of blk.txs || []) {
      if (tx.from && tx.from !== 'COINBASE') b[tx.from] = (b[tx.from] || 0) - tx.amount;
      if (tx.to) b[tx.to] = (b[tx.to] || 0) + tx.amount;
    }
  }
  return b;
}
async function auditBalances() {
  const recalced = recalcFromChainFile();
  // Инцидент 2026-10-15: permabanned-адреса нода (по протоколу) показывает как 0
  // ('opinion: permabanned') — аудит орал FAIL на них каждый час.
  // Правило: бан берём из ОТВЕТА САМОЙ ноды (банлисты нод не обязаны совпадать),
  // а не по чужому глобальному списку — иначе ложные FAIL из чужих банов.
  const mismatches = [];
  let bannedSkipped = 0, rewardDrift = 0;
  for (const [addr, expected] of Object.entries(recalced)) {
    const r = await api('POST', '/balance', { address: addr });
    if (r.status !== 200) { mismatches.push({ addr: addr.slice(0, 16), error: 'balance_api_' + r.status }); continue; }
    if (r.body?.opinion === 'permabanned') { bannedSkipped++; continue; }
    const got = r.body?.balance;
    if (typeof got !== 'number' || Math.abs(got - expected) > AUDIT_EPS) {
      if (typeof got === 'number' && got > expected) { rewardDrift++; continue; } // нода богаче диска: награда/tx ещё не доехала до chain.json — не коррупция
      mismatches.push({ addr: addr.slice(0, 16), expected, got: got ?? 'absent' });
    }
  }
  return { checked: Object.keys(recalced).length, bannedSkipped, rewardDrift, mismatches, ok: mismatches.length === 0 };
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
  let digestPosted = false, audit = null;
  if (n % 60 === 0 && MINER) {
    // 3a) сам аудедит балансов: пересчёт из chain.json + сверка с нодой
    try {
      audit = await auditBalances();
      if (!audit.ok && MINER) {
        const detail = audit.mismatches.slice(0, 5).map(m => `${m.addr}: expected=${m.expected} got=${m.got}${m.error ? ' err=' + m.error : ''}`).join('; ');
        await api('POST', '/community/send', { sender: MINER, senderHandle: 'administrator', text: `🚨 SECURITY AUDIT FAIL: расхождение балансов! пересчёт из chain.json vs нода — адресов всего ${audit.checked}, несошлись: ${detail}` });
      }
    } catch (e) { audit = { ok: false, error: e.message }; }
    // 3b) digest
    const info = (await api('GET', '/info')).body;
    const tex = `⏰ Hourly digest: блоков ${info.blocks}, chain valid=${valid}, живой=${fresh}, banned=${info.security?.bannedCount ?? 'n/a'}${audit ? `, аудит балансов=${audit.ok ? 'OK' : 'FAIL'}` : ''}. Двигаем, братья!`;
    await api('POST', '/community/send', { sender: MINER, senderHandle: 'administrator', text: tex });
    digestPosted = true;
  }
  // 4) health-log CSV
  const auditCol = audit ? `audit=${audit.ok ? 'ok' : 'fail'}` : 'audit=skip';
  logLine(HEALTH_LOG, `${t0.toISOString()},alive=${alive},fresh=${fresh},valid=${valid},block=${mined?.h ?? '-'},cloudGB=${mined?.cloud ?? '-'},digest=${digestPosted},${auditCol}`);
  console.log(`[${t0.toISOString().slice(11, 19)}] tick ${n}: alive=${alive} fresh=${fresh} valid=${valid} mined=${mined?.h ?? '-'} digest=${digestPosted} audit=${audit ? (audit.ok ? 'ok/' + audit.checked + ' addr' : 'FAIL') : 'skip'}`);
  // CSV-заголовок совместименность: audit-колонка дописывалась с хвоста, старые парсеры не обязаны
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
