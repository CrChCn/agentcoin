// Synthetic future-protocol tests: no RPC, files, production keys or activation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import * as core from '../core.mjs';
import { treasuryState } from '../treasury.mjs';
import { createConsensusV2, transactionId, prefixContentDigest } from '../consensus-v2.mjs';
const A = 'AGT' + 'a'.repeat(40), B = 'AGT' + 'b'.repeat(40), T = 1792339200;
const keys = generateKeyPairSync('ed25519');
const pub = keys.publicKey.export({ type: 'spki', format: 'pem' });
const wallet = core.addressFromPub(pub);
const prefix = [{ height: 0, hash: '1'.repeat(64), header: { timestamp: T - 60, difficultyBits: 8 }, txs: [{ from: 'COINBASE', to: wallet, amount: 100, nonce: 0, ts: T - 60, memo: 'synthetic' }] }];
const primitives = { ...core, chainId: core.CHAIN_ID, treasuryPolicy: chain => treasuryState(chain).policy };
const policy = { activationHeight: 1, legacyCheckpoint: { blockCount: 1, contentDigest: prefixContentDigest(prefix) }, allowPartialEscrowSettlements: false };
const validator = createConsensusV2(primitives, policy);
const id = tx => ({ ...tx, txid: transactionId(tx) });
const cb = (changes = {}, height = 1) => id({ from: 'COINBASE', to: A, amount: core.blockReward(height), nonce: height, ts: T + height, memo: 'block ' + height, ...changes });
function payment(amount, nonce, changes = {}) {
  const tx = { from: wallet, to: B, amount, nonce, ts: T, memo: 'test', fromPub: pub, ...changes };
  tx.signature = core.signTransaction(tx, keys.privateKey);
  return id(tx);
}
function solve(txs, chain = prefix, changes = {}) {
  const header = { version: 2, chainId: core.CHAIN_ID, prevHash: chain.at(-1).hash, timestamp: T + chain.length, difficultyBits: core.expectedDifficultyBits(chain), nonce: 0, merkleRoot: core.merkleRoot(txs), ...changes };
  while (!core.hashMeetsDifficulty(core.computeBlockHash(header), header.difficultyBits)) { if (++header.nonce > 1000000) throw Error('fixture_pow_limit'); }
  return { height: chain.length, header, hash: core.computeBlockHash(header), txs };
}
function reject(block, pattern, chain = prefix, v = validator) { const r = v.validateBlock(block, chain); assert.equal(r.ok, false); assert.match(r.reason, pattern); }
test('valid future block; canonical ID includes authorization fields and ignores property order', () => {
  assert.deepEqual(validator.validateBlock(solve([cb(), payment(1, 1)]), prefix), { ok: true, reason: null });
  const t = payment(1, 1); assert.equal(transactionId(Object.fromEntries(Object.entries(t).reverse())), t.txid);
  for (const field of ['signature', 'fromPub', 'sig2', 'escProof']) assert.notEqual(transactionId({ ...t, [field]: 'changed' }), t.txid);
});
test('seven historical regression vectors are rejected', () => {
  reject(solve([cb(), cb({ to: B, amount: 500000000, nonce: 99 })]), /coinbase/);
  reject(solve([cb(), id({ from: 'AGENT_REWARD_POOL', to: B, amount: 1, nonce: 4, ts: T, memo: '' })]), /reserved/);
  const baseline = solve([cb()]);
  reject({ ...baseline, txs: [{ ...baseline.txs[0], to: B }] }, /transaction_id/);
  reject({ ...baseline, txs: [{ ...baseline.txs[0], amount: 1 }] }, /transaction_id/);
  reject(solve([cb({ to: 'undefined' })]), /recipient/);
  const missing = cb(); delete missing.to; missing.txid = transactionId(missing); reject(solve([missing]), /recipient/);
  reject(solve([cb()], prefix, { chainId: 'WRONG' }), /chain_id/);
});
test('aggregate sequential overspend and nonce replay fail', () => {
  reject(solve([cb(), payment(60, 1), payment(60, 2)]), /overspend/);
  reject(solve([cb(), payment(1, 1), payment(2, 1)]), /nonce_replay/);
  const first = solve([cb(), payment(1, 1)]); const chain = [...prefix, first];
  reject(solve([cb({}, 2), payment(1, 1)], chain), /transaction_id_or_replay/, chain);
  reject(solve([cb({}, 2), payment(2, 1)], chain), /nonce_replay/, chain);
});
test('signature, scheduled reward, precision and header validation fail closed', () => {
  reject(solve([cb({ amount: 49 })]), /scheduled_coinbase/);
  reject(solve([cb(), payment(0.0000000001, 1)]), /magenta/);
  reject(solve([cb(), id({ ...payment(1, 1), signature: '00' })]), /signature/);
  const b = solve([cb()]); reject({ ...b, header: { ...b.header, nonce: NaN } }, /header/);
  reject(solve([cb()], prefix, { version: 1 }), /version/);
});
test('full-content checkpoint prevents mutation under unchanged historical block hash', () => {
  const changed = structuredClone(prefix); changed[0].txs[0].to = B;
  reject(solve([cb()], changed), /checkpoint/, changed);
  const wrong = createConsensusV2(primitives, { ...policy, legacyCheckpoint: { blockCount: 1, contentDigest: prefix[0].hash } });
  reject(solve([cb()]), /checkpoint/, prefix, wrong);
});
test('future prefix is revalidated, not trusted by tip hash', () => {
  const first = solve([cb(), payment(1, 1)]); const chain = [...prefix, first];
  const next = solve([cb({}, 2)], chain);
  chain[1] = { ...first, txs: [{ ...first.txs[0], to: B }, first.txs[1]] };
  reject(next, /transaction_id/, chain);
});
test('legacy tiny decimal residual is preserved, not rounded away', () => {
  const old = structuredClone(prefix); old[0].txs.push({ from: 'COINBASE', to: B, amount: 1.823e-16, nonce: 9, ts: T - 60, memo: '' });
  const v = createConsensusV2(primitives, { ...policy, legacyCheckpoint: { blockCount: 1, contentDigest: prefixContentDigest(old) } });
  assert.equal(v.validateBlock(solve([cb()], old), old).ok, true);
});
test('configuration is explicit; no environment activation', () => {
  assert.throws(() => createConsensusV2(primitives, {}), /explicit_activation/);
  assert.throws(() => createConsensusV2(primitives, { ...policy, allowPartialEscrowSettlements: undefined }), /explicit_activation/);
});
test('escrow authorization uses earlier current-block transactions and rejects replayed receipts', async () => {
  const { sign } = await import('node:crypto');
  const worker = generateKeyPairSync('ed25519');
  const workerPub = worker.publicKey.export({ type: 'spki', format: 'pem' });
  const workerAddress = core.addressFromPub(workerPub), escId = 'abc123def456', escrow = 'ESCROW_' + escId;
  const taskHash = 'c'.repeat(32);
  const open = payment(10, 10, { to: escrow, memo: `escrow:${escId}:${taskHash}:${T + 1000}:${workerAddress}` });
  const proof = {
    taskHash, workerPub,
    workerReceipt: sign(null, Buffer.from(core.escrowReceiptDigest(escId, taskHash, workerAddress, 3), 'hex'), worker.privateKey).toString('hex'),
    employerConfirm: sign(null, Buffer.from(core.escrowConfirmDigest(escId, taskHash, workerAddress, 3), 'hex'), keys.privateKey).toString('hex'),
  };
  const payout = nonce => id({ from: escrow, to: workerAddress, amount: 3, nonce, ts: T, memo: 'escpayout:' + escId, escProof: proof });
  assert.equal(validator.validateBlock(solve([cb(), open, payout(1)]), prefix).ok, true);
  const throwing = createConsensusV2({ ...primitives, verifyEscrowTx: () => { throw Error('synthetic_escrow_callback_failure'); } }, policy);
  reject(solve([cb(), open, payout(1)]), /synthetic_escrow_callback_failure/, prefix, throwing);
  reject(solve([cb(), payout(1), open]), /overspend/);
  reject(solve([cb(), open, payout(1), payout(2)]), /already_settled/);
  const partial = createConsensusV2(primitives, { ...policy, allowPartialEscrowSettlements: true });
  reject(solve([cb(), open, payout(1), payout(2)]), /proof_replay/, prefix, partial);
  const encoded = payout(2); encoded.escProof = { ...proof, workerPub: proof.workerPub + '\n', workerReceipt: proof.workerReceipt.toUpperCase() }; encoded.txid = transactionId(encoded);
  reject(solve([cb(), open, payout(1), encoded]), /proof_replay/, prefix, partial);
  const refill = payment(1, 11, { to: escrow });
  reject(solve([cb(), open, payout(1), refill]), /reopening/);
  const settled = solve([cb(), open, payout(1)]);
  const settledChain = [...prefix, settled];
  reject(solve([cb({}, 2), refill], settledChain), /reopening/, settledChain);
  const broken = payout(1); broken.escProof = { ...proof, workerReceipt: '00' }; broken.txid = transactionId(broken);
  reject(solve([cb(), open, broken]), /escrow_authorization/);
});

