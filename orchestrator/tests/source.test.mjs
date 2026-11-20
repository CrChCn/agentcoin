import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { cli, cliRaw, tempRoot } from './helpers.mjs';

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

function git(dir, args) {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

function sourceRepo(label) {
  const dir = tempRoot(label);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.mjs'), 'export const answer = 42;\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'source: initial']);
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']) };
}

function writeTask(dir, overrides = {}) {
  const task = {
    taskId: 'source-01',
    title: 'Base commit comes from a real repository',
    objective: 'Prove that checkout clones the repository named in the contract instead of the fixture template.',
    scope: { allowedPaths: ['src'], forbiddenPaths: [], environment: 'isolated' },
    acceptance: ['AC-1: baseCommit is the commit of the source repository'],
    commandsAllowed: ['node --test tests/unit.test.mjs'],
    networkPolicy: 'none',
    productionWrites: false,
    moneyOperations: false,
    consensusChanges: false,
    maxIterations: 1,
    maxRuntimePerAgentMinutes: 5,
    maxTotalRuntimeMinutes: 5,
    maxTotalTokens: 1000,
    deadline: '2027-12-31T00:00:00Z',
    ...overrides,
  };
  const file = path.join(dir, `${task.taskId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`);
  return file;
}

test('checkout clones the repository named in the contract and records it', () => {
  const { dir: repo, commit } = sourceRepo('source-repo');
  const root = tempRoot('source-run');
  const file = writeTask(root, { source: { repo, ref: 'main' } });

  cli(root, 'init', '--task', file);
  const ready = cli(root, 'step', '--task', 'source-01');

  assert.equal(ready.state, 'READY');
  assert.equal(ready.baseCommit, commit, 'baseCommit must be the commit of the source repository');
  assert.equal(ready.source.repo, repo);
  assert.equal(ready.source.ref, 'main');
  assert.equal(ready.source.commit, commit);

  const copied = path.join(root, 'workspaces', 'source-01', 'implementer', 'src', 'app.mjs');
  assert.match(fs.readFileSync(copied, 'utf8'), /answer = 42/);

  // Клон не переписывает источник: ни HEAD, ни индекс, ни рабочие файлы.
  assert.equal(git(repo, ['rev-parse', 'HEAD']), commit);
  assert.equal(git(repo, ['status', '--porcelain']), '');

  const report = cli(root, 'report', '--task', 'source-01');
  assert.equal(report.source.commit, commit);
  assert.equal(report.baseCommit, commit);
});

test('a missing or non-git source is refused at checkout, never replaced by the fixture', () => {
  const missingRoot = tempRoot('source-missing');
  const missingFile = writeTask(missingRoot, {
    taskId: 'source-02',
    source: { repo: path.join(missingRoot, 'no-such-repo'), ref: 'main' },
  });
  cli(missingRoot, 'init', '--task', missingFile);
  const missing = cliRaw(missingRoot, 'step', '--task', 'source-02');
  assert.notEqual(missing.status, 0, 'checkout must fail when the source repo is missing');
  assert.match(missing.stderr, /TASK_SOURCE_MISSING/);
  assert.equal(
    fs.existsSync(path.join(missingRoot, 'workspaces', 'source-02', 'implementer', 'src', 'pricing.mjs')),
    false,
    'the fixture template must not stand in for a missing source',
  );

  const plainDir = tempRoot('source-plain');
  fs.writeFileSync(path.join(plainDir, 'file.txt'), 'not a git repo\n');
  const notGitRoot = tempRoot('source-notgit');
  const notGitFile = writeTask(notGitRoot, { taskId: 'source-03', source: { repo: plainDir, ref: 'main' } });
  cli(notGitRoot, 'init', '--task', notGitFile);
  const notGit = cliRaw(notGitRoot, 'step', '--task', 'source-03');
  assert.notEqual(notGit.status, 0, 'checkout must fail when the source is not a git repository');
  assert.match(notGit.stderr, /TASK_SOURCE_NOT_REPO/);
});
