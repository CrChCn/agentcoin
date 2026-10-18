#!/usr/bin/env node
/* ============================================================
   moltbook-daily-report.mjs — мотивный ежедневный отчёт империи в Moltbook.
   Собирает: статус своей ноды или AGT_MONITOR_TARGETS_FILE (высота, chainValid, loopLag),
   говернанс (/gov/state: активные предложения и голоса), статистику
   майнера за 24 ч (coinbase из локальной chain.json ноды A).

   Запуск:
     node moltbook-daily-report.mjs --print      # только отчёт в консоль (dry-run)
     node moltbook-daily-report.mjs              # отчёт + пост в Moltbook 'general'
   Планирование (Windows): schtasks AGTDailyLoopReport (см. подсказку в конце).
   Безопасность: ничего секретного не выводится (только публичные метрики).
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(process.cwd() + '/');
function loadNodeTargets() {
  const rows = process.env.AGT_MONITOR_TARGETS_FILE
    ? JSON.parse(fs.readFileSync(process.env.AGT_MONITOR_TARGETS_FILE, 'utf8'))
    : [{ name: 'own-node', url: process.env.AGT_API || 'http://127.0.0.1:9335' }];
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 16) throw new Error('AGT_MONITOR_TARGETS_FILE: нужен список 1..16 нод');
  return rows.map(row => {
    if (!row || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 64 || typeof row.url !== 'string') throw new Error('target: нужны name и url');
    const u = new URL(row.url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('target url: нужен http(s) origin без credentials/пути/query/fragment');
    return [row.name.trim(), u.origin];
  });
}
const CORE = loadNodeTargets();
const API = CORE[0][1];
const MINER_STATS_FILE = path.join(process.env.AGT_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'), 'chain.json');
const MINER_ADDRS = (process.env.AGT_MINER_ADDRESSES || '').split(',').map(a => a.trim()).filter(Boolean);

async function getJSON(url, timeout = 9000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'AGT-daily-report' }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    const reader = r.body.getReader(); const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 64e3) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
}

async function farmStatus() {
  const lines = [];
  for (const [name, base] of CORE) {
    const life = await getJSON(`${base}/life`);
    if (!life || typeof life !== 'object' || typeof life.blocks !== 'number') { lines.push(`${name}: ❌ не отвечает`); continue; }
    const h = await getJSON(`${base}/health`);
    const lag = h && typeof h === 'object' ? h.loopLagMs : undefined;
    lines.push(`${name}: жива, блок ${life.blocks}, chainValid=${life.chainValid}${lag != null ? `, loopLag=${lag}мс` : ''}`);
  }
  return lines;
}

async function govSnapshot() {
  const st = await getJSON(API + '/gov/state');
  if (!st || !Array.isArray(st.proposals)) return 'gov: недоступно';
  const active = st.proposals.filter(p => p.active);
  // счётчики с приведением к числу: в JSON NaN сериализуется как null (AGIP-26-dev)
  let sumYes = 0, sumNo = 0, sumAb = 0;
  for (const p of st.proposals) {
    sumYes += Number(p.yes) || 0;
    sumNo += Number(p.no) || 0;
    sumAb += Number(p.abstain) || 0;
  }
  const last = st.proposals[0];
  return `gov: предложений всего ${st.proposals.length}, активных ${active.length}; голоса агентов yes/no/abstain=${sumYes}/${sumNo}/${sumAb}${last ? `; последнее: «${String(last.title).slice(0, 52)}» ${last.yes}/${last.no}/${last.abstain || 0} ${last.result}` : ''}`;
}

function minerStats() {
  try {
    const chain = (JSON.parse(fs.readFileSync(MINER_STATS_FILE, 'utf8')).chain) || [];
    const now = Date.now() / 1000;
    const stats = new Map(MINER_ADDRS.map(a => [a, { blocks: 0, reward: 0 }]));
    let blocks24 = 0;
    for (const b of chain) {
      const t = (b.header && b.header.timestamp) || b.timestamp || 0;
      if (!t || now - t > 86400) continue;
      blocks24++;
      for (const tx of (b.txs || [])) {
        const s = stats.get(tx.to);
        if (s) { s.blocks++; s.reward += tx.amount || 0; }
      }
    }
    const rows = [...stats.entries()].filter(([, s]) => s.blocks > 0)
      .map(([a, s]) => `${a.slice(0, 12)}…: ${s.blocks} шт → ${s.reward.toLocaleString('ru-RU')} AGT`);
    return `майнер за 24 ч: блоков ${blocks24}; награда — ${rows.join(' · ') || 'нет выплат'}`;
  } catch (e) { return `майнер: chain.json недоступен (${e.message})`; }
}

async function buildReport() {
  const tip = await getJSON(API + '/life');
  const lines = [
    `🏰 AGT-империя, сводка за ${new Date().toISOString().slice(0, 10)} UTC`,
    `⛓ сеть: высота ${tip?.blocks ?? '?'}, chainValid=${tip?.chainValid ?? '?'}, ${tip?.fresh ? 'fresh' : 'stale'}`,
    '', '— ФЕРМА —', ...(await farmStatus()),
    '— ГОВЕРНАНС —', await govSnapshot(),
    '— МАЙНИНГ —', minerStats(),
  ];
  return lines.join('\n');
}

async function main() {
  const report = await buildReport();
  console.log(report);
  if (process.argv.includes('--print')) return;
  const { MoltbookOps } = require('../cyberguard-skill/moltbook-ops.js');
  const ops = new MoltbookOps({ stateFile: path.join(process.cwd(), 'data', 'moltbook-daily-state.json') });
  const today = new Date().toISOString().slice(0, 10);
  if (ops.state && ops.state.lastDaily === today) { console.log('\n(сегодня уже постили, выход)'); return; }
  const res = await ops.post('general', `🏰 AGT daily loop report ${today}`, report);
  if (res.ok) {
    ops.state.lastDaily = today;
    ops._saveState();
    console.log(`\n✓ пост в Moltbook: ${(res.data && res.data.post && (res.data.post.id || res.data.post.post_id)) || 'ok'}`);
    const LOGF = path.join(process.cwd(), 'data-agents', 'moltbook-watch.log');
    try { fs.appendFileSync(LOGF, `[${new Date().toISOString()}] DAILY-REPORT OK\n`); } catch {}
  } else {
    console.log(`✗ пост не прошёл: ${JSON.stringify(res).slice(0, 200)}`);
    process.exitCode = 1;
  }
}

if (process.argv[2] === 'help') console.log('node moltbook-daily-report.mjs [--print]');
else await main();
