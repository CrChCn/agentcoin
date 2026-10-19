import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPaymentCLI, paymentOrigin } from '../tools/payment-intents.mjs';
import { runGrantCLI, checkGrantLedger } from '../node-grants.mjs';
import { createWallet, signTransaction, txDigest, merkleRoot, computeBlockHash } from '../core.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agt-cli-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sender = createWallet(), recipient = createWallet();
  const tx = { from: sender.address, to: recipient.address, fromPub: sender.pub, amount: 10, nonce: 1, ts: 123, memo: 'audit accepted' };
  tx.txid = txDigest(tx); tx.signature = signTransaction(tx, sender.privKey);
  const intent = { taskRef: 'task:cli', sender: sender.address, recipient: recipient.address, amount: '10', evidence: { accepted: true, ref: 'commit:' + 'a'.repeat(40), sha256: 'b'.repeat(64) } };
  function block(prevHash, nonce) { const header = { version: 1, prevHash, merkleRoot: merkleRoot([]), timestamp: 123, difficultyBits: 8, nonce, chainId: 'AGENTCOIN' }; return { header, hash: computeBlockHash(header), txs: [] }; }
  const genesis = block('0'.repeat(64), 0), tip = block(genesis.hash, 1);
  const observation = { complete: true, observedAt: 1000, anchor: { genesisHash: genesis.hash, tipHash: tip.hash, height: 1 }, chain: [genesis, tip], mempool: [] };
  for (const [name, content] of Object.entries({ intent, tx, observation })) await fs.writeFile(path.join(dir, name + '.json'), JSON.stringify(content));
  const base = ['--journal', path.join(dir, 'journal.json'), '--genesis', genesis.hash];
  const deps = { now: () => 1000, fetchFn: () => assert.fail('network unexpectedly used') };
  await runPaymentCLI(['prepare', ...base, '--intent', path.join(dir, 'intent.json'), '--tx', path.join(dir, 'tx.json')], deps);
  return { dir, base, deps, tx, intent, observation };
}
test('CLI dry-run, deliberate broadcast sends exact saved tx and marks HTTP201 pending', async t => {
  const f = await setup(t), args = ['submit', ...f.base, '--task', f.intent.taskRef];
  assert.equal((await runPaymentCLI(args, f.deps)).dryRun, true);
  await assert.rejects(runPaymentCLI([...args, '--broadcast', '--origin', 'https://example.org'], f.deps), /reconcile_required/);
  await runPaymentCLI(['reconcile', ...f.base, '--task', f.intent.taskRef, '--observation', path.join(f.dir, 'observation.json')], f.deps);
  let calls = 0;
  const result = await runPaymentCLI([...args, '--broadcast', '--origin', 'https://example.org'], { ...f.deps, fetchFn: async (url, options) => {
    calls++; assert.equal(url, 'https://example.org/tx'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.ok(options.signal instanceof AbortSignal); assert.deepEqual(options.headers, { 'content-type': 'application/json' }); assert.deepEqual(JSON.parse(options.body), f.tx); return { status: 201 };
  } });
  assert.equal(calls, 1); assert.equal(result.record.state, 'submitted'); assert.equal(result.response.confirmation, false);
});
test('transport timeout persists unknown and disallows blind resubmit', async t => {
  const f = await setup(t);
  await runPaymentCLI(['reconcile', ...f.base, '--task', f.intent.taskRef, '--observation', path.join(f.dir, 'observation.json')], f.deps);
  const args = ['submit', ...f.base, '--task', f.intent.taskRef, '--origin', 'http://127.0.0.1:9335', '--broadcast'];
  await assert.rejects(runPaymentCLI(args, { ...f.deps, fetchFn: async () => { throw Error('timeout'); } }), /submission_unknown/);
  assert.equal((await runPaymentCLI(['inspect', ...f.base, '--task', f.intent.taskRef], f.deps)).state, 'unknown');
  await assert.rejects(runPaymentCLI(args, f.deps), /reconcile_required/);
});
test('origins, private material and flags fail closed', async t => {
  for (const value of ['http://example.org', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org?token=x', 'https://example.org#x']) assert.throws(() => paymentOrigin(value), /origin/);
  assert.equal(paymentOrigin('http://[::1]:9335'), 'http://[::1]:9335');
  const f = await setup(t);
  await fs.writeFile(path.join(f.dir, 'tx.json'), JSON.stringify({ ...f.tx, privKey: 'DO NOT SAVE' }));
  await assert.rejects(runPaymentCLI(['plan', '--intent', path.join(f.dir, 'intent.json'), '--tx', path.join(f.dir, 'tx.json')], f.deps), /private_material_forbidden/);
  await assert.rejects(runPaymentCLI(['plan', '--broadcast'], f.deps), /broadcast_submit_only/);
});
test('legacy payout invocations refuse before wallet reads or network; ledger checks stay read-only', async t => {
  const f = await setup(t);
  for (const [script, args] of [['commission-payout.mjs', ['http://127.0.0.1:1']], ['node-grants.mjs', ['grant', f.tx.to, 'peer']]]) {
    const r = spawnSync(process.execPath, [path.join(repo, script), ...args], { encoding: 'utf8', cwd: f.dir });
    assert.equal(r.status, 1); assert.match(r.stderr, /implicit.*disabled/); assert.doesNotMatch(r.stderr, /ENOENT|ECONNREFUSED/);
  }
  const ledger = path.join(f.dir, 'legacy.json');
  assert.equal((await checkGrantLedger(ledger)).status, 'missing_unverified');
  await assert.rejects(fs.stat(ledger), { code: 'ENOENT' });
  await fs.writeFile(ledger, '{broken');
  await assert.rejects(runGrantCLI(['check-ledger', '--ledger', ledger]), SyntaxError);
  const data = { grants: { [f.tx.to]: { peerRef: 'peer', totalPaid: 10, lastPaidAt: 1000, lastTxid: f.tx.txid.slice(0, 16) } } };
  await fs.writeFile(ledger, JSON.stringify(data));
  const before = await fs.readFile(ledger, 'utf8');
  assert.equal((await runGrantCLI(['check-ledger', '--ledger', ledger])).grants[0].confirmation, 'unverified_legacy_record');
  assert.equal(await fs.readFile(ledger, 'utf8'), before);
});
