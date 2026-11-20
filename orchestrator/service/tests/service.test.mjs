#!/usr/bin/env node
/* Тесты сервисного слоя C1.1. Движок и адаптеры настоящие, агенты —
   детерминированные дублёры (simulated=true), сеть и production не
   используются. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { OpsStore, STATUS } from '../store.mjs';
import { planNext } from '../planner.mjs';
import { tick, breakerState } from '../runner.mjs';
import { createApi } from '../api.mjs';
import { buildPublicStatus, auditPublicKeys } from '../publicview.mjs';
import { checkWatchdog } from '../watchdog.mjs';
import { budgetBreakdown } from '../../lib/engine.mjs';
import { validate } from '../../lib/schema.mjs';
import { processVerdict, selfIdentity } from '../../lib/procinfo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.resolve(HERE, '..', '..');
const TEMPLATE = path.join(ORCH, 'fixtures', 'tasks', 'lesson-01.json');
const PUBLIC_SCHEMA = JSON.parse(fs.readFileSync(path.join(ORCH, 'contracts', 'public-status.schema.json'), 'utf8'));

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ops-${name}-`));
}

function mission(overrides = {}) {
  return {
    mission: 'test mission',
    continuous: true,
    priorities: ['доступность сети'],
    planner: { enabled: true, taskPrefix: 'test' },
    repositoryRoot: 'repository',
    loop: { intervalSec: 5, maxTaskMinutes: 5, maxStepsPerTick: 8 },
    budget: { project: 'unlimited', task: 'finite', consecutiveFailureBreaker: 3 },
    adapters: { mode: 'fixture', fixtureImplementer: 'fixture-implementer', fixtureReviewer: 'fixture-reviewer' },
    allowRealAgents: false,
    ...overrides,
  };
}

/* Задание владельца: контракт lesson-01 с другим taskId, положенный в backlog. */
function seedBacklog(root, taskId) {
  const store = new OpsStore(root);
  fs.mkdirSync(store.paths.backlogDir, { recursive: true });
  fs.mkdirSync(store.paths.tasksDir, { recursive: true });
  const task = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  task.taskId = taskId;
  task.title = `${task.title} — ${taskId}`;
  fs.writeFileSync(path.join(store.paths.backlogDir, `${taskId}.json`), JSON.stringify(task, null, 2));
  return store;
}

function seedRegistry(root, entries) {
  const store = new OpsStore(root);
  fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(root, 'queue', 'registry.json'), JSON.stringify({ version: 1, entries }, null, 2));
  return store;
}

test('queue: durable, no duplicate taskId, trigger stored', () => {
  const root = tempRoot('queue');
  const store = new OpsStore(root);
  fs.mkdirSync(store.paths.tasksDir, { recursive: true });
  const taskFile = path.join(store.paths.tasksDir, 'demo-01.json');
  fs.copyFileSync(TEMPLATE, taskFile);
  const trigger = { type: 'registry_gap', evidence: ['docs/x.md: missing'], observedAt: new Date().toISOString(), deduplicationKey: 'a'.repeat(64) };

  store.enqueue({ taskId: 'demo-01', title: 'demo', taskFile, origin: 'test' });
  assert.throws(() => store.enqueue({ taskId: 'demo-01', taskFile }), /already in the queue/);
  store.enqueue({ taskId: 'demo-02', taskFile, trigger });

  const reopened = new OpsStore(root);
  assert.equal(reopened.list().length, 2);
  assert.deepEqual(reopened.get('demo-02').trigger, trigger);
  reopened.claimNext({ pid: process.pid });
  reopened.complete('demo-01', { state: 'ACCEPTED', commit: 'abc' });
  assert.equal(new OpsStore(root).get('demo-01').status, STATUS.DONE);
});

