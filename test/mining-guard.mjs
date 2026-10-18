import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHAIN_ID, blockReward, computeBlockHash, hashMeetsDifficulty, merkleRoot } from '../core.mjs';
import { isCanonicalMinerAddress, validateMiningTemplate } from '../mining-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINER = 'AGT' + 'a'.repeat(40);
const OTHER = 'AGT' + 'b'.repeat(40);
const CONTEXT = { miner: MINER, tipHash: '1'.repeat(64), height: 2 };
function fixture(height = CONTEXT.height) {
  const txs = [{ from: 'COINBASE', to: MINER, amount: blockReward(height), nonce: height,
    ts: 1_792_339_200, memo: `block ${height}`, txid: 'coinbase-1792339200000' }];
  return { height, tipPrevHash: CONTEXT.tipHash, txs,
    header: { version: 1, prevHash: CONTEXT.tipHash, merkleRoot: merkleRoot(txs),
      timestamp: 1_792_339_200, difficultyBits: 8, nonce: 0, chainId: CHAIN_ID } };
}
const clone = value => structuredClone(value);

test('canonical recipients reject historical typos, placeholders and coerced values', () => {
  assert.equal(isCanonicalMinerAddress(MINER), true);
  for (const address of [undefined, null, {}, 1, 'undefined', 'dummy-miner', 'AGT' + 'a'.repeat(39),
    'AGT' + 'a'.repeat(41), 'AGT' + 'A'.repeat(40), ' ' + MINER, MINER + '\n']) {
    assert.equal(isCanonicalMinerAddress(address), false, String(address));
  }
});

test('current time-label coinbase templates and scheduled halving rewards remain usable', () => {
  for (const height of [1, 2, 209_999, 210_000, 420_000]) {
    assert.deepEqual(validateMiningTemplate(fixture(height), { ...CONTEXT, height }), { ok: true });
  }
});

test('reject unsafe rewards, mismatched packages and malformed headers before PoW', () => {
  const cases = [
    ['template_coinbase_count', t => { t.txs = []; } , 'invalid_template_shape'],
    ['template_coinbase_count', t => { t.txs.push(clone(t.txs[0])); }],
    ['template_coinbase_count', t => { t.txs[0].from = MINER; }],
    ['template_reward_recipient_mismatch', t => { t.txs[0].to = OTHER; }],
    ['template_reward_recipient_mismatch', t => { t.txs[0].to = 'undefined'; }],
    ['template_reward_recipient_mismatch', t => { delete t.txs[0].to; }],
    ...[0, -1, 1, 51, NaN, Infinity, '50'].map(amount => ['template_reward_amount_mismatch', t => { t.txs[0].amount = amount; }]),
    ['template_reserved_sender', t => { t.txs.push({ from: 'AGENT_REWARD_POOL', to: MINER, amount: 1_000_000 }); }],
    ['template_prev_hash_mismatch', t => { t.header.prevHash = '2'.repeat(64); }],
    ['template_prev_hash_mismatch', t => { t.tipPrevHash = '2'.repeat(64); }],
    ['template_height_mismatch', t => { t.height++; }],
    ['template_height_mismatch', t => { delete t.height; }],
    ['template_chain_id_mismatch', t => { t.header.chainId = 'OTHER'; }],
    ['template_merkle_mismatch', t => { t.header.merkleRoot = '0'.repeat(64); }],
    ['template_merkle_mismatch', t => { t.txs[0].txid = 'another-id'; }],
    ['invalid_template_transaction', t => { t.txs.push(null); }],
    ...[0, 7, 21, 8.5, NaN, Infinity, '8'].map(bits => ['invalid_template_header', t => { t.header.difficultyBits = bits; }]),
    ['invalid_template_header', t => { t.header.timestamp = 0; }],
    ['invalid_template_header', t => { t.header.nonce = -1; }],
    ['invalid_template_header', t => { t.header.version = 2; }],
  ];
  for (const [reason, mutate, overrideReason] of cases) {
    const template = fixture(); mutate(template);
    assert.deepEqual(validateMiningTemplate(template, CONTEXT), { ok: false, reason: overrideReason || reason });
  }
  for (const template of [null, [], {}, { header: null, txs: [] }]) {
    assert.equal(validateMiningTemplate(template, CONTEXT).reason, 'invalid_template_shape');
  }
  assert.equal(validateMiningTemplate(fixture(), { ...CONTEXT, miner: 'undefined' }).reason, 'invalid_miner_address');
  assert.equal(validateMiningTemplate(fixture(), { ...CONTEXT, height: '2' }).reason, 'invalid_mining_context');
});

