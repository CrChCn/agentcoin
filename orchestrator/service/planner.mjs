#!/usr/bin/env node
/* Planner C2: задача ставится только по доказанному расхождению, а повторный
   дефект получает новое поколение инцидента.

   Порядок:
   1. STOP-файл → ничего не создаётся;
   2. в очереди есть незавершённое задание → ничего не создаётся;
   3. контракт владельца из queue/backlog/*.json → в очередь;
   4. реестр проверок (queue/registry.json): проверка доказывает расхождение →
      инцидент OPEN → TASK_CREATED с trigger {type, evidence, observedAt,
      deduplicationKey, incident {id, generation}};
   5. проверка снова проходит → инцидент RESOLVED;
   6. дефект вернулся после RESOLVED → REOCCURRED, generation += 1 и новый
      ключ дедупликации, поэтому старый ключ не блокирует задачу навсегда;
   7. доказанного основания нет → IDLE. Шаблон не клонируется. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTask } from '../lib/engine.mjs';
import { canonical, readJson, sha256, writeJsonAtomic } from '../lib/fsx.mjs';
import { isRepo } from '../lib/git.mjs';

import { STATUS } from './store.mjs';
import { evaluateCheck } from './checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

const INCIDENT = Object.freeze({
  OPEN: 'OPEN',
  TASK_CREATED: 'TASK_CREATED',
  RESOLVED: 'RESOLVED',
  REOCCURRED: 'REOCCURRED',
});

export function loadMission(root, explicitFile = null) {
  const candidates = [explicitFile, path.join(path.resolve(root), 'queue', 'mission.json'), path.join(HERE, 'mission.json')].filter(Boolean);
  for (const file of candidates) {
    const mission = readJson(file, null);
    if (mission) return { mission, file };
  }
  throw Object.assign(new Error('mission.json not found'), { code: 'MISSION_MISSING' });
}

/* Реестр ищется сначала в OPS_ROOT (владелец может править его без
   переустановки кода), затем рядом с сервисом. */
export function registryPathOf(store, mission) {
  const local = path.join(store.paths.base, 'queue', 'registry.json');
  if (fs.existsSync(local)) return local;
  const configured = mission.planner && mission.planner.registry;
  if (!configured) return local;
  return path.isAbsolute(configured) ? configured : path.resolve(HERE, configured);
}

export function repositoryRootOf(store, mission) {
  const configured = mission.repositoryRoot;
  if (!configured) return path.join(store.paths.base, 'repository');
  return path.isAbsolute(configured) ? configured : path.resolve(store.paths.base, configured);
}

/* Ключ поколения инцидента. Меняется только при новом поколении, поэтому
   один и тот же дефект не ставится дважды, а вернувшийся после исправления —
   ставится снова. */
function generationKey(id, generation) {
  return sha256(canonical({ id, generation: Number(generation) || 1 }));
}

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

