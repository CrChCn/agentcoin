#!/usr/bin/env node
/* ============================================================
   uptime.mjs — ВНЕШНИЙ watchdog (AGIP-5, шаг 13): взгляд со стороны.
   Отличие от watchdog.mjs: watchdog.mjs живёт НА машине и умеет
   рестартовать ноды (локальный сторож). uptime.mjs смотрит ИЗВНЕ
   (GitHub Actions каждые 5 мин / локальный цикл) и только тревожит.

   Логика:
     - GET <url>/life по каждому URL из AGT_URLS (5с таймаут);
     - down дольше AGT_DOWN_AFTER_SEC (по умолчанию 90с) → POST
       /community/send (публичный, sender = AGT_ALERT_SENDER,
       handle 'uptime-bot'); чат забанит спам (10/30с) — поэтому
       дедуп: повторная тревога не чаще 1 раза в 55 минут.
       Как определяем «уже тревожили» без постоянного стейта:
       читаем /community/feed и ищем свою последнюю тревогу по URL
       (работает в GitHub Actions, где локального стейта нет);
     - выздоровление → POST «✅ [uptime] <url> жив» + сброс down-состояния;
     - недоступная чат-нода — не fatal: пишем в stdout, exit 0.

   Режимы:
     node uptime.mjs --once            — один прогон (GitHub Actions)
     node uptime.mjs                   — цикл каждые AGT_CHECK_MS(30с)

   env: AGT_URLS (comma-список), AGT_CHAT_URL (куда постить тревогу,
   default: первый URL), AGT_STATE_FILE, AGT_DOWN_AFTER_SEC=90,
   AGT_CHECK_MS=30000, AGT_ALERT_SENDER.
   ============================================================ */
'use strict';

const ONCE = process.argv.includes('--once');
const URLS = String(process.env.AGT_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const CHAT_URL = (process.env.AGT_CHAT_URL || (URLS[0] || '')).replace(/\/$/, '');
const STATE_FILE = process.env.AGT_STATE_FILE || 'data-agents/uptime-state.json';
const DOWN_AFTER_SEC = Number(process.env.AGT_DOWN_AFTER_SEC) || 90;
const CHECK_MS = Number(process.env.AGT_CHECK_MS) || 30_000;
const SENDER = process.env.AGT_ALERT_SENDER || 'AGT17extUptimeBot000000000000000000000000';
const HANDLE = 'uptime-bot';
const REPEAT_ALERT_MIN = 55;

import fs from 'node:fs';
import path from 'node:path';

function log(m) { console.log(`[uptime ${new Date().toISOString()}] ${m}`); }

async function json(m, u, bodyText, timeoutMs = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(m === 'GET' ? u : u, {
      method: m, signal: ctl.signal,
      headers: m === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: bodyText,
    });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: text }; }
  } finally { clearTimeout(t); }
}

// --- локальный стейт (для циклового режима / локальных прогонов) ---
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { urls: {} }; } }
function saveState(st) { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); } catch {} }

// --- дедуп через ленту чата: когда мы (SENDER) последний раз тревожили ЭТОТ url ---
async function lastAlertAt(chatUrl, url) {
  try {
    const r = await json('GET', `${chatUrl}/community/feed?limit=200`);
    const msgs = (r.body && r.body.messages) || [];
    const mine = msgs.filter(m => m.sender === SENDER && String(m.text).includes(`[uptime]`) && String(m.text).includes(urlTag(url)));
    if (!mine.length) return 0;
    // у ленты newest-first (feed делает slice(-limit).reverse())
    const t = Date.parse(mine[0].at || '');
    return Number.isFinite(t) ? t : 0;
  } catch { return -1; } // чат недоступен → не знаем (≠ «не тревожили»)
}

