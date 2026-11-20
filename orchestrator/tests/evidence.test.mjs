import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ORCH_ROOT } from '../lib/package.mjs';

import { isolationEvidence, buildEvidence } from '../lib/agentsandbox.mjs';
import {
  authSecrets, currentBuildFingerprint, findSecretLeaks, issueNonce, loadKey, signEvidence,
} from '../lib/evidence.mjs';
import { ALLOW_ATTACKS, DENY_ATTACKS } from '../lib/attackmatrix.mjs';

/* Уровень 3 проверяется на синтетической «машине»: verifier принимает
   инъекцию текущего fingerprint'а, но preflight её никогда не передаёт. Это
   позволяет проверить все отказы на любой платформе, не выдавая ручной JSON
   за доказательство. */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-evidence-test-'));
const env = { ...process.env, ORCH_EVIDENCE_HOME: base };
const HOME_FP = 'e'.repeat(64);

const build = {
  commit: 'a'.repeat(40),
  dirty: false,
  dirtyFiles: 0,
  bwrap: { available: true, version: 'bubblewrap 0.9.0', sha256: 'b'.repeat(64) },
  codex: { available: true, sha256: 'c'.repeat(64), version: 'codex-cli 0.50.0' },
  files: {
    policy: '1'.repeat(64),
    broker: '2'.repeat(64),
    proxy: '3'.repeat(64),
    sandbox: '4'.repeat(64),
    agentsandbox: '5'.repeat(64),
    matrix: '6'.repeat(64),
    evidence: '7'.repeat(64),
    orchestrator: '8'.repeat(64),
  },
};

const results = () => [
  ...DENY_ATTACKS.map((id) => ({
    id, expect: 'deny', denied: true, technical: { exitCode: 126, code: 'TOOL_PATH_DENIED', stdoutSha256: 'f'.repeat(64), stderrSha256: 'f'.repeat(64) },
  })),
  ...ALLOW_ATTACKS.map((id) => ({
    id, expect: 'allow', denied: false, ok: true, technical: { exitCode: 0, code: 'OK', stdoutSha256: 'f'.repeat(64), stderrSha256: 'f'.repeat(64) },
  })),
];

const journalEntries = () => [
  { seq: 1, at: new Date().toISOString(), command: 'cat ./allowed.txt', allow: true, code: 'OK', exitCode: 0 },
  { seq: 2, at: new Date().toISOString(), command: 'id', allow: false, code: 'TOOL_COMMAND_NOT_ALLOWED', exitCode: 126 },
];

function writeEvidence(name, mutate = (item) => item, afterSign = (item) => item) {
  const nonce = issueNonce({ env });
  assert.equal(nonce.ok, true);
  const composed = buildEvidence({
    nonce: nonce.nonce,
    backend: 'bwrap',
    threadId: 'thread_0123456789abcdef',
    exitCode: 0,
    build,
    host: { fingerprint: HOME_FP, hostname: 'synthetic' },
    results: results(),
    journalEntries: journalEntries(),
    leaks: { scanned: [{ name: 'tokens.access_token', sha256: '9'.repeat(64) }], found: [] },
  });
  const key = loadKey({ create: true, env });
  assert.equal(key.ok, true);
  const signed = signEvidence(mutate(composed), { key: key.key });
  assert.equal(signed.ok, true);
  const file = path.join(base, name);
  fs.writeFileSync(file, `${JSON.stringify(afterSign(signed.evidence), null, 2)}\n`);
  return file;
}

const verify = (file) => isolationEvidence(file, { backend: 'bwrap', env, build, host: HOME_FP });

test('the forged level-3 JSON the auditor wrote is rejected', () => {
  const file = path.join(base, 'forged.json');
  fs.writeFileSync(file, JSON.stringify({
    ok: true,
    adapter: 'codex-cli',
    backend: 'bwrap',
    threadId: 'forged_thread_123456',
    attacks: [{ attack: 'made-up', denied: true }],
  }));
  const verdict = verify(file);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'agent_isolation_unproven');
});

test('a complete but unsigned evidence file is rejected', () => {
  const file = writeEvidence('unsigned.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete parsed.signature;
  fs.writeFileSync(file, JSON.stringify(parsed));
  const verdict = verify(file);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /signature|nonce/i);
});

test('a properly signed, machine-bound evidence file is accepted', () => {
  const verdict = verify(writeEvidence('valid.json'));
  assert.equal(verdict.ok, true, verdict.detail);
  assert.equal(verdict.attacks, DENY_ATTACKS.length + ALLOW_ATTACKS.length);
});

