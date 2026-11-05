// ============================================================
// security-detector.mjs — Уровень 2 «Департамента Юстиции» (Forta-подобный бот)
// Слушает мемпул и новые блоки ноды, ищет аномалии:
//  1) перевод > 10000 AGT из казны / вообще (подозрение на слив казны) — Critical
//  2) tx с забаненного/замороженного адреса, просочившаяся наружу — High
//  3) memo с исполнимым кодом (script/eval/exec/rm -rf/curl|sh) — High
//  4) спам-паттерн: N одинаковых (from,to,amount) за окно — Medium
// Находит → POST /jail/case на ноду (локальная админ-плоскость) + security.log.
// Запуск: systemd agentcoin-detector.service (node1). Нода: AGT_NODE env.
// ============================================================
'use strict';
import fs from 'node:fs';
import path from 'node:path';

const NODE = process.env.AGT_NODE || 'http://127.0.0.1:9335';
const INTERVAL_MS = Number(process.env.AGT_DETECT_INTERVAL_MS || 5000);
const TREASURY = process.env.AGT_JUSTICE_TREASURY || 'AGT209ec9884a9569ac8d5b897177087aab5bd0c937';
const TREASURY_LIMIT = Number(process.env.AGT_TREASURY_LIMIT || 10000);
const LOG_FILE = process.env.AGT_JUSTICE_LOG || '/opt/justice/logs/security.log';
const SPAM_WINDOW = 30_000;
const SPAM_COUNT = 3;

let rulesHit = 0, startedAt = Date.now(), ticks = 0;
const seenTxid = new Set();
const spamRing = [];

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  console.log(s);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, s + '\n'); } catch {}
}

async function api(p, opts) {
  const r = await fetch(NODE + p, { ...opts, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
}

async function openCase(body) {
  try {
    await api('/jail/case', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, autoFreeze: body.severity === 'Critical' }) });
    rulesHit++;
    log(`CASE_OPEN source=forta kind=${body.kind} severity=${body.severity} address=${body.address || '-'} evidence=${String(body.evidence).slice(0, 120)}`);
  } catch (e) { log(`CASE_FAIL ${e.message}`); }
}

function screenTx(tx) {
  if (!tx || !tx.txid || seenTxid.has(tx.txid)) return;
  seenTxid.add(tx.txid);
  const memo = String(tx.memo || '');
  // R1 — слив казны
  if (tx.from === TREASURY && Number(tx.amount) > TREASURY_LIMIT) {
    openCase({ source: 'forta', address: tx.from, kind: 'Попытка слива казны', severity: 'Critical', evidence: `txid=${tx.txid} amount=${tx.amount} to=${tx.to}` });
  } else if (Number(tx.amount) > TREASURY_LIMIT) {
    openCase({ source: 'forta', address: tx.from, kind: 'Аномальный крупный перевод', severity: 'High', evidence: `txid=${tx.txid} amount=${tx.amount} (без казны)` });
  }
  // R2 — memo с кодом
  if (/(eval\s*\(|exec\s*\(|system\s*\(|rm\s+-rf|curl[^|]*\|\s*sh|powershell|<script)/i.test(memo)) {
    openCase({ source: 'forta', address: tx.from, kind: 'Memo с исполнимым кодом', severity: 'High', evidence: `txid=${tx.txid} memo=${memo.slice(0, 100)}` });
  }
  // R3 — спам-паттерн
  const now = Date.now();
  while (spamRing.length && now - spamRing[0].ts > SPAM_WINDOW) spamRing.shift();
  const same = spamRing.filter(s => s.from === tx.from && s.to === tx.to && s.amount === tx.amount).length;
  spamRing.push({ ts: now, from: tx.from, to: tx.to, amount: tx.amount });
  if (same >= SPAM_COUNT - 1) {
    spamRing.length = 0;
    openCase({ source: 'forta', address: tx.from, kind: 'Спам-транзакции', severity: 'Medium', evidence: `${same + 1} повторов (from,to,amount) за 30с` });
  }
}

async function heartbeat() {
  try {
    await api('/jail/detector-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      running: true, rulesHit, ticks, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      watch: ['treasury-drain', 'banned-tx', 'memo-code', 'spam-pattern'],
    }) });
  } catch (e) { log(`HEARTBEAT_FAIL ${e.message}`); }
}

async function tick() {
  ticks++;
  try {
    // Мемпул
    const mem = await api('/api/v1/mempool');
    for (const t of (mem.txs || [])) screenTx(t);
    // Последний блок (ончейн-анализ: казна уже ушла — фиксируем пост-фактум)
    const blocks = await api('/blocks?n=1');
    const tip = Array.isArray(blocks) ? blocks[0] : (blocks.blocks?.[0] || blocks.tip);
    if (tip && tip.txs) {
      const seen = new Set((tip.txs || []).map(t => t.txid).filter(Boolean));
      for (const t of tip.txs || []) {
        if (t && t.from === TREASURY && Number(t.amount) > TREASURY_LIMIT && !seenTxid.has('blk' + (t.txid || t.hash))) {
          seenTxid.add('blk' + (t.txid || t.hash));
          await openCase({ source: 'forta', address: t.from, kind: 'Слив казны зафиксирован В ЦЕПИ', severity: 'Critical', evidence: `height=${tip.height || tip.header?.height} amount=${t.amount} to=${t.to}` });
        }
      }
    }
  } catch (e) {
    log(`TICK_ERR ${e.message}`);
  }
}

log(`security-detector START node=${NODE} treasury=${TREASURY.slice(0, 14)}… limit=${TREASURY_LIMIT} interval=${INTERVAL_MS}ms log=${LOG_FILE}`);
setInterval(tick, INTERVAL_MS);
setInterval(heartbeat, INTERVAL_MS);
tick();
