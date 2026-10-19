import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PaymentIntentJournal, inspectPaymentPlan } from '../payment-intent.mjs';
import { createWallet, signTransaction, txDigest, computeBlockHash, merkleRoot } from '../core.mjs';
function block(prevHash, txs = [], nonce = 0) {
  const header = { version: 1, prevHash, merkleRoot: merkleRoot(txs), timestamp: 123, difficultyBits: 8, nonce, chainId: 'AGENTCOIN' };
  return { header, hash: computeBlockHash(header), txs };
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agt-payment-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sender = createWallet(), recipient = createWallet();
  const tx = { from: sender.address, to: recipient.address, amount: 10, nonce: 1, ts: 123, memo: 'accepted work', fromPub: sender.pub };
  tx.signature = signTransaction(tx, sender.privKey); tx.txid = txDigest(tx);
  const input = { taskRef: 'issue:1/task:7', sender: sender.address, recipient: recipient.address, amount: '10.00', evidence: { accepted: true, ref: 'commit:' + 'a'.repeat(40), sha256: 'b'.repeat(64) } };
  const genesis = block('0'.repeat(64));
  const file = path.join(dir, 'journal.json');
  let clock = 100000;
  const journal = new PaymentIntentJournal({ file, genesisHash: genesis.hash, now: () => clock });
  const observe = (txs = [], mempool = [], nonce = 1) => {
    const tip = block(genesis.hash, txs, nonce);
    return { complete: true, observedAt: ++clock, anchor: { genesisHash: genesis.hash, tipHash: tip.hash, height: 1 }, chain: [genesis, tip], mempool };
  };
  return { journal, file, input, tx, observe, advance: (ms = 1) => { clock += ms; } };
}
test('stable exact-decimal intent, immutable terms and signed transaction binding', async t => {
  const f = await fixture(t), first = await f.journal.prepare(f.input, f.tx);
  assert.equal((await f.journal.prepare({ ...f.input, amount: '10' }, f.tx)).paymentId, first.paymentId);
  await assert.rejects(f.journal.prepare({ ...f.input, amount: '11' }, f.tx), /terms_conflict/);
  await assert.rejects(f.journal.prepare(f.input, { ...f.tx, nonce: 2 }), /signature_or_digest/);
  await assert.rejects(f.journal.prepare({ ...f.input, evidence: { ...f.input.evidence, accepted: false } }, f.tx), /evidence/);
  assert.equal((await f.journal.submit(f.input.taskRef, null, { dryRun: true })).dryRun, true);
  assert.equal((await f.journal.inspect(f.input.taskRef)).attempts, 0);
});
test('timeout/crash recovery never replaces signed tx, requires fresh complete observation', async t => {
  const f = await fixture(t); await f.journal.prepare(f.input, f.tx);
  await f.journal.reconcile(f.input.taskRef, f.observe());
  await assert.rejects(f.journal.submit(f.input.taskRef, async tx => { assert.deepEqual(tx, f.tx); throw Error('timeout after send'); }, { dryRun: false }), /submission_unknown/);
  assert.equal((await f.journal.inspect(f.input.taskRef)).state, 'unknown');
  await assert.rejects(f.journal.submit(f.input.taskRef, () => assert.fail(), { dryRun: false }), /reconcile_required/);
  const o = f.observe([], [], 2); await f.journal.reconcile(f.input.taskRef, o);
  const result = await f.journal.submit(f.input.taskRef, async tx => { assert.deepEqual(tx, f.tx); return { status: 201 }; }, { dryRun: false });
  assert.equal(result.record.state, 'submitted');
  await assert.rejects(f.journal.reconcile(f.input.taskRef, o), /stale_observation/);
  f.advance(); await f.journal.reconcile(f.input.taskRef, { ...o, observedAt: o.observedAt + 1 });
  await assert.rejects(f.journal.submit(f.input.taskRef, () => assert.fail(), { dryRun: false }), /reconcile_required/);
  await f.journal.reconcile(f.input.taskRef, f.observe([f.tx], [], 2));
  assert.equal((await f.journal.inspect(f.input.taskRef)).state, 'confirmed');
  await assert.rejects(f.journal.submit(f.input.taskRef, () => assert.fail(), { dryRun: false }), /already_confirmed/);
});
test('full tx comparison, anchored complete chain and nonce conflict fail closed', async t => {
  const f = await fixture(t); await f.journal.prepare(f.input, f.tx);
  await assert.rejects(f.journal.reconcile(f.input.taskRef, { ...f.observe(), complete: false }), /incomplete_observation/);
  await assert.rejects(f.journal.reconcile(f.input.taskRef, f.observe([{ ...f.tx, amount: 11 } ])), /txid_content_conflict/);
  await assert.rejects(f.journal.reconcile(f.input.taskRef, f.observe([], [{ ...f.tx, txid: 'c'.repeat(64) }])), /nonce_conflict/);
  const falseAnchor = f.observe(); falseAnchor.anchor.genesisHash = 'f'.repeat(64);
  await assert.rejects(f.journal.reconcile(f.input.taskRef, falseAnchor), /incomplete_observation/);
  const falseHash = f.observe(); falseHash.chain[1].header.nonce++;
  await assert.rejects(f.journal.reconcile(f.input.taskRef, falseHash), /unanchored_observation/);
});
test('corrupt journal and existing lock never initialize empty state', async t => {
  const f = await fixture(t); await f.journal.prepare(f.input, f.tx);
  await fs.writeFile(f.file, '{broken');
  await assert.rejects(f.journal.inspect(f.input.taskRef), /corrupt_journal/);
  await fs.writeFile(f.file + '.lock', 'crashed process');
  await assert.rejects(f.journal.inspect(f.input.taskRef), /locked_manual_recovery/);
});
test('exact tx and ambiguous state persisted before callback; concurrent submits excluded', async t => {
  const f = await fixture(t); await f.journal.prepare(f.input, f.tx);
  let release; const gate = new Promise(r => { release = r; }); let entered; const started = new Promise(r => { entered = r; });
  await f.journal.reconcile(f.input.taskRef, f.observe());
  const first = f.journal.submit(f.input.taskRef, async () => {
    const disk = JSON.parse(await fs.readFile(f.file, 'utf8')).data.records;
    assert.deepEqual(Object.values(disk)[0].transaction, f.tx);
    assert.equal(Object.values(disk)[0].state, 'unknown'); entered(); await gate; return { status: 201 };
  }, { dryRun: false });
  await started;
  await assert.rejects(f.journal.submit(f.input.taskRef, () => assert.fail(), { dryRun: false }), /locked_manual_recovery/);
  release(); await first;
  assert.equal((await f.journal.inspect(f.input.taskRef)).state, 'submitted');
});
test('nine decimal units supported without rounding fractional units', async t => {
  const f = await fixture(t), sender = createWallet();
  const tx = { ...f.tx, from: sender.address, fromPub: sender.pub, amount: 0.000000001 };
  tx.signature = signTransaction(tx, sender.privKey); tx.txid = txDigest(tx);
  const input = { ...f.input, sender: sender.address, amount: '0.000000001' };
  assert.equal((await f.journal.prepare(input, tx)).terms.amount, '0.000000001');
  const altered = { ...tx, amount: 0.0000000011 };
  altered.signature = signTransaction(altered, sender.privKey); altered.txid = txDigest(altered);
  await assert.rejects(f.journal.prepare(input, altered), /transaction_terms/);
});
test('default is dry-run; first send needs current complete absence observation', async t => {
  const f = await fixture(t); await f.journal.prepare(f.input, f.tx);
  const dry = await f.journal.submit(f.input.taskRef, () => assert.fail());
  assert.equal(dry.dryRun, true);
  await assert.rejects(f.journal.submit(f.input.taskRef, () => assert.fail(), { dryRun: false }), /reconcile_required/);
  const o = f.observe();
  await assert.rejects(f.journal.reconcile(f.input.taskRef, { ...o, irrelevant: 1 }), /observation_fields/);
  await f.journal.reconcile(f.input.taskRef, o); f.advance(30001);
  await assert.rejects(f.journal.submit(f.input.taskRef, () => assert.fail(), { dryRun: false }), /reconcile_required/);
  await assert.rejects(f.journal.reconcile(f.input.taskRef, o), /stale_observation/);
});
test('confirmation stores exact inclusion block height/hash/txid', async t => {
  const f = await fixture(t); await f.journal.prepare(f.input, f.tx);
  const o = f.observe([f.tx]); const r = await f.journal.reconcile(f.input.taskRef, o);
  assert.deepEqual(r.confirmation, { blockHeight: 1, blockHash: o.chain[1].hash, txid: f.tx.txid });
});
test('directory open EPERM is documented unsupported durability; other I/O errors fail closed', async t => {
  const f = await fixture(t), original = fs.open.bind(fs); let mode = 'EPERM';
  t.mock.method(fs, 'open', async (name, ...args) => {
    if (name === path.dirname(f.file)) { const e = new Error(mode); e.code = mode; throw e; }
    return original(name, ...args);
  });
  await f.journal.prepare(f.input, f.tx);
  mode = 'EIO';
  await assert.rejects(f.journal.reconcile(f.input.taskRef, f.observe()), /EIO/);
});

