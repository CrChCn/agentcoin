import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { computeBlockHash, CHAIN_ID } from '../core.mjs';
import { prefixContentDigest } from '../consensus-v2.mjs';
import { MAX_SNAPSHOT_BYTES, proposeCheckpoint, runCheckpointCLI } from '../tools/consensus-checkpoint.mjs';
function fixture() {
  const blocks = [];
  for (let i = 0; i < 2; i++) {
    const header = { version: 1, timestamp: 100 + i, nonce: 0, difficultyBits: 8, chainId: CHAIN_ID, prevHash: blocks.at(-1)?.hash || '0'.repeat(64), merkleRoot: i ? 'coinbase-legacy-synthetic' : 'a'.repeat(64) };
    blocks.push({ height: i, header, hash: computeBlockHash(header), txs: [{ from: 'COINBASE', to: 'AGT' + 'b'.repeat(40), amount: i ? 50 : 0 }] });
  }
  return blocks;
}
async function temp(fn) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agt-checkpoint-'));
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
test('disabled proposal binds exact bytes and full content without writing files', () => temp(async root => {
  const chain = fixture(), source = path.join(root, 'chain.json');
  const bytes = JSON.stringify({ chain, blockCount: 2 }); await fs.writeFile(source, bytes);
  const proposal = await proposeCheckpoint({ snapshotPath: source, trustedGenesisHash: chain[0].hash });
  assert.equal(proposal.enabled, false); assert.equal(proposal.activationHeight, null);
  assert.equal(proposal.blockCount, 2); assert.equal(proposal.contentDigest, prefixContentDigest(chain));
  assert.equal(proposal.sourceSHA256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(await fs.readFile(source, 'utf8'), bytes); assert.deepEqual(await fs.readdir(root), ['chain.json']);
  let output = ''; await runCheckpointCLI(['--snapshot', source, '--trusted-genesis', chain[0].hash], { write: text => { output += text; } });
  assert.deepEqual(JSON.parse(output), proposal);
}));
test('explicit trusted genesis, block count, height and header links are mandatory', () => temp(async root => {
  const chain = fixture(), source = path.join(root, 'chain.json');
  async function check(data, reason, trustedGenesisHash = chain[0].hash) {
    await fs.writeFile(source, JSON.stringify(data));
    await assert.rejects(proposeCheckpoint({ snapshotPath: source, trustedGenesisHash }), reason);
  }
  await check({ chain }, /explicit_trusted_genesis/, null);
  await check({ chain }, /trusted_genesis_mismatch/, 'f'.repeat(64));
  await check({ chain, height: 1 }, /count_mismatch/);
  const badHeight = structuredClone(chain); badHeight[1].height = 99; await check({ chain: badHeight }, /shape_or_height/);
  const badLink = structuredClone(chain); badLink[1].header.prevHash = 'c'.repeat(64); badLink[1].hash = computeBlockHash(badLink[1].header); await check({ chain: badLink }, /header_link/);
  const badHash = structuredClone(chain); badHash[1].hash = 'd'.repeat(64); await check({ chain: badHash }, /header_hash/);
}));
test('same header hashes cannot conceal transaction content changes in proposed digest', () => temp(async root => {
  const chain = fixture(), source = path.join(root, 'chain.json');
  await fs.writeFile(source, JSON.stringify({ blocks: chain, height: 2 }));
  const first = await proposeCheckpoint({ snapshotPath: source, trustedGenesisHash: chain[0].hash });
  chain[0].txs[0].to = 'AGT' + 'c'.repeat(40);
  await fs.writeFile(source, JSON.stringify({ blocks: chain, height: 2 }));
  const second = await proposeCheckpoint({ snapshotPath: source, trustedGenesisHash: chain[0].hash });
  assert.equal(first.tipHash, second.tipHash); assert.notEqual(first.contentDigest, second.contentDigest); assert.notEqual(first.sourceSHA256, second.sourceSHA256);
  // Tool proposes evidence; only comparison to a separately trusted full-content
  // digest can reject this legacy content mutation. It never calls it authentic.
  assert.match(second.assurance, /NOT certified/);
}));
test('reject symlinks, directories, oversized snapshots and invalid input', () => temp(async root => {
  const source = path.join(root, 'chain.json'), chain = fixture();
  const opts = { snapshotPath: source, trustedGenesisHash: chain[0].hash };
  await fs.writeFile(source, JSON.stringify({ chain }));
  const link = path.join(root, 'link.json');
  try { await fs.symlink(source, link); await assert.rejects(proposeCheckpoint({ ...opts, snapshotPath: link }), /regular_nonsymlink/); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  await assert.rejects(proposeCheckpoint({ ...opts, snapshotPath: root }), /regular_nonsymlink/);
  const handle = await fs.open(source, 'w'); await handle.truncate(MAX_SNAPSHOT_BYTES + 1); await handle.close();
  await assert.rejects(proposeCheckpoint(opts), /size_limit/);
  for (const value of ['', '{', JSON.stringify({ chain: [], blocks: [] }), JSON.stringify({ chain: [] })]) {
    await fs.writeFile(source, value); await assert.rejects(proposeCheckpoint(opts));
  }
  await assert.rejects(runCheckpointCLI(['--activate', 'true']), /usage/);
  await assert.rejects(runCheckpointCLI(['--snapshot', source, '--snapshot', source]), /usage/);
}));
