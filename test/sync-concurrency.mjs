import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  Blockchain, CHAIN_ID, blockReward, chainWork, computeBlockHash,
  expectedDifficultyBits, hashMeetsDifficulty, merkleRoot, validateBlockAgainstChain,
} from '../core.mjs';

// All HTTP is a disposable loopback peer; metadata never touches a real node.
const metadataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-sync-concurrency-'));
process.env.AGT_DATA_DIR = metadataDir;
const { syncOne, syncAll, savePeers, savePeerMeta, loadPeerMeta } = await import('../sync.mjs');
test.after(() => fs.rmSync(metadataDir, { recursive: true, force: true }));

function mine(chain, tag, timestamp) {
  const height = chain.length;
  const txs = [{ from: 'COINBASE', to: 'AGT_SYNTHETIC_TEST_POOL', amount: height ? blockReward(height) : 0, nonce: height, ts: timestamp, memo: tag, txid: tag + height }];
  const header = { version: 1, chainId: CHAIN_ID, prevHash: chain.at(-1)?.hash || '0'.repeat(64), merkleRoot: merkleRoot(txs), timestamp, difficultyBits: height ? expectedDifficultyBits(chain) : 8, nonce: 0 };
  while (!hashMeetsDifficulty(computeBlockHash(header), header.difficultyBits)) header.nonce++;
  const block = { height, hash: computeBlockHash(header), header, txs };
  if (height) assert.equal(validateBlockAgainstChain(block, chain), null);
  return block;
}
const genesis = mine([], 'genesis', 1_700_000_000);
function branch(count, tag, step = 30) {
  const chain = [structuredClone(genesis)];
  while (chain.length < count) chain.push(mine(chain, tag, genesis.header.timestamp + chain.length * step));
  return chain;
}
function blockchain(chain) {
  return {
    chain: structuredClone(chain), genesisHeader: structuredClone(genesis.header), forks: [],
    saved: 0, adopted: 0, cacheInvalidations: 0,
    blockCount() { return this.chain.length; }, tip() { return this.chain.at(-1); },
    getTreasuryPolicy() { return null; }, invalidateTxCache() { this.cacheInvalidations++; },
    refilterMempool() {}, saveForks() {}, save() { this.saved++; },
    adoptFork(...args) { this.adopted++; return Blockchain.prototype.adoptFork.apply(this, args); },
  };
}
async function peer(chain, hook = async () => {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); requests.push(url.pathname);
    try {
      await hook(url);
      let value;
      if (url.pathname === '/info') value = { chainId: CHAIN_ID, genesisHash: genesis.hash, blocks: chain.length };
      else if (url.pathname === '/life') value = { tipHash: chain.at(-1).hash };
      else if (url.pathname === '/headers') value = { headers: chain.slice(Number(url.searchParams.get('from') || 0), Number(url.searchParams.get('from') || 0) + Math.min(2000, Number(url.searchParams.get('limit') || 2000))).map(({ height, hash, header }) => ({ height, hash, header })) };
      else if (url.pathname === '/blocks') value = { blocks: chain.slice(Number(url.searchParams.get('from') || 0)) };
      else { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  return { url, requests, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
function assertDeferred(log, bc, expectedTip, peerUrl) {
  assert.equal(bc.tip().hash, expectedTip);
  assert.equal(bc.saved, 0);
  assert.equal(bc.adopted, 0);
  assert.match(log.join('\n'), /DEFERRED.*local chain changed/);
  assert.equal(loadPeerMeta()[peerUrl], undefined, 'local mutation must not penalize the peer');
}

test('linear sync preserves a local append while /blocks is in flight; clean retry succeeds', async () => {
  savePeerMeta({});
  const remote = branch(2, 'remote'); const bc = blockchain([genesis]);
  let injected = false; let localTip;
  const p = await peer(remote, async url => {
    if (url.pathname === '/blocks' && !injected) {
      injected = true;
      const block = mine(bc.chain, 'concurrent-local', genesis.header.timestamp + 31);
      bc.chain.push(block); localTip = block.hash;
    }
  });
  try {
    const log = await syncOne(bc, p.url);
    assert.equal(injected, true); assertDeferred(log, bc, localTip, p.url);
    assert.equal(bc.blockCount(), 2);
    // A separate clean node can still accept exactly these peer blocks.
    const clean = blockchain([genesis]);
    assert.match((await syncOne(clean, p.url)).join('\n'), /accepted 1 blocks/);
    assert.equal(clean.tip().hash, remote.at(-1).hash);
    assert.equal(clean.saved, 1);
  } finally { await p.close(); }
});

test('longer fork sync preserves a concurrent same-height local reorg before adoptFork', async () => {
  savePeerMeta({});
  const local = branch(2, 'local'); const remote = branch(3, 'remote');
  const replacement = branch(2, 'new-local'); const bc = blockchain(local);
  let injected = false;
  const p = await peer(remote, async url => {
    if (url.pathname === '/blocks') { injected = true; bc.chain = structuredClone(replacement); }
  });
  try {
    const log = await syncOne(bc, p.url);
    assert.equal(injected, true); assertDeferred(log, bc, replacement.at(-1).hash, p.url);
    assert.equal(bc.blockCount(), 2);
  } finally { await p.close(); }
});

test('shorter heavier fork also cannot erase a concurrent local append', async () => {
  savePeerMeta({});
  // Both histories obey deterministic retargeting: fast peer raises difficulty,
  // slow local remains at minimum. A shorter peer is genuinely heavier.
  const local = branch(22, 'slow-local', 90); const remote = branch(21, 'fast-peer', 1);
  assert.ok(chainWork(remote) > chainWork(local));
  const bc = blockchain(local); let injected = false; let tip;
  const p = await peer(remote, async url => {
    if (url.pathname === '/blocks') {
      injected = true;
      const block = mine(bc.chain, 'concurrent-miner', bc.tip().header.timestamp + 90);
      bc.chain.push(block); tip = block.hash;
    }
  });
  try {
    const log = await syncOne(bc, p.url);
    assert.equal(injected, true); assertDeferred(log, bc, tip, p.url);
    assert.equal(bc.blockCount(), 23);
  } finally { await p.close(); }
});

test('mutation during headers fallback defers without false header strikes', async () => {
  savePeerMeta({});
  const remote = branch(2, 'remote'); const bc = blockchain([genesis]); let injected = false; let tip;
  const p = await peer(remote, async url => {
    if (url.pathname === '/headers') {
      injected = true;
      const block = mine(bc.chain, 'local-header-race', genesis.header.timestamp + 30);
      bc.chain.push(block); tip = block.hash;
    }
  });
  try {
    const log = await syncOne(bc, p.url);
    assert.equal(injected, true); assertDeferred(log, bc, tip, p.url);
    assert.equal(p.requests.includes('/blocks'), false);
  } finally { await p.close(); }
});

test('overlapping syncAll runs share one flight and release it after completion', async () => {
  savePeerMeta({});
  let release; let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let holdFirst = true;
  const remote = branch(2, 'peer'); const bc = blockchain([genesis]);
  const p = await peer(remote, async url => {
    if (url.pathname === '/info' && holdFirst) { holdFirst = false; entered(); await blocked; }
  });
  try {
    savePeers([p.url]);
    const first = syncAll(bc); const second = syncAll(bc);
    assert.strictEqual(first, second);
    await started; assert.equal(p.requests.filter(v => v === '/info').length, 1);
    release(); const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b);
    assert.equal(bc.saved, 1);
    await syncAll(bc);
    assert.equal(p.requests.filter(v => v === '/info').length, 2);
  } finally { release(); await p.close(); savePeers([]); }
});

test('fresh timestamps in seconds do not bypass quarantine; stale tip alone permits the valve', async () => {
  const remote = branch(1, 'peer'); const bc = blockchain([genesis]);
  const p = await peer(remote);
  try {
    savePeers([p.url]);
    const until = Date.now() + 60_000;
    savePeerMeta({ [p.url]: { strikes: 3, accepted: 0, blockedUntil: until } });
    bc.chain[0].header.timestamp = Math.floor(Date.now() / 1000);
    let log = await syncAll(bc);
    assert.match(log.join('\n'), /SKIPPED/);
    assert.doesNotMatch(log.join('\n'), /SAFETY VALVE/);
    assert.equal(p.requests.length, 0);
    assert.equal(loadPeerMeta()[p.url].blockedUntil, until);
    bc.chain[0].header.timestamp = Math.floor(Date.now() / 1000) - 301;
    log = await syncAll(bc);
    assert.match(log.join('\n'), /SAFETY VALVE/);
    assert.equal(loadPeerMeta()[p.url].blockedUntil, undefined);
    assert.equal(loadPeerMeta()[p.url].strikes, 3);
    assert.ok(p.requests.length > 0);
  } finally { await p.close(); savePeers([]); savePeerMeta({}); }
});