test('lease: carries hostId/bootId/processStartTime and survives PID reuse', () => {
  const root = tempRoot('lease');
  const store = seedBacklog(root, 'lease-01');
  const plan = planNext(store, mission());
  assert.equal(plan.action, 'enqueued');

  const identity = selfIdentity();
  const claimed = store.claimNext({ pid: 999999 });
  assert.equal(claimed.lease.hostId, identity.hostId);
  assert.equal(claimed.lease.bootId, identity.bootId);
  assert.ok('processStartTime' in claimed.lease);
  assert.equal(claimed.lease.taskId, claimed.taskId);

  /* Чужой хост: владелец не наш, даже если pid «жив». */
  const released = store.releaseExpiredLeases({ pidAliveFn: () => true, current: { hostId: 'other-host', bootId: identity.bootId } });
  assert.equal(released.length, 1);
  assert.match(released[0].verdict.reason, /another host/);

  /* Другая загрузка и переиспользованный pid решаются той же функцией. */
  const previousBoot = processVerdict({ pid: 4242, hostId: identity.hostId, bootId: 'previous-boot', processStartTime: 1 });
  assert.equal(previousBoot.alive, false);
  assert.match(previousBoot.reason, /previous boot|is gone/);

  const reusedPid = processVerdict(
    { pid: process.pid, hostId: identity.hostId, bootId: identity.bootId, processStartTime: 1 },
    { pidAliveFn: () => true, startTimeFn: () => 999 },
  );
  assert.equal(reusedPid.alive, false);
  assert.match(reusedPid.reason, /reused/);
});

test('planner: empty registry is IDLE, no template cloning', () => {
  const root = tempRoot('planner-idle');
  const store = seedRegistry(root, []);
  fs.mkdirSync(path.join(root, 'repository'), { recursive: true });
  for (let i = 0; i < 3; i++) {
    const plan = planNext(store, mission());
    assert.equal(plan.action, 'idle');
  }
  assert.equal(store.list().length, 0);
});

test('planner: proven gap becomes one task, then deduplication blocks a repeat', () => {
  const root = tempRoot('planner-gap');
  const repo = path.join(root, 'repository');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'no expected sentence here\n');
  const task = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const store = seedRegistry(root, [{
    id: 'readme-gap', priority: 5, type: 'registry_gap',
    check: { kind: 'file_includes', path: 'README.md', needle: 'EXPECTED SENTENCE' },
    task,
  }]);

  const first = planNext(store, mission());
  assert.equal(first.action, 'enqueued');
  assert.equal(first.trigger.type, 'registry_gap');
  assert.match(first.trigger.deduplicationKey, /^[a-f0-9]{64}$/);
  assert.ok(first.trigger.evidence[0].includes('README.md'));

  const item = store.get(first.taskId);
  assert.deepEqual(item.trigger, first.trigger);
  assert.equal(store.list().length, 1);

  const second = planNext(store, mission());
  assert.equal(second.action, 'none', 'queue is busy while the task is open');

  store.complete(first.taskId, { state: 'ACCEPTED', commit: 'abc1234' });
  const third = planNext(store, mission());
  assert.equal(third.action, 'idle', 'same evidence must not create a second task');
});

test('tick: runs the isolated cycle to ACCEPTED and records memory', async () => {
  const root = tempRoot('tick');
  const store = seedBacklog(root, 'owner-01');
  const plan = planNext(store, mission());
  assert.equal(plan.action, 'enqueued');

  let outcome = null;
  for (let i = 0; i < 12; i++) {
    outcome = await tick({ root, mission: mission() });
    if (outcome.action === 'finished') break;
  }
  assert.equal(outcome.action, 'finished');
  assert.equal(outcome.result.state, 'ACCEPTED');
  assert.equal(outcome.result.artifactSha.length, 64);

  const item = new OpsStore(root).get(plan.taskId);
  assert.equal(item.status, STATUS.DONE);
  const memory = new OpsStore(root).memory();
  assert.equal(memory.facts.lastAcceptedTask, plan.taskId);
  assert.equal(new OpsStore(root).readCheckpoint().state, 'ACCEPTED');
});