test('unknown, missing and repeated attack ids are rejected', () => {
  const unknown = verify(writeEvidence('unknown.json', (item) => ({
    ...item,
    attacks: [...item.attacks, { ...item.attacks[0], id: 'made-up-attack' }],
  })));
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /unknown attack id/);

  const missing = verify(writeEvidence('missing.json', (item) => ({
    ...item,
    attacks: item.attacks.filter((attack) => attack.id !== 'abs-bin-bash'),
  })));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /missing mandatory attacks/);

  const repeated = verify(writeEvidence('repeated.json', (item) => ({
    ...item,
    attacks: [...item.attacks, item.attacks[0]],
  })));
  assert.equal(repeated.ok, false);
  assert.match(repeated.detail, /repeats attack id/);
});

test('an attack that was not technically blocked is rejected', () => {
  const file = writeEvidence('not-denied.json', (item) => ({
    ...item,
    attacks: item.attacks.map((attack) => (attack.id === 'abs-bin-bash'
      ? { ...attack, denied: false, technical: { ...attack.technical, exitCode: 0, code: 'OK' } }
      : attack)),
  }));
  const verdict = verify(file);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /abs-bin-bash/);
});

test('another host, build or Codex binary invalidates the evidence', () => {
  const file = writeEvidence('hash.json');

  const otherHost = isolationEvidence(file, { backend: 'bwrap', env, build, host: 'd'.repeat(64) });
  assert.equal(otherHost.ok, false);
  assert.match(otherHost.detail, /host fingerprint/);

  const otherBuild = { ...build, files: { ...build.files, policy: '0'.repeat(64) } };
  const otherPolicy = isolationEvidence(file, { backend: 'bwrap', env, build: otherBuild, host: HOME_FP });
  assert.equal(otherPolicy.ok, false);
  assert.match(otherPolicy.detail, /hashes do not match/);

  const otherBwrap = { ...build, bwrap: { ...build.bwrap, sha256: '0'.repeat(64) } };
  const otherBinary = isolationEvidence(file, { backend: 'bwrap', env, build: otherBwrap, host: HOME_FP });
  assert.equal(otherBinary.ok, false);
  assert.match(otherBinary.detail, /bwrap fingerprint/);

  const otherCodex = { ...build, codex: { ...build.codex, sha256: '0'.repeat(64) } };
  const otherCli = isolationEvidence(file, { backend: 'bwrap', env, build: otherCodex, host: HOME_FP });
  assert.equal(otherCli.ok, false);
  assert.match(otherCli.detail, /Codex fingerprint/);
});

test('a stale nonce, a reused nonce and a tampered signature are rejected', () => {
  const stale = path.join(base, 'stale.json');
  const nonce = issueNonce({ env, ttlMs: -60000, now: Date.now() - 120000 });
  const composed = buildEvidence({
    nonce: nonce.nonce,
    backend: 'bwrap',
    threadId: 'thread_0123456789abcdef',
    exitCode: 0,
    build,
    host: { fingerprint: HOME_FP },
    results: results(),
    journalEntries: journalEntries(),
    leaks: { scanned: [{ name: 'tokens.access_token', sha256: '9'.repeat(64) }], found: [] },
  });
  const key = loadKey({ create: true, env });
  const signed = signEvidence(composed, { key: key.key });
  fs.writeFileSync(stale, JSON.stringify(signed.evidence));
  const staleVerdict = verify(stale);
  assert.equal(staleVerdict.ok, false);
  assert.match(staleVerdict.detail, /nonce/);

  const valid = writeEvidence('tampered.json', (item) => item, (item) => ({
    ...item,
    attacks: item.attacks.map((attack, index) => (index === 0
      ? { ...attack, technical: { ...attack.technical, detail: 'changed after signing' } }
      : attack)),
  }));
  const tampered = verify(valid);
  assert.equal(tampered.ok, false);
  assert.match(tampered.detail, /signature/);
});

test('a leaked auth.json value fails the evidence even when everything else is valid', () => {
  const file = writeEvidence('leak.json', (item) => ({
    ...item,
    leaks: { scanned: item.leaks.scanned, found: [{ name: 'tokens.access_token', sha256: '9'.repeat(64) }] },
  }));
  const verdict = verify(file);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /secret leaks/);
});

test('auth.json values are scanned in memory and only hashes are returned', () => {
  const file = path.join(base, 'auth.json');
  const token = 'sk-live-token-that-must-never-be-logged';
  fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: token } }));
  const secrets = authSecrets(file);
  assert.equal(secrets.ok, true);
  assert.equal(secrets.values.includes(token), true);
  assert.equal(secrets.hashes.some((item) => item.sha256.length === 64), true);
  const leaks = findSecretLeaks(`transcript with ${token} inside`, secrets.values.map((value, index) => ({ ...secrets.hashes[index], value })));
  assert.equal(leaks.length, 1);
  assert.equal(JSON.stringify(leaks).includes(token), false);
});

test('the build fingerprint is computed from this tree', () => {
  const current = currentBuildFingerprint({ backend: 'bwrap' });
  const policy = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ORCH_ROOT, 'lib', 'toolpolicy.mjs')))
    .digest('hex');
  assert.equal(current.files.policy, policy);
  assert.equal(typeof current.codex.available, 'boolean');
});

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
