#!/usr/bin/env node
/* Публичное представление статуса: собирается из allowlist, а не вырезанием
   полей из внутреннего объекта. Даже если внутри появится новое приватное
   поле, в публичный JSON оно не попадёт без отдельного решения.

   Запрещено публиковать: абсолютные пути, usernames, PID, внутренние адреса,
   task prompts, stderr, credentials, operational memory, имена секретов.
   Форма ответа зафиксирована contracts/public-status.schema.json. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertValid } from '../lib/schema.mjs';
import { readJson } from '../lib/fsx.mjs';

import { OpsStore, STATUS } from './store.mjs';

const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'public-status.schema.json');
const PUBLIC_STATUS_SCHEMA = readJson(SCHEMA, null);

const ALLOWED_STATES = new Set([
  'never-started', 'starting', 'idle', 'working', 'partial', 'recovering', 'waiting',
  'stopped', 'stopping', 'stopped-by-signal', 'breaker', 'unknown',
]);
const ALLOWED_TRIGGERS = new Set(['registry_gap', 'health_failure', 'roadmap_item', 'owner_goal']);
const ALLOWED_ITEM = new Set([STATUS.PENDING, STATUS.LEASED, STATUS.DONE, STATUS.FAILED, STATUS.BLOCKED]);

function publicTask(item) {
  const result = item.result || {};
  const commit = typeof result.commit === 'string' && /^[0-9a-f]{7,40}$/.test(result.commit) ? result.commit : null;
  const artifactSha = typeof result.artifactSha === 'string' && /^[a-f0-9]{64}$/.test(result.artifactSha) ? result.artifactSha : null;
  const triggerType = item.trigger && ALLOWED_TRIGGERS.has(item.trigger.type) ? item.trigger.type : null;
  return {
    taskId: item.taskId,
    status: ALLOWED_ITEM.has(item.status) ? item.status : STATUS.PENDING,
    attempts: Number.isInteger(item.attempts) ? item.attempts : 0,
    commit,
    artifactSha,
    triggerType,
  };
}

export function buildPublicStatus({ root, mission = null, now = new Date(), staleAfterSec = 900 } = {}) {
  const store = new OpsStore(root, { readOnly: true });
  const beat = store.readHeartbeat();
  const age = store.heartbeatAgeSec(now);
  const counts = store.counts();
  const items = store.list()
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 20)
    .map(publicTask);

  const status = {
    service: 'agentcoin-ops',
    generatedAt: now.toISOString(),
    orchestrator: {
      state: ALLOWED_STATES.has(beat.state) ? beat.state : 'unknown',
      stale: age == null ? true : age > staleAfterSec,
      heartbeatAgeSec: age,
      continuous: Boolean(mission && mission.continuous),
    },
    queue: {
      pending: counts.pending, leased: counts.leased, done: counts.done,
      failed: counts.failed, blocked: counts.blocked, total: counts.total,
    },
    tasks: items,
    mission: {
      title: mission && mission.mission ? String(mission.mission).slice(0, 300) : 'mission not configured',
      priorities: mission && Array.isArray(mission.priorities)
        ? mission.priorities.slice(0, 12).map((p) => String(p).slice(0, 80))
        : [],
    },
    deployment: 'not-enabled',
  };

  if (PUBLIC_STATUS_SCHEMA) assertValid(PUBLIC_STATUS_SCHEMA, status, 'public-status');
  return status;
}

/* Страховка для тестов утечки: ни один ключ вне allowlist не должен появиться
   ни на одном уровне публичного объекта. */
export function auditPublicKeys(value) {
  const allowed = new Set(Object.keys((PUBLIC_STATUS_SCHEMA && PUBLIC_STATUS_SCHEMA.properties) || {}));
  const taskProps = new Set(Object.keys((PUBLIC_STATUS_SCHEMA && PUBLIC_STATUS_SCHEMA.properties.tasks.items.properties) || {}));
  const problems = [];
  const extraTop = Object.keys(value || {}).filter((key) => !allowed.has(key));
  if (extraTop.length) problems.push({ level: 'root', keys: extraTop });
  for (const task of value.tasks || []) {
    const extra = Object.keys(task).filter((key) => !taskProps.has(key));
    if (extra.length) problems.push({ level: 'task', taskId: task.taskId, keys: extra });
  }
  return problems;
}