function urlTag(u) { return u.replace(/^[a-z]+:\/\//, '').slice(0, 40); }

async function postChat(chatUrl, text) {
  if (!chatUrl) return { ok: false, reason: 'no_chat_url' };
  try {
    const r = await json('POST', `${chatUrl}/community/send`, JSON.stringify({ sender: SENDER, senderHandle: HANDLE, text }));
    return { ok: r.status === 201 || r.status === 200, status: r.status, body: r.body };
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function checkTargets() {
  const st = loadState();
  if (!st.urls) st.urls = {};
  const results = [];
  for (const u of URLS) {
    let alive = false, status = 0;
    try {
      const r = await json('GET', `${u.replace(/\/$/, '')}/life`);
      status = r.status; alive = r.status === 200 && r.body && typeof r.body === 'object';
    } catch { alive = false; }
    const rec = st.urls[u] || (st.urls[u] = { downSince: 0, everUp: false, lastAlertAt: 0 });
    const now = Date.now();
    let alerted = null;

    if (alive) {
      if (rec.downSince && rec.everUp) {
        // выздоровление
        const secs = Math.round((now - rec.downSince) / 1000);
        const rr = await postChat(CHAT_URL, `✅ [uptime] ${urlTag(u)} снова жив после ~${secs}s тишины`);
        alerted = { kind: 'recovery', chat: rr.ok || rr.reason };
      }
      rec.downSince = 0; rec.everUp = true;
    } else {
      if (!rec.downSince) {
        rec.downSince = ONCE ? (now - 90_000) : now; // в Actions стейт-файл пустой: считаем down ≥90с, т.к. снаружи уже 5 мин крона не доехал
      }
      const downSec = Math.round((now - rec.downSince) / 1000);
      const cooled = (now - (rec.lastAlertAt || 0)) < REPEAT_ALERT_MIN * 60_000;
      let feedDup = false;
      if (rec.everUp || ONCE) {
        const la = await lastAlertAt(CHAT_URL, u);
        feedDup = la === -1 ? true /* чат недоступен — молчим, не спамим */ :
          (la && (now - la) < REPEAT_ALERT_MIN * 60_000);
      }
      if (!cooled && !feedDup) {
        const rr = await postChat(CHAT_URL, `🚨 [uptime] ${urlTag(u)} не отвечает ~${Math.max(downSec, DOWN_AFTER_SEC)}s (GET /life → ${status || 'connection fail'})`);
        if (rr.ok) { rec.lastAlertAt = now; alerted = { kind: 'down-alert', chat: true }; }
        else alerted = { kind: 'down-alert', chat: rr.reason || rr.status };
      } else {
        log(`${u} всё ещё вниз (${downSec}s); тревога уже была — не спамлю`);
      }
    }
    results.push({ url: u, alive, status, downSec: rec.downSince ? Math.round((now - rec.downSince) / 1000) : 0, alerted });
  }
  saveState(st);
  return results;
}

function statusLine(results) {
  for (const r of results) log(`${r.alive ? 'OK ' : 'DOWN'} ${r.url} (status ${r.status}${r.downSec ? `, down ${r.downSec}s` : ''})${r.alerted ? ` → ${r.alerted.kind}:${r.alerted.chat}` : ''}`);
  return results;
}

async function cycle() {
  const results = await checkTargets();
  statusLine(results);
  return results;
}

if (!URLS.length) {
  // Dormant, а не ошибка: пока AGT_PUBLIC_URL не задана (Funnel ещё не поднят),
  // монитор без целей не должен краснить Actions каждые 5 минут.
  if (ONCE) { log('AGT_URLS не задан — dormant (ща задача настроит AGT_PUBLIC_URL), exit 0'); process.exit(0); }
  console.error('uptime: AGT_URLS не задан — нечего сторожить'); process.exit(1);
}
log(`внешний сторож: targets=[${URLS.join(' ')}] chat=${CHAT_URL || '(нет)'} mode=${ONCE ? 'once' : 'loop'}`);
const r = await cycle();
if (ONCE) process.exit(0);
setInterval(() => { cycle().catch(e => log(`ERROR ${e.message}`)); }, CHECK_MS);
