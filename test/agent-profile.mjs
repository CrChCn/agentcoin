// Synthetic identities only. All files are isolated under os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createProfile, readPublicProfile, inspectProfile, createEncryptedBackup,
  restoreProfile, signProfileChallenge, PROFILE_KDF,
} from '../agt-skill/agent-profile.mjs';
import { recoverFromMnemonic } from '../bip39-lite.mjs';
import { canonicalAgentChallenge } from '../agent-identity.mjs';

const password = 'synthetic-test-password';
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const issuerFingerprint = 'sha256:' + 'a'.repeat(64);
const audience = 'https://test.invalid';
const now = 1900000000000;
const cli = fileURLToPath(new URL('../agt-skill/agent-profile.mjs', import.meta.url));
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-profile-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function challengeFor(pub, changes = {}) {
  const challenge = { version: 1, domain: 'AGT-IDENTITY-V1', action: 'register',
    network: pub.network, issuerFingerprint, audience, address: pub.address,
    pub: pub.pub, handle: 'synthetic-agent', challengeId: 'b'.repeat(32), nonce: 'c'.repeat(64),
    issuedAt: now - 1000, expiresAt: now + 60000, ...changes };
  challenge.message = canonicalAgentChallenge(challenge);
  return challenge;
}
function signOptions(profilePath, challenge, changes = {}) {
  return { profilePath, password, challenge, expectedAction: 'register',
    expectedAudience: audience, expectedIssuerFingerprint: issuerFingerprint,
    expectedNetwork: 'AGENTCOIN', now, ...changes };
}

test('BIP39 recovery is compatible; vault/public export never contains plaintext secrets', async t => {
  const dir = await temp(t), profilePath = path.join(dir, 'profile.json');
  const pub = await createProfile({ profilePath, password, mnemonic, label: 'synthetic' });
  const expected = recoverFromMnemonic(mnemonic, 'synthetic').wallet;
  assert.equal(pub.address, expected.address); assert.equal(pub.pub, expected.pub);
  assert.deepEqual(await readPublicProfile(profilePath), pub);
  assert.deepEqual(await inspectProfile({ profilePath, password }), pub);
  const serialized = await fs.readFile(profilePath, 'utf8');
  for (const secret of [password, mnemonic, expected.privKey, 'PRIVATE KEY']) assert.equal(serialized.includes(secret), false);
  for (const key of ['mnemonic', 'mnemonicPassphrase', 'privKey', 'password']) assert.equal(Object.hasOwn(pub, key), false);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(profilePath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  }
  await assert.rejects(inspectProfile({ profilePath, password: 'incorrect-test-password' }), /vault_unlock_failed/);
});

test('encrypted backup restores identical identity with a new password; never overwrites', async t => {
  const dir = await temp(t), profilePath = path.join(dir, 'profile.json');
  const pub = await createProfile({ profilePath, password, mnemonic });
  const backupPath = path.join(dir, 'backup.json');
  const backupPassword = 'synthetic-backup-password', restoredPassword = 'synthetic-restored-password';
  const backup = await createEncryptedBackup({ profilePath, password, backupPassword, backupPath });
  assert.notEqual(JSON.parse(await fs.readFile(profilePath, 'utf8')).ciphertext, backup.ciphertext);
  const restoredPath = path.join(dir, 'restored.json');
  assert.deepEqual(await restoreProfile({ profilePath: restoredPath, password: restoredPassword, backupPath, backupPassword }), pub);
  assert.deepEqual(await inspectProfile({ profilePath: restoredPath, password: restoredPassword }), pub);
  await assert.rejects(restoreProfile({ profilePath, password, backup, backupPassword }), /already_exists/);
  await assert.rejects(createProfile({ profilePath, password }), /already_exists/);
  await assert.rejects(createEncryptedBackup({ profilePath, password, backupPath }), /already_exists/);
  assert.deepEqual(await inspectProfile({ profilePath, password }), pub);
  assert.equal((await fs.readdir(dir)).some(name => name.startsWith('.agent-profile-')), false);
});

