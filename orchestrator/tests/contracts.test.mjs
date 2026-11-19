import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../lib/schema.mjs';
import { initTask, loadTask, schemas } from '../lib/engine.mjs';
import { assertActionAllowed } from '../policies/policy.mjs';
import { TASKS, tempRoot } from './helpers.mjs';

const baseTask = () => JSON.parse(fs.readFileSync(path.join(TASKS, 'lesson-01.json'), 'utf8'));

test('task contract rejects production writes, money, consensus and relaxed limits', () => {
  const cases = [
    (t) => { t.productionWrites = true; },
    (t) => { t.moneyOperations = true; },
    (t) => { t.consensusChanges = true; },
    (t) => { t.maxIterations = 0; },
    (t) => { t.maxRuntimePerAgentMinutes = 0; },
    (t) => { t.maxTotalRuntimeMinutes = 0; },
    (t) => { t.maxTotalTokens = 0; },
    (t) => { delete t.maxTotalTokens; },
    (t) => { t.scope.environment = 'shared'; },
    (t) => { t.commandsAllowed = ['bash -lc "rm -rf /"']; },
    (t) => { t.unexpected = 'field'; },
    (t) => { delete t.acceptance; },
  ];
  for (const mutate of cases) {
    const task = baseTask();
    mutate(task);
    const errors = validate(schemas.task, task);
    assert.ok(errors.length > 0, `must reject: ${mutate}`);
  }
  assert.equal(validate(schemas.task, baseTask()).length, 0);
});

test('task contract rejects path traversal and shell commands that pass the schema pattern', () => {
  const root = tempRoot('contracts-paths');
  const traversal = baseTask();
  traversal.taskId = 'lesson-traversal';
  traversal.scope.allowedPaths = ['../etc'];
  const file = path.join(root, 'task.json');
  fs.writeFileSync(file, JSON.stringify(traversal));
  assert.throws(() => loadTask(file), (err) => err.code === 'TASK_INVARIANT_VIOLATION');

  // Shell-метасимволы отсекает уже схема команды; проверяем, что загрузка падает.
  const shell = baseTask();
  shell.taskId = 'lesson-shell';
  shell.commandsAllowed = ['node --test tests/x.test.mjs; rm -rf src'];
  fs.writeFileSync(file, JSON.stringify(shell));
  assert.throws(() => loadTask(file));

  const budget = baseTask();
  budget.taskId = 'lesson-budget';
  budget.maxRuntimePerAgentMinutes = 61;
  budget.maxTotalRuntimeMinutes = 60;
  fs.writeFileSync(file, JSON.stringify(budget));
  assert.throws(() => loadTask(file), (err) => err.code === 'TASK_INVARIANT_VIOLATION');
});

test('taskId is immutable: same id with different content is refused', () => {
  const root = tempRoot('contracts-immutable');
  const original = path.join(TASKS, 'lesson-01.json');
  initTask({ root, taskFile: original });
  const changed = baseTask();
  changed.title = 'different title with the same immutable id';
  const file = path.join(root, 'changed.json');
  fs.writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => initTask({ root, taskFile: file }), (err) => err.code === 'TASK_ID_REUSED');
});

test('orchestrator exposes only typed actions and refuses deployment', () => {
  for (const action of ['checkout', 'apply_patch', 'run_test', 'build_artifact', 'calculate_hash', 'submit_review']) {
    assert.deepEqual(assertActionAllowed(action), { ok: true, action });
  }
  assert.deepEqual(assertActionAllowed('prepare_deployment'), {
    ok: false,
    code: 'DEPLOYMENT_RUNNER_NOT_PROVISIONED',
    action: 'prepare_deployment',
  });
  assert.equal(assertActionAllowed('shell').code, 'ACTION_NOT_TYPED');
});
