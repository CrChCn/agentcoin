#!/usr/bin/env node
/* ============================================================
   digest.mjs — авто-дайджест сети AGT (AGIP-6, шаг 15).
   Что делает: 2 раза в сутки собирает статистику с ноды и
   публикует: (а) в сетевой чат (POST /community/send от
   administrator-бота), (б) на Moltbook (cyberguard-skill).
   Календарь эпох: время до халвинга при темпе ~1 мин/блок.
   Гвард: постим только если прошло > 11 ч с последнего поста
   (каждого канала отдельно; состояние в data/digest-state.json).
   Расписание: schtasks AGTDigest — каждый час запуск, гвард решает.
   Запуск вручную: node digest.mjs            (уважает гвард)
                   AGT_DIGEST_FORCE=1 node digest.mjs   (постить безусловно)
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(process.cwd() + '/');
const API = (process.env.AGT_API || 'http://127.0.0.1:9335').replace(/\/$/, '');
const PUBLIC_URL = process.env.AGT_PUBLIC_URL || '';
if (PUBLIC_URL) {
  const u = new URL(PUBLIC_URL);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('AGT_PUBLIC_URL: нужен http(s) origin без пароля, пути, query и fragment');
}
const STATE_FILE = path.join(process.cwd(), 'data', 'digest-state.json');
const MIN_INTERVAL_H = 11;

async function j(p) {
  const r = await fetch(API + p, { signal: AbortSignal.timeout(15000) });
  return await r.json();
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { chatAt: 0, moltbookAt: 0 }; } }
function saveState(s) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function buildDigest() {
  const info = await j('/info');
  const jobs = await j('/jobs/state').catch(() => null);
  const life = await j('/life').catch(() => null);
  let watchdog = null; try { watchdog = await j('/ops/watchdog/state'); } catch {}
  const blocks = info.blocks, valid = life?.chainValid !== false;
  const supply = (info.totalSupplyCirculating || 0).toFixed(0);
  const halvingIn = info.halvingIn || 0;
  const era = `эпоха: до халвинга ${halvingIn} блоков ≈ ${(halvingIn / 1440).toFixed(1)} суток (темп ~1 мин/блок)`;
  const js = jobs && jobs.stats ? `джобы: открыто ${jobs.stats.open}, выплачено ${jobs.stats.paid}, рефнды ${jobs.stats.refunded}; комиссий казны собрано ${(jobs.stats.feesAGT || 0).toFixed(4)} AGT (escfee on-chain)` : 'джобы: старый код ноды (без /jobs/state) или н/д';
  const wd = watchdog ? Object.entries(watchdog.nodes).map(([n, r]) => `${n.split(' ')[0]}:${r.restarts}`).join(' ') : 'watchdog н/д';
  return {
    title: `DIGEST «империя»: блоков ${blocks}, valid=${valid}, supply ${supply} AGT`,
    text: `ORANGE DIGEST: блоков ${blocks}, chainValid=${valid}, supply ${supply}/2.1B AGT. ${era}. ${js}. Watchdog-рестарты: ${wd}. ${PUBLIC_URL ? `Публичный вход: ${PUBLIC_URL}` : 'Публичный URL этой ноды не настроен (AGT_PUBLIC_URL)'} · витрина /stats · джобборд /jobs · регистрация: локальный профиль agt-skill.`,
  };
}

async function main() {
  const force = process.env.AGT_DIGEST_FORCE === '1';
  const now = Date.now();
  const st = loadState();
  const d = await buildDigest();
  const dueChat = force || (now - (st.chatAt || 0) > MIN_INTERVAL_H * 3600e3);
  const results = { title: d.title };
  if (dueChat) {
    try {
      const wallets = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'wallets.json'), 'utf8'));
      const sender = Object.keys(wallets)[0];
      const r = await fetch(API + '/community/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender, senderHandle: 'administrator', text: d.text }) });
      results.chat = r.status === 201 || r.status === 200 ? 'posted' : `status ${r.status}`;
      if (results.chat === 'posted') { st.chatAt = now; }
    } catch (e) { results.chat = 'error ' + e.message; }
  } else results.chat = 'not due yet';
  // Moltbook — отдельный канал
  const dueMolt = force || (now - (st.moltbookAt || 0) > MIN_INTERVAL_H * 3600e3);
  if (dueMolt) {
    try {
      const opsMod = require('../cyberguard-skill/moltbook-ops.js');
      const ops = new opsMod.MoltbookOps({ stateFile: path.join(process.cwd(), 'data', 'moltbook-ops-state.json') });
      const info = await j('/info');
      const r = await ops.post('general', `AGT-дайджест: ${info.blocks} блоков, supply ${(info.totalSupplyCirculating || 0).toFixed(0)} AGT`, d.text);
      results.moltbook = r.ok ? 'posted' : 'fail ' + JSON.stringify(r).slice(0, 100);
      if (r.ok) st.moltbookAt = now;
    } catch (e) { results.moltbook = 'skipped (' + String(e.message).slice(0, 60) + ')'; }
  } else results.moltbook = 'not due yet';
  saveState(st);
  console.log(JSON.stringify(results));
}

main().catch(e => { console.error('digest ERROR', e.message); process.exit(1); });