test('backup tampering, arbitrary KDF costs and wrong-network restores fail before writing', async t => {
  const dir = await temp(t), profilePath = path.join(dir, 'profile.json');
  await createProfile({ profilePath, password, mnemonic });
  const backup = await createEncryptedBackup({ profilePath, password });
  const cases = [
    b => { b.kdf.N = PROFILE_KDF.N * 1000; },
    b => { b.kdf.p = 1024; },
    b => { b.kdf.salt = 'bad'; },
    b => { b.cipher.tag = Buffer.alloc(16).toString('base64'); },
    b => { b.ciphertext = Buffer.from('tampered').toString('base64'); },
    b => { b.public.label = 'tampered'; },
  ];
  for (let i = 0; i < cases.length; i++) {
    const changed = structuredClone(backup); cases[i](changed);
    const destination = path.join(dir, `invalid-${i}.json`);
    await assert.rejects(restoreProfile({ profilePath: destination, password, backup: changed }));
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
  await assert.rejects(restoreProfile({ profilePath: path.join(dir, 'wrong-network.json'), password, backup, network: 'OTHER' }), /network_mismatch/);
});

test('challenge signing is offline, domain separated and bound to identity and pinned issuer', async t => {
  const dir = await temp(t), profilePath = path.join(dir, 'profile.json');
  const pub = await createProfile({ profilePath, password, mnemonic });
  const challenge = challengeFor(pub);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network_not_allowed'); };
  t.after(() => { globalThis.fetch = previousFetch; });
  const signed = await signProfileChallenge(signOptions(profilePath, challenge));
  assert.match(signed.signature, /^[a-f0-9]{128}$/);
  assert.equal(crypto.verify(null, Buffer.from(challenge.message), pub.pub, Buffer.from(signed.signature, 'hex')), true);
  assert.equal(crypto.verify(null, Buffer.from('transaction:' + challenge.message), pub.pub, Buffer.from(signed.signature, 'hex')), false);
  const login = challengeFor(pub, { action: 'login', handle: '' });
  const loginSigned = await signProfileChallenge(signOptions(profilePath, login, { expectedAction: 'login' }));
  assert.equal(crypto.verify(null, Buffer.from(login.message), pub.pub, Buffer.from(loginSigned.signature, 'hex')), true);
  for (const changes of [
    { expectedAction: 'send' }, { expectedAction: undefined }, { expectedAction: 'login' },
    { expectedIssuerFingerprint: 'sha256:' + 'f'.repeat(64) }, { expectedIssuerFingerprint: undefined },
    { expectedAudience: 'https://other.invalid' }, { expectedNetwork: 'OTHER' },
    { now: challenge.expiresAt + 1 }, { now: challenge.issuedAt - 60000 },
  ]) await assert.rejects(signProfileChallenge(signOptions(profilePath, challenge, changes)));
  for (const changed of [
    { ...challenge, message: challenge.message + 'x' }, { ...challenge, message: undefined },
    { ...challenge, action: 'send' }, { ...challenge, extra: true },
    challengeFor(pub, { network: 'OTHER' }),
  ]) await assert.rejects(signProfileChallenge(signOptions(profilePath, changed)));
  const other = await createProfile({ profilePath: path.join(dir, 'other.json'), password });
  await assert.rejects(signProfileChallenge(signOptions(profilePath, challengeFor(other))), /challenge_profile_mismatch/);
});

test('CLI accepts secrets only on stdin and emits only safe metadata/signatures', async t => {
  const dir = await temp(t), profilePath = path.join(dir, 'cli.json');
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input), timeout: 15000 });
  const created = run(['create', profilePath], { password, mnemonic });
  assert.equal(created.status, 0, created.stderr); const pub = JSON.parse(created.stdout);
  const publicResult = run(['public', profilePath]); assert.equal(publicResult.status, 0); assert.deepEqual(JSON.parse(publicResult.stdout), pub);
  const backupPath = path.join(dir, 'cli-backup.json');
  const saved = run(['backup', profilePath, backupPath], { password }); assert.equal(saved.status, 0, saved.stderr);
  const restored = run(['restore', path.join(dir, 'cli-restored.json'), backupPath], { password });
  assert.equal(restored.status, 0, restored.stderr); assert.deepEqual(JSON.parse(restored.stdout), pub);
  const cliNow = Date.now();
  const cliChallenge = challengeFor(pub, { issuedAt: cliNow - 1000, expiresAt: cliNow + 60000 });
  const signed = run(['sign-challenge', profilePath], signOptions(profilePath, cliChallenge));
  assert.equal(signed.status, 0, signed.stderr); assert.match(JSON.parse(signed.stdout).signature, /^[a-f0-9]{128}$/);
  const expiredChallenge = challengeFor(pub, { issuedAt: cliNow - 120000, expiresAt: cliNow - 60000 });
  const expired = run(['sign-challenge', profilePath], signOptions(profilePath, expiredChallenge, { now: cliNow - 90000 }));
  assert.equal(expired.status, 1, 'stdin clock cannot permit an expired challenge');
  const invalidMnemonic = run(['create', path.join(dir, 'bad.json')], { password, mnemonic: 'secret invalid mnemonic words' });
  assert.equal(invalidMnemonic.status, 1); assert.equal(invalidMnemonic.stderr, 'invalid_mnemonic\n');
  const argPassword = run(['create', path.join(dir, 'arg.json'), password], {}); assert.equal(argPassword.status, 1);
  for (const result of [created, publicResult, saved, restored, signed, expired, invalidMnemonic, argPassword]) {
    for (const secret of [password, mnemonic, 'secret invalid mnemonic words', 'PRIVATE KEY']) assert.equal((result.stdout + result.stderr).includes(secret), false);
  }
});

test('symlink and insecure profile destinations are rejected', async t => {
  const dir = await temp(t), target = path.join(dir, 'target.json');
  await createProfile({ profilePath: target, password, mnemonic });
  const link = path.join(dir, 'link.json');
  await fs.symlink(target, link);
  await assert.rejects(readPublicProfile(link), /regular_file/);
  await assert.rejects(createProfile({ profilePath: link, password }), /already_exists/);
  const realDir = path.join(dir, 'real'); await fs.mkdir(realDir, { mode: 0o700 });
  const linkedDir = path.join(dir, 'linked'); await fs.symlink(realDir, linkedDir);
  await assert.rejects(createProfile({ profilePath: path.join(linkedDir, 'nested', 'profile.json'), password }), /directory_must_be_real/);
  if (process.platform !== 'win32') {
    const insecure = path.join(dir, 'insecure'); await fs.mkdir(insecure, { mode: 0o755 });
    await assert.rejects(createProfile({ profilePath: path.join(insecure, 'profile.json'), password }), /0700/);
    await fs.chmod(target, 0o644);
    await assert.rejects(readPublicProfile(target), /private_and_bounded/);
  }
});
