import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartbeat, collectHeartbeats, currentStreak, weeklyLedger, HB_MIN_AGE_DAYS } from '../tools/heartbeat.mjs';

const DAY = 86400;
const mk = (from, day, ts, memo) => ({ from, to: from, amount: 0.001, nonce: 1, ts, memo: memo === undefined ? `hb|${day}` : memo });

test('parseHeartbeat: только self-tx с memo hb|DATE', () => {
  assert.equal(parseHeartbeat(mk('A', '2026-11-01', 1)).day, '2026-11-01');
  assert.equal(parseHeartbeat({ ...mk('A', '2026-11-01', 1), to: 'B' }), null);
  assert.equal(parseHeartbeat({ ...mk('A', '2026-11-01', 1), amount: 0 }), null);
  assert.equal(parseHeartbeat(mk('A', '2026-11-01', 1, 'hello')), null);
  assert.equal(parseHeartbeat(mk('A', '2026-13-45', 1)), null);
});

test('streak: подряд и разрыв', () => {
  const now = Date.parse('2026-11-15T12:00:00Z') / 1000;
  const days = new Set(['2026-11-15', '2026-11-14', '2026-11-13']);
  assert.equal(currentStreak(days, now), 3);
  const gap = new Set(['2026-11-15', '2026-11-13']);
  assert.equal(currentStreak(gap, now), 1);
  const yest = new Set(['2026-11-14', '2026-11-13']);
  assert.equal(currentStreak(yest, now), 2);
  assert.equal(currentStreak(new Set(), now), 0);
});

test('weeklyLedger: молодые адреса мимо, кэп 7, бюджет', () => {
  const ws = Date.parse('2026-11-09T00:00:00Z') / 1000; // пн
  const now = ws + 8 * DAY;
  const old = now - (HB_MIN_AGE_DAYS + 1) * DAY;
  const txs = [];
  for (let d = 0; d < 7; d++) txs.push(mk('OLD', `2026-11-${String(9 + d).padStart(2, '0')}`, old));
  for (let d = 0; d < 3; d++) txs.push(mk('NEWBIE', `2026-11-${String(9 + d).padStart(2, '0')}`, now - DAY));
  const col = collectHeartbeats(txs);
  const led = weeklyLedger(col, ws, now);
  const byAddr = Object.fromEntries(led.rows.map(r => [r.address, r]));
  assert.equal(byAddr.OLD.days, 7);
  assert.equal(byAddr.OLD.amount, 7);
  assert.ok(!byAddr.NEWBIE, 'молодой адрес без выплат');
  assert.equal(led.scaled, false);
});

test('weeklyLedger: overflow бюджета делится пропорционально', () => {
  const ws = Date.parse('2026-11-09T00:00:00Z') / 1000;
  const now = ws + 8 * DAY;
  const old = now - 30 * DAY;
  const txs = [];
  for (let i = 0; i < 600; i++) for (let d = 0; d < 7; d++) txs.push(mk('A' + i, `2026-11-${String(9 + d).padStart(2, '0')}`, old));
  const led = weeklyLedger(collectHeartbeats(txs), ws, now);
  assert.equal(led.scaled, true);
  assert.ok(led.total <= 500.001);
  assert.ok(led.rows.every(r => r.scaled));
});
