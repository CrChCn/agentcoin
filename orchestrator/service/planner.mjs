#!/usr/bin/env node
/* Planner C1.1: задача ставится только по доказанному расхождению.

   Порядок:
   1. STOP-файл → ничего не создаётся;
   2. в очереди есть незавершённое задание → ничего не создаётся;
   3. контракт владельца из queue/backlog/*.json → в очередь;
   4. реестр проверок (queue/registry.json): если проверка доказывает
      расхождение, а такой задачи ещё не было (deduplicationKey), создаётся
      конечная задача с trigger {type, evidence, observedAt, deduplicationKey};
   5. доказанного основания нет → IDLE. Шаблон больше не клонируется:
      бесконечное повторение одной задачи под новыми taskId запрещено. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTask } from '../lib/engine.mjs';
import { canonical, readJson, sha256, writeJsonAtomic } from '../lib/fsx.mjs';

import { STATUS } from './store.mjs';
import { evaluateCheck } from './checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

export function loadMission(root, explicitFile = null) {
  const candidates = [explicitFile, path.join(path.resolve(root), 'queue', 'mission.json'), path.join(HERE, 'mission.json')].filter(Boolean);
  for (const file of candidates) {
    const mission = readJson(file, null);
    if (mission) return { mission, file };
  }
  throw Object.assign(new Error('mission.json not found'), { code: 'MISSION_MISSING' });
}

/* Задание владельца: контракт берётся как есть, меняется только идентичность.
   Планировщик не редактирует требования — иначе он стал бы автором ТЗ. */
export function taskFromTemplate({ templateFile, taskFile, taskId, titleSuffix = '' }) {
  const task = readJson(templateFile, null);
  if (!task) throw Object.assign(new Error(`template not found: ${templateFile}`), { code: 'TEMPLATE_MISSING' });
  const clone = { ...task, taskId, title: titleSuffix ? `${task.title} — ${titleSuffix}` : task.title };
  writeJsonAtomic(taskFile, clone);
  return path.resolve(taskFile);
}

/* Реестр ищется сначала в OPS_ROOT (владелец может править его без
   переустановки кода), затем рядом с сервисом. */
function registryPathOf(store, mission) {
  const local = path.join(store.paths.base, 'queue', 'registry.json');
  if (fs.existsSync(local)) return local;
  const configured = mission.planner && mission.planner.registry;
  if (!configured) return local;
  return path.isAbsolute(configured) ? configured : path.resolve(HERE, configured);
}

function repositoryRootOf(store, mission) {
  const configured = mission.repositoryRoot;
  if (!configured) return path.join(store.paths.base, 'repository');
  return path.isAbsolute(configured) ? configured : path.resolve(store.paths.base, configured);
}

export { repositoryRootOf };

/* Все уже известные ключи дедупликации: очередь (включая завершённые) и память. */
function knownDedupKeys(store) {
  const keys = new Set();
  for (const item of store.list()) {
    if (item.trigger && item.trigger.deduplicationKey) keys.add(item.trigger.deduplicationKey);
  }
  const memory = store.memory();
  for (const lesson of memory.lessons || []) if (lesson.dedupKey) keys.add(lesson.dedupKey);
  for (const decision of memory.decisions || []) if (decision.dedupKey) keys.add(decision.dedupKey);
  return keys;
}

