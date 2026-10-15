#!/usr/bin/env node
/* ============================================================
   DXE — mini-exchange ноды AGENTCOIN (v1).
   ИДЕЯ: ордера и сделки = обычные ончейн tx с memo-протоколом.
   Состояние книги — ЧИСТАЯ ФУНКЦИЯ ЦЕПИ: любая нода, посчитав
   индекс по одинаковым блокам, получает одинаковую книгу.
   ⇒ книга не может разъехаться между нодами (без state-файлов).

   Протокол memo:
     dxe|O|<side b|s>|<item>|<qty>|<price>|<ref8>   — лимит-ордер (amount=0)
     dxe|F|<ref8>|<qty>                             — исполнение: buyer
                                                      платит maker'у amount
                                                      = price×qtyFill (memo tx)
     dxe|C|<ref8>                                   — отмена (с адреса maker)
   Правила (по best-practice matching engine, Coinbase docs):
     • приоритет: цена → высота блока → порядковый номер tx в блоке;
     • цена исполнения — цена resting-ордера (maker);
     • самосделка: fill от адреса maker игнорируется (STP cancel-like);
     • частичное исполнение уменьшает остаток; сумма fills ≠ qty — ok;
     • первый валидный fill фиксируется в цепи → двойной спенд невозможен.
   ============================================================ */
'use strict';
import crypto from 'node:crypto';

const REF_LEN = 8;
const MAX_ITEM = 40;
const DEC = 6; //.matches tx amount precision

function txKey(tx) {
  return crypto.createHash('sha256').update(`${tx.from}|${tx.nonce}|${tx.memo}`).digest('hex').slice(0, 12);
}
export function fmtNum(n) {
  const s = String(n);
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Number(s)) : null;
}
export function parseDxe(tx) {
  if (!tx || typeof tx.memo !== 'string' || !tx.memo.startsWith('dxe|')) return null;
  const parts = tx.memo.split('|');
  const validRef = (r) => /^[A-Za-z0-9]{8}$/.test(r);
  if (parts[1] === 'O') {
    const side = parts[2] === 'b' ? 'b' : parts[2] === 's' ? 's' : null;
    const item = String(parts[3] || '');
    const qty = Number(parts[4]);
    const price = Number(parts[5]);
    const ref = String(parts[6] || '');
    if (!side || !item || item.length > MAX_ITEM || /[|\r\n]/.test(item)) return null;
    if (!isFinite(qty) || qty <= 0 || !isFinite(price) || price <= 0 || !validRef(ref)) return null;
    return { type: 'order', side, item, qty, price, ref, key: txKey(tx), from: tx.from, amount: Number(tx.amount) || 0, ts: tx.ts };
  }
  if (parts[1] === 'F') {
    const ref = String(parts[2] || '');
    const qty = Number(parts[3]);
    if (!validRef(ref) || !isFinite(qty) || qty <= 0) return null;
    return { type: 'fill', ref, qty, key: txKey(tx), from: tx.from, to: tx.to, amount: Number(tx.amount) || 0, ts: tx.ts };
  }
  if (parts[1] === 'C') {
    const ref = String(parts[2] || '');
    if (!validRef(ref)) return null;
    return { type: 'cancel', ref, key: txKey(tx), from: tx.from, amount: Number(tx.amount) || 0, ts: tx.ts };
  }
  return null;
}

// Детерминированный индекс. Кэш: пересчёт только когда выросла цепь —
// /dxe/book не лезет через всю цепь на каждый запрос.
let cacheHeight = -1, cacheVal = null;
export function dxeState(bc) {
  const h = bc.blockCount();
  if (cacheHeight === h && cacheVal) return cacheVal;
  const orders = new Map(); // ref → order
  const fills = [];
  const cancels = new Set();
  let ordNo = 0;
  for (const blk of bc.chain) {
    (blk.txs || []).forEach((tx, idx) => {
      const p = parseDxe(tx);
      if (!p) return;
      p.height = blk.height; p.txIdx = idx; p.ordSeq = ordNo++;
      if (p.type === 'order') {
        if (orders.has(p.ref) || cancels.has(p.ref)) return; // ref одноразов
        orders.set(p.ref, { ...p, filled: 0, status: 'open', fills: [] });
      } else if (p.type === 'cancel') {
        const o = orders.get(p.ref);
        if (o && o.from === p.from && o.status === 'open') { o.status = 'canceled'; cancels.add(p.ref); }
      } else if (p.type === 'fill') {
        const o = orders.get(p.ref);
        if (!o) return;
        const remaining = o.qty - o.filled;
        if (remaining <= 0) { fills.push({ ...p, orderRef: p.ref, accepted: false, reason: 'order_closed' }); return; }
        if (p.from === o.from) { fills.push({ ...p, orderRef: p.ref, accepted: false, reason: 'self_trade_stp' }); return; }
        // цена сделки = цена maker'а (resting price wins); сумма = price × qtyFill
        const qtyFill = Math.min(p.qty, remaining);
        const due = +(o.price * qtyFill).toFixed(DEC);
        if (Math.abs(p.amount - due) > 1e-9) {
          fills.push({ ...p, orderRef: p.ref, accepted: false, reason: `amount_mismatch_due_${due}` });
          return;
        }
        o.filled = +(o.filled + qtyFill).toFixed(DEC);
        o.fills.push({ key: p.key, buyer: p.from, qty: qtyFill, amount: due, height: blk.height, txIdx: idx });
        if (o.qty - o.filled <= 1e-9) o.status = 'closed';
        fills.push({ ...p, orderRef: p.ref, qtyFill, due, accepted: true, height: blk.height });
      }
    });
  }
  cacheHeight = h;
  cacheVal = { orders: [...orders.values()], fills, seq: ordNo };
  return cacheVal;
}

export function dxeBook(bc, dxe, item) {
  const open = dxe.orders.filter(o => o.status === 'open' && o.item === item);
  const sort = (a, b) => (b.side === 'b' ? b.price - a.price : a.price - b.price) || a.height - b.height || a.txIdx - b.txIdx;
  const bids = open.filter(o => o.side === 'b').sort(sort).slice(0, 2000);
  const asks = open.filter(o => o.side === 's').sort(sort).slice(0, 2000);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    item, bestBid, bestAsk,
    spread: bestBid != null && bestAsk != null ? +(bestAsk - bestBid).toFixed(DEC) : null,
    bids: bids.map(o => ({ ref: o.ref, price: o.price, qty: o.qty, filled: o.filled, remaining: +(o.qty - o.filled).toFixed(DEC), maker: o.from, height: o.height })),
    asks: asks.map(o => ({ ref: o.ref, price: o.price, qty: o.qty, filled: o.filled, remaining: +(o.qty - o.filled).toFixed(DEC), maker: o.from, height: o.height })),
    note: 'книга выведена из цепи (memo dxe|O|/F|/C|) — одинакова на всех нодах',
  };
}

export function dxeItems(dxe) {
  const m = new Map();
  for (const o of dxe.orders) {
    const e = m.get(o.item) || { item: o.item, open: 0, closed: 0, volume: 0 };
    if (o.status === 'open') e.open++; else if (o.status === 'closed') { e.closed++; e.volume = +(e.volume + o.filled).toFixed(DEC); }
    m.set(o.item, e);
  }
  return [...m.values()].sort((a, b) => (b.open + b.closed) - (a.open + a.closed));
}

export function newRef() {
  return crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').padEnd(REF_LEN, '0').slice(0, REF_LEN);
}
