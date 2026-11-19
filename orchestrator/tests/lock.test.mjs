import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { CLI, DOUBLE, ORCH, TASKS, cli, cliRaw, testEnv, tempRoot } from './helpers.mjs';
import { lockPaths } from '../lib/lock.mjs';
import { Store } from '../state/store.mjs';

const HOLDER = path.join(ORCH, 'tests', 'lock-holder.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 20000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

function runProcess(args, env) {
  const child = spawn(process.execPath, args, { env: testEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

function initRealTask(root) {
  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'),
    '--implementer', 'codex-implementer', '--reviewer', 'codex-reviewer',
    '--confirm-real-agents', 'lesson-01');
  cli(root, 'step', '--task', 'lesson-01');
  const state = new Store(root, { readOnly: true }).load('lesson-01');
  assert.equal(state.state, 'READY');
  return state.baseCommit;
}

test('two concurrent step processes: the agent runs once, the second gets TASK_BUSY', async () => {
  const root = tempRoot('lock-two');
  const baseCommit = initRealTask(root);
  const agentLog = path.join(root, 'agent-runs.log');

  const env = {
    CODEX_BIN: DOUBLE,
    ORCH_TEST_ALLOW_DOUBLE: '1',
    FAKE_CODEX_MODE: 'implement',
    FAKE_ROLE: 'implementer',
    FAKE_ITERATION: '1',
    FAKE_BASE_COMMIT: baseCommit,
    FAKE_CODEX_LOG: agentLog,
    FAKE_CODEX_DELAY_MS: '2500',
  };

  const first = runProcess([CLI, 'step', '--task', 'lesson-01', '--root', root], env);
  assert.equal(await waitFor(() => fs.existsSync(lockPaths(root, 'lesson-01').dir)), true, 'first process must take the lock');

  const second = spawnSync(process.execPath, [CLI, 'step', '--task', 'lesson-01', '--root', root], {
    encoding: 'utf8', env: testEnv(env),
  });
  assert.equal(second.status, 75, `second process must be refused, got ${second.status}: ${second.stderr}`);
  assert.equal(JSON.parse(second.stdout).blockedCode, 'TASK_BUSY');

  const finished = await first.done;
  assert.equal(finished.code, 0, finished.stderr);

  const runs = fs.readFileSync(agentLog, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(runs.length, 1, 'the agent must be invoked exactly once');

  const store = new Store(root, { readOnly: true });
  const state = store.load('lesson-01');
  assert.equal(state.artifacts.length, 1, 'exactly one artifact');
  const journal = store.verifyJournal('lesson-01');
  assert.equal(journal.ok, true, JSON.stringify(journal.errors));
  assert.deepEqual(journal.events.map((e) => e.seq), journal.events.map((_, i) => i));
  assert.equal(journal.events.slice(1).every((e) => typeof e.payload.operationId === 'string'), true, 'every transition must record its operationId');
  assert.equal(lockPaths(root, 'lesson-01') && fs.existsSync(lockPaths(root, 'lesson-01').dir), false, 'lock must be released');
});

test('lock storm: 20 concurrent processes, exactly one wins, the rest get TASK_BUSY', async () => {
  const root = tempRoot('lock-storm');
  const dir = path.join(root, 'storm');
  fs.mkdirSync(dir, { recursive: true });
  const releaseFile = path.join(dir, 'release');
  const results = [];
  const children = [];

  for (let i = 0; i < 20; i += 1) {
    const resultFile = path.join(dir, `result-${i}.json`);
    results.push(resultFile);
    const child = spawn(process.execPath, [HOLDER, root, 'lesson-01', releaseFile, resultFile], {
      env: testEnv(), stdio: ['ignore', 'ignore', 'ignore'],
    });
    children.push(new Promise((resolve) => child.on('close', resolve)));
  }

  const allReported = await waitFor(() => results.every((file) => fs.existsSync(file)), 30000);
  assert.equal(allReported, true, 'every process must report within the window');
  fs.writeFileSync(releaseFile, 'go\n');
  await Promise.all(children);

  const outcomes = results.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const winners = outcomes.filter((outcome) => outcome.ok);
  const busy = outcomes.filter((outcome) => !outcome.ok);

  assert.equal(winners.length, 1, `exactly one lock holder expected, got ${winners.length}`);
  assert.equal(busy.length, 19);
  assert.deepEqual([...new Set(busy.map((outcome) => outcome.code))], ['TASK_BUSY']);
  assert.equal(fs.existsSync(lockPaths(root, 'lesson-01').dir), false, 'lock must be released');
});

test('a dead lock is never taken over blindly: NEEDS_RECONCILE, then explicit reconcile', async () => {
  const root = tempRoot('lock-stale');
  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'));

  const { dir, file } = lockPaths(root, 'lesson-01');
  fs.mkdirSync(dir, { recursive: true });
  const deadPid = await deadPidValue();
  fs.writeFileSync(file, `${JSON.stringify({
    taskId: 'lesson-01', operationId: 'stale-operation', pid: deadPid, startedAt: new Date().toISOString(), action: 'step',
  }, null, 2)}\n`);

  const blocked = cliRaw(root, 'step', '--task', 'lesson-01');
  assert.equal(blocked.status, 76, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).blockedCode, 'NEEDS_RECONCILE');
  assert.equal(fs.existsSync(dir), true, 'the stale lock must not be removed automatically');

  const withoutForce = cliRaw(root, 'reconcile', '--task', 'lesson-01');
  assert.equal(withoutForce.status, 76);
  assert.equal(fs.existsSync(dir), true);

  const forced = cliRaw(root, 'reconcile', '--task', 'lesson-01', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(JSON.parse(forced.stdout).reconciled, true);

  const after = cli(root, 'step', '--task', 'lesson-01');
  assert.equal(after.state, 'READY');
});

/* PID завершившегося процесса: гарантированно мёртвый на этой машине. */
async function deadPidValue() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => child.on('close', resolve));
  return pid;
}
