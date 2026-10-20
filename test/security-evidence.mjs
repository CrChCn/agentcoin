import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Blockchain, SecurityController, addressFromPub, signTransaction,
  classifySecurityEvent, summarizeSecurityEvidence } from '../core.mjs';

function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-security-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function signedSpend(amount = 1) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const fromPub = publicKey.export({ type: 'spki', format: 'pem' });
  const tx = { from: addressFromPub(fromPub), fromPub, to: 'AGT' + 'a'.repeat(40),
    amount, nonce: 123, ts: 1737777777, memo: 'synthetic security regression' };
  tx.signature = signTransaction(tx, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return tx;
}

test('legacy ledger is classified conservatively without modifying evidence or bans', t => {
  const dir = isolated(t);
  const original = { bans: {
    ESCROW_example: { reason: 'double_spend', ttlMs: null, bannedAt: '2026-10-19T00:00:00Z' },
    ['AGT' + 'a'.repeat(40)]: { reason: 'spoof_signature', ttlMs: null },
    unknown: { reason: 'flood', ttlMs: null },
  }, attacks: [
    { kind: 'double_spend', address: 'ESCROW_example', evidence: 'balance 0, pending 0, tried 1' },
    { kind: 'double_spend', evidence: 'stale tx in mempool: budget 0, tried 1' },
    { kind: 'flood', evidence: 'banned address keeps submitting txs' },
    { kind: 'spoof_signature', evidence: 'invalid signature' },
  ] };
  const file = path.join(dir, 'security.json');
  fs.writeFileSync(file, JSON.stringify(original));
  const bytes = fs.readFileSync(file, 'utf8');
  const sec = new SecurityController(dir);
  const summary = sec.status().evidenceSummary;
  assert.deepEqual(summary, { eventCount: 4, confirmedAttackCount: 0,
    unverifiedEventCount: 1, requestErrorCount: 3, bannedAddressCount: 3,
    bannedAgentAddressCount: 1, bannedEscrowAddressCount: 1, bannedUnknownAddressCount: 1,
    provenance: 'unknown' });
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(sec.attacks, original.attacks);
  assert.equal(sec.status().attacksSeen, 4, 'legacy counter retained');
  assert.equal(classifySecurityEvent(null).confirmedAttack, false);
  assert.equal(summarizeSecurityEvidence(null, null).eventCount, 0);
});

test('valid signed spend without funds is rejected without a ban or attack event', t => {
  const bc = new Blockchain(isolated(t));
  const tx = signedSpend();
  assert.deepEqual(bc.addTransaction(tx), { ok: false, reason: 'insufficient_funds' });
  assert.equal(bc.security.attacks.length, 0);
  assert.equal(bc.security.isBanned(tx.from), false);
  assert.equal(bc.mempool.length, 0);
});

test('stale valid signed mempool spend is skipped without sanctions or journal writes', t => {
  const bc = new Blockchain(isolated(t));
  const tx = signedSpend();
  bc.mempool = [tx];
  assert.deepEqual(bc.usableMempoolTxs(), []);
  assert.equal(bc.security.attacks.length, 0);
  assert.equal(bc.security.isBanned(tx.from), false);
  assert.deepEqual(bc.mempool, [tx], 'selection itself does not rewrite historical input');
});

test('retries from a banned address cannot renew ban or amplify attack ledger', t => {
  const bc = new Blockchain(isolated(t));
  const tx = signedSpend();
  bc.security.ban(tx.from, 'flood', 'synthetic prior incident');
  bc.security.bans[tx.from].bannedAt = new Date(Date.now() - 1000).toISOString();
  bc.security.save();
  const before = fs.readFileSync(bc.security.file, 'utf8');
  for (let i = 0; i < 10; i++) assert.equal(bc.addTransaction({ ...tx, signature: 'unverified' }).reason, 'address_permabanned');
  assert.equal(fs.readFileSync(bc.security.file, 'utf8'), before);
  assert.equal(bc.security.attacks.length, 0);
  assert.deepEqual(bc.security.strikes, {});
});
