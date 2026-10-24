import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createProfile } from '../../agt-skill/agent-profile.mjs';
import { createAgentChallenge } from '../../agent-identity.mjs';
import { signRegisterChallenge } from '../src/cli.mjs';

test('sign-register prints only a signature that verifies over the registration challenge message', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-sign-register-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const password = `synthetic-${crypto.randomBytes(12).toString('hex')}`;
  const profilePath = path.join(dir, 'agent.profile.json');
  const profile = await createProfile({ profilePath, password, network: 'AGENTCOIN', label: 'synthetic-register-test' });
  const challenge = {
    ok: true,
    ...createAgentChallenge({ action: 'register', network: 'AGENTCOIN',
      issuerFingerprint: 'sha256:' + 'a'.repeat(64), audience: 'agentcoin-register-test',
      address: profile.address, pub: profile.pub, handle: 'register-test' }),
  };
  const signature = await signRegisterChallenge({ profilePath, challenge, password });
  assert.match(signature, /^[a-f0-9]{128}$/);
  assert.equal(crypto.verify(null, Buffer.from(challenge.message, 'utf8'), profile.pub,
    Buffer.from(signature, 'hex')), true);
});

test('sign-register refuses expired, wrong-action, wrong-network, and mismatched-address challenges', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-sign-register-negative-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const password = `synthetic-${crypto.randomBytes(12).toString('hex')}`;
  const profilePath = path.join(dir, 'agent.profile.json');
  const profile = await createProfile({ profilePath, password, network: 'AGENTCOIN', label: 'synthetic-register-negative' });
  const base = { ok: true, ...createAgentChallenge({ action: 'register', network: 'AGENTCOIN',
    issuerFingerprint: 'sha256:' + 'b'.repeat(64), audience: 'agentcoin-register-test',
    address: profile.address, pub: profile.pub, handle: 'register-test' }) };
  for (const [name, challenge] of [
    ['expired', { ...base, expiresAt: Date.now() - 1 }],
    ['wrong action', { ...base, action: 'login' }],
    ['wrong network', { ...base, network: 'OTHER' }],
    ['wrong address', { ...base, address: 'AGT' + '0'.repeat(40) }],
  ]) {
    await assert.rejects(signRegisterChallenge({ profilePath, challenge, password }), /sign_register_failed/, name);
  }
});
