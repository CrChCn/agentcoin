import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildArtifact } from '../artifacts/store.mjs';
import { applyArtifactEntries } from '../artifacts/apply.mjs';
import { DOUBLE, TASKS, cli, cliWith, tempRoot } from './helpers.mjs';
import { Store } from '../state/store.mjs';

/* Русский комментарий: symlink — это единственный способ обойти строковую
   проверку пути. Проверяем все девять обязательных сценариев. */

const symlinkSupported = (() => {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-sym-probe-'));
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'link.txt'));
    return true;
  } catch {
    return false;
  }
})();

const fifoSupported = (() => {
  if (process.platform === 'win32') return false;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-fifo-probe-'));
    const result = spawnSync('mkfifo', [path.join(dir, 'pipe')]);
    return result.status === 0;
  } catch {
    return false;
  }
})();

const symlinkTest = (name, fn) => test(name, { skip: symlinkSupported ? false : 'symlinks are not permitted for this user/platform' }, fn);
const fifoTest = (name, fn) => test(name, { skip: fifoSupported ? false : 'mkfifo is not available on this platform' }, fn);

function workspace(label) {
  const dir = tempRoot(label);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  return { dir, ws, artifactRoot: path.join(dir, 'artifact-root') };
}

function build(ctx, changes) {
  return buildArtifact({
    root: ctx.artifactRoot,
    taskId: 'symlink-task',
    iteration: 1,
    baseCommit: 'a'.repeat(40),
    resultCommit: 'b'.repeat(40),
    workspace: ctx.ws,
    changes,
  });
}

function noArtifactWritten(ctx) {
  assert.equal(fs.existsSync(path.join(ctx.artifactRoot, 'artifacts')), false, 'no artifact may be written');
}

test('a normal regular file still works end to end', () => {
  const ctx = workspace('sym-regular');
  fs.writeFileSync(path.join(ctx.ws, 'src', 'ok.txt'), 'hello\n');
  const artifact = build(ctx, [{ file: 'src/ok.txt', status: 'added' }]);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(artifact.size > 0, true);
  assert.equal(fs.existsSync(path.join(ctx.artifactRoot, artifact.path)), true);
});

symlinkTest('1. an allowed path that is a symlink to an outside file is refused before reading', () => {
  const ctx = workspace('sym-outside-file');
  const outside = path.join(ctx.dir, 'outside.txt');
  fs.writeFileSync(outside, 'TOP SECRET FROM OUTSIDE\n');
  fs.symlinkSync(outside, path.join(ctx.ws, 'src', 'result.txt'));

  assert.throws(
    () => build(ctx, [{ file: 'src/result.txt', status: 'added' }]),
    (err) => err.code === 'SYMLINK_ESCAPE',
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'TOP SECRET FROM OUTSIDE\n', 'the external file must be untouched');
  noArtifactWritten(ctx);
});

symlinkTest('2. a symlink to an outside directory cannot be used as a path component', () => {
  const ctx = workspace('sym-outside-dir');
  const outsideDir = path.join(ctx.dir, 'outside-dir');
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'pwn.txt'), 'outside\n');
  fs.symlinkSync(outsideDir, path.join(ctx.ws, 'src', 'out'));

  assert.throws(
    () => build(ctx, [{ file: 'src/out/pwn.txt', status: 'added' }]),
    (err) => err.code === 'SYMLINK_ESCAPE',
  );
  noArtifactWritten(ctx);
});

symlinkTest('3. a symlink to a file inside the workspace is still refused', () => {
  const ctx = workspace('sym-inside');
  fs.writeFileSync(path.join(ctx.ws, 'src', 'real.txt'), 'real\n');
  fs.symlinkSync(path.join(ctx.ws, 'src', 'real.txt'), path.join(ctx.ws, 'src', 'alias.txt'));

  assert.throws(
    () => build(ctx, [{ file: 'src/alias.txt', status: 'added' }]),
    (err) => err.code === 'SYMLINK_ESCAPE',
  );
  noArtifactWritten(ctx);
});

