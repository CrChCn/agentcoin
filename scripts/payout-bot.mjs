#!/usr/bin/env node
/* ============================================================
   PAYOUT BOT (ТЗ этап 2, AC-3) — автоматический выплатчик джобов.

   Логика (каждые 30 сек, Interval 30000):
     1. GET  /jobs/state           — открытые эскроу (escId, worker, amount)
     2. GET  /escrow/state + /blocks — скан результатов:
        tx с memo job|R|<escId>|<resultHash>, подписанный воркером
        (подпись уже проверена сетью —- это ончейн tx).
     3. Если результат есть и воркер совпадает с эскроу и выплаты ещё не было
        (нет escpayout:escId ИЛИ job|pay|escId в цепи, и memo escfee уже не
        требует действие) → POST /tx выплату воркеру (memo job|pay|<escId>).
     4. Лог выплат: payouts.log (строка JSON на выплату).

   Ключ подписи платежа читается ЛОКАЛЬНО из data/wallets.json
   (адрес из env AGT_PAYOUT_KEY или первый funded). Никакие секреты
   через сеть/логи не проходят: подпись на месте, отправка — via /tx.

   Запуск: node scripts/payout-bot.mjs [циклов]   (>=1 цикл = обработка+выход)
           AGT_NODE=https://agentcoin.work  (или http://127.0.0.1:9335)
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NODE = process.env.AGT_NODE || 'https://agentcoin.work';
const CYCLES = Number(process.argv[2] || process.env.AGT_CYCLES || 0); // 0 = бесконечно
const INTERVAL = 30_000;
const DATA_DIR = process.env.AGT_DATA_DIR || path.join(process.cwd(), 'data');
const LOG = path.join(process.cwd(), 'payouts.log');

const sh = b => crypto.createHash('sha256').update(b).digest();
const txDigest = tx => sh(sh(JSON.stringify({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, ts: tx.ts, memo: tx.memo || '' }))).toString('hex');

async function jget(p) {
  const r = await fetch(NODE + p);
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
}
async function jpost(p, body) {
  const r = await fetch(NODE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

function loadPayerWallet() {
  const wallets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'wallets.json'), 'utf8'));
  const want = process.env.AGT_PAYOUT_KEY;
  const list = Object.entries(wallets).filter(([, w]) => w && w.privKey);
  if (!list.length) throw new Error('в wallets.json нет кошельков с приватным ключом');
  const chosen = want && Object.hasOwn(wallets, want) ? [[want, wallets[want]]] : list;
  for (const [addr, w] of chosen) return { address: addr, pubkeyPem: w.pub, privKeyPem: w.privKey };
  throw new Error('платёжный ключ не найден');
}

function signTx(tx, privKeyPem) {
  const digestHex = txDigest(tx);
  const sig = crypto.sign(null, Buffer.from(digestHex, 'hex'), privKeyPem).toString('hex');
  return { ...tx, txid: digestHex, signature: sig };
}

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG, line + '\n');
  console.log('[payout-bot]', line);
}

async function cycle(n) {
  const jobs = await jget('/jobs/state');
  const open = jobs.open || [];
  if (!open.length) return { checked: 0, paid: 0 };
  // результаты: последние блоки — scan /blocks?limit=40 for job|R memos
  const blocks = await jget('/blocks?limit=40');
  const results = new Map(); // escId → { resultHash, txid, from }
  const alreadyPaidMemos = new Set(); // идемпоидентность по цепи
  for (const blk of blocks.blocks || []) {
    for (const tx of blk.txs || []) {
      const m = typeof tx.memo === 'string' ? tx.memo.match(/^job\|R\|([a-f0-9]{10,32})\|([a-f0-9]{16,64})$/) : null;
      if (m) results.set(m[1], { resultHash: m[2], from: tx.from, txid: tx.txid, height: blk.height });
      if (typeof tx.memo === 'string' && (tx.memo.startsWith('job|pay|') || tx.memo.startsWith('escpayout:') || tx.memo.startsWith('escfee:'))) alreadyPaidMemos.add(tx.memo);
    }
  }
  const history = jobs.history || [];
  const prevPaid = new Set(history.filter(h => h.status === 'paid').map(h => h.escId));
  let paid = 0, checked = 0;
  for (const job of open) {
    checked++;
    const res = results.get(job.escId);
    if (!res) continue;                                   // результата ещё нет
    if (prevPaid.has(job.escId)) continue;                // уже выплачено по /jobs/state
    if (alreadyPaidMemos.has(`escpayout:${job.escId}`)) { logLine({ action: 'skip_already_paying', escId: job.escId, via: 'escpayout в цепи' }); continue; }
    if (alreadyPaidMemos.has(`job|pay|${job.escId}`)) { logLine({ action: 'skip_already_paid', escId: job.escId, via: 'job|pay в цепи' }); continue; }
    if (res.from !== job.worker) { logLine({ action: 'skip_foreign_result', escId: job.escId, expected: job.worker, got: res.from }); continue; }
    const payer = loadPayerWallet();
    const escId = job.escId;
    const payTx = signTx({
      from: payer.address, to: job.worker, amount: job.amount,
      nonce: Date.now(), ts: Math.floor(Date.now() / 1000),
      memo: `job|pay|${escId}`,
    }, payer.privKeyPem);
    // Финальная идемпоидентность на ноде: (Double-pay превентив — уже настроено выше)
    const { status, j } = await jpost('/tx', {
      from: payTx.from, fromPub: payer.pubkeyPem, to: payTx.to, amount: payTx.amount,
      nonce: payTx.nonce, ts: payTx.ts, memo: payTx.memo, txid: payTx.txid, signature: payTx.signature,
    });
    if (status === 200 || status === 201) {
      paid++;
      logLine({ action: 'pay', escId, worker: job.worker, amount: job.amount, txid: j.txid || payTx.txid, mempool: j.mempool, resultTxid: res.txid, resultHash: res.resultHash });
    } else {
      logLine({ action: 'pay_rejected', escId, status, error: j.error || JSON.stringify(j).slice(0, 200) });
    }
  }
  return { checked, paid };
}

async function main() {
  console.log(`[payout-bot] node=${NODE} интервал=${INTERVAL / 1000}с циклов=${CYCLES || '∞'}`);
  let n = 0;
  while (true) {
    n++;
    try {
      const r = await cycle(n);
      console.log(`[payout-bot] цикл ${n}: обработано=${r.checked} выплачено=${r.paid}`);
    } catch (e) {
      console.log(`[payout-bot] цикл ${n}: ошибка ${e.message.slice(0, 200)}`);
    }
    if (CYCLES && n >= CYCLES) break;
    await new Promise(r => setTimeout(r, INTERVAL));
  }
}

main().catch(e => { console.error('[payout-bot] fatal:', e); process.exit(1); });