test('guard explicitly preserves the unresolved historical txid binding limitation', () => {
  // Ordinary transaction signatures, txid-to-content binding and historical
  // consensus are outside this preventive guard. Do not present it as their fix.
  const template = fixture();
  template.txs.push({ from: OTHER, to: MINER, amount: 1, txid: 'legacy-unbound-id' });
  template.header.merkleRoot = merkleRoot(template.txs);
  assert.deepEqual(validateMiningTemplate(template, CONTEXT), { ok: true });
  template.txs[1].amount = 2;
  assert.deepEqual(validateMiningTemplate(template, CONTEXT), { ok: true });
});

test('invalid configured recipient exits before creating miner state or requesting RPC', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-miner-invalid-'));
  try {
    const minerDir = path.join(dir, 'must-not-exist');
    const child = spawnSync(process.execPath, ['miner-client.mjs', 'http://127.0.0.1:1', 'dummy-miner'],
      { cwd: ROOT, env: { ...process.env, AGT_MINER_DATA: minerDir }, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /invalid_miner_address/);
    await assert.rejects(fs.stat(minerDir), { code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

async function clientFixture({ badRecipient }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-miner-rpc-fixture-'));
  let child, resolveOutcome, rejectOutcome, timer;
  const requests = [];
  const outcome = new Promise((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
  const server = http.createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://fixture').pathname;
      requests.push(route);
      let value;
      if (route === '/life') value = { blocks: CONTEXT.height, tipHash: CONTEXT.tipHash, fresh: true, tipAgeSec: 0 };
      else if (route === '/headers') value = { headers: [] };
      else if (route === '/blocktemplate') {
        value = fixture(); if (badRecipient) value.txs[0].to = OTHER;
      } else if (route === '/block/submit') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const submitted = JSON.parse(Buffer.concat(chunks).toString());
        if (badRecipient) throw new Error('client submitted a redirected-reward template');
        assert.equal(submitted.miner, MINER);
        assert.equal(submitted.txs[0].to, MINER);
        assert.equal(submitted.txs[0].amount, 50);
        assert.ok(hashMeetsDifficulty(computeBlockHash(submitted.header), 8));
        value = { accepted: true, height: CONTEXT.height, hash: computeBlockHash(submitted.header) };
        resolveOutcome('submitted');
      } else throw new Error(`unexpected fixture route: ${route}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(500); res.end('{}'); rejectOutcome(error); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    child = spawn(process.execPath, ['miner-client.mjs', url, MINER],
      { cwd: ROOT, env: { ...process.env, AGT_MINER_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (badRecipient && output.includes('template_reward_recipient_mismatch')) resolveOutcome('rejected');
    });
    child.on('error', rejectOutcome);
    child.on('exit', code => rejectOutcome(new Error(`fixture client exited early: ${code}`)));
    timer = setTimeout(() => rejectOutcome(new Error('fixture client timed out')), 8000);
    assert.equal(await outcome, badRecipient ? 'rejected' : 'submitted');
    assert.equal(requests.includes('/wallet/create'), false);
    assert.equal(requests.includes('/block/submit'), !badRecipient);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('thin miner rejects redirected rewards before its local PoW and submit flow', () => clientFixture({ badRecipient: true }));
test('thin miner preserves a legitimate isolated template and submit flow', () => clientFixture({ badRecipient: false }));