test('unchanged ordinary transaction IDs reject changed auth fields', () => {
  const original = payment(1, 1), block = solve([cb(), original]);
  for (const [field, value] of [['signature', '00'], ['fromPub', pub + '\n']]) {
    reject({ ...block, txs: [block.txs[0], { ...original, [field]: value }] }, /transaction_id/);
  }
});
test('ordinary funding and spend use actual signatures and transaction order', () => {
  const second = generateKeyPairSync('ed25519');
  const secondPub = second.publicKey.export({ type: 'spki', format: 'pem' });
  const secondAddress = core.addressFromPub(secondPub);
  const funding = payment(10, 101, { to: secondAddress });
  const spend = { from: secondAddress, to: B, amount: 10, nonce: 1, ts: T, memo: 'fund-and-spend', fromPub: secondPub };
  spend.signature = core.signTransaction(spend, second.privateKey);
  const signed = id(spend);
  assert.equal(core.verifyTransaction(funding), true);
  assert.equal(core.verifyTransaction(signed), true);
  assert.equal(validator.validateBlock(solve([cb(), funding, signed]), prefix).ok, true);
  reject(solve([cb(), signed, funding]), /overspend/);
  const extra = payment(91, 102);
  assert.equal(core.verifyTransaction(extra), true);
  reject(solve([cb(), funding, extra]), /overspend/);
});
test('explicit version and strictly increasing timestamp boundaries', () => {
  const previousTime = prefix.at(-1).header.timestamp;
  for (const timestamp of [previousTime - 1, previousTime]) reject(solve([cb({ ts: timestamp })], prefix, { timestamp }), /previous_block_or_time/);
  const timestamp = previousTime + 1;
  assert.equal(validator.validateBlock(solve([cb({ ts: timestamp })], prefix, { timestamp }), prefix).ok, true);
  for (const version of [0, 1, 3, '2']) reject(solve([cb()], prefix, { version }), /version/);
  // Deliberately no wall-clock limit: deterministic validator cannot consult Date.now().
  const distant = T + 1000000000;
  assert.equal(validator.validateBlock(solve([cb({ ts: distant })], prefix, { timestamp: distant }), prefix).ok, true);
});
test('callback exceptions fail closed rather than accepting a block', () => {
  for (const name of ['blockReward', 'computeBlockHash', 'hashMeetsDifficulty', 'expectedDifficultyBits', 'merkleRoot', 'verifyTransaction', 'verifySecondSig', 'treasuryPolicy']) {
    const v = createConsensusV2({ ...primitives, [name]: () => { throw Error('synthetic_callback_failure:' + name); } }, policy);
    reject(solve([cb(), payment(1, 1)]), /synthetic_callback_failure/, prefix, v);
  }
});
test('transaction serialization rejects non-JSON shapes and numbers', () => {
  const tx = payment(1, 1);
  for (const invalid of [[], Object.assign([], tx), Object.assign(Object.create(null), tx), Object.assign(Object.create({ evil: true }), tx)]) assert.throws(() => transactionId(invalid), /plain_object/);
  for (const value of [NaN, Infinity, -Infinity, -0, undefined, 1n, Symbol('x')]) assert.throws(() => transactionId({ ...tx, extra: value }), /noncanonical_json/);
  const accessor = { ...tx }; Object.defineProperty(accessor, 'extra', { enumerable: true, get() { throw Error('getter_must_not_run'); } });
  assert.throws(() => transactionId(accessor), /plain_object/);
  const sparse = Array(1); assert.throws(() => transactionId({ ...tx, extra: sparse }), /noncanonical_json/);
  const enrichedArray = []; enrichedArray.extra = 1; assert.throws(() => transactionId({ ...tx, extra: enrichedArray }), /noncanonical_json/);
});
test('policy and checkpoint reject unknown fields and non-plain shapes', () => {
  for (const bad of [
    { ...policy, unexpected: true },
    { ...policy, legacyCheckpoint: { ...policy.legacyCheckpoint, tipHash: prefix[0].hash } },
    Object.assign(Object.create({}), policy),
    { ...policy, legacyCheckpoint: Object.assign([], policy.legacyCheckpoint) },
  ]) assert.throws(() => createConsensusV2(primitives, bad), /explicit_activation/);
});

