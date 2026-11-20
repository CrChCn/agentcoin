#!/usr/bin/env node
/* Тесты сервисного слоя. Движок и адаптеры настоящие, агенты — детерминированные
   дублёры (simulated=true), сеть и production не используются. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OpsStore, STATUS } from '../store.mjs';
import { planNext } from '../planner.mjs';
import { tick } from '../runner.mjs';
import { createApi } from '../api.mjs';
import { checkWatchdog } from '../watchdog.mjs';
import { loadTask } from '../../lib/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.resolve(HERE, '..', '..');
const TEMPLATE = path.join(ORCH, 'fixtures', 'tasks', 'lesson-01.json');

function tempRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ops-${name}-`));
  return dir;
}

function mission(overrides = {}) {
  return {
    mission: 'test mission',
    continuous: true,
    priorities: ['доступность сети'],
    planner: { enabled: true, maxOpenTasks: 1, template: TEMPLATE, taskPrefix: 'test', titleSuffix: 'rehearsal' },
    loop: { intervalSec: 5, maxTaskMinutes: 5, maxStepsPerTick: 8 },
    adapters: { mode: 'fixture', fixtureImplementer: 'fixture-implementer', fixtureReviewer: 'fixture-reviewer' },
    allowRealAgents: false,
    ...overrides,
  };
}

test('queue: survives a new store instance and refuses duplicate task ids', () => {
  const root = tempRoot('queue');
  const store = new OpsStore(root);
  fs.mkdirSync(store.paths.tasksDir, { recursive: true });
  const taskFile = path.join(store.paths.tasksDir, 'demo-01.json');
  fs.copyFileSync(TEMPLATE, taskFile);

  store.enqueue({ taskId: 'demo-01', title: 'demo', taskFile, origin: 'test' });
  assert.throws(() => store.enqueue({ taskId: 'demo-01', title: 'demo again', taskFile }), /already in the queue/);

  const reopened = new OpsStore(root);
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.get('demo-01').status, STATUS.PENDING);
  assert.equal(reopened.counts().pending, 1);

  const claimed = reopened.claimNext({ pid: process.pid });
  assert.equal(claimed.taskId, 'demo-01');
  assert.equal(reopened.counts().leased, 1);
  reopened.complete('demo-01', { state: 'ACCEPTED', commit: 'abc' });
  assert.equal(new OpsStore(root).get('demo-01').status, STATUS.DONE);
});

test('queue: a lease of a dead pid returns to pending and is journaled', () => {
  const root = tempRoot('lease');
  const store = new OpsStore(root);
  fs.mkdirSync(store.paths.tasksDir, { recursive: true });
  const taskFile = path.join(store.paths.tasksDir, 'lease-01.json');
  fs.copyFileSync(TEMPLATE, taskFile);
  store.enqueue({ taskId: 'lease-01', taskFile });

  store.claimNext({ pid: 999999 });
  assert.equal(store.counts().leased, 1);

  const released = store.releaseExpiredLeases();
  assert.equal(released.length, 1);
  assert.equal(store.get('lease-01').status, STATUS.PENDING);
  assert.match(store.get('lease-01').lastError, /pid 999999 is gone/);
  const journal = fs.readFileSync(store.paths.queueJournal, 'utf8');
  assert.match(journal, /lease\.expired/);
});

test('planner: clones the configured template once and stays single-line', () => {
  const root = tempRoot('planner');
  const store = new OpsStore(root);
  fs.mkdirSync(store.paths.tasksDir, { recursive: true });

  const first = planNext(store, mission());
  assert.equal(first.action, 'enqueued');
  assert.equal(store.counts().pending, 1);
  const task = loadTask(first.taskFile);
  assert.equal(task.taskId, first.taskId);
  assert.deepEqual(task.acceptance, loadTask(TEMPLATE).acceptance);

  const second = planNext(store, mission());
  assert.equal(second.action, 'none');
  assert.equal(store.counts().pending, 1);
});

test('tick: runs the isolated cycle to ACCEPTED and records memory', async () => {
  const root = tempRoot('tick');
  const store = new OpsStore(root);
  fs.mkdirSync(store.paths.tasksDir, { recursive: true });
  const plan = planNext(store, mission());
  assert.equal(plan.action, 'enqueued');

  let outcome = null;
  for (let i = 0; i < 12; i++) {
    outcome = await tick({ root, mission: mission() });
    if (outcome.action === 'finished') break;
  }

  assert.equal(outcome.action, 'finished', `unexpected outcome: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.result.state, 'ACCEPTED');
  assert.match(outcome.result.commit, /^[0-9a-f]{7,40}$/);
  assert.equal(outcome.result.artifactSha.length, 64);

  const item = new OpsStore(root).get(plan.taskId);
  assert.equal(item.status, STATUS.DONE);
  assert.equal(item.result.state, 'ACCEPTED');

  const memory = new OpsStore(root).memory();
  assert.equal(memory.facts.lastAcceptedTask, plan.taskId);
  assert.equal(memory.facts.lastAcceptedCommit, outcome.result.commit);
  assert.ok(memory.lessons.some((lesson) => lesson.kind === 'accepted' && lesson.task === plan.taskId));

  const checkpoint = new OpsStore(root).readCheckpoint();
  assert.equal(checkpoint.taskId, plan.taskId);
  assert.equal(checkpoint.state, 'ACCEPTED');
});

test('restart: a new process continues the same task from the journal, not from scratch', async () => {
  const root = tempRoot('restart');
  const store = new OpsStore(root);
  fs.mkdirSync(store.paths.tasksDir, { recursive: true });
  const plan = planNext(store, mission());

  /* Один шаг за тик — имитация обрыва после короткого прогресса. */
  const shortMission = mission({ loop: { intervalSec: 5, maxTaskMinutes: 5, maxStepsPerTick: 1 } });
  const first = await tick({ root, mission: shortMission });
  assert.equal(first.action, 'partial');
  const afterFirst = new OpsStore(root).get(plan.taskId);
  assert.equal(afterFirst.status, STATUS.PENDING, 'lease must return to pending after a partial tick');
  const journalBefore = new OpsStore(root).readCheckpoint();
  assert.ok(['CREATED', 'READY'].includes(journalBefore.state), `unexpected first state ${journalBefore.state}`);

  /* «Новый процесс»: другой экземпляр store и другие объекты в памяти. */
  const fresh = new OpsStore(root);
  const historyBefore = JSON.parse(fs.readFileSync(path.join(root, 'logs', plan.taskId, 'events.jsonl'), 'utf8').trim().split('\n')[0]).seq;

  let outcome = null;
  for (let i = 0; i < 12; i++) {
    outcome = await tick({ root, mission: mission() });
    if (outcome.action === 'finished') break;
  }
  assert.equal(outcome.result.state, 'ACCEPTED');

  const items = fresh.list().filter((item) => item.taskId === plan.taskId);
  assert.equal(items.length, 1, 'restart must not duplicate the queue item');
  assert.equal(items[0].status, STATUS.DONE);

  const events = fs.readFileSync(path.join(root, 'logs', plan.taskId, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.length > 2, 'journal must keep the pre-restart events');
  assert.equal(historyBefore, 0);
  const states = events.map((event) => event.to);
  assert.equal(states.filter((state) => state === 'CREATED').length, 1, 'task must be created exactly once');
  assert.equal(new OpsStore(root).counts().done, 1);
});

