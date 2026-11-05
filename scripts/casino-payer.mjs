#!/usr/bin/env node
/* ============================================================
   CASINO PAYER (ТЗ этап 2, AC-4) — казначей казино.
   Опрашивает /casino/state; для раундов со статусом pending_payout
   (ставка выиграла, выплаты ещё нет) отправляет tx 2 AGT от Казны
   победителю (memo casino|W|<ref8>). Идемпоидентно: перед выплатой
   перечитывает state — «paid»/«paid_mismatch» пропускает.

   Ключ Казны (env AGT_CASINO_HOUSE, по умолчанию адрес дома) читается
   ЛОКАЛЬНО из data/wallets.json; в сеть уходит только подписанная tx.

   Запуск: node scripts/casino-payer.mjs [циклов]  (0 = бесконечно, default 1)
           AGT_NODE=https://agentcoin.work
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NODE = process.env.AGT_NODE || 'https://agentcoin.work';
const CYCLES = Number(process.argv[2] || 1);
const INTERVAL = 20_000;
const WALLETS = process.env.AGT_WALLETS_FILE || path.join(process.cwd(), 'data', 'wallets.json');

const sh = b => crypto.createHash('sha256').update(b).digest();
const txDigest = tx => sh(sh(JSON.stringify({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, ts: tx.ts, memo: tx.memo || '' }))).toString('hex');

async function jget(p) { const r = await fetch(NODE + p); if (!r.ok) throw new Error(`${p} -> ${r.status}`); return r.json(); }
async function jpost(p, b) { const r = await fetch(NODE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, j: await r.json().catch(() => ({})) }; }

function houseWallet() {
  const wallets = JSON.parse(fs.readFileSync(WALLETS, 'utf8'));
  const house = process.env.AGT_CASINO_HOUSE || null;
  const candidates = house ? [[house, wallets[house]]] : Object.entries(wallets);
  for (const [addr, w] of candidates) {
    if (w && w.privKey) return { address: addr, pubkeyPem: w.pub, privKeyPem: w.privKey };
  }
  throw new Error('ключ Казны не найден в wallets.json');
}

async function cycle(n) {
  const st = await jget('/casino/state');
  const ready = st.readyPayouts || [];
  if (!ready.length) return { readiness: 0, paid: 0 };
  const payer = houseWallet();
  let paid = 0;
  for (const r of ready) {
    // идемпоидентность: перечитали state — если уже не pending, skip
    const now = await jget('/casino/state');
    const still = (now.readyPayouts || []).find(x => x.ref === r.ref);
    if (!still) { console.log(`[casino-payer] ${r.ref}: уже нерешаемо — пропуск`); continue; }
    const tx = {
      from: payer.address, to: r.winner, amount: r.amount,
      nonce: Date.now(), ts: Math.floor(Date.now() / 1000),
      memo: `casino|W|${r.ref}`,
    };
    tx.txid = txDigest(tx);
    tx.signature = crypto.sign(null, Buffer.from(tx.txid, 'hex'), payer.privKeyPem).toString('hex');
    const { status, j } = await jpost('/tx', {
      from: tx.from, fromPub: payer.pubkeyPem, to: tx.to, amount: tx.amount,
      nonce: tx.nonce, ts: tx.ts, memo: tx.memo, txid: tx.txid, signature: tx.signature,
    });
    if (status === 200 || status === 201) {
      paid++;
      console.log(`[casino-payer] выплата: ${r.ref} → ${r.winner} (${r.amount} AGT), txid=${j.txid || tx.txid}, mempool=${j.mempool}`);
    } else {
      console.log(`[casino-payer] отклонено: ${r.ref} status=${status} ${JSON.stringify(j).slice(0, 200)}`);
    }
  }
  return { readiness: ready.length, paid };
}

async function main() {
  console.log(`[casino-payer] node=${NODE} казна-циклов=${CYCLES}`);
  for (let n = 1; CYCLES === 0 || n <= CYCLES; n++) {
    try {
      const r = await cycle(n);
      console.log(`[casino-payer] цикл ${n}: к выплате=${r.readiness} выплачено=${r.paid}`);
    } catch (e) {
      console.log(`[casino-payer] цикл ${n}: ошибка ${e.message.slice(0, 200)}`);
    }
    if (CYCLES !== 0 && n >= CYCLES) break;
    await new Promise(r => setTimeout(r, INTERVAL));
  }
}
main().catch(e => { console.error('[casino-payer] fatal:', e); process.exit(1); });
