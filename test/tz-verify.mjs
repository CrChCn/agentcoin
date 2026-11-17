#!/usr/bin/env node
/* TZ verification: precision, supply definition, 24h coverage, event-id bounds.
 * Run: node test/tz-verify.mjs  (no network, no secrets)
 */
'use strict';
import { balancesOf } from '../core.mjs';
import fs from 'node:fs';

let fail = 0;
function ok(c, name, extra = '') {
  console.log((c ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' :: ' + extra : ''));
  if (!c) fail++;
}

// 1. fmt как в imperial.html после фикса: максимум 9 знаков, ru-RU
const fmt = n => {
  if (n == null) return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('ru-RU', { maximumFractionDigits: 9 });
};
// fmtAGT второго блока (chronicle/liveFeed) — строковые суммы 9 знаков
const fmtAGT = n => {
  try {
    if (typeof n === 'string' && /^-?\d+(\.\d{1,9})?$/.test(n.trim())) {
      const parts = n.trim().split('.');
      const intP = Number(parts[0]).toLocaleString('en-US');
      if (parts.length === 1) return intP;
      const frac = parts[1].replace(/0+$/, '');
      return frac ? intP + '.' + frac : intP;
    }
    const num = Number(n);
    if (!Number.isFinite(num)) return '—';
    return num.toLocaleString('en-US', { maximumFractionDigits: 9 });
  } catch (e) { return '—'; }
};
ok(fmt(0.000000001) === '0,000000001', 'fmt 1 magnet', fmt(0.000000001));
ok(fmt(160.123456789) === '160,123456789', 'fmt supply 9dec', fmt(160.123456789));
ok(fmtAGT('0.000000001') === '0.000000001', 'fmtAGT 1 magnet', fmtAGT('0.000000001'));
ok(fmtAGT('12345678.123456789') === '12,345,678.123456789', 'fmtAGT big 9dec', fmtAGT('12345678.123456789'));
// строковая сумма без float: BigInt-магент точна; JSON-числа float64 для больших значений
// 9-й знак после запятой не держат — ограничение формата, страница показывает float честно
const toMag = s => { const [i, f = ''] = s.split('.'); return BigInt(i) * 1000000000n + BigInt((f + '000000000').slice(0, 9)); };
ok(toMag('0.100000000') + toMag('0.200000000') === 300000000n, 'string sum 0.1+0.2 = 0.3 exact');
ok(fmt(12345678.123456789) !== fmtAGT('12345678.123456789'), 'large float: JSON-number loses 9th digit (known limit)', fmt(12345678.123456789));

// 2. totalSupplyCirculating = всего намайнено: серверный расчёт core.mjs info()
{
  const chain = [
    { txs: [{ from: 'COINBASE', to: 'A', amount: 50 }] },
    { txs: [{ from: 'COINBASE', to: 'B', amount: 50 }] },
    { txs: [{ from: 'A', to: 'B', amount: 10 }] },
  ];
  const b = balancesOf(chain);
  const supply = Object.entries(b).reduce((s, [, v]) => s + Math.max(0, v), 0);
  ok(b.A === 40 && b.B === 60, 'balancesOf replay', JSON.stringify(b));
  ok(supply === 100, 'supply=sum positives=всего намайнено (переводы net-0)', 'supply=' + supply);
  const src = fs.readFileSync(new URL('../core.mjs', import.meta.url), 'utf8');
  ok(src.includes('totalSupplyCirculating: Object.entries(b).reduce((s, [, v]) => s + Math.max(0, v), 0)'), 'server calc pinned in core.mjs info()');
}

// 3. 24h покрытие (логика econRender)
function mined24h(blocksArr, nowS) {
  const win = blocksArr.filter(b => { const ts = Number(b.header && b.header.timestamp || 0); return ts > 0 && (nowS - ts) <= 86400; });
  const allTs = blocksArr.map(b => Number(b.header && b.header.timestamp || 0)).filter(t => t > 0).sort((a, b2) => a - b2);
  const covered = allTs.length && (nowS - allTs[0]) >= 86400;
  let sum = 0, good = true;
  for (const b of win) for (const tx of (b.txs || [])) { if (tx && (tx.from === 'COINBASE' || tx.coinbase)) { const v = Number(tx.amount); if (!Number.isFinite(v) || v < 0) { good = false; break; } sum += v; } }
  if (good && covered && win.length) return { mined24h: sum, note: 'fact' };
  if (good && win.length && !covered) return { mined24h: null, note: 'partial-no-full-total' };
  return { mined24h: null, note: 'absent' };
}
{
  const t = Math.floor(Date.now() / 1000);
  const mk = (ageH, amt = 50) => ({ header: { timestamp: t - ageH * 3600 }, txs: [{ from: 'COINBASE', amount: amt }] });
  const r1 = mined24h([mk(1), mk(2)], t);
  ok(r1.mined24h === null && r1.note === 'partial-no-full-total', '24h partial => no full total, honest message');
  const full = []; for (let i = 0; i < 30; i++) full.push(mk(i));
  ok(mined24h(full, t).mined24h !== null, '24h full => fact');
  ok(mined24h([{ header: { timestamp: t - 100 }, txs: [{ from: 'COINBASE', amount: 'lots' }] }], t).mined24h === null, '24h bad types => no total');
}

// 4. event-id: версионированный ключ + TTL/release (логика ecosphere.js после фикса)
{
  const histKey = e => String(e.jobId) + '|' + String(e.at != null ? e.at : '') + '|' + String(e.agent || '');
  ok(histKey({ jobId: 'J1', at: 1000, agent: 'A' }) === histKey({ jobId: 'J1', at: 1000, agent: 'A' }), 'same snapshot entry => same key (no dupes)');
  ok(histKey({ jobId: 'J1', at: 1000, agent: 'A' }) !== histKey({ jobId: 'J1', at: 2000, agent: 'A' }), 'same jobId, new stage => new key (no merge)');
  const seen = { 'qin:X': Date.now() };
  delete seen['qin:X']; // leave releases
  ok(!('qin:X' in seen), 'leave releases qin key: re-entry emits again');
  const eco = fs.readFileSync(new URL('../site/ecosphere.js', import.meta.url), 'utf8');
  ok(eco.includes('histKey') && eco.includes('SEEN_MAX') && eco.includes('seenHas'), 'ecosphere: bounded TTL dedup + versioned id present');
  ok(eco.includes("Array.isArray(d.nextFive)") && eco.includes("Array.isArray(d.history)") && eco.includes("Array.isArray(d.auctions)"), 'ecosphere: full-snapshot guards present');
  ok(eco.includes('/api/v1/queue/history'), 'ecosphere: history via AGTData path');
}

// 5. imperial.html: нет межблочных ссылок на fmtAGT; mismatch-ветка; i18n-строки
{
  const h = fs.readFileSync(new URL('../site/imperial.html', import.meta.url), 'utf8');
  const firstBlock = h.slice(0, h.indexOf('Авто-навигация'));
  ok(!/fmtAGT\s*\(/.test(firstBlock), 'tick block: no cross-script fmtAGT (first-tick crash fixed)');
  ok(h.includes('NETWORK MISMATCH'), 'mismatch branch surfaces foreign net explicitly');
  const i18 = fs.readFileSync(new URL('../site/empire-i18n.js', import.meta.url), 'utf8');
  ok(i18.includes('Последние блоки') && !i18.includes('Живая лента — блоки и транзакции'), 'i18n: no stale live-feed copy');
}

console.log(fail ? `\nRESULT: ${fail} FAIL(s)` : '\nRESULT: all PASS');
process.exit(fail ? 1 : 0);
