import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createProfile } from '../../agt-skill/agent-profile.mjs';
import { txDigest, escrowReceiptDigest } from '../../core.mjs';
import { signCabinetOperation } from '../src/cli.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-sign-op-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const password = `synthetic-${crypto.randomBytes(12).toString('hex')}`;
  const profilePath = path.join(dir, 'agent.profile.json');
  const profile = await createProfile({ profilePath, password, network: 'AGT_TESTNET', label: 'synthetic-sign-op-test' });
  const pin = { nodeUrl: 'https://exchange.example.test', network: 'AGT_TESTNET', genesisHash: 'a'.repeat(64) };
  return { dir, password, profilePath, profile, pin };
}

test('sign-op accepts a complete cabinet order response and returns only a verifiable signature', async t => {
  const f = await fixture(t);
  const ref = 'AB12cd34';
  const tx = { from: f.profile.address, fromPub: f.profile.pub, to: f.profile.address, amount: 0.001,
    nonce: Date.now() * 1000 + 314, ts: Math.floor(Date.now() / 1000), memo: `dxe|O|b|mbc20:BOTAI|2|0.125|${ref}` };
  tx.txid = txDigest(tx);
  const request = { ok: true, opId: 'o'.repeat(32), ttlSec: 300,
    payload: { kind: 'order', tx, txidHex: tx.txid, ref }, passportPub: f.profile.pub };
  const signature = await signCabinetOperation({ profilePath: f.profilePath, request, opId: request.opId,
    txidHex: tx.txid, password: f.password, pin: f.pin });
  assert.match(signature, /^[a-f0-9]{128}$/);
  assert.equal(crypto.verify(null, Buffer.from(tx.txid, 'hex'), f.profile.pub, Buffer.from(signature, 'hex')), true);
});

test('sign-op rejects mismatched ids, edited order fields, or untrusted digests', async t => {
  const f = await fixture(t);
  const ref = 'EF56gh78';
  const tx = { from: f.profile.address, fromPub: f.profile.pub, to: f.profile.address, amount: 0.001,
    nonce: Date.now() * 1000 + 315, ts: Math.floor(Date.now() / 1000), memo: `dxe|O|s|mbc20:BOTAI|1|2|${ref}` };
  tx.txid = txDigest(tx);
  const request = { opId: 'p'.repeat(32), payload: { kind: 'order', tx, txidHex: tx.txid, ref } };
  await assert.rejects(signCabinetOperation({ profilePath: f.profilePath, request, opId: 'x'.repeat(32),
    txidHex: tx.txid, password: f.password, pin: f.pin }), /op_sign_failed/);
  await assert.rejects(signCabinetOperation({ profilePath: f.profilePath, request, opId: request.opId,
    txidHex: 'f'.repeat(64), password: f.password, pin: f.pin }), /op_sign_failed/);
  const changed = structuredClone(request); changed.payload.tx.memo = `dxe|O|s|mbc20:BOTAI|9|2|${ref}`;
  await assert.rejects(signCabinetOperation({ profilePath: f.profilePath, request: changed, opId: request.opId,
    txidHex: tx.txid, password: f.password, pin: f.pin }), /op_sign_failed/);
  const fakeDigest = 'b'.repeat(64);
  await assert.rejects(signCabinetOperation({ profilePath: f.profilePath, request, opId: request.opId,
    digestHex: fakeDigest, password: f.password, pin: f.pin }), /op_sign_failed/);
});

test('sign-op supports only a recomputed job-claim digest, not an arbitrary digest', async t => {
  const f = await fixture(t);
  const taskHash = 'c'.repeat(64), escId = 'escrow_test_01', amount = 2.5;
  const payload = { kind: 'job-claim', address: f.profile.address, worker: f.profile.address,
    employer: 'AGT' + 'd'.repeat(40), escId, taskHash, amount,
    digestHex: escrowReceiptDigest(escId, taskHash, f.profile.address, amount) };
  const request = { opId: 'q'.repeat(32), payload };
  const signature = await signCabinetOperation({ profilePath: f.profilePath, request, opId: request.opId,
    digestHex: payload.digestHex, password: f.password, pin: f.pin });
  assert.equal(crypto.verify(null, Buffer.from(payload.digestHex, 'hex'), f.profile.pub, Buffer.from(signature, 'hex')), true);
  await assert.rejects(signCabinetOperation({ profilePath: f.profilePath, request: { ...request, payload: { ...payload, digestHex: 'e'.repeat(64) } },
    opId: request.opId, digestHex: 'e'.repeat(64), password: f.password, pin: f.pin }), /op_sign_failed/);
});