test('restart: a new process continues the journal, single creation, single done', async () => {
  const root = tempRoot('restart');
  const store = seedBacklog(root, 'owner-02');
  const plan = planNext(store, mission());
  const shortMission = mission({ loop: { intervalSec: 5, maxTaskMinutes: 5, maxStepsPerTick: 1 } });

  const first = await tick({ root, mission: shortMission });
  assert.equal(first.action, 'partial');
  assert.equal(new OpsStore(root).get(plan.taskId).status, STATUS.PENDING);

  const headBefore = JSON.parse(fs.readFileSync(path.join(root, 'logs', plan.taskId, 'events.jsonl'), 'utf8').trim().split('\n').at(-1));

  let outcome = null;
  for (let i = 0; i < 12; i++) {
    outcome = await tick({ root, mission: mission() });
    if (outcome.action === 'finished') break;
  }
  assert.equal(outcome.result.state, 'ACCEPTED');

  const items = new OpsStore(root).list().filter((item) => item.taskId === plan.taskId);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, STATUS.DONE);

  const events = fs.readFileSync(path.join(root, 'logs', plan.taskId, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.to === 'CREATED').length, 1);
  assert.equal(events[0].hash, JSON.parse(fs.readFileSync(path.join(root, 'logs', plan.taskId, 'events.jsonl'), 'utf8').trim().split('\n')[0]).hash);
  assert.ok(events.length > headBefore.seq + 1);
});

test('STOP: planner and loop stop, restart keeps STOP, resume signs an event', async () => {
  const root = tempRoot('stop');
  const store = seedBacklog(root, 'owner-03');
  const plan = planNext(store, mission());
  assert.equal(plan.action, 'enqueued');

  store.requestStop('test stop');
  assert.equal(planNext(store, mission()).action, 'stopped');

  const outcome = await tick({ root, mission: mission() });
  assert.equal(outcome.action, 'stopped');
  assert.equal(new OpsStore(root).stopRequested(), true, 'STOP file must survive a new store instance');
  assert.equal(new OpsStore(root).get(plan.taskId).status, STATUS.PENDING, 'no lease is taken while stopped');

  const resume = new OpsStore(root);
  resume.clearStop();
  const signed = resume.signedJournal('service.resume_signed', null, { by: 'owner' });
  assert.match(signed.sig, /^[a-f0-9]{64}$/);
  assert.equal(resume.verifySignature(signed), true);
  assert.equal(resume.stopRequested(), false);
});

test('budget: hard overrun is detected and excludes ACCEPTED', async () => {
  const task = { maxTotalTokens: 200000, maxTotalRuntimeMinutes: 60, maxRuntimePerAgentMinutes: 20, softTotalTokens: 150000 };
  const over = budgetBreakdown({ usage: { totalTokens: 290851 }, runtimeMs: { implementer: 0, reviewer: 0 } }, task);
  assert.equal(over.hard.exceeded, true);
  assert.equal(over.soft.exceeded, true);

  const atLimit = budgetBreakdown({ usage: { totalTokens: 200000 }, runtimeMs: {} }, task);
  assert.equal(atLimit.hard.exceeded, false, 'reaching the limit is not exceeding it');

  const root = tempRoot('budget');
  const store = seedBacklog(root, 'owner-04');
  planNext(store, mission());
  const taskId = store.list()[0].taskId;
  /* Один шаг за тик: состояние артефакта наблюдаемо, а не проскакивает в ACCEPTED. */
  const stepMission = mission({ loop: { intervalSec: 5, maxTaskMinutes: 5, maxStepsPerTick: 1 } });

  for (let i = 0; i < 10; i++) {
    await tick({ root, mission: stepMission });
    const checkpoint = new OpsStore(root).readCheckpoint();
    if (!checkpoint || checkpoint.state === 'ARTIFACT_SUBMITTED' || checkpoint.state === 'REVIEWING') break;
  }

  const { Store } = await import('../../state/store.mjs');
  const journal = new Store(root, { operationId: 'test' });
  journal.appendEvent({ taskId, action: 'test.inject_usage', payload: { patch: { usage: { totalTokens: 290851 } } } });

  let outcome = null;
  for (let i = 0; i < 8; i++) {
    outcome = await tick({ root, mission: stepMission });
    if (outcome.action === 'finished') break;
  }
  assert.equal(outcome.action, 'finished', JSON.stringify(outcome));
  assert.equal(outcome.result.state, 'BLOCKED', JSON.stringify(outcome.result));
  assert.equal(new OpsStore(root).get(taskId).status, STATUS.BLOCKED);

  const events = fs.readFileSync(path.join(root, 'logs', taskId, 'events.jsonl'), 'utf8');
  assert.match(events, /budget\.overrun/);
  assert.match(events, /budget_overrun_hard/);
  assert.doesNotMatch(events, /"to":"ACCEPTED"/);
});