test('pure inspection normalizes nine decimals and rejects invalid signatures without journal files', async t => {
  const f = await fixture(t), sender = createWallet();
  const tx = { ...f.tx, from: sender.address, fromPub: sender.pub, amount: 0.000000001 };
  tx.signature = signTransaction(tx, sender.privKey); tx.txid = txDigest(tx);
  const input = { ...f.input, sender: sender.address, amount: '0.000000001' };
  assert.equal(inspectPaymentPlan(input, tx).terms.amount, '0.000000001');
  assert.equal(inspectPaymentPlan(f.input, f.tx).paymentId, inspectPaymentPlan({ ...f.input, amount: '10.000000000' }, f.tx).paymentId);
  assert.throws(() => inspectPaymentPlan(input, { ...tx, signature: '0'.repeat(128) }), /signature_or_digest/);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});
test('journal rejects symlink ancestors and non-private parent', async t => {
  const f = await fixture(t), dir = path.dirname(f.file);
  const outside = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agt-journal-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const alias = path.join(dir, 'alias');
  try { await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM' && process.platform === 'win32') return t.skip('Windows account cannot create directory symlink'); throw e; }
  const j = new PaymentIntentJournal({ file: path.join(alias, 'nested', 'journal.json'), genesisHash: f.observe().anchor.genesisHash });
  await assert.rejects(j.prepare(f.input, f.tx), /unsafe_parent/);
  await assert.rejects(fs.stat(path.join(outside, 'nested')), { code: 'ENOENT' });
  if (process.platform !== 'win32') {
    await fs.chmod(dir, 0o755);
    await assert.rejects(f.journal.prepare(f.input, f.tx), /parent_not_private_owned/);
    await fs.chmod(dir, 0o700);
  }
});
