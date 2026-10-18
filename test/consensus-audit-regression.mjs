#!/usr/bin/env node
// Intentional negative security audit: exit 1 means a vulnerability remains.
// This is not included in CI until the corresponding consensus rules are fixed.
// Run: node test/consensus-audit-regression.mjs [--json]
// All inputs are synthetic and deterministic. No RPC, keys, signatures, node
// processes, persistent Blockchain instance, or production data are used.
import assert from 'node:assert/strict';
import {
  CHAIN_ID, blockReward, computeBlockHash, expectedDifficultyBits,
  hashMeetsDifficulty, merkleRoot, txDigest, validateBlockAgainstChain,
} from '../core.mjs';

const TIMESTAMP = 1_792_339_200;
const DIFFICULTY = 8;
const RECIPIENT_A = 'AGT' + 'a'.repeat(40);
const RECIPIENT_B = 'AGT' + 'b'.repeat(40);
// This test targets validation of a new block against a supplied prefix; it
// does not claim that this synthetic prefix is the production genesis.
const chain = [
  { height: 0, hash: '1'.repeat(64), header: { difficultyBits: DIFFICULTY, timestamp: TIMESTAMP - 60 }, txs: [] },
  { height: 1, hash: '2'.repeat(64), header: { difficultyBits: DIFFICULTY, timestamp: TIMESTAMP - 30 }, txs: [] },
];
assert.equal(expectedDifficultyBits(chain), DIFFICULTY);

function identified(fields) { return { ...fields, txid: txDigest(fields) }; }
function coinbase(to = RECIPIENT_A, amount = blockReward(chain.length), nonce = chain.length) {
  return identified({ from: 'COINBASE', to, amount, nonce, ts: TIMESTAMP, memo: `block ${chain.length}` });
}
function solvedBlock(txs, changes = {}) {
  const header = { version: 1, prevHash: chain.at(-1).hash,
    merkleRoot: merkleRoot(txs), timestamp: TIMESTAMP,
    difficultyBits: DIFFICULTY, nonce: 0, chainId: CHAIN_ID, ...changes };
  // Bounded, deterministic, in-memory fixture PoW only (8 bits).
  while (!hashMeetsDifficulty(computeBlockHash(header), DIFFICULTY)) {
    if (++header.nonce > 1_000_000) throw new Error('synthetic_fixture_pow_limit');
  }
  return { height: chain.length, hash: computeBlockHash(header), header, txs };
}
const baseline = solvedBlock([coinbase()]);
assert.equal(validateBlockAgainstChain(baseline, chain), null, 'synthetic baseline must be accepted');

const cases = [
  {
    id: 'CONS-01-extra-coinbase',
    expectation: 'Reject more than one coinbase and aggregate issuance above the scheduled reward.',
    block: solvedBlock([coinbase(), coinbase(RECIPIENT_B, 500_000_000, 99)]),
  },
  {
    id: 'CONS-02-unsigned-reward-pool-spend',
    expectation: 'Reject an unsigned ordinary credit from a reserved reward-pool sender.',
    block: solvedBlock([coinbase(), identified({ from: 'AGENT_REWARD_POOL', to: RECIPIENT_B,
      amount: 1_000_000, nonce: 7, ts: TIMESTAMP, memo: 'synthetic unsigned credit' })]),
  },
  {
    id: 'CONS-03-recipient-not-committed',
    expectation: 'Reject a changed coinbase recipient under an unchanged transaction ID, merkle root and block hash.',
    block: { ...baseline, txs: [{ ...baseline.txs[0], to: RECIPIENT_B }] },
  },
  {
    id: 'CONS-04-amount-not-committed',
    expectation: 'Reject a changed coinbase amount under an unchanged transaction ID, merkle root and block hash.',
    block: { ...baseline, txs: [{ ...baseline.txs[0], amount: 1 }] },
  },
  {
    id: 'CONS-05-malformed-reward-recipient',
    expectation: 'Reject the malformed reward recipient string "undefined".',
    block: solvedBlock([coinbase('undefined')]),
  },
  {
    id: 'CONS-06-missing-reward-recipient',
    expectation: 'Reject a coinbase with no recipient.',
    block: solvedBlock([identified({ from: 'COINBASE', amount: 50, nonce: 2,
      ts: TIMESTAMP, memo: 'synthetic missing recipient' })]),
  },
  {
    id: 'CONS-07-wrong-chain-id',
    expectation: 'Reject a header naming another chain.',
    block: solvedBlock([coinbase()], { chainId: 'SYNTHETIC_WRONG_CHAIN' }),
  },
];

const findings = cases.map(({ id, expectation, block }) => {
  assert.equal(block.header.difficultyBits, DIFFICULTY);
  assert.equal(computeBlockHash(block.header), block.hash);
  assert.ok(hashMeetsDifficulty(block.hash, DIFFICULTY));
  const rejection = validateBlockAgainstChain(block, chain);
  let securityAssertion;
  try {
    assert.equal(typeof rejection, 'string', `${id}: invalid block must be rejected`);
    securityAssertion = 'PASS';
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    securityAssertion = 'FAIL';
  }
  return { id, expectation, securityAssertion, vulnerable: securityAssertion === 'FAIL',
    actualRejection: rejection, blockHash: block.hash, nonce: block.header.nonce,
    coinbases: block.txs.filter(tx => tx.from === 'COINBASE').length,
    coinbaseAmount: block.txs.filter(tx => tx.from === 'COINBASE').reduce((sum, tx) => sum + tx.amount, 0) };
});
const vulnerableCount = findings.filter(item => item.vulnerable).length;
const result = { schemaVersion: 1, status: vulnerableCount ? 'VULNERABLE' : 'PASS',
  scope: 'Synthetic block-validator audit only; no assertion about production exploitation.',
  fixture: { difficultyBits: DIFFICULTY, height: chain.length, timestamp: TIMESTAMP,
    baselineAccepted: true, baselineBlockHash: baseline.hash },
  vulnerableCount, findings };
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log('Isolated consensus audit: no RPC, keys, signing, or persistent state.');
  for (const finding of findings) console.log(`${finding.vulnerable ? 'VULNERABLE' : 'PASS'} ${finding.id}: expected rejection; actual=${String(finding.actualRejection)}`);
  console.log(`${result.status}: ${vulnerableCount}/${findings.length} negative security assertions failed.`);
}
process.exitCode = vulnerableCount ? 1 : 0;