test('public status: allowlisted, schema-valid, no paths/pids/usernames', () => {
  const root = tempRoot('public');
  const store = seedBacklog(root, 'public-01');
  store.heartbeat({ state: 'idle' });
  const status = buildPublicStatus({ root, mission: mission() });

  const errors = validate(PUBLIC_SCHEMA, status);
  assert.deepEqual(errors, []);
  assert.deepEqual(auditPublicKeys(status), []);

  const json = JSON.stringify(status);
  assert.doesNotMatch(json, /\/tmp\/|\/srv\/|C:\\\\/);
  assert.doesNotMatch(json, /"pid":/);
  assert.doesNotMatch(json, /root|mark|LAPTOP/i);
  assert.doesNotMatch(json, /prompt|stderr|secret/i);
  assert.equal(status.deployment, 'not-enabled');
});

async function withApi(root, fn) {
  const server = createApi({ root, mission: mission() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('api: read-only, allowlisted, no writes', async () => {
  const root = tempRoot('api');
  const store = seedBacklog(root, 'api-01');
  planNext(store, mission());
  store.heartbeat({ state: 'idle' });

  await withApi(root, async (base) => {
    const status = await fetch(`${base}/ops/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    const body = await status.json();
    assert.equal(body.service, 'agentcoin-ops');
    assert.deepEqual(validate(PUBLIC_SCHEMA, body), []);
    assert.doesNotMatch(JSON.stringify(body), /"pid":|taskFile|lastError/);

    const queue = await (await fetch(`${base}/ops/queue`)).json();
    assert.equal(queue.queue.total, 1);
    assert.equal((await fetch(`${base}/ops/queue`, { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(`${base}/ops/status`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${base}/ops/nope`)).status, 404);
    const memory = await (await fetch(`${base}/ops/memory`)).json();
    assert.deepEqual(Object.keys(memory).sort(), ['decisions', 'lessons', 'ok', 'readonly']);
  });
});

test('watchdog and breaker report state instead of acting', async () => {
  const root = tempRoot('watchdog');
  const store = new OpsStore(root);
  store.heartbeat({ state: 'working' });
  assert.equal(checkWatchdog({ root }).verdict, 'alive');

  fs.writeFileSync(store.paths.heartbeatFile, JSON.stringify({ pid: 999999, host: os.hostname(), at: new Date(Date.now() - 3600 * 1000).toISOString(), state: 'working' }));
  const stale = checkWatchdog({ root });
  assert.equal(stale.verdict, 'attention');
  assert.ok(stale.problems.some((p) => p.code === 'HEARTBEAT_STALE'));

  const breakerStore = seedBacklog(root, 'brk-01');
  planNext(breakerStore, mission());
  const item = breakerStore.list()[0];
  breakerStore.fail(item.taskId, { status: STATUS.FAILED, reason: 'boom' });
  const breaker = breakerState(breakerStore, mission({ budget: { consecutiveFailureBreaker: 1 } }));
  assert.equal(breaker.tripped, true);
});
