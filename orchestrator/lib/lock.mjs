#!/usr/bin/env node
/* Межпроцессный lock задания.
   Критическая секция: load state → verify journal → reserve transition →
   запуск шага → append journal → write snapshot → release. Захват — атомарный
   rename подготовленного каталога: lock.json появляется уже заполненным,
   поэтому второй процесс не увидит полупустой lock.
   Неизвестный или «мёртвый» lock не снимается автоматически: возвращается
   NEEDS_RECONCILE и требует явного reconcile. */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { pidAlive, processVerdict, selfIdentity } from './procinfo.mjs';

/* Реэкспорт: остальные модули исторически импортируют pidAlive из lock. */
export { pidAlive };

export const TASK_BUSY = 'TASK_BUSY';
export const NEEDS_RECONCILE = 'NEEDS_RECONCILE';

export function lockPaths(root, taskId) {
  const base = path.join(path.resolve(root), 'locks');
  const dir = path.join(base, taskId);
  return { base, dir, file: path.join(dir, 'lock.json') };
}

export function readLock(root, taskId) {
  const { file } = lockPaths(root, taskId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function newOperationId() {
  return crypto.randomUUID();
}

/* Возвращает {ok, code, lock, operationId, release()}. */
export function acquireLock(root, taskId, { action = 'step', operationId = newOperationId(), pid = process.pid } = {}) {
  const { base, dir } = lockPaths(root, taskId);
  fs.mkdirSync(base, { recursive: true });

  /* hostId + bootId + processStartTime: pid сам по себе не доказывает, что
     владелец блокировки — тот же процесс (PID reuse после перезагрузки). */
  const identity = selfIdentity();
  const record = {
    taskId, operationId, pid, startedAt: new Date().toISOString(), action,
    hostId: identity.hostId, bootId: identity.bootId, processStartTime: identity.processStartTime,
  };
  const staging = path.join(base, `.${taskId}.${operationId}.tmp`);
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'lock.json'), `${JSON.stringify(record, null, 2)}\n`);

  try {
    fs.renameSync(staging, dir);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
    const existing = readLock(root, taskId);
    if (!existing) return { ok: false, code: NEEDS_RECONCILE, lock: null, reason: 'lock directory exists without a readable lock.json' };
    const verdict = processVerdict(existing);
    if (verdict.alive) return { ok: false, code: TASK_BUSY, lock: existing };
    return { ok: false, code: NEEDS_RECONCILE, lock: existing, reason: `lock owner is gone: ${verdict.reason}` };
  }

  let released = false;
  return {
    ok: true,
    code: null,
    operationId,
    record,
    release() {
      if (released) return;
      released = true;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* Явное восстановление после падения. Автоматически не снимается ничего. */
export function reconcileLock(root, taskId, { force = false } = {}) {
  const { dir } = lockPaths(root, taskId);
  if (!fs.existsSync(dir)) return { ok: true, reconciled: false, reason: 'no lock' };
  const lock = readLock(root, taskId);
  if (!lock) {
    return { ok: false, code: NEEDS_RECONCILE, reason: 'lock directory exists without a readable lock.json; inspect it manually' };
  }
  const verdict = processVerdict(lock);
  if (verdict.alive) {
    return { ok: false, code: TASK_BUSY, lock, reason: `lock owner is still running: ${verdict.reason}` };
  }
  if (!force) {
    return { ok: false, code: NEEDS_RECONCILE, lock, reason: `lock owner is gone (${verdict.reason}); re-run with --force` };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, reconciled: true, lock };
}

export function lockStatus(root, taskId) {
  const { dir } = lockPaths(root, taskId);
  if (!fs.existsSync(dir)) return { locked: false, lock: null };
  const lock = readLock(root, taskId);
  if (!lock) return { locked: true, lock: null, ownerAlive: null };
  const verdict = processVerdict(lock);
  return { locked: true, lock, ownerAlive: verdict.alive, verdict };
}
