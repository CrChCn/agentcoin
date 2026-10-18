import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditBalances, recalcFromChainFile } from '../audit-lib.mjs';

const coinbase = (to = 'AGTsynthetic', amount = 5) => ({ from: 'COINBASE', to, amount });
function fixture(t, transactions = [coinbase()], raw = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-balance-audit-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'chain.json'), raw ?? JSON.stringify({ chain: [{ txs: transactions }] }));
  return dir;
}
const response = (body, status = 200) => async () => ({ status, json: async () => body });
const run = (dataDir, fetchFn, extra = {}) => auditBalances({ dataDir, baseUrl: 'https://public.example', attempts: 1, fetchFn, ...extra });

test('finite matching balances return a complete sampler result and snapshot fingerprint', async t => {
  const dir = fixture(t);
  const result = await run(dir, response({ balance: 5 }));
  assert.equal(result.ok, true); assert.equal(result.complete, true); assert.equal(result.status, 'matched');
  assert.equal(result.compared, 1); assert.equal(result.matched, 1); assert.equal(result.checked, 1);
  assert.match(result.snapshotHash, /^[a-f0-9]{64}$/); assert.equal(result.height, 1);
  assert.equal(result.sharedSnapshotVerified, false);
  assert.equal(result.mode, 'sequential_live_balance_sampler');
});

test('higher and lower live balances both fail; unexplained increases are never reward drift', async t => {
  const dir = fixture(t);
  for (const got of [4, 6]) {
    const result = await run(dir, response({ balance: got }));
    assert.equal(result.ok, false); assert.equal(result.complete, true); assert.equal(result.status, 'mismatch');
    assert.equal(result.rewardDrift, 0); assert.equal(result.mismatches[0].got, got);
  }
});

test('node-reported bans leave reconciliation incomplete and visible in legacy diagnostics', async t => {
  const result = await run(fixture(t), response({ balance: 0, opinion: 'permabanned' }));
  assert.equal(result.ok, false); assert.equal(result.complete, false); assert.equal(result.status, 'incomplete');
  assert.equal(result.bannedSkipped, 1); assert.equal(result.compared, 0);
  assert.equal(result.mismatches[0].error, 'balance_opinion_permabanned_unverified');
});

test('503/429 exhaustion and transport errors cannot produce false success', async t => {
  const dir = fixture(t);
  for (const status of [503, 429]) {
    const result = await run(dir, response({}, status));
    assert.equal(result.ok, false); assert.equal(result.complete, false);
    assert.equal(result.transientSkipped, 1); assert.equal(result.mismatches.length, 1);
  }
  const result = await run(dir, async () => { throw new Error('offline'); });
  assert.equal(result.ok, false); assert.equal(result.complete, false);
  assert.equal(result.mismatches[0].error, 'balance_api_0');
});

test('NaN, infinities, missing and mistyped live balances are explicitly unverifiable', async t => {
  const dir = fixture(t);
  for (const balance of [NaN, Infinity, -Infinity, undefined, '5', null]) {
    const result = await run(dir, response({ balance }));
    assert.equal(result.ok, false, String(balance)); assert.equal(result.complete, false);
    assert.equal(result.compared, 0); assert.equal(result.mismatches[0].error, 'balance_not_finite_number');
  }
});

test('nonfinite snapshot amounts and overflowed expected balances cannot be excused', async t => {
  const invalid = fixture(t, [], '{"chain":[{"txs":[{"from":"COINBASE","to":"AGTsynthetic","amount":1e999}]}]}');
  let called = false;
  const result = await run(invalid, async () => { called = true; return { status: 200, json: async () => ({ balance: 5 }) }; });
  assert.equal(called, false); assert.equal(result.ok, false); assert.equal(result.complete, false);
  assert.equal(result.snapshotIssues[0].error, 'invalid_amount');
  const overflow = fixture(t, [coinbase('AGTsynthetic', Number.MAX_VALUE), coinbase('AGTsynthetic', Number.MAX_VALUE)]);
  const over = await run(overflow, response({ balance: Infinity }));
  assert.equal(over.ok, false); assert.equal(over.complete, false);
  assert.ok(over.snapshotIssues.some(issue => issue.error === 'expected_balance_not_finite'));
});

test('full addresses distinguish identities that share a truncated prefix', async t => {
  const a = 'AGT1234567890123456aaaaaaaa', b = 'AGT1234567890123456bbbbbbbb';
  const result = await run(fixture(t, [coinbase(a), coinbase(b)]), response({ balance: 0 }));
  assert.deepEqual(result.mismatches.map(m => m.addr), [a, b]);
  assert.equal(result.mismatches.length, 2);
});

test('prototype-like addresses are accounted as ordinary distinct string keys', t => {
  const dir = fixture(t, [coinbase('__proto__', 5), { from: '__proto__', to: 'constructor', amount: 2 }]);
  const result = recalcFromChainFile(dir);
  assert.equal(Object.getPrototypeOf(result.balances), null);
  assert.equal(result.balances.__proto__, 3); assert.equal(result.balances.constructor, 2);
});

test('metadata without an amount is disclosed, while malformed numeric fields fail completeness', async t => {
  const metadata = await run(fixture(t, [coinbase(), { memo: 'service-record' }]), response({ balance: 5 }));
  assert.equal(metadata.metadataSkipped, 1); assert.equal(metadata.ok, true);
  const malformed = await run(fixture(t, [coinbase(), { from: 'a', to: 'b', amount: '7' }]), response({ balance: 5 }));
  assert.equal(malformed.ok, false); assert.equal(malformed.complete, false);
});

test('abort during retry backoff is honored without waiting for the retry timer', async t => {
  const start = Date.now(); let calls = 0;
  await assert.rejects(run(fixture(t), async () => { calls++; return { status: 503, json: async () => ({}) }; }, { attempts: 4, signal: AbortSignal.timeout(20) }), /abort|timeout/i);
  assert.equal(calls, 1); assert.ok(Date.now() - start < 400);
});

test('zero retry attempts cannot turn an unexecuted audit green', async t => {
  await assert.rejects(run(fixture(t), response({ balance: 5 }), { attempts: 0 }), /positive integer/);
});

test('a snapshot containing only skipped metadata cannot attest any balance match', async t => {
  const result = await run(fixture(t, [{ memo: 'service-record' }]), response({ balance: 0 }));
  assert.equal(result.checked, 0); assert.equal(result.compared, 0);
  assert.equal(result.ok, false); assert.equal(result.complete, false);
  assert.ok(result.snapshotIssues.some(issue => issue.error === 'no_numeric_balances'));
});
