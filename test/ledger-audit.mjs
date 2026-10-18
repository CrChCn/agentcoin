#!/usr/bin/env node
// Synthetic only: no production data, keys, node, wallet or network access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditSnapshot, auditSnapshotText, normalizeTimestamp, addressKind, categoryFor } from '../tools/ledger-audit.mjs';

const A = 'AGT' + 'a'.repeat(40), B = 'AGT' + 'b'.repeat(40);
const cb = (to, amount, extra = {}) => ({ from: 'COINBASE', to, amount, ts: 1792320000, nonce: 1, txid: 'coinbase-1', memo: 'block 1', ...extra });
const transfer = (from, to, amount, extra = {}) => ({ from, to, amount, ts: 1792320000, nonce: 2, txid: 'transfer-2', memo: 'payment', ...extra });
const block = (height, txs, extra = {}) => ({ height, timestamp: 1792320000000 + height * 30000, txs, ...extra });
const snapshot = txs => ({ chain: [block(0, [cb('AGT_GENESIS_TREASURY', 0, { txid: 'genesis', memo: 'genesis' })]), block(1, txs)] });
const audit = txs => auditSnapshotText(JSON.stringify(snapshot(txs)));

test('issuance and gross turnover are separate; exact decimal posting conserves supply', () => {
  const result = audit([cb(A, 50), transfer(A, B, 0.1), transfer(A, B, 0.2, { txid: 'transfer-3', nonce: 3 })]);
  assert.equal(result.accounting.issuance, '50');
  assert.equal(result.accounting.nonCoinbaseGrossTurnover, '0.3');
  assert.equal(result.accounting.sumBalances, '50');
  assert.equal(result.accounting.postingDifference, '0');
  assert.equal(result.balances.find(a => a.address === B).balance, '0.3');
  assert.equal(result.balances.find(a => a.address === A).balance, '49.7');
  assert.equal(result.accounting.scheduledIssuanceCeiling, '50');
  assert.deepEqual(result.categories.map(c => c.category), ['coinbase:block-memo', 'coinbase:other', 'other']);
});

test('JSON number lexeme precision survives unsafe Number parsing', () => {
  const json = JSON.stringify(snapshot([cb(A, 50)])).replace('"amount":50', '"amount":9007199254740993');
  const result = auditSnapshotText(json);
  assert.equal(result.provenance.exactJsonAmountLexemes, true);
  assert.equal(result.accounting.issuance, '9007199254740993');
  assert.equal(result.accounting.sumBalances, '9007199254740993');
  assert.equal(result.anomalyCounts.jsonNumberPrecisionLoss, 1);
  assert.equal(result.anomalyCounts.unsafeNumberMagentInteger, 1);
  assert.equal(result.anomalies.jsonNumberPrecisionLoss[0].parsedNumber, '9007199254740992');
});

test('sub-magent values are preserved and flagged, without rounding', () => {
  const result = audit([cb(A, 50), transfer(A, B, 1e-12)]);
  assert.equal(result.balances.find(a => a.address === B).balance, '0.000000000001');
  assert.equal(result.balances.find(a => a.address === A).balance, '49.999999999999');
  assert.equal(result.anomalyCounts.subMagentAmount, 1);
});

test('metadata and nonfinite/mistyped amounts are explicitly excluded', () => {
  const data = snapshot([cb(A, 50), { memo: 'metadata' }, transfer(A, B, '4'), transfer(A, B, Infinity, { nonce: 9, txid: 'nonfinite' })]);
  const result = auditSnapshot(data);
  assert.equal(result.summary.transactions, 5);
  assert.equal(result.summary.numericTransactions, 2);
  assert.equal(result.summary.excludedOrMalformedTransactions, 3);
  assert.equal(result.anomalyCounts.excludedAmount, 3);
  assert.equal(result.accounting.sumBalances, '50');
  assert.equal(result.provenance.exactJsonAmountLexemes, false);
});

test('duplicate IDs, economic digests, and sender nonces remain posted and disclosed', () => {
  const tx = transfer(A, B, 2);
  const result = audit([cb(A, 50), tx, { ...tx }, { ...tx, txid: 'another-id' }]);
  assert.equal(result.balances.find(a => a.address === B).balance, '6');
  assert.equal(result.accounting.issuance, '50');
  assert.equal(result.anomalyCounts.duplicateTxid, 1);
  assert.equal(result.anomalyCounts.duplicateTransactionDigest, 2);
  assert.equal(result.anomalyCounts.repeatedSenderNonce, 2);
});

