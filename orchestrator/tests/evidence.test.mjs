import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ORCH_ROOT, closure, runtimeEntrypoints } from '../lib/package.mjs';

import { isolationEvidence, buildEvidence } from '../lib/agentsandbox.mjs';
import {
  authSecrets, currentBuildFingerprint, findSecretLeaks, inspectStoreFile, issueNonce, loadKey, runtimeManifest, signEvidence,
} from '../lib/evidence.mjs';
import { ALLOW_ATTACKS, DENY_ATTACKS } from '../lib/attackmatrix.mjs';

/* Уровень 3 проверяется на синтетической «машине»: verifier принимает
   инъекцию текущего fingerprint'а, но preflight её никогда не передаёт. Это
   позволяет проверить все отказы на любой платформе, не выдавая ручной JSON
   за доказательство. */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-evidence-test-'));
const env = { ...process.env, ORCH_EVIDENCE_HOME: base };
const HOME_FP = 'e'.repeat(64);

const manifest = {
  root: 'orchestrator',
  dirs: ['lib', 'adapters', 'tools', 'contracts', 'policies'],
  files: [
    { path: 'adapters/codex-cli.mjs', bytes: 100, sha256: '1'.repeat(64) },
    { path: 'lib/engine.mjs', bytes: 200, sha256: '2'.repeat(64) },
  ],
  count: 2,
  rootHash: 'a'.repeat(64),
  missing: [],
  ok: true,
};

const build = {
  commit: 'a'.repeat(40),
  dirty: false,
  dirtyFiles: 0,
  bwrap: { available: true, version: 'bubblewrap 0.9.0', sha256: 'b'.repeat(64) },
  codex: { available: true, sha256: 'c'.repeat(64), version: 'codex-cli 0.50.0' },
  manifest,
};

const CLEANUP = { ok: true, removed: ['broker-socket', 'ipc', 'scratch', 'codex-home'], failed: [], authCopyRemoved: true };

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
    cleanup: CLEANUP,
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

  const otherBuild = { ...build, manifest: { ...manifest, rootHash: '0'.repeat(64) } };
  const otherPolicy = isolationEvidence(file, { backend: 'bwrap', env, build: otherBuild, host: HOME_FP });
  assert.equal(otherPolicy.ok, false);
  assert.match(otherPolicy.detail, /runtime manifest/);

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
    cleanup: CLEANUP,
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

test('the build fingerprint covers the whole runtime closure', () => {
  const current = currentBuildFingerprint({ backend: 'bwrap' });
  const entry = current.manifest.files.find((item) => item.path === 'lib/toolpolicy.mjs');
  const policy = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ORCH_ROOT, 'lib', 'toolpolicy.mjs')))
    .digest('hex');
  assert.equal(entry.sha256, policy);
  for (const file of [
    'adapters/codex-cli.mjs', 'lib/engine.mjs', 'lib/envpolicy.mjs', 'lib/prompts.mjs',
    'lib/schema.mjs', 'lib/toolpolicy.mjs', 'lib/agentsandbox.mjs', 'lib/evidence.mjs',
    'tools/tool-proxy.mjs', 'tools/tool-broker.mjs', 'orchestrator.mjs',
  ]) {
    assert.equal(current.manifest.files.some((item) => item.path === file), true, `${file} must be in the runtime manifest`);
  }
  assert.match(current.manifest.rootHash, /^[a-f0-9]{64}$/);
  assert.equal(current.manifest.ok, true);
});

/* Один изменённый байт любого runtime-файла меняет rootHash: иначе старый
   уровень 3 пережил бы правку адаптера или engine. */
test('changing one byte of a runtime file invalidates the manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-manifest-'));
  for (const dir of ['lib', 'adapters', 'tools', 'contracts', 'policies', 'state', 'artifacts']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'state', 'store.mjs'), 'export const s = 1;\n');
  fs.writeFileSync(path.join(root, 'artifacts', 'apply.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'lib', 'engine.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(root, 'adapters', 'codex-cli.mjs'), 'export const y = 1;\n');
  fs.writeFileSync(path.join(root, 'tools', 'tool-proxy.mjs'), 'export const z = 1;\n');
  fs.writeFileSync(path.join(root, 'orchestrator.mjs'), '// entry\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');

  const before = runtimeManifest(root);
  assert.equal(before.ok, true);
  fs.appendFileSync(path.join(root, 'adapters', 'codex-cli.mjs'), ' ');
  const after = runtimeManifest(root);
  assert.notEqual(after.rootHash, before.rootHash);
  assert.equal(after.count, before.count);

  /* Подписанное evidence с прежним manifest больше не принимается. */
  const file = writeEvidence('manifest.json', (item) => ({ ...item, build: { ...item.build, manifest: before } }));
  const verdict = isolationEvidence(file, { backend: 'bwrap', env, build: { ...build, manifest: after }, host: HOME_FP });
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /runtime manifest/);

  fs.rmSync(root, { recursive: true, force: true });
});

