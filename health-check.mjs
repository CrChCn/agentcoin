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
// ТЗ-2 (аудит 2026-10-15): собственные recalc/аудит удалены — используется audit-lib.mjs
import { auditBalances as sharedAuditBalances } from './audit-lib.mjs';
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
  // 3) аудит балансов — единый источник правды (ТЗ-2 из аудита 2026-10-15):
  // вся логика (NaN-скип, opinion-скип, 503/429-ретраи, rewardDrift) живёт в audit-lib.mjs
  const miner = minerAddr();
  const audit = await sharedAuditBalances({ dataDir: path.join(__dirname, 'data'), baseUrl: API });
  const auditBad = audit.mismatches.length;
  for (const m of audit.mismatches.slice(0, 4)) {
    findings.push(`balance ${m.addr}: chain=${m.expected} node=${m.got ?? m.error ?? 'absent'}`);
  }
  const status = findings.length ? `FAIL: ${findings.slice(0, 4).join('; ')}` : 'OK';
  log(`health-check: blocks=${audit.height} audit=${audit.checked} addr, bannedSkipped=${audit.bannedSkipped}, rewardDrift=${audit.rewardDrift}, transientSkipped=${audit.transientSkipped}, mismatches=${auditBad} → ${status}`);
  if (findings.length) await alert(`🚨 AGTHealthCheck: ${status}`);
  console.log(status);
  // process.exit сразу после fetch рождает libuv-assert на win (exit 127/134):
  // даём undici опустошить пул соединений, выходим штатным +exitCode
  await new Promise(r => setTimeout(r, 1200));
  process.exitCode = findings.length ? 1 : 0;
}
main().catch((e) => { log('health-check ERROR: ' + e.message); process.exitCode = 2; });