test('multiple coinbase rewards are summed before comparing with the schedule', () => {
  const result = audit([cb(A, 50), cb(B, 50, { txid: 'second-coinbase' })]);
  assert.equal(result.accounting.issuance, '100');
  assert.equal(result.accounting.issuanceMinusSchedule, '50');
  assert.deepEqual(result.anomalies.coinbaseCount, [{ blockIndex: 1, count: 2 }]);
  assert.equal(result.anomalies.coinbaseRewardDifference[0].difference, '50');
});

test('repeated grant business references are distinguished from transaction replay', () => {
  const result = audit([cb(A, 50), transfer(A, B, 10, { memo: 'army:grant:agent-0001' }), transfer(A, B, 10, { memo: 'army:grant:agent-0001', nonce: 3, txid: 'distinct-grant' })]);
  assert.equal(result.anomalyCounts.repeatedGrantReference, 1);
  assert.equal(result.anomalyCounts.duplicateTransactionDigest, undefined);
  assert.equal(result.anomalyCounts.duplicateTxid, undefined);
  assert.equal(result.balances.find(a => a.address === B).balance, '20');
});

test('missing address legs are reconciled instead of inventing accounts', () => {
  const result = audit([cb(A, 50), transfer(null, B, 4), transfer(A, null, 2, { nonce: 3, txid: 'missing-recipient' }), cb(null, 1, { txid: 'unallocated' })]);
  assert.equal(result.accounting.issuance, '51');
  assert.equal(result.accounting.missingSenderCredits, '4');
  assert.equal(result.accounting.missingRecipientDebits, '2');
  assert.equal(result.accounting.unallocatedCoinbase, '1');
  assert.equal(result.accounting.expectedNetBalances, '52');
  assert.equal(result.accounting.sumBalances, '52');
  assert.equal(result.accounting.postingDifference, '0');
  assert.equal(result.anomalyCounts.missingAddress, 3);
});

test('seconds and milliseconds normalize to UTC days; absent dates stay unknown', () => {
  assert.equal(normalizeTimestamp(1792320000).iso, normalizeTimestamp(1792320000000).iso);
  assert.equal(normalizeTimestamp(1792320000).unit, 'seconds');
  assert.equal(normalizeTimestamp(1792320000000).unit, 'milliseconds');
  assert.equal(normalizeTimestamp(undefined).day, 'unknown');
  assert.equal(normalizeTimestamp(0).day, 'unknown');
  const data = { chain: [block(0, [cb(A, 0)], { timestamp: undefined, header: { timestamp: 1792320000 } }), block(1, [cb(A, 50)]), block(2, [cb(A, 50)], { timestamp: undefined })] };
  const result = auditSnapshot(data);
  assert.equal(result.timestamps.block.seconds, 1);
  assert.equal(result.timestamps.block.milliseconds, 1);
  assert.equal(result.timestamps.block.missing_or_invalid, 1);
  assert.equal(result.days.find(d => d.day === 'unknown').issuance, '50');
  assert.equal(result.days.reduce((sum, d) => sum + Number(d.issuance), 0), 100);
});

test('malformed recipients and prototype-looking strings remain exact distinct accounts', () => {
  const result = audit([cb('undefined', 20), cb('__proto__', 30, { txid: 'prototype' }), transfer('__proto__', 'constructor', 1)]);
  assert.equal(result.balances.find(a => a.address === 'undefined').balance, '20');
  assert.equal(result.balances.find(a => a.address === '__proto__').balance, '29');
  assert.equal(result.balances.find(a => a.address === 'constructor').balance, '1');
  assert.equal(result.accounting.noncanonicalAccountBalance, '50');
  assert.equal(addressKind(A), 'wallet_shape');
  assert.equal(addressKind(A.slice(0, -1)), 'noncanonical');
});

test('treasury-like missing-character address is not merged or declared lost', () => {
  const fund = 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a';
  const lookalike = 'AGT11a01a612a422dff68f758eefbd9ab3a991439a';
  const result = audit([cb(fund, 25), cb(lookalike, 25, { txid: 'lookalike' })]);
  assert.equal(fund.length, 43); assert.equal(lookalike.length, 42);
  assert.equal(result.balances.find(a => a.address === lookalike).kind, 'noncanonical');
  assert.equal(result.nearAddressMatches.length, 1);
  assert.equal(result.nearAddressMatches[0].editDistance, 1);
  assert.equal(result.balances.find(a => a.address === fund).balance, '25');
});

