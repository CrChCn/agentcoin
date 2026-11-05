#!/usr/bin/env node
/* ============================================================
   CASINO — ставки на чётность nonce блока AGENTCOIN (ТЗ этап 2, AC-4).
   ИДЕЯ (lottery.mjs / dxe.mjs): состояние = ЧИСТАЯ ФУНКЦИЯ ЦЕПИ,
   никакой консенсусной логики и state-файлов. Ставка и выплата —
   обычные on-chain tx: их проверяет ЛЮБАЯ нода штатной верификацией.

   Протокол memo:
     casino|B|<even|odd>|<ref8>  — ставка (tx → HOUSE, amount = ровно 1 AGT);
                                   целевой блок детерминирован: target =
                                   высота блока, в который упакована ставка, + 1
     casino|W|<ref8>             — выплата (tx от Казны → победителю, amount = 2 AGT)
   Правила:
     • ставки принимаются только в блоках СТРОГО до target (ставка в блоке h
       играет на блок h+1 — «next block» по ТЗ);
     • исход = nonce%2 целевого блока: even при nonce%2==0, odd иначе;
     • угадал → 2 AGT (1 своя + 1 из казны), не угадал → ставка остаётся казне;
     • один ref = одна ставка: повторный memo ref игнорируется (идемпотентность);
     • выплаты подписывает кошелёк Казны (вне ноды — казначей/payout-bot;
       синглтон тот же паттерн, что AGT_LOTTERY_PAYER у лотереи);
     • double-pay защита: перед выплатой проверяем «casino|W|<ref> в цепи?».

   Всё вижит детерминированно: две ноды на одинаковой цепи получают
   одинаковую историю раундов — это и есть честность.
   ============================================================ */
'use strict';

const BET_PRICE = 1;      // ставка = 1 AGT
const BET_PAYOUT = 2;     // угадал → 2 AGT (1 возврат + 1 выигранный)
const DEC = 6;
const ADDR_RE = /^AGT[A-Za-z0-9]+$/;
const REF_RE = /^[A-Za-z0-9]{8}$/;
const BET_RE = /^casino\|B\|(even|odd)\|([A-Za-z0-9]{8})$/;
const PAY_RE = /^casino\|W\|([A-Za-z0-9]{8})$/;

const fmt = n => Math.round(n * 10 ** DEC) / 10 ** DEC;

export function parseCasinoBet(tx, house) {
  if (!tx || typeof tx.memo !== 'string') return null;
  if (tx.to !== house || Number(tx.amount) !== BET_PRICE || !ADDR_RE.test(String(tx.from))) return null;
  const m = tx.memo.match(BET_RE);
  if (!m) return null;
  return { type: 'bet', side: m[1], ref: m[2], from: tx.from, amount: Number(tx.amount), ts: tx.ts, nonce: tx.nonce };
}

export function parseCasinoPayout(tx, house) {
  if (!tx || typeof tx.memo !== 'string') return null;
  if (tx.from !== house) return null;
  const m = tx.memo.match(PAY_RE);
  if (!m) return null;
  return { type: 'payout', ref: m[1], to: tx.to, amount: Number(tx.amount), ts: tx.ts };
}

// Состояние казино: ставки/выплаты/раунды — из цепи. house = адрес казны.
export function casinoState(bc, house) {
  const height = bc.blockCount();
  const chain = bc.chain || [];
  const bets = new Map();     // ref → bet
  const payouts = new Map();  // ref → payout
  for (const blk of chain) {
    for (const tx of (blk.txs || [])) {
      const b = parseCasinoBet(tx, house);
      if (b) { if (!bets.has(b.ref)) bets.set(b.ref, { ...b, height: blk.height, target: blk.height + 1 }); continue; }
      const p = parseCasinoPayout(tx, house);
      if (p) { if (!payouts.has(p.ref)) payouts.set(p.ref, { ...p, height: blk.height }); }
    }
  }
  const rounds = [];
  const stats = { betAGT: 0, paidAGT: 0, rounds: 0, wins: 0, openBets: 0 };
  for (const bet of bets.values()) {
    stats.betAGT = fmt(stats.betAGT + bet.amount);
    const pay = payouts.get(bet.ref);
    const targetBlk = bet.target < chain.length ? chain[bet.target] : null;
    let resolved = null;
    if (targetBlk && targetBlk.header && typeof targetBlk.header.nonce === 'number') {
      const parity = targetBlk.header.nonce % 2 === 0 ? 'even' : 'odd';
      resolved = { target: bet.target, nonce: targetBlk.header.nonce, parity, win: parity === bet.side, hash: String(targetBlk.hash || '').slice(0, 16) };
    }
    if (pay) stats.paidAGT = fmt(stats.paidAGT + pay.amount);
    if (targetBlk) stats.rounds++;
    if (pay && pay.amount !== BET_PAYOUT) pay.amountNote = `анамалия: выплачено ${pay.amount}, по правилам положено ${BET_PAYOUT}`;
    if (targetBlk) stats.wins += resolved.win ? (pay ? 1 : 0) : 0;
    if (!targetBlk) stats.openBets++;
    rounds.push({
      ref: bet.ref, side: bet.side, bettor: bet.from, amount: bet.amount,
      betHeight: bet.height, target: bet.target, ...resolved,
      status: !targetBlk ? 'open' : (pay ? (pay.to === bet.from && pay.amount === BET_PAYOUT ? 'paid' : 'paid_mismatch') : (resolved.win ? 'pending_payout' : 'lost')),
      payout: pay ? { amount: pay.amount, to: pay.to, height: pay.height } : null,
    });
  }
  // неопубликованные выплаты, которые пора послать (казначей/BOT)
  const readyPayouts = rounds.filter(r => r.status === 'pending_payout')
    .map(r => ({ ref: r.ref, winner: r.bettor, amount: BET_PAYOUT, target: r.target, side: r.side, nonce: r.nonce }));
  rounds.sort((a, b) => b.target - a.target || (a.ref > b.ref ? 1 : -1));
  return {
    height, house,
    rules: { betPrice: BET_PRICE, payout: BET_PAYOUT, pool: 'nonce%2 целевого блока (even = чётный)', singleRefPerBet: true },
    stats, readyPayouts,
    rounds: rounds.slice(0, 50),
    note: 'ставка = tx 1 AGT → казна с memo casino|B|<side>|<ref8>; играет на nonce блока, следующего за блоком ставки; выплата = tx 2 AGT от казны с memo casino|W|<ref8>; без консенсусных изменений',
  };
}