/* fix7: state/store.mjs, artifacts/store.mjs и artifacts/apply.mjs исполняются
   в runtime (apply.mjs применяет патч к рабочему дереву), но лежали вне
   manifest — правка этого кода не меняла rootHash. Теперь модули обоих
   контейнеров входят в manifest, а данные прогонов в нём не участвуют:
   иначе evidence становился бы недействительным после каждого запуска. */
test('state and artifacts modules are covered by the manifest, their data is not', () => {
  const current = currentBuildFingerprint({ backend: 'bwrap' });
  const paths = new Set(current.manifest.files.map((item) => item.path));
  for (const file of ['state/store.mjs', 'artifacts/store.mjs', 'artifacts/apply.mjs']) {
    assert.equal(paths.has(file), true, `${file} must be in the runtime manifest`);
  }
  assert.equal(current.manifest.files.some((item) => item.path.startsWith('state/lesson-01/')), false);
  assert.equal(current.manifest.files.some((item) => /\.json$/.test(item.path) && item.path.startsWith('state/')), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-manifest-data-'));
  for (const dir of ['lib', 'adapters', 'tools', 'contracts', 'policies', 'state', 'artifacts']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'orchestrator.mjs'), '// entry\n');
  fs.writeFileSync(path.join(root, 'state', 'store.mjs'), 'export const s = 1;\n');
  fs.writeFileSync(path.join(root, 'artifacts', 'store.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'artifacts', 'apply.mjs'), 'export const b = 1;\n');
  fs.mkdirSync(path.join(root, 'state', 'internal'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'internal', 'util.mjs'), 'export const u = 1;\n');
  fs.mkdirSync(path.join(root, 'state', 'lesson-01'));
  fs.writeFileSync(path.join(root, 'state', 'lesson-01', 'state.json'), '{"iteration":1}\n');
  fs.mkdirSync(path.join(root, 'artifacts', 'lesson-01', '1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts', 'lesson-01', '1', 'patch.diff'), '+one\n');

  const before = runtimeManifest(root);
  assert.equal(before.ok, true);
  assert.equal(before.files.some((item) => item.path === 'state/internal/util.mjs'), true, 'nested module must be hashed');

  /* Данные прогона изменились — сборка та же. */
  fs.writeFileSync(path.join(root, 'state', 'lesson-01', 'state.json'), '{"iteration":2}\n');
  fs.writeFileSync(path.join(root, 'artifacts', 'lesson-01', '1', 'patch.diff'), '+two\n');
  assert.equal(runtimeManifest(root).rootHash, before.rootHash);

  /* Изменился код в artifacts/ или state/ — evidence обязан инвалидироваться. */
  fs.appendFileSync(path.join(root, 'artifacts', 'apply.mjs'), ' ');
  const after = runtimeManifest(root);
  assert.notEqual(after.rootHash, before.rootHash);
  assert.equal(after.count, before.count);

  fs.appendFileSync(path.join(root, 'artifacts', 'store.mjs'), ' ');
  const afterArtifactStore = runtimeManifest(root);
  assert.notEqual(afterArtifactStore.rootHash, after.rootHash);

  fs.writeFileSync(path.join(root, 'state', 'store.mjs'), 'export const s = 2;\n');
  const afterState = runtimeManifest(root);
  assert.notEqual(afterState.rootHash, afterArtifactStore.rootHash);

  fs.appendFileSync(path.join(root, 'state', 'internal', 'util.mjs'), ' ');
  assert.notEqual(runtimeManifest(root).rootHash, afterState.rootHash);

  fs.rmSync(root, { recursive: true, force: true });
});

/* Общий предохранитель от повторения дефекта: каждый модуль, достижимый из
   runtime entrypoint'ов, обязан быть в manifest. Новый каталог с кодом не
   сможет снова выпасть из привязки незамеченным. */
test('every module reachable from a runtime entrypoint is in the manifest', () => {
  const graph = closure(runtimeEntrypoints());
  assert.deepEqual(graph.missing, []);
  const paths = new Set(currentBuildFingerprint({ backend: 'bwrap' }).manifest.files.map((item) => item.path));
  const escaped = graph.files.filter((rel) => !paths.has(rel));
  assert.deepEqual(escaped, [], `runtime modules outside the manifest:\n${escaped.join('\n')}`);
});

/* Аудитор подписал evidence с dirty:false/dirtyFiles:0, а дерево было
   грязным. fix5 это пропускал: verifier сравнивал только commit. */
test('evidence from a dirty tree is rejected even with a matching commit', () => {
  const file = writeEvidence('dirty-evidence.json');
  const dirtyTree = { ...build, dirty: true, dirtyFiles: 99 };
  const verdict = isolationEvidence(file, { backend: 'bwrap', env, build: dirtyTree, host: HOME_FP });
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /working tree is dirty/);

  const dirtyEvidence = writeEvidence('dirty-build.json', (item) => ({ ...item, build: { ...item.build, dirty: true, dirtyFiles: 3 } }));
  const authored = isolationEvidence(dirtyEvidence, { backend: 'bwrap', env, build, host: HOME_FP });
  assert.equal(authored.ok, false);
  assert.match(authored.detail, /dirty working tree/);
});

/* Распакованный ZIP без .git: commit:null не считается привязкой, решает
   подписанный manifest digest. */
test('a tree without git is bound by the manifest digest, not by commit:null', () => {
  const noGit = { ...build, commit: null, dirty: null, dirtyFiles: null };
  const nonce = issueNonce({ env });
  const composed = buildEvidence({
    nonce: nonce.nonce,
    backend: 'bwrap',
    threadId: 'thread_0123456789abcdef',
    exitCode: 0,
    build: noGit,
    host: { fingerprint: HOME_FP },
    results: results(),
    journalEntries: journalEntries(),
    leaks: { scanned: [{ name: 'tokens.access_token', sha256: '9'.repeat(64) }], found: [] },
    cleanup: CLEANUP,
  });
  const key = loadKey({ create: true, env });
  const signed = signEvidence(composed, { key: key.key });
  const file = path.join(base, 'no-git.json');
  fs.writeFileSync(file, JSON.stringify(signed.evidence));

  assert.equal(isolationEvidence(file, { backend: 'bwrap', env, build: noGit, host: HOME_FP }).ok, true);
  const otherManifest = { ...noGit, manifest: { ...manifest, rootHash: '0'.repeat(64) } };
  const changed = isolationEvidence(file, { backend: 'bwrap', env, build: otherManifest, host: HOME_FP });
  assert.equal(changed.ok, false);
  assert.match(changed.detail, /runtime manifest/);
  /* commit:null на одной стороне и реальный commit на другой — не привязка. */
  const mixed = isolationEvidence(file, { backend: 'bwrap', env, build, host: HOME_FP });
  assert.equal(mixed.ok, false);
  assert.match(mixed.detail, /git binding/);
});

/* Копия auth.json должна быть удалена, и harness обязан это засвидетельствовать. */
test('evidence without proof of auth.json removal is rejected', () => {
  const missing = writeEvidence('no-cleanup.json', (item) => { const { cleanup, ...rest } = item; return rest; });
  const verdict = verify(missing);
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /CODEX_HOME/);

  const leaked = writeEvidence('cleanup-failed.json', (item) => ({
    ...item,
    cleanup: { ok: false, removed: [], failed: [{ label: 'codex-home', detail: 'EPERM' }], authCopyRemoved: false },
  }));
  assert.equal(verify(leaked).ok, false);
});

/* fix6, п.9: ключ и реестр — обычные файлы, не symlink, режим 0600. */
test('a symlinked or world-readable key store is refused', { skip: process.platform === 'win32' ? 'POSIX ownership/mode checks' : false }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-key-store-'));
  const keyEnv = { ...process.env, ORCH_EVIDENCE_HOME: home };
  const real = path.join(home, 'real.key');
  fs.writeFileSync(real, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
  const link = path.join(home, 'evidence-hmac.key');
  fs.symlinkSync(real, link);
  const symlinked = loadKey({ env: keyEnv });
  assert.equal(symlinked.ok, false);
  assert.equal(symlinked.code, 'EVIDENCE_KEY_UNSAFE');

  fs.unlinkSync(link);
  fs.writeFileSync(link, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
  fs.chmodSync(link, 0o644);
  assert.equal(inspectStoreFile(link).ok, false);
  const readable = loadKey({ env: keyEnv });
  assert.equal(readable.ok, false);
  assert.match(readable.detail, /mode 644/);

  fs.rmSync(home, { recursive: true, force: true });
});

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