test('negative balances are disclosed and self-transfers do not create overdrafts', () => {
  const result = audit([cb(A, 50), transfer(B, B, 5), transfer(B, A, 2, { txid: 'overdraft', nonce: 3 })]);
  assert.equal(result.accounting.selfTransferGrossTurnover, '5');
  assert.equal(result.accounting.nonCoinbaseGrossTurnover, '7');
  assert.equal(result.accounting.finalNegativeAccounts, 1);
  assert.equal(result.accounting.transientNegativeAccounts, 1);
  assert.equal(result.transientNegatives[0].balance, '-2');
});

test('memo categories include escrow fee/refund/payments without claiming purpose', () => {
  for (const memo of ['escrow:aa', 'escpayout:aa', 'escrefund:aa', 'escfee:aa']) assert.equal(categoryFor({ memo }), 'escrow');
  assert.equal(categoryFor({ memo: 'army-w2:seed' }), 'w2/army-w2');
  assert.equal(categoryFor({ memo: 'w2-faucet' }), 'w2/army-w2');
  assert.equal(categoryFor({ memo: 'soak#1' }), 'soak');
  assert.equal(categoryFor({ memo: 'gov|P|x' }), 'gov');
  assert.equal(categoryFor({ from: 'COINBASE', memo: 'block 1' }), 'coinbase:block-memo');
});

test('source fingerprint and repeated audit are deterministic', () => {
  const json = JSON.stringify(snapshot([cb(A, 50)]));
  const one = auditSnapshotText(json), two = auditSnapshotText(json);
  assert.deepEqual(one, two);
  assert.equal(one.provenance.sha256, crypto.createHash('sha256').update(json).digest('hex'));
  assert.equal(one.provenance.bytes, Buffer.byteLength(json));
});

test('prefix auditing preserves original amount lexemes and original source fingerprint', () => {
  const data = snapshot([cb(A, 50), transfer(A, B, 0.1)]);
  data.chain.push(block(2, [cb(A, 50, { txid: 'coinbase-2', nonce: 2 })]));
  const json = JSON.stringify(data).replace('"amount":0.1', '"amount":0.100000000000000001');
  const result = auditSnapshotText(json, { blockLimit: 2 });
  assert.equal(result.summary.blocks, 2);
  assert.equal(result.accounting.issuance, '50');
  assert.equal(result.accounting.nonCoinbaseGrossTurnover, '0.100000000000000001');
  assert.equal(result.provenance.sha256, crypto.createHash('sha256').update(json).digest('hex'));
  assert.deepEqual(result.provenance.scope, { inputBlocks: 3, selectedBlocks: 2, selection: 'prefix of supplied snapshot' });
  assert.throws(() => auditSnapshotText(json, { blockLimit: 4 }), /blockLimit/);
});

test('public-key address binding is not a claim of cryptographic signature validity', () => {
  const pub = 'synthetic public text, deliberately not a valid PEM';
  const sha256d = value => crypto.createHash('sha256').update(crypto.createHash('sha256').update(value).digest()).digest('hex');
  const pubHash = sha256d(pub);
  const sender = 'AGT' + pubHash.slice(0, 32) + sha256d(pubHash).slice(0, 8);
  const result = audit([cb(sender, 50), transfer(sender, B, 1, { fromPub: pub, signature: 'definitely invalid' })]);
  assert.equal(result.balances.find(a => a.address === sender).keyBoundOutgoingCount, 1);
  assert.equal(result.anomalyCounts.senderPublicKeyAddressMismatch, undefined);
  assert.ok(result.provenance.limitations.some(text => text.includes('without claiming signature validation')));
});

test('CLI reads only the named snapshot; no state/config files are created or changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-ledger-audit-test-'));
  try {
    const source = path.join(dir, 'chain.json');
    const bytes = JSON.stringify(snapshot([cb(A, 50)]));
    fs.writeFileSync(source, bytes);
    const script = fileURLToPath(new URL('../tools/ledger-audit.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, source], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).accounting.issuance, '50');
    assert.equal(fs.readFileSync(source, 'utf8'), bytes);
    assert.deepEqual(fs.readdirSync(dir), ['chain.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
