#!/usr/bin/env node
/* ============================================================
   steward.mjs — локальный дом-стюард (Node, офлайн, без облака).
   Задачи (по требованиям оператора):
   1) Мониторинг всплывающих ошибок Windows: читает Application/System
      журналы (Errors за последний час), пишет в лог; дежурные наблюдатели:
      WSH-ошибки 80070002 (run-hidden.vbs), Windows «не удается найти»,
      планировщик. Повтор одной ошибки >3 раз/ч → метка ALARM-REPEAT.
   2) Порядок на дисках: чистка %TEMP% (файлы старше 24ч) + папки
      data-agents/*.lost.* + старые логи >50 МБ. Всё только безвредное,
      ничего системного.
   3) Health AGT-сети: ноды 9335/9341/9342/9336 — blocks/valid/fresh;
     wat  падение valid или более 2 нод fresh=false → ALARM в лог.
   4) Отчёт: каждый проход дописывает steward-log.txt (последняя строка —
      сводка: алерты/чистка/сеть). Запуск планировщиком каждые 30 мин,
      скрыто через run-hidden.vbs (окон не даёт).
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';

const ROOT = path.dirname(process.argv[1] || '.');
const LOG = path.join(ROOT, 'data-agents', 'steward-log.txt');
const ALARM_STATE = path.join(ROOT, 'data-agents', 'steward-state.json');

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch (e) { console.error('log err', e.message); }
}
function loadState() { try { return JSON.parse(fs.readFileSync(ALARM_STATE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(ALARM_STATE, JSON.stringify(s, null, 1)); } catch {} }

// ---------- 1) Монитор алертов Windows ----------
async function checkAlerts() {
  const cmd = `powershell -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName='Application'; Level=2; StartTime=(Get-Date).AddHours(-1)} -MaxEvents 50 -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -match 'Windows Script Host|Application Error|.NET' -or $_.Message -match '80070002|run-hidden|vbs' } | Select-Object -ExpandProperty Message"`;
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: 60_000 }, (err, stdout) => {
      if (err) { log('alerts: err ' + err.message); return resolve([]); }
      const msgs = String(stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
      resolve(msgs);
    });
  });
}
function alarmKey(msg) { return String(msg).slice(0, 80); }

async function monitoringPass() {
  const alerts = await checkAlerts();
  const st = loadState();
  const hourAgo = Date.now() - 3600_000;
  const counts = {};
  for (const a of alerts) {
    const k = alarmKey(a);
    counts[k] = counts[k] || [];
    counts[k].push(Date.now());
  }
  const merged = { ...(st.alerts || {}) };
  const repeated = [];
  for (const [k, times] of Object.entries(counts)) {
    merged[k] = [...(merged[k] || []), ...times].filter(t => t > hourAgo).slice(-20);
    if (merged[k].length > 3) {
      log(`ALARM-REPEAT: ${merged[k].length}/час — ${k}`);
      repeated.push(k);
    }
  }
  st.alerts = merged;
  saveState(st);
  if (!alerts.length) log('alerts: чисто за последний час');
  // AI-глаз: только на реальные/повторяющиеся алерты (экономим драгоценную RAM)
  if (repeated.length) await explainAlerts(repeated);
  return alerts.length;
}

// ---------- 1a) Ollama: смысловой разбор ALARM (офлайн, лёгкая модель) ----------
// RAM на компе скромная: гоняем только при ALARM-REPEAT, num_predict малый,
// num_ctx 512, таймаут 120 с. Плохо грузится — не роняем проход, просто нет объяснения.
const OLLAMA = process.env.AGT_OLLAMA || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.AGT_OLLAMA_MODEL || 'qwen3:0.6b';
async function explainAlerts(keyedAlerts) {
  if (!keyedAlerts.length) return;
  const prompt =
    'Ты — домашний помощник-стюард. Кратко объясни одним предложением по-русски, что означает эта ошибка Windows и опасна ли она:\n' +
    keyedAlerts.slice(0, 3).map(s => '- ' + s.slice(0, 160)).join('\n') +
    '\nОтвет максимум в 30 словах.';
  const t0 = Date.now();
  try {
    const r = await fetch(OLLAMA + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { num_predict: 60, num_ctx: 512 } }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = await r.json();
    const text = (String(j.response || '') + ' ' + String(j.thinking || '')).replace(/\s+/g, ' ').trim();
    if (text) log(`OLLAMA-EXPLAIN ${OLLAMA_MODEL} (${Date.now() - t0}ms): ${text.slice(0, 300)}`);
  } catch (e) {
    log(`ollama explain недоступен (${e.message.slice(0, 60)}) — правила-детекция продолжает работать`);
  }
}
function cleanGarbage() {
  let freed = 0;
  const targets = [];
  try { targets.push(os.tempdir()); } catch {}
  targets.push(path.join(ROOT, 'data-agents'));
  // lost-файлы и старые большие логи
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const stat = fs.statSync(p);
        if (f.endsWith('.log') && stat.size > 50 * 1024 * 1024) { fs.truncateSync(p, 1024 * 1024); freed += stat.size; log(`truncate большой лог: ${f}`); }
        if (f.includes('.lost.') && Date.now() - stat.mtimeMs > 24 * 3600_000) { freed += stat.size; fs.unlinkSync(p); log(`удалён lost: ${f}`); }
        if (dir === os.tempdir() && Date.now() - stat.mtimeMs > 24 * 3600_000 && stat.isFile()) {
          try { freed += stat.size; fs.unlinkSync(p); } catch {}
        }
      } catch {}
    }
  }
  return freed;
}
import os from 'node:os';

// ---------- 3) Health AGT-сети ----------
async function netHealth() {
  const nodes = [
    ['A', 'http://127.0.0.1:9335'],
    ['B', 'http://127.0.0.1:9341'],
    ['C', 'http://127.0.0.1:9342'],
    ['TS', 'http://100.96.7.15:9336'],
  ];
  const results = [];
  for (const [name, url] of nodes) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(url + '/life', { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      results.push({ name, blocks: j.blocks, valid: j.chainValid, fresh: j.fresh });
      if (!j.chainValid) log(`ALARM-NET: ${name} chainValid=false`);
    } catch (e) {
      results.push({ name, down: true });
      log(`ALARM-NET: ${name} не отвечает (${e.message.slice(0, 50)})`);
    }
  }
  const alive = results.filter(r => !r.down);
  if (alive.length && alive.filter(r => r.fresh).length < 2) log('ALARM-NET: меньше 2 свежих нод — майнение стоит');
  return results;
}

// ---------- main ----------
const t0 = Date.now();
log('=== steward проход ===');
const nAlerts = await monitoringPass();
const freed = cleanGarbage();
const net = await netHealth();
log(`сводка: alerts=${nAlerts}, freed=${(freed / 1024).toFixed(0)}KB, net=${net.map(r => r.down ? r.name + ':DOWN' : r.name + ':' + r.blocks + '/v' + (r.valid ? 1 : 0) + '/f' + (r.fresh ? 1 : 0)).join(' ')}, took=${Date.now() - t0}ms`);
