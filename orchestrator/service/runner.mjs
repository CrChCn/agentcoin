#!/usr/bin/env node
/* Исполнитель сервиса: один tick = восстановление → планирование → шаги
   задания → запись результата. Цикл повторяет tick с паузой.

   Что здесь важно для «always-on»:
   - после SIGTERM процесс не рвёт шаг: он доигрывает текущий переход движка,
     пишет checkpoint и выходит;
   - после аварийного завершения следующий процесс видит lease мёртвого pid,
     возвращает задание в pending и продолжает его с состояния из журнала,
     а не с начала;
   - lock мёртвого владельца снимается только для задания из очереди, только
     если журнал задания цел, и это отдельное событие lock.reconciled;
   - настоящие адаптеры (codex-*) включаются лишь при mission.allowRealAgents
     и доказанной изоляции; по умолчанию работают детерминированные дублёры. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TERMINAL, initTask, report, step } from '../lib/engine.mjs';
import { Store } from '../state/store.mjs';
import { lockStatus, reconcileLock } from '../lib/lock.mjs';
import { detectSandbox } from '../lib/sandbox.mjs';
import { isolationEvidence } from '../lib/agentsandbox.mjs';

import { OpsStore, STATUS } from './store.mjs';
import { planNext } from './planner.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function realAgentsGate(mission) {
  const requested = mission.adapters && mission.adapters.mode === 'real';
  if (!requested) return { requested: false, ok: false, detail: 'mission.adapters.mode is not real' };
  if (mission.allowRealAgents !== true) {
    return { requested: true, ok: false, detail: 'mission.allowRealAgents is not true' };
  }
  const sandbox = detectSandbox();
  const evidence = isolationEvidence(undefined, { backend: sandbox.backend });
  const smokeTested = sandbox.levels ? sandbox.levels.smokeTested === true : false;
  return {
    requested: true,
    ok: smokeTested && evidence.ok === true,
    backend: sandbox.backend,
    smokeTested,
    adapterEndToEnd: evidence.ok === true,
    detail: smokeTested
      ? (evidence.ok ? 'isolation proven' : evidence.detail)
      : `isolation backend not smoke-tested: ${sandbox.detail || 'none'}`,
  };
}

/* Снятие lock мёртвого владельца: только своё задание, только мёртвый pid,
   только целый журнал. Возвращает список снятых блокировок. */
export function reconcileDeadLocks(store, queueItems) {
  const reconciled = [];
  for (const item of queueItems) {
    const status = lockStatus(store.paths.base, item.taskId);
    if (!status.locked || !status.lock) continue;
    /* Решение по всей комбинации hostId + bootId + pid + processStartTime:
       pid сам по себе после перезагрузки может принадлежать другому процессу. */
    if (status.ownerAlive) continue;
    let journalOk = true;
    try {
      journalOk = new Store(store.paths.base, { readOnly: true }).verifyJournal(item.taskId).ok;
    } catch {
      journalOk = false;
    }
    if (!journalOk) {
      store.journal('lock.reconcile_refused', item.taskId, { reason: 'journal does not verify', lock: status.lock });
      continue;
    }
    const result = reconcileLock(store.paths.base, item.taskId, { force: true });
    if (result.ok) {
      reconciled.push({ taskId: item.taskId, lock: result.lock });
      store.journal('lock.reconciled', item.taskId, {
        deadPid: status.lock.pid,
        operationId: status.lock.operationId,
        reason: status.verdict ? status.verdict.reason : null,
        weak: status.verdict ? status.verdict.weak : null,
        bootId: status.lock.bootId || null,
        processStartTime: status.lock.processStartTime ?? null,
      });
    } else {
      store.journal('lock.reconcile_refused', item.taskId, { code: result.code, reason: result.reason });
    }
  }
  return reconciled;
}

function adaptersFor(mission, gate) {
  const adapters = mission.adapters || {};
  if (gate.requested && gate.ok) {
    return { implementer: adapters.implementer || 'codex-implementer', reviewer: adapters.reviewer || 'codex-reviewer', real: true };
  }
  return { implementer: adapters.fixtureImplementer || 'fixture-implementer', reviewer: adapters.fixtureReviewer || 'fixture-reviewer', real: false };
}

/* Предохранитель: несколько подряд неудачных заданий — это не повод
   продолжать. Пока breaker не снят владельцем (правкой очереди/памяти),
   планировщик новых задач не создаёт. */
export function breakerState(store, mission) {
  const limit = Number((mission.budget || {}).consecutiveFailureBreaker || 0);
  if (!limit) return { tripped: false, failures: 0, limit: 0 };
  const terminal = store.list()
    .filter((item) => item.status === STATUS.FAILED || item.status === STATUS.BLOCKED || item.status === STATUS.DONE)
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  let failures = 0;
  for (let i = terminal.length - 1; i >= 0; i--) {
    if (terminal[i].status === STATUS.DONE) break;
    failures += 1;
  }
  return { tripped: failures >= limit, failures, limit };
}

