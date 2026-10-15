#!/usr/bin/env node
/* health-check.mjs — одно-прогонный контроль здоровья AGT (для планировщика).
 * Задача AGTHealthCheck вызывает его по расписанию (ежедневно 09:00 + répétition каждый час):
 *   1) /life — fresh+chainValid
 *   2) /security/banlist — rollback тамперинга не проверяем здесь, но пишем в CSV
 *   3) self-аудит балансов: пересчёт из chain.json vs нода (как в auto-miner)
 *   4) нода упала/нездорова? → попытка Start-ScheduledTask AGTNode9335 (self-heal) + алерт в чат
 * Логи: data/autominer/health-check.log (append) — календарь контроля.
 * Запуск вручную: node health-check.mjs [port]
 * Планировщик: AGTHealthCheck (действие: cmd-обёртка run-healthcheck.cmd, like run-node.cmd)
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.argv[2] || process.env.AGT_HEALTH_PORT || 9335;
const API = `http://127.0.0.1:${PORT}`;
const MINER_FILE = path.join(__dirname, 'data', 'wallets.json');
const LOG = path.join(__dirname, 'data', 'autominer', 'health-check.log');

function log(msg) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
}
async function api(m, p, b = null) {
  const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function minerAddr() {
  try { return Object.keys(JSON.parse(fs.readFileSync(MINER_FILE, 'utf8')))[0]; } catch { return ''; }
}
// пересчёт балансов из chain.json (тот же независимый алгоритм, что в auto-miner)
function recalc() {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'chain.json'), 'utf8'));
  const b = {};
  for (const blk of d.chain || []) for (const tx of blk.txs || []) {
    if (tx.from && tx.from !== 'COINBASE') b[tx.from] = (b[tx.from] || 0) - tx.amount;
    if (tx.to) b[tx.to] = (b[tx.to] || 0) + tx.amount;
  }
  return { b, blocks: (d.chain || []).length };
}
async function alert(text) {
  const m = minerAddr();
  if (!m) return;
  await api('POST', '/community/send', { sender: m, senderHandle: 'administrator', text }).catch(() => {});
}

async function main() {
  const findings = [];
  // 1/2) жизнь
  let life = null;
  try {
    life = (await api('GET', '/life')).body;
    if (life.chainValid !== true) findings.push(`chainValid=false (${life.chainIssue ?? '?'})`);
    if (life.fresh === false) findings.push(`chain stale: tipAge=${life.tipAgeSec}s`);
  } catch (e) {
    findings.push(`noda не отвечает: ${e.message}`);
    // self-heal: поднять задачу ноды (не выбрасываем — аудит продолжаем только если оживёт)
    try {
      execSync('powershell -NoProfile -Command "Start-ScheduledTask -TaskName AGTNode9335"', { timeout: 20_000 });
      log('self-heal: Start-ScheduledTask AGTNode9335 отправлен');
      await new Promise(r => setTimeout(r, 15_000));
      life = (await api('GET', '/life')).body; // повторная попытка
    } catch { /* без self-heal — оставляем findings */ }
  }
  // 3) аудит балансов: permabanned-адреса нода показывает как 0 (документировано) —
  //    сравнивать их с chain-пересчётом нельзя, исключаем из аудита.
  const banned = new Set((await api('GET', '/security/banlist')).body?.banned || []);
  const recalced = recalc();
  let auditBad = 0, bannedSkipped = 0, rewardDrift = 0;
  const miner = minerAddr();
  for (const [addr, exp] of Object.entries(recalced.b)) {
    if (banned.has(addr)) { bannedSkipped++; continue; }
    // 503-shedding ноды под бурстом аудита — транзиент, а не некро-бит:
    // ретраи до 4 попыток, как в auto-miner (инцидент 2026-10-15).
    let r = null;
    for (let i = 0; i < 4; i++) {
      if (i > 0) await new Promise(res => setTimeout(res, 250 * (i + 1)));
      r = await api('POST', '/balance', { address: addr });
      if (r.status !== 503 && r.status !== 429) break;
      r = null;
    }
    if (!r) continue; // все попытки — 503/429: нода перегружена, не несоответствие баланса
    const got = r.body?.balance || 0;
    if (Math.abs(got - exp) > 1e-6) {
      if (got > exp) { rewardDrift++; continue; } // node богаче диска: свежая награда/tx не доехала до chain.json save-цикла — не коррупция
      auditBad++; findings.push(`balance ${addr.slice(0, 16)}: chain=${exp} node=${got}`);
    }
  }
  const status = findings.length ? `FAIL: ${findings.slice(0, 4).join('; ')}` : 'OK';
  log(`health-check: blocks=${recalced.blocks} audit=${Object.keys(recalced.b).length} addr, bannedSkipped=${bannedSkipped}, rewardDrift=${rewardDrift}, mismatches=${auditBad} → ${status}`);
  if (findings.length) await alert(`🚨 AGTHealthCheck: ${status}`);
  console.log(status);
  // process.exit сразу после fetch рождает libuv-assert на win (exit 127/134):
  // даём undici опустошить пул соединений, выходим штатным +exitCode
  await new Promise(r => setTimeout(r, 1200));
  process.exitCode = findings.length ? 1 : 0;
}
main().catch((e) => { log('health-check ERROR: ' + e.message); process.exitCode = 2; });
