'use strict';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mineMany, coinbaseTx } from '../src/mine.mjs';
import { waitFor } from '../src/util.mjs';
import { cleanupAll, endpoint, makeNetworkId, startTestNode, tempDir } from './helpers.mjs';

after(cleanupAll);

test('sync: headers-first + тела, общий tip', async () => {
  const networkId = makeNetworkId('sync');
  const a = await startTestNode({ dir: tempDir('sa'), networkId });
  const b = await startTestNode({ dir: tempDir('sb'), networkId, seeds: [endpoint(a)] });
  try {
    mineMany(a.chain, 4, { txs: [coinbaseTx('s1')] });
    await b.connect(endpoint(a));
    await waitFor(() => b.chain.height === 4, { timeoutMs: 10000, label: 'height=4' });
    assert.equal(b.chain.tip.hash, a.chain.tip.hash);
    await waitFor(() => b.chain.bodies.size === 4, { timeoutMs: 10000, label: 'bodies' });
    assert.equal(b.chain.bodies.get(4).hash, a.chain.bodies.get(4).hash);
    assert.ok(b.sync.headersAdded >= 4);
    assert.ok(b.sync.bodiesAdded >= 4);
  } finally {
    await b.stop('test'); await a.stop('test');
  }
});

test('sync: остановка и повторный старт продолжают цепь с диска', async () => {
  const networkId = makeNetworkId('resume');
  const dir = tempDir('nres');
  const a = await startTestNode({ dir: tempDir('ra'), networkId });
  mineMany(a.chain, 3, { txs: [coinbaseTx('rs1')] });
  const b = await startTestNode({ dir, networkId, seeds: [endpoint(a)] });
  await waitFor(() => b.chain.height === 3, { timeoutMs: 10000, label: 'sync3' });
  await waitFor(() => b.chain.bodies.size === 3, { timeoutMs: 10000, label: 'bodies3' });
  const tip = b.chain.tip.hash;
  await b.stop('restart');
  const c = await startTestNode({ dir, networkId, seeds: [endpoint(a)] });
  try {
    assert.equal(c.chain.height, 3);
    assert.equal(c.chain.tip.hash, tip);
    assert.equal(c.chain.bodies.size, 3);
  } finally {
    await c.stop('test'); await a.stop('test');
  }
});

test('sync: node3 догоняет через node2 (seed не обязателен после знакомства)', async () => {
  const networkId = makeNetworkId('mesh');
  const a = await startTestNode({ dir: tempDir('ma'), networkId });
  mineMany(a.chain, 2, { txs: [coinbaseTx('m1')] });
  const b = await startTestNode({ dir: tempDir('mb'), networkId, seeds: [endpoint(a)] });
  await waitFor(() => b.chain.height === 2, { timeoutMs: 10000, label: 'b2' });
  const c = await startTestNode({ dir: tempDir('mc'), networkId, seeds: [endpoint(b)] });
  try {
    await waitFor(() => c.chain.height === 2, { timeoutMs: 10000, label: 'c2' });
    assert.equal(c.chain.tip.hash, a.chain.tip.hash);
    mineMany(a.chain, 1, { txs: [coinbaseTx('m2')] });
    a.broadcastAnnouncement();
    await waitFor(() => c.chain.height === 3, { timeoutMs: 10000, label: 'c3' });
  } finally {
    await c.stop('test'); await b.stop('test'); await a.stop('test');
  }
});