function incidentIndex(store) {
  const state = store.incidents();
  return { state, byId: new Map((state.items || []).map((item) => [item.id, item])) };
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
  const { state: incidentState, byId } = incidentIndex(store);
  /* Новые инциденты создаются в byId; перед записью переносим их в состояние. */
  const persistIncidents = () => { incidentState.items = [...byId.values()]; store.saveIncidents(incidentState); };
  const candidates = [];
  const evaluated = [];
  let dirty = false;

  for (const entry of entries) {
    if (!entry.id || !entry.check || !entry.task) {
      evaluated.push({ id: entry.id || null, skipped: 'entry needs id, check and task' });
      continue;
    }
    const outcome = evaluateCheck(entry.check, { repositoryRoot: repoRoot });
    if (outcome.skipped) {
      evaluated.push({ id: entry.id, skipped: outcome.error });
      continue;
    }

    let incident = byId.get(entry.id) || null;
    const observedAt = now.toISOString();

    if (outcome.ok) {
      /* Проверка проходит: если инцидент был открыт, он закрыт исправлением. */
      if (incident && incident.state !== INCIDENT.RESOLVED) {
        incident.state = INCIDENT.RESOLVED;
        incident.resolvedAt = observedAt;
        dirty = true;
      }
      evaluated.push({ id: entry.id, ok: true, incident: incident ? { id: incident.id, state: incident.state, generation: incident.generation } : null });
      continue;
    }

    if (!incident) {
      incident = {
        id: entry.id, generation: 1, state: INCIDENT.OPEN,
        signature: outcome.signature, firstSeenAt: observedAt, lastSeenAt: observedAt,
        taskIds: [],
      };
      byId.set(entry.id, incident);
      dirty = true;
    } else if (incident.state === INCIDENT.RESOLVED) {
      /* Дефект вернулся после исправления: новое поколение, новый ключ. */
      incident.generation = Number(incident.generation || 1) + 1;
      incident.state = INCIDENT.REOCCURRED;
      incident.reoccurredAt = observedAt;
      incident.resolvedAt = null;
      dirty = true;
    }
    incident.signature = outcome.signature;
    incident.lastSeenAt = observedAt;

    /* knownDedupKeys уже собирает trigger.deduplicationKey всех заданий очереди,
       включая завершённые, поэтому отдельная проверка «уже в очереди» была бы
       вторым ответом на тот же вопрос. */
    const dedupKey = generationKey(entry.id, incident.generation);
    const handled = known.has(dedupKey);
    evaluated.push({ id: entry.id, ok: false, generation: incident.generation, state: incident.state, dedupKey, handled });
    if (handled) continue;
    candidates.push({ entry, outcome, incident, dedupKey });
  }

  if (!candidates.length) {
    if (dirty) persistIncidents();
    return { action: 'idle', reason: 'no unhandled proven gap', evaluated };
  }

  candidates.sort((a, b) => (Number(a.entry.priority || 100) - Number(b.entry.priority || 100)) || String(a.entry.id).localeCompare(String(b.entry.id)));
  const chosen = candidates[0];
  const slug = String(chosen.entry.id).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40);
  /* Один и тот же дефект может быть доказан дважды в одну секунду (например,
     после возврата после RESOLVED), а taskId обязан быть уникальным. */
  const baseId = `${planner.taskPrefix || 'gap'}-${slug}-${stamp(now)}`.slice(0, 60);
  const taken = new Set(items.map((item) => item.taskId));
  let taskId = baseId;
  for (let suffix = 2; taken.has(taskId); suffix += 1) taskId = `${baseId}-${suffix}`.slice(0, 63);
  const taskFile = path.join(store.paths.tasksDir, `${taskId}.json`);

  const trigger = {
    type: chosen.entry.type || 'registry_gap',
    evidence: chosen.outcome.evidence.slice(0, 8),
    observedAt: now.toISOString(),
    deduplicationKey: chosen.dedupKey,
    registryId: chosen.entry.id,
    incident: { id: chosen.entry.id, generation: chosen.incident.generation, state: INCIDENT.TASK_CREATED },
  };
  const task = {
    ...chosen.entry.task,
    taskId,
    title: chosen.entry.task.title || taskId,
    trigger,
  };
  /* Расхождение доказано в repositoryRoot — работать нужно в нём. Без source
     движок берёт fixture-шаблон, где нужного пути может просто не быть, и
     задача «чинит» не тот репозиторий. Fixture остаётся путём тестов, а не
     рабочей петлёй. */
  if (!task.source && isRepo(repoRoot)) {
    task.source = { repo: repoRoot, ref: 'HEAD' };
  }
  writeJsonAtomic(taskFile, task);
  /* Контракт проверяется до постановки: безвалидное ТЗ не попадает в очередь. */
  loadTask(taskFile);

  chosen.incident.state = INCIDENT.TASK_CREATED;
  chosen.incident.dedupKey = chosen.dedupKey;
  chosen.incident.taskIds = [...(chosen.incident.taskIds || []), taskId];
  persistIncidents();

  store.enqueue({ taskId, title: task.title, priority: Number(chosen.entry.priority || 100), taskFile, origin: 'planner-evidence', trigger });
  store.remember({
    decision: {
      kind: 'plan.evidence', taskId, registryId: chosen.entry.id,
      dedupKey: chosen.dedupKey, generation: chosen.incident.generation, evidence: trigger.evidence,
    },
  });
  return {
    action: 'enqueued', taskId, taskFile, origin: 'planner-evidence', trigger,
    incident: { id: chosen.incident.id, generation: chosen.incident.generation, state: chosen.incident.state },
    evaluated,
  };
}
