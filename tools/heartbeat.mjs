#!/usr/bin/env node
/* heartbeat.mjs — учёт heartbeat-ритма агентов (фонд «ежедневного хлеба»).
 *
 * Концепция: агент раз в сутки шлёт self-tx с memo `hb|YYYY-MM-DD`
 * (сумма любая > 0, обычно 0.001 AGT — пылинка как доказательство живости).
 * Сторож раз в неделю считает streak'и и формирует реестр выплат:
 * 1 AGT за каждые сутки непрерывного ритма, но не более 7 AGT в неделю
 * на адрес. Выплаты — вручную из казны (подпись владельца), этот модуль
 * только считает и ничего не тратит.
 *
 * Анти-ферма (правила v1):
 * - 1 heartbeat в сутки на адрес (повторы в тот же день не считаются);
 * - возраст адреса (первое появление в цепи) >= 7 суток;
 * - недельный бюджет фонда: 500 AGT (overflow — пропорциональная дележка,
 *   в реестре помечается scaled:true).
 */
export const HB_MEMO_RE = /^hb\|(\d{4})-(\d{2})-(\d{2})$/;
export const HB_REWARD_PER_DAY = 1;
export const HB_MAX_PER_WEEK = 7;
export const HB_MIN_AGE_DAYS = 7;
export const HB_WEEKLY_BUDGET = 500;

export function parseHeartbeat(tx) {
  if (!tx || tx.from !== tx.to) return null;
  if (typeof tx.amount !== 'number' || !(tx.amount > 0)) return null;
  const m = HB_MEMO_RE.exec(String(tx.memo || ''));
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  return { address: tx.from, day, dayTs: t };
}

// txs: [{from,to,amount,memo,ts}] — ts в секундах. Возвращает Map addr -> {days:Set, firstSeenTs}
export function collectHeartbeats(txs) {
  const out = new Map();
  for (const tx of txs || []) {
    const hb = parseHeartbeat(tx);
    if (!hb) continue;
    let rec = out.get(hb.address);
    if (!rec) { rec = { days: new Set(), firstSeenTs: null }; out.set(hb.address, rec); }
    rec.days.add(hb.day);
    const ts = Number(tx.ts) || 0;
    if (rec.firstSeenTs == null || ts < rec.firstSeenTs) rec.firstSeenTs = ts;
  }
  return out;
}

const DAY = 86400;
function dayStr(tsSec) {
  return new Date(Math.floor(tsSec / DAY) * DAY * 1000).toISOString().slice(0, 10);
}

// Текущий streak (подряд суток назад от `nowSec`, включая сегодня/вчера).
export function currentStreak(daysSet, nowSec) {
  const has = d => daysSet.has(d);
  let streak = 0;
  let cursor = Math.floor(nowSec / DAY) * DAY;
  if (!has(dayStr(cursor))) cursor -= DAY; // сегодня ещё не отметился — считаем от вчера
  while (has(dayStr(cursor))) { streak++; cursor -= DAY; }
  return streak;
}

// Реестр выплат за неделю [weekStartSec, weekStartSec+7d).
export function weeklyLedger(collected, weekStartSec, nowSec) {
  const rows = [];
  for (const [addr, rec] of collected) {
    const ageDays = rec.firstSeenTs == null ? 0 : (nowSec - rec.firstSeenTs) / DAY;
    if (ageDays < HB_MIN_AGE_DAYS) continue;
    let paid = 0;
    for (let d = 0; d < 7; d++) {
      const day = dayStr(weekStartSec + d * DAY);
      if (rec.days.has(day)) paid++;
    }
    paid = Math.min(paid, HB_MAX_PER_WEEK);
    if (paid > 0) rows.push({ address: addr, days: paid, amount: paid * HB_REWARD_PER_DAY, scaled: false });
  }
  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (total > HB_WEEKLY_BUDGET && total > 0) {
    const k = HB_WEEKLY_BUDGET / total;
    for (const r of rows) { r.amount = Math.floor(r.amount * k * 1000) / 1000; r.scaled = true; }
  }
  rows.sort((a, b) => b.days - a.days || (a.address < b.address ? -1 : 1));
  const totalScaled = rows.reduce((s, r) => s + r.amount, 0);
  return { weekStart: dayStr(weekStartSec), rows, total: totalScaled, budget: HB_WEEKLY_BUDGET, scaled: total > HB_WEEKLY_BUDGET };
}
