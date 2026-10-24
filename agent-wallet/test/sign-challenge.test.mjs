import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createProfile } from '../../agt-skill/agent-profile.mjs';
import { createAgentChallenge } from '../../agent-identity.mjs';
import { signCabinetChallenge } from '../src/cli.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-sign-challenge-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const password = `synthetic-${crypto.randomBytes(12).toString('hex')}`;
  const profilePath = path.join(dir, 'agent.profile.json');
  const profile = await createProfile({ profilePath, password, network: 'AGT_TESTNET', label: 'synthetic-challenge-test' });
  const trust = { version: 1, network: 'AGT_TESTNET', audience: 'agentcoin-test-node',
    nodeIssuerFingerprint: 'sha256:' + 'a'.repeat(64) };
  return { dir, password, profilePath, profile, trust };
}

function responseFor(profile, trust, changes = {}) {
  const challenge = createAgentChallenge({ action: 'login', network: trust.network,
    issuerFingerprint: trust.nodeIssuerFingerprint, audience: trust.audience,
    address: profile.address, pub: profile.pub });
  Object.assign(challenge, changes);
  return { ok: true, challenge, nonce: challenge.message, challengeId: challenge.challengeId, ttlSec: 300 };
}

test('sign-challenge signs a valid login challenge under separately pinned trust', async t => {
  const f = await fixture(t);
  const response = responseFor(f.profile, f.trust);
  const signature = await signCabinetChallenge({ profilePath: f.profilePath, response, password: f.password, trust: f.trust });
  assert.match(signature, /^[a-f0-9]{128}$/);
  assert.equal(crypto.verify(null, Buffer.from(response.challenge.message), f.profile.pub, Buffer.from(signature, 'hex')), true);
});

test('sign-challenge rejects another profile and expired challenges with specific errors', async t => {
  const f = await fixture(t);
  const other = await createProfile({ profilePath: path.join(f.dir, 'other.profile.json'), password: f.password,
    network: f.trust.network, label: 'synthetic-other-test' });
  await assert.rejects(signCabinetChallenge({ profilePath: f.profilePath,
    response: responseFor(other, f.trust), password: f.password, trust: f.trust }), /challenge_profile_mismatch/);

  const expired = responseFor(f.profile, f.trust, { expiresAt: Date.now() - 1 });
  await assert.rejects(signCabinetChallenge({ profilePath: f.profilePath, response: expired,
    password: f.password, trust: f.trust }), /challenge_expired/);

  const wrongNetwork = responseFor(f.profile, f.trust, { network: 'OTHER_TESTNET' });
  await assert.rejects(signCabinetChallenge({ profilePath: f.profilePath, response: wrongNetwork,
    password: f.password, trust: f.trust }), /challenge_network_mismatch/);
});

test('sign-challenge rejects unpinned issuer and audience values', async t => {
  const f = await fixture(t);
  const response = responseFor(f.profile, f.trust);
  await assert.rejects(signCabinetChallenge({ profilePath: f.profilePath, response, password: f.password,
    trust: { ...f.trust, nodeIssuerFingerprint: 'sha256:' + 'b'.repeat(64) } }), /challenge_sign_failed/);
  await assert.rejects(signCabinetChallenge({ profilePath: f.profilePath, response, password: f.password,
    trust: { ...f.trust, audience: 'other-audience' } }), /challenge_sign_failed/);
});