async function withApi(root, fn) {
  const server = createApi({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('api: read-only surface answers GET and rejects writes', async () => {
  const root = tempRoot('api');
  const store = new OpsStore(root);
  store.heartbeat({ state: 'idle' });

  await withApi(root, async (base) => {
    const status = await fetch(`${base}/ops/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    const body = await status.json();
    assert.equal(body.readonly, true);
    assert.equal(body.orchestrator.state, 'idle');

    const queue = await (await fetch(`${base}/ops/queue`)).json();
    assert.equal(queue.counts.total, 0);

    const post = await fetch(`${base}/ops/queue`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 405);

    const del = await fetch(`${base}/ops/status`, { method: 'DELETE' });
    assert.equal(del.status, 405);

    const missing = await fetch(`${base}/ops/nope`);
    assert.equal(missing.status, 404);
  });
});

test('watchdog: reports a stale heartbeat and a dead lock owner', () => {
  const root = tempRoot('watchdog');
  const store = new OpsStore(root);
  store.heartbeat({ state: 'working' });
  const fresh = checkWatchdog({ root });
  assert.equal(fresh.verdict, 'alive');

  const staleAt = new Date(Date.now() - 3600 * 1000).toISOString();
  fs.writeFileSync(store.paths.heartbeatFile, JSON.stringify({ pid: 999999, host: os.hostname(), at: staleAt, state: 'working' }));
  const stale = checkWatchdog({ root });
  assert.equal(stale.verdict, 'attention');
  assert.ok(stale.problems.some((p) => p.code === 'HEARTBEAT_STALE'));
  assert.equal(stale.action.includes('never kills'), true);
});
