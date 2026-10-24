import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createProfile } from '../agt-skill/agent-profile.mjs';
import { txDigest, verifyTransaction } from '../core.mjs';
import { signDxeCancellationRequest } from '../agent-wallet/src/cli.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dxe-cancel-request-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const password = 'synthetic-' + crypto.randomBytes(18).toString('hex');
  const profilePath = path.join(dir, 'agent.agp');
  const profile = await createProfile({ profilePath, password, network: 'AGT_TESTNET', label: 'cancel-request-test' });
  const pin = { nodeUrl: 'https://exchange.example.test', network: 'AGT_TESTNET', genesisHash: 'a'.repeat(64) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), pin.nodeUrl + '/info');
    return new Response(JSON.stringify({ network: pin.network, genesisHash: pin.genesisHash }), { status: 200,
      headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const ref = 'Ab12Cd34';
  const tx = { from: profile.address, to: profile.address, amount: 0.001, nonce: Date.now() * 1000, ts: Math.floor(Date.now() / 1000), memo: `dxe|C|${ref}` };
  tx.txid = txDigest(tx);
  const request = { schema: 'agt-dxe-cancel-request-v1', nodeUrl: pin.nodeUrl, network: pin.network,
    genesisHash: pin.genesisHash, address: profile.address, ref, tx };
  return { dir, password, profilePath, profile, pin, request };
}

test('sign-cancel signs the exact pinned cancellation request locally without submitting it', async t => {
  const f = await fixture(t);
  const response = await signDxeCancellationRequest({ profilePath: f.profilePath, request: f.request, password: f.password, pin: f.pin });
  assert.equal(response.schema, 'agt-dxe-cancel-response-v1');
  assert.equal(response.nodeUrl, f.pin.nodeUrl);
  assert.equal(response.ref, f.request.ref);
  assert.equal(response.tx.txid, f.request.tx.txid);
  assert.equal(response.tx.memo, `dxe|C|${f.request.ref}`);
  assert.equal(response.tx.from, f.profile.address);
  assert.equal(verifyTransaction(response.tx), true);
});

test('sign-cancel rejects another profile and a mismatched ref before producing a signature', async t => {
  const f = await fixture(t);
  const otherPath = path.join(f.dir, 'other.agp');
  const other = await createProfile({ profilePath: otherPath, password: f.password, network: 'AGT_TESTNET', label: 'other-agent' });
  await assert.rejects(signDxeCancellationRequest({ profilePath: otherPath, request: f.request, password: f.password, pin: f.pin }), /cancel_sign_failed/);
  const forged = structuredClone(f.request); forged.ref = 'Zz99Yy88';
  await assert.rejects(signDxeCancellationRequest({ profilePath: f.profilePath, request: forged, password: f.password, pin: f.pin }), /cancel_sign_failed/);
  assert.notEqual(other.address, f.profile.address);
});