/* Источник должен быть доступен только на чтение: запись в source-репозиторий
   означала бы, что агент меняет базу будущих задач, а не только свою копию.
   По умолчанию это предупреждение в журнале; enforceReadOnly=true блокирует. */
export function sourceAccess(store, mission, taskFile) {
  try {
    const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    if (!task || !task.source || !task.source.repo) return { checked: false, reason: 'task has no source repo' };
    const repoPath = path.isAbsolute(task.source.repo) ? task.source.repo : path.resolve(store.paths.base, task.source.repo);
    if (!fs.existsSync(repoPath)) return { checked: true, exists: false, repo: task.source.repo };
    let writable = false;
    try {
      fs.accessSync(repoPath, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    return { checked: true, exists: true, writable, repo: task.source.repo, enforced: Boolean((mission.sourceRequirements || {}).enforceReadOnly) };
  } catch (err) {
    return { checked: false, reason: String(err.message || err) };
  }
}

/* Один шаг задания с heartbeat. Возвращает состояние или null при отказе
   lock. Отказ lock не блокирует задание: это ответ «занято». */
async function stepOnce({ store, taskId, timeboxMs, startedAt }) {
  if (Date.now() - startedAt > timeboxMs) return { stop: 'timebox' };
  try {
    const state = await step({ root: store.paths.base, taskId });
    store.checkpoint({ taskId, state: state.state, iteration: state.iteration, seq: state.seq });
    store.heartbeat({ state: 'working', taskId, taskState: state.state, iteration: state.iteration });
    return { state };
  } catch (err) {
    if (err.code === 'TASK_BUSY' || err.code === 'NEEDS_RECONCILE') {
      return { stop: 'locked', code: err.code, reason: err.reason || null };
    }
    throw err;
  }
}

export async function tick({ root, mission, signal = null } = {}) {
  const store = new OpsStore(root);
  const startedAt = Date.now();
  const loop = mission.loop || {};
  const timeboxMs = Math.min(Number(loop.maxTaskMinutes || 30), 480) * 60 * 1000;
  const maxSteps = Number.isInteger(loop.maxStepsPerTick) ? loop.maxStepsPerTick : 8;

  const released = store.releaseExpiredLeases();
  if (released.length) {
    store.heartbeat({ state: 'recovering', released: released.map((r) => r.taskId) });
    for (const record of released) store.journal('lease.released_after_crash', record.taskId, record.verdict || null);
  }

  const queueItems = store.list();
  const reconciled = reconcileDeadLocks(store, queueItems.filter((item) => item.status === STATUS.LEASED || item.status === STATUS.PENDING));

  if (store.stopRequested()) {
    /* STOP сильнее планировщика и аренды: ни задача не создаётся, ни шаг не
       начинается. Файл на диске переживает перезапуск процесса. */
    store.heartbeat({ state: 'stopped', stopFile: store.paths.stopFile });
    return { action: 'stopped', released, reconciled };
  }

  const breaker = breakerState(store, mission);
  if (breaker.tripped) {
    store.heartbeat({ state: 'breaker', failures: breaker.failures, limit: breaker.limit });
    return { action: 'breaker', breaker, released, reconciled };
  }

  const gate = realAgentsGate(mission);
  const plan = planNext(store, mission);
  const item = store.claimNext({ runId: `${os.hostname()}-${process.pid}` });
  if (!item) {
    store.checkpoint({ taskId: null, state: 'idle', iteration: null, seq: null });
    store.heartbeat({ state: 'idle', gate: gate.requested ? { ok: gate.ok, detail: gate.detail } : null });
    return { action: plan.action === 'enqueued' ? 'planned' : 'idle', plan, released, reconciled, gate };
  }

  const source = item.taskFile ? sourceAccess(store, mission, item.taskFile) : { checked: false, reason: 'no task file' };
  if (source.checked && source.exists && source.writable) {
    store.journal('source.writable', item.taskId, source);
    if (source.enforced) {
      store.fail(item.taskId, { status: STATUS.BLOCKED, reason: 'source repository is writable; read-only access is required' });
      store.heartbeat({ state: 'idle', lastError: 'source_not_read_only' });
      return { action: 'source-refused', taskId: item.taskId, source, released, reconciled };
    }
  }

  store.heartbeat({ state: 'working', taskId: item.taskId, taskState: 'starting' });
  const choice = adaptersFor(mission, gate);
  const engineStore = new Store(store.paths.base, { readOnly: true });

  try {
    if (!engineStore.exists(item.taskId)) {
      if (!item.taskFile) throw Object.assign(new Error(`queue item ${item.taskId} has no taskFile`), { code: 'QUEUE_NO_TASK_FILE' });
      initTask({
        root: store.paths.base,
        taskFile: item.taskFile,
        implementer: choice.implementer,
        reviewer: choice.reviewer,
        confirmRealAgents: choice.real ? item.taskId : null,
      });
      store.journal('task.initialised', item.taskId, { adapters: choice });
    }
  } catch (err) {
    store.fail(item.taskId, { status: STATUS.BLOCKED, reason: `${err.code || 'INIT_FAILED'}: ${err.message}` });
    store.heartbeat({ state: 'idle' });
    return { action: 'init-failed', taskId: item.taskId, error: String(err.message || err), released, reconciled };
  }

  let state = engineStore.load(item.taskId);
  let steps = 0;
  let stop = null;
  while (!TERMINAL.has(state.state) && steps < maxSteps) {
    if (signal && signal.aborted) { stop = 'signal'; break; }
    const outcome = await stepOnce({ store, taskId: item.taskId, timeboxMs, startedAt });
    steps += 1;
    if (outcome.stop) { stop = outcome.stop; if (outcome.code) stop = outcome.code; break; }
    state = outcome.state;
  }

  if (!TERMINAL.has(state.state)) {
    /* Не терминальное состояние: шаг движка уже закрыт и lock снят, поэтому
       аренда возвращается в pending с чекпойнтом. Следующий tick (в этом или
       новом процессе) продолжит задание с состояния в журнале. */
    store.releaseLease(item.taskId, { reason: `partial: ${state.state} (${stop || 'step limit'})` });
    store.heartbeat({ state: 'partial', taskId: item.taskId, taskState: state.state, steps, stop });
    return { action: 'partial', taskId: item.taskId, state: state.state, steps, stop, released, reconciled };
  }

  const final = report({ root: store.paths.base, taskId: item.taskId });
  const result = {
    state: final.state,
    commit: final.resultCommit || null,
    baseCommit: final.baseCommit || null,
    artifactSha: final.acceptedArtifactSha256 || (final.artifact && final.artifact.sha256) || null,
    reportPath: final.reportPath || null,
    iterations: final.iteration,
    findings: (final.findings || []).map((f) => f.code),
  };

  if (final.state === 'ACCEPTED') {
    store.complete(item.taskId, result);
    store.remember({
      facts: { lastAcceptedTask: item.taskId, lastAcceptedCommit: result.commit, lastAcceptedAt: new Date().toISOString() },
      lesson: { kind: 'accepted', task: item.taskId, commit: result.commit, artifactSha: result.artifactSha, iterations: result.iterations },
    });
  } else {
    store.fail(item.taskId, {
      status: final.state === 'FAILED' ? STATUS.FAILED : STATUS.BLOCKED,
      reason: final.reason || final.blockedCode || final.state,
      result,
      retry: final.state !== 'BLOCKED',
    });
    store.remember({ lesson: { kind: final.state.toLowerCase(), task: item.taskId, reason: final.reason || final.blockedCode || null, findings: result.findings } });
  }
  store.heartbeat({ state: 'idle', lastTask: item.taskId, lastState: final.state });
  return { action: 'finished', taskId: item.taskId, result, steps, released, reconciled };
}

/* Постоянный цикл. Останавливается по SIGTERM/SIGINT: доигрывает текущий шаг,
   пишет checkpoint и выходит с кодом 0. */
export async function loop({ root, mission, once = false, untilIdle = false, onTick = null } = {}) {
  const store = new OpsStore(root);
  const controller = new AbortController();
  let stopping = false;
  const stop = (name) => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    try {
      store.heartbeat({ state: 'stopping', signal: name });
      store.checkpoint({ ...(store.readCheckpoint() || {}), stopSignal: name, at: new Date().toISOString() });
    } catch {}
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const intervalSec = Math.max(5, Number((mission.loop || {}).intervalSec || 60));
  let ticks = 0;
  const results = [];
  while (!stopping) {
    if (store.stopRequested()) {
      store.heartbeat({ state: 'stopped', reason: 'STOP file' });
      break;
    }
    const outcome = await tick({ root, mission, signal: controller.signal });
    ticks += 1;
    results.push(outcome);
    if (onTick) onTick(outcome);
    if (once) break;
    if (untilIdle && (outcome.action === 'idle' || outcome.action === 'stopped')) break;
    if (stopping) break;
    const queue = store.counts();
    store.heartbeat({ state: 'waiting', nextTickInSec: intervalSec, queue });
    await sleep(Math.min(intervalSec * 1000, 1500));
    if (untilIdle && store.counts().pending === 0) break;
  }
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  store.heartbeat({ state: stopping ? 'stopped-by-signal' : 'idle', ticks });
  return { ticks, results };
}