symlinkTest('4. a dangling symlink is refused instead of being followed', () => {
  const ctx = workspace('sym-dangling');
  fs.symlinkSync(path.join(ctx.dir, 'does-not-exist.txt'), path.join(ctx.ws, 'src', 'dangling.txt'));

  assert.throws(
    () => build(ctx, [{ file: 'src/dangling.txt', status: 'added' }]),
    (err) => err.code === 'SYMLINK_ESCAPE',
  );
  noArtifactWritten(ctx);
});

fifoTest('5. a FIFO is not a regular file and is refused', () => {
  const ctx = workspace('sym-fifo');
  const fifo = path.join(ctx.ws, 'src', 'pipe');
  const made = spawnSync('mkfifo', [fifo]);
  assert.equal(made.status, 0);

  assert.throws(
    () => build(ctx, [{ file: 'src/pipe', status: 'added' }]),
    (err) => err.code === 'UNSAFE_FILE_TYPE',
  );
  noArtifactWritten(ctx);
});

symlinkTest('6. applying an artifact through a symlinked parent cannot write outside', () => {
  const dir = tempRoot('sym-apply');
  const dest = path.join(dir, 'applied');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(dest);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dest, 'evil'));

  assert.throws(
    () => applyArtifactEntries(dest, [{ name: 'evil/pwn.txt', data: Buffer.from('pwned\n') }]),
    (err) => err.code === 'SYMLINK_ESCAPE',
  );
  assert.equal(fs.existsSync(path.join(outside, 'pwn.txt')), false);
});

symlinkTest('7. deleting through a symlinked parent cannot remove an outside file', () => {
  const dir = tempRoot('sym-delete');
  const dest = path.join(dir, 'applied');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(dest);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'keep me\n');
  fs.symlinkSync(outside, path.join(dest, 'evil'));

  assert.throws(
    () => applyArtifactEntries(dest, [], ['evil/victim.txt']),
    (err) => err.code === 'SYMLINK_ESCAPE',
  );
  assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'keep me\n');
});

symlinkTest('8. an external file with an unknown secret never reaches the artifact', () => {
  const ctx = workspace('sym-unknown-secret');
  const outside = path.join(ctx.dir, 'id_ed25519');
  fs.writeFileSync(outside, '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-in-env\n');
  fs.symlinkSync(outside, path.join(ctx.ws, 'secret.txt'));

  assert.throws(
    () => build(ctx, [{ file: 'secret.txt', status: 'added' }]),
    (err) => err.code === 'SYMLINK_ESCAPE',
  );
  noArtifactWritten(ctx);
  assert.match(fs.readFileSync(outside, 'utf8'), /OPENSSH PRIVATE KEY/, 'the external file must be intact');
});

symlinkTest('the orchestrator blocks an iteration that commits a symlink to an outside file', () => {
  const root = tempRoot('sym-engine');
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'OUTSIDE\n');

  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'),
    '--implementer', 'codex-implementer', '--reviewer', 'codex-reviewer',
    '--confirm-real-agents', 'lesson-01');
  cli(root, 'step', '--task', 'lesson-01');
  const state = new Store(root, { readOnly: true }).load('lesson-01');

  const blocked = cliWith(root, {
    CODEX_BIN: DOUBLE,
    ORCH_TEST_ALLOW_DOUBLE: '1',
    FAKE_CODEX_MODE: 'symlink-escape',
    FAKE_CODEX_TARGET: outside,
    FAKE_BASE_COMMIT: state.baseCommit,
    FAKE_ITERATION: '1',
  }, 'step', '--task', 'lesson-01');

  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.blockedCode, 'SYMLINK_ESCAPE');
  assert.equal(blocked.artifact, null);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE\n');
  assert.equal((new Store(root, { readOnly: true }).load('lesson-01').artifacts || []).length, 0);
});