/* Возвращает {action, taskId?, trigger?, evidence?, reason?}. */
export function planNext(store, mission, { now = new Date(), repositoryRoot = null } = {}) {
  if (store.stopRequested()) return { action: 'stopped', reason: 'STOP file present' };

  const items = store.list();
  const active = items.filter((item) => item.status === STATUS.PENDING || item.status === STATUS.LEASED);
  if (active.length) return { action: 'none', reason: 'queue not empty', active: active.map((item) => item.taskId) };

  const planner = mission.planner || {};
  if (planner.enabled === false) return { action: 'none', reason: 'planner disabled by mission' };

  /* 1) Задания владельца. */
  const backlog = fs.existsSync(store.paths.backlogDir)
    ? fs.readdirSync(store.paths.backlogDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  for (const name of backlog) {
    const source = path.join(store.paths.backlogDir, name);
    let task;
    try {
      task = loadTask(source);
    } catch (err) {
      store.journal('planner.backlog_rejected', null, { file: name, error: String(err.message || err) });
      continue;
    }
    const target = path.join(store.paths.tasksDir, `${task.taskId}.json`);
    fs.renameSync(source, target);
    store.enqueue({ taskId: task.taskId, title: task.title, priority: 1, taskFile: target, origin: 'owner-backlog' });
    return { action: 'enqueued', taskId: task.taskId, taskFile: target, origin: 'owner-backlog' };
  }

  /* 2) Реестр доказанных расхождений. */
  const registryFile = registryPathOf(store, mission);
  const registry = readJson(registryFile, { entries: [] });
  const entries = (registry.entries || []).filter((entry) => entry && entry.enabled !== false);
  if (!entries.length) {
    return { action: 'idle', reason: 'no backlog and an empty registry: nothing proven to fix', registry: registryFile };
  }

  const repoRoot = repositoryRoot ? path.resolve(repositoryRoot) : repositoryRootOf(store, mission);
  if (!fs.existsSync(repoRoot)) {
    return { action: 'idle', reason: 'repositoryRoot is absent; no evidence can be gathered', repositoryRoot: repoRoot };
  }

  const known = knownDedupKeys(store);
  const candidates = [];
  const evaluated = [];
  for (const entry of entries) {
    if (!entry.id || !entry.check || !entry.task) {
      evaluated.push({ id: entry.id || null, skipped: 'entry needs id, check and task' });
      continue;
    }
    const outcome = evaluateCheck(entry.check, { repositoryRoot: repoRoot });
    if (outcome.ok) {
      evaluated.push({ id: entry.id, ok: true });
      continue;
    }
    const dedupKey = sha256(canonical({ id: entry.id, signature: outcome.signature }));
    evaluated.push({ id: entry.id, ok: false, dedupKey });
    if (known.has(dedupKey)) continue;
    candidates.push({ entry, outcome, dedupKey });
  }

  if (!candidates.length) {
    return { action: 'idle', reason: 'no unhandled proven gap', evaluated };
  }

  candidates.sort((a, b) => (Number(a.entry.priority || 100) - Number(b.entry.priority || 100)) || String(a.entry.id).localeCompare(String(b.entry.id)));
  const chosen = candidates[0];
  const slug = String(chosen.entry.id).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40);
  const taskId = `${planner.taskPrefix || 'gap'}-${slug}-${stamp(now)}`.slice(0, 63);
  const taskFile = path.join(store.paths.tasksDir, `${taskId}.json`);

  const trigger = {
    type: chosen.entry.type || 'registry_gap',
    evidence: chosen.outcome.evidence.slice(0, 8),
    observedAt: now.toISOString(),
    deduplicationKey: chosen.dedupKey,
    registryId: chosen.entry.id,
  };
  const task = {
    ...chosen.entry.task,
    taskId,
    title: chosen.entry.task.title ? `${chosen.entry.task.title}` : taskId,
    trigger,
  };
  writeJsonAtomic(taskFile, task);
  /* Контракт проверяется до постановки: безвалидное ТЗ не попадает в очередь. */
  loadTask(taskFile);

  store.enqueue({ taskId, title: task.title, priority: Number(chosen.entry.priority || 100), taskFile, origin: 'planner-evidence', trigger });
  store.remember({
    decision: { kind: 'plan.evidence', taskId, registryId: chosen.entry.id, dedupKey: chosen.dedupKey, evidence: trigger.evidence },
  });
  return { action: 'enqueued', taskId, taskFile, origin: 'planner-evidence', trigger, evaluated };
}
