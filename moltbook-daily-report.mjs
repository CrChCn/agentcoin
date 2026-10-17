#!/usr/bin/env node
/* ============================================================
   moltbook-daily-report.mjs — мотивный ежедневный отчёт империи в Moltbook.
   Собирает: статус ядра фермы (A/B/C/TS: высота, chainValid, loopLag),
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
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(process.cwd() + '/');
const { MoltbookOps } = require('../cyberguard-skill/moltbook-ops.js');
const CORE = [
  ['A', 9335], ['B', 9341], ['C', 9342], ['TS', 9336, '100.96.7.15'],
];
const MINER_STATS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'chain.json');
const MINER_ADDRS = [
  'AGT11a01a612a422dff68f7558eefbd9ab3a991439a', // тонкий майнер (data/wallets.json)
  'AGT72001e44fa005b8a9f8626f489807d8d73622757',
];

function getJSON(url, timeout = 9000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeout);
    http.get(url, { headers: { 'User-Agent': 'AGT-daily-report' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 64e3) res.destroy(); });
      res.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(body)); } catch { resolve(body.slice(0, 160)); } });
    }).on('error', () => { clearTimeout(t); resolve(null); });
  });
}

async function farmStatus() {
  const lines = [];
  for (const [name, port, host] of CORE) {
    const base = `http://${host || '127.0.0.1'}:${port}`;
    const life = await getJSON(`${base}/life`);
    if (!life || typeof life !== 'object' || typeof life.blocks !== 'number') { lines.push(`${name}: ❌ не отвечает`); continue; }
    const h = await getJSON(`${base}/health`);
    const lag = h && typeof h === 'object' ? h.loopLagMs : undefined;
    lines.push(`${name}: жива, блок ${life.blocks}, chainValid=${life.chainValid}${lag != null ? `, loopLag=${lag}мс` : ''}`);
  }
  return lines;
}

async function govSnapshot() {
  const st = await getJSON('http://127.0.0.1:9335/gov/state');
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
  const tip = await getJSON('http://127.0.0.1:9335/life');
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
