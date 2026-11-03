// queue-bounty-payer.mjs — десктоп-пейер казны AGT: платит 2 AGT агентам за выполненные задачи /queue.
// Ключ казны хранится ТОЛЬКО здесь (data-node-ts/wallets.json, label treasury-faucet) — не на нодах.
// Правила (те же, что хотел нода): dedup по jobId, 6ч кулдаун/адрес, ≤30 выплат/сутки, отчёт ≥40 символов.
// Запуск: node queue-bounty-payer.mjs [API=https://node1.agentcoin.work]
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signTransaction, txDigest } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.argv[2] || 'https://node1.agentcoin.work';
const WALLETS_FILE = process.argv[3] || path.resolve(__dirname, '../agentcoin/data-node-ts/wallets.json');
const FUND = 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a';
const PRIZE = 2;                       // AGT за задачу
const STATE_FILE = path.join(__dirname, 'data', 'queue-bounty-payer-state.json');
const POLL_MS = 45_000;

function short(a) { return a ? String(a).slice(0, 10) + '…' : '-'; }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { paidJobs: {}, paidAt: {}, day: '', dayCount: 0, lastSeq: 0 }; }
}
function saveState(s) {
  s.paidJobs = s.paidJobs || {}; s.paidAt = s.paidAt || {}; fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
async function api(method, p, body = null) {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function main() {
  const all = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
  const w = all[FUND];
  if (!w || !w.privKey) { console.log('[payer] FATAL: нет ключа казны в', WALLETS_FILE); process.exit(1); }
  console.log('[payer] старт · API', API, '· казна', short(FUND), '· приз', PRIZE, 'AGT/задача');
  const seen = loadState();
  if (seen.day !== new Date().toISOString().slice(0, 10)) { seen.day = new Date().toISOString().slice(0, 10); seen.dayCount = 0; }
  while (true) {
    try {
      const h = await api('GET', '/queue/history');
      if (h.status === 200 && Array.isArray(h.body.history)) {
        // история приходит с newest-first — обрабатываем от старых к новым, dedup по at+jobId
        const hist = h.body.history.slice().reverse();
        for (const it of hist) {
          if (!it || !it.jobId || !it.agent) continue;                 // старые записи без agent
          if (seen.paidJobs[it.jobId]) continue;                       // выплачено ранее
          if (String(it.summary || '').trim().length < 40) continue;   // пустой отчёт — не задача
          const now = Date.now();
          if (seen.day !== new Date().toISOString().slice(0, 10)) { seen.day = new Date().toISOString().slice(0, 10); seen.dayCount = 0; }
          const last = seen.paidAt[it.agent] || 0;
          if (now - last < 6 * 3600_000) continue;                     // кулдаун адреса
          if (seen.dayCount >= 30) continue;                           // дневной лимит
          const tx = { from: FUND, fromPub: w.pub, to: it.agent, amount: PRIZE, nonce: Date.now(), ts: Math.floor(now / 1000), memo: `hire:queue:${String(it.jobId).slice(0, 24)}` };
          tx.txid = txDigest(tx);
          tx.signature = signTransaction(tx, w.privKey);
          const r = await api('POST', '/tx', tx);
          if (r.status === 200 || r.status === 201) {
            seen.paidJobs[it.jobId] = now; seen.paidAt[it.agent] = now; seen.dayCount++;
            saveState(seen);
            console.log(`[payer] 2 AGT → ${short(it.agent)} за ${it.jobId} · tx ${String(tx.txid).slice(0, 16)}… · выплат сегодня: ${seen.dayCount}`);
          } else {
            console.log('[payer] tx отклонён:', r.status, JSON.stringify(r.body).slice(0, 160));
            // не помечаем — попробуем в следующем проходе (лимиты защищают от спама)
          }
        }
      } else console.log('[payer] history недоступна:', h.status);
    } catch (e) { console.log('[payer] цикл:', e.message); }
    await new Promise(s => setTimeout(s, POLL_MS));
  }
}
main();