test('unsupported off-grid halving reward is an explicit activation blocker, never rounded', () => {
  assert.equal(core.blockReward(2310000), 0.0244140625);
  const v = createConsensusV2({ ...primitives, blockReward: () => core.blockReward(2310000) }, policy);
  reject(solve([cb({ amount: core.blockReward(2310000) })]), /amount_not_magenta_aligned/, prefix, v);
  const zeroReward = createConsensusV2({ ...primitives, blockReward: () => 0 }, policy);
  reject(solve([cb({ amount: 0 })]), /amount_not_magenta_aligned/, prefix, zeroReward);
});
test('maximum safe timestamp is an explicit terminal-chain activation blocker', () => {
  const terminal = solve([cb({ ts: Number.MAX_SAFE_INTEGER })], prefix, { timestamp: Number.MAX_SAFE_INTEGER });
  assert.equal(validator.validateBlock(terminal, prefix).ok, true);
  const chain = [...prefix, terminal];
  // Candidate currently accepts the terminal timestamp, leaving no possible
  // strictly greater safe-integer timestamp. This test records an OPEN defect.
  reject(solve([cb({ ts: Number.MAX_SAFE_INTEGER }, 2)], chain, { timestamp: Number.MAX_SAFE_INTEGER }), /previous_block_or_time/, chain);
});
