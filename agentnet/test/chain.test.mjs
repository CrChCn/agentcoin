'use strict';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openChain, defaultHashHeader, merkleRoot } from '../src/chain.mjs';
import { AgentcoinNode } from '../src/node.mjs';
import { mineMany, coinbaseTx } from '../src/mine.mjs';
import { DiskFullError } from '../src/util.mjs';
import { cleanupAll, makeNetworkId, startTestNode, tempDir } from './helpers.mjs';

after(cleanupAll);

function chain(name, opts = {}) {
  // один networkId на все цепочки теста: genesis обязан совпадать, иначе это другая сеть
  return openChain({ dir: tempDir(name), networkId: 'chain-test', ...opts });
}

function headersOf(c) {
  return c.headers.slice(1).map((r) => ({ height: r.height, hash: r.hash, header: r.header }));
}

test('chain: более тяжёлая ветка побеждает более длинную', () => {
  const a = chain('heavy-a');
  const b = chain('heavy-b');
  mineMany(a, 3, { bits: 1 });
  mineMany(b, 1, { bits: 3 });
  assert.equal(a.height, 3);
  assert.equal(b.height, 1);
  assert.ok(b.work > a.work, 'chainwork короче, но тяжелее');
  const res = a.addHeaders(headersOf(b));
  assert.equal(res.ok, true);
  assert.ok(res.reorg, 'reorg случился');
  assert.equal(a.height, 1);
  assert.equal(a.tip.hash, b.tip.hash);
  assert.equal(a.reorgs, 1);
});

test('chain: лёгкая ветка не принимается', () => {
  const a = chain('light-a');
  const b = chain('light-b');
  mineMany(a, 3, { bits: 2 });
  mineMany(b, 1, { bits: 1 });
  const before = a.tip.hash;
  const res = a.addHeaders(headersOf(b));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_heavier');
  assert.equal(a.tip.hash, before);
});

test('chain: тело с чужим merkle отвергается', () => {
  const c = chain('merkle');
  const prev = c.tip;
  const goodTx = coinbaseTx('tx-good');
  const header = {
    version: 1, prevHash: prev.hash, merkleRoot: merkleRoot([goodTx]),
    timestamp: Math.floor(Date.now() / 1000), difficultyBits: 0, nonce: 0, chainId: c.networkId,
  };
  const hash = defaultHashHeader(header);
  assert.equal(c.addHeaders([{ height: 1, hash, header }]).ok, true);
  const bad = c.addBlock({ height: 1, hash, header, txs: [coinbaseTx('tx-evil')] });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'merkle_mismatch');
  assert.equal(c.addBlock({ height: 1, hash, header, txs: [goodTx] }).ok, true);
});

test('chain: продолжение с диска и обрезка битого хвоста', () => {
  const dir = tempDir('resume');
  const c = openChain({ dir, networkId: 'resume' });
  mineMany(c, 4, { txs: [coinbaseTx('r1')] });
  const tip = c.tip.hash;
  const work = c.work;
  fs.appendFileSync(path.join(dir, 'headers.ndjson'), '{"broken":');
  const again = openChain({ dir, networkId: 'resume' });
  assert.equal(again.height, 4);
  assert.equal(again.tip.hash, tip);
  assert.equal(again.work, work);
  assert.equal(again.bodies.size, 4);
});

test('chain: pruning держит только последние тела', () => {
  const c = chain('prune', { pruneBodies: 2 });
  mineMany(c, 5, { txs: [coinbaseTx('p1')] });
  assert.equal(c.bodies.size, 2);
  assert.equal(c.prunedBefore, 4);
  assert.equal(c.blocksFrom(1, 10).length, 2);
});

test('chain: ENOSPC переводит запись в read-only и не теряет цепь', () => {
  const c = chain('disk', { io: { appendFileSync() { throw new DiskFullError(); } } });
  const prev = c.tip;
  const header = {
    version: 1, prevHash: prev.hash, merkleRoot: '0'.repeat(64),
    timestamp: Math.floor(Date.now() / 1000), difficultyBits: 0, nonce: 0, chainId: c.networkId,
  };
  const hash = defaultHashHeader(header);
  c.addHeaders([{ height: 1, hash, header }]);
  assert.equal(c.readOnly, true);
  assert.equal(c.stoppedReason, 'disk_full');
  const second = c.addHeaders([{ height: 2, hash: 'f'.repeat(64), header: { ...header, prevHash: hash } }]);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'read_only');
  const body = c.addBlock({ height: 1, hash, header, txs: [] });
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'read_only');
});

test('guard: второй процесс на том же каталоге не запускается', async () => {
  const networkId = makeNetworkId('guard');
  const node = await startTestNode({ dir: tempDir('guarded'), networkId });
  try {
    const dup = new AgentcoinNode({ dataDir: node.dataDir, config: { networkId }, log: () => {} });
    await assert.rejects(() => dup.start(), /already running/);
  } finally {
    await node.stop('test');
  }
});
