#!/usr/bin/env node
/* Долговременное состояние сервиса: очередь заданий, память проекта,
   heartbeat, checkpoint и журнал действий сервиса.

   Правила, на которых держится восстановление:
   - queue.json пишется атомарно (tmp + fsync + rename), поэтому падение
     процесса не оставляет половину файла;
   - очередь не является источником истины о шагах задания: шаги живут в
     hash-журнале движка (logs/<taskId>/events.jsonl). Очередь хранит только
     «какое задание взято» и «чем оно кончилось»;
   - lease содержит pid и хост: после перезапуска просроченный lease с мёртвым
     pid возвращается в pending, и это видно в журнале (lease.expired);
   - повторная постановка того же taskId запрещена: QUEUE_DUPLICATE. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { appendJsonl, ensureDir, readJson, readJsonl, writeJsonAtomic } from '../lib/fsx.mjs';
import { pidAlive } from '../lib/lock.mjs';
import { hostId as machineId, processStartTime, processVerdict, selfIdentity } from '../lib/procinfo.mjs';

export const STATUS = Object.freeze({
  PENDING: 'pending',
  LEASED: 'leased',
  DONE: 'done',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});

const TERMINAL_ITEM = new Set([STATUS.DONE, STATUS.FAILED, STATUS.BLOCKED]);

export function resolvePaths(root) {
  const base = path.resolve(root);
  return {
    base,
    queueFile: path.join(base, 'queue', 'queue.json'),
    queueJournal: path.join(base, 'queue', 'journal.jsonl'),
    tasksDir: path.join(base, 'queue', 'tasks'),
    backlogDir: path.join(base, 'queue', 'backlog'),
    stopFile: path.join(base, 'queue', 'STOP'),
    missionFile: path.join(base, 'queue', 'mission.json'),
    memoryFile: path.join(base, 'project-memory', 'memory.json'),
    lessonsFile: path.join(base, 'project-memory', 'lessons.jsonl'),
    heartbeatFile: path.join(base, 'state', 'heartbeat.json'),
    checkpointFile: path.join(base, 'state', 'checkpoint.json'),
    watchdogFile: path.join(base, 'state', 'watchdog.json'),
    runsDir: path.join(base, 'runs'),
    artifactsDir: path.join(base, 'artifacts'),
    logsDir: path.join(base, 'logs'),
    workspacesDir: path.join(base, 'workspaces'),
  };
}

const nowIso = () => new Date().toISOString();
const newRunId = () => crypto.randomUUID();

function emptyQueue() {
  return { version: 1, seq: 0, items: [] };
}

export class OpsStore {
  constructor(root, { readOnly = false, host = os.hostname() } = {}) {
    this.paths = resolvePaths(root);
    this.readOnly = readOnly;
    this.host = host;
  }

  /* ---------- очередь ---------- */

  load() {
    const queue = readJson(this.paths.queueFile, null);
    if (!queue || !Array.isArray(queue.items)) return emptyQueue();
    return queue;
  }

  save(queue) {
    if (this.readOnly) throw Object.assign(new Error('store is read-only'), { code: 'READ_ONLY' });
    return writeJsonAtomic(this.paths.queueFile, queue);
  }

  journal(event, taskId = null, detail = null) {
    if (this.readOnly) return null;
    const queue = this.load();
    const entry = { seq: queue.seq, at: nowIso(), host: this.host, event, taskId, detail };
    appendJsonl(this.paths.queueJournal, entry);
    queue.seq += 1;
    this.save(queue);
    return entry;
  }

  list() {
    return this.load().items.map((item) => ({ ...item }));
  }

  get(taskId) {
    return this.load().items.find((item) => item.taskId === taskId) || null;
  }

  enqueue({ taskId, title, priority = 100, taskFile, origin = 'owner', trigger = null }) {
    if (this.readOnly) throw Object.assign(new Error('store is read-only'), { code: 'READ_ONLY' });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(String(taskId || ''))) {
      throw Object.assign(new Error(`invalid taskId: ${taskId}`), { code: 'QUEUE_BAD_TASK_ID' });
    }
    const queue = this.load();
    if (queue.items.some((item) => item.taskId === taskId)) {
      throw Object.assign(new Error(`task ${taskId} is already in the queue`), { code: 'QUEUE_DUPLICATE', taskId });
    }
    const at = nowIso();
    queue.items.push({
      taskId,
      title: title || taskId,
      priority: Number.isFinite(priority) ? priority : 100,
      origin,
      status: STATUS.PENDING,
      trigger: trigger || null,
      attempts: 0,
      maxAttempts: 2,
      taskFile: taskFile ? path.resolve(taskFile) : null,
      createdAt: at,
      updatedAt: at,
      lease: null,
      result: null,
      lastError: null,
    });
    this.save(queue);
    this.journal('queue.enqueued', taskId, { origin, priority, trigger: trigger ? { type: trigger.type, deduplicationKey: trigger.deduplicationKey } : null });
    return this.get(taskId);
  }

  /* Захват следующего задания. Порядок: priority ↑, createdAt ↑, taskId. */
  claimNext({ runId = newRunId(), pid = process.pid } = {}) {
    if (this.readOnly) throw Object.assign(new Error('store is read-only'), { code: 'READ_ONLY' });
    const queue = this.load();
    const candidate = queue.items
      .filter((item) => item.status === STATUS.PENDING)
      .sort((a, b) => (a.priority - b.priority) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.taskId.localeCompare(b.taskId))[0];
    if (!candidate) return null;
    /* hostId + bootId + processStartTime: после перезагрузки тот же pid может
       принадлежать другому процессу, поэтому lease фиксирует всю комбинацию. */
    const identity = selfIdentity();
    candidate.status = STATUS.LEASED;
    candidate.lease = {
      runId, host: this.host, at: nowIso(),
      hostId: identity.hostId, bootId: identity.bootId, pid,
      processStartTime: identity.processStartTime, taskId: candidate.taskId,
      operationId: runId,
    };
    candidate.updatedAt = nowIso();
    this.save(queue);
    this.journal('queue.claimed', candidate.taskId, { runId, pid, attempt: candidate.attempts });
    return { ...candidate };
  }

  /* Просроченные lease мёртвых процессов возвращаются в pending.
     Живой pid не трогаем никогда: два писателя в один журнал запрещены. */
  releaseExpiredLeases({ pidAliveFn = pidAlive, current = null } = {}) {
    if (this.readOnly) return [];
    const queue = this.load();
    const released = [];
    for (const item of queue.items) {
      if (item.status !== STATUS.LEASED || !item.lease) continue;
      const verdict = processVerdict(item.lease, { pidAliveFn, current });
      if (verdict.alive) continue;
      item.status = STATUS.PENDING;
      item.lastError = `lease owner is gone: ${verdict.reason}`;
      released.push({ taskId: item.taskId, lease: item.lease, attempts: item.attempts, verdict });
      item.lease = null;
      item.updatedAt = nowIso();
    }
    if (released.length) {
      this.save(queue);
      for (const record of released) this.journal('lease.expired', record.taskId, record);
    }
    return released;
  }

  /* Возврат аренды без изменения состояния задания: tick закончился по
     таймбоксу или сигналу, шаг движка уже закрыт. Попытка при этом не
     расходуется — attempts считает отказы, а не тики. */
  releaseLease(taskId, { reason = 'tick finished before terminal state' } = {}) {
    if (this.readOnly) throw Object.assign(new Error('store is read-only'), { code: 'READ_ONLY' });
    const queue = this.load();
    const item = queue.items.find((entry) => entry.taskId === taskId);
    if (!item || item.status !== STATUS.LEASED) return item ? { ...item } : null;
    item.status = STATUS.PENDING;
    item.lease = null;
    item.updatedAt = nowIso();
    this.save(queue);
    this.journal('lease.released', taskId, { reason });
    return { ...item };
  }

  complete(taskId, result) {
    if (this.readOnly) throw Object.assign(new Error('store is read-only'), { code: 'READ_ONLY' });
    const queue = this.load();
    const item = queue.items.find((entry) => entry.taskId === taskId);
    if (!item) throw Object.assign(new Error(`unknown queue item ${taskId}`), { code: 'QUEUE_UNKNOWN' });
    if (TERMINAL_ITEM.has(item.status)) return { ...item };
    item.status = STATUS.DONE;
    item.result = result;
    item.lease = null;
    item.lastError = null;
    item.updatedAt = nowIso();
    this.save(queue);
    this.journal('queue.done', taskId, { state: result && result.state, commit: result && result.commit });
    return { ...item };
  }

  fail(taskId, { status = STATUS.FAILED, reason, result = null, retry = false } = {}) {
    if (this.readOnly) throw Object.assign(new Error('store is read-only'), { code: 'READ_ONLY' });
    const queue = this.load();
    const item = queue.items.find((entry) => entry.taskId === taskId);
    if (!item) throw Object.assign(new Error(`unknown queue item ${taskId}`), { code: 'QUEUE_UNKNOWN' });
    if (TERMINAL_ITEM.has(item.status)) return { ...item };
    item.attempts += 1;
    const canRetry = retry && item.attempts < item.maxAttempts;
    item.status = canRetry ? STATUS.PENDING : status;
    item.result = result;
    item.lastError = reason || null;
    item.lease = null;
    item.updatedAt = nowIso();
    this.save(queue);
    this.journal(canRetry ? 'queue.retry' : status === STATUS.BLOCKED ? 'queue.blocked' : 'queue.failed', taskId, { reason, attempts: item.attempts });
    return { ...item };
  }

  counts() {
    const items = this.list();
    const out = { pending: 0, leased: 0, done: 0, failed: 0, blocked: 0, total: items.length };
    for (const item of items) if (out[item.status] != null) out[item.status] += 1;
    return out;
  }

  stopRequested() {
    return fs.existsSync(this.paths.stopFile);
  }

  requestStop(reason = 'owner stop') {
    if (this.readOnly) throw Object.assign(new Error('store is read-only'), { code: 'READ_ONLY' });
    ensureDir(path.dirname(this.paths.stopFile));
    fs.writeFileSync(this.paths.stopFile, `${nowIso()} ${reason}\n`);
    this.journal('service.stop_requested', null, { reason });
    return this.paths.stopFile;
  }

  clearStop() {
    if (this.readOnly) throw Object.assign(new Error('store is read-only'), { code: 'READ_ONLY' });
    fs.rmSync(this.paths.stopFile, { force: true });
    this.journal('service.stop_cleared', null, null);
  }

  /* ---------- heartbeat и checkpoint ---------- */

  heartbeat(patch = {}) {
    if (this.readOnly) return null;
    const previous = this.readHeartbeat();
    const next = {
      ...previous,
      ...patch,
      pid: process.pid,
      host: this.host,
      at: nowIso(),
    };
    writeJsonAtomic(this.paths.heartbeatFile, next);
    return next;
  }

  readHeartbeat() {
    return readJson(this.paths.heartbeatFile, null) || { pid: null, host: null, at: null, state: 'never-started' };
  }

  heartbeatAgeSec(at = new Date()) {
    const beat = this.readHeartbeat();
    if (!beat.at) return null;
    const time = Date.parse(beat.at);
    if (!Number.isFinite(time)) return null;
    return Math.max(0, Math.round((at.getTime() - time) / 1000));
  }

  checkpoint({ taskId, state, iteration, seq }) {
    if (this.readOnly) return null;
    const record = { at: nowIso(), taskId: taskId || null, state: state || null, iteration: iteration ?? null, seq: seq ?? null };
    writeJsonAtomic(this.paths.checkpointFile, record);
    return record;
  }

  readCheckpoint() {
    return readJson(this.paths.checkpointFile, null);
  }

  /* ---------- память проекта ---------- */

  memory() {
    return readJson(this.paths.memoryFile, null) || { version: 1, facts: {}, decisions: [], lessons: [] };
  }

  remember({ facts = {}, decision = null, lesson = null } = {}) {
    if (this.readOnly) throw Object.assign(new Error('store is read-only'), { code: 'READ_ONLY' });
    const memory = this.memory();
    Object.assign(memory.facts, facts);
    if (decision) memory.decisions.push({ at: nowIso(), ...decision });
    if (lesson) {
      const entry = { at: nowIso(), ...lesson };
      memory.lessons.push(entry);
      appendJsonl(this.paths.lessonsFile, entry);
    }
    memory.updatedAt = nowIso();
    writeJsonAtomic(this.paths.memoryFile, memory);
    return memory;
  }

  lessons(limit = 50) {
    return readJsonl(this.paths.lessonsFile).slice(-limit);
  }

  /* Событие без смены состояния: подпись (HMAC-SHA256 машины) приклеивается
     к каноническому телу записи. Ключ хранится в state/machine.key (0600). */
  signedJournal(event, taskId = null, detail = null) {
    if (this.readOnly) return null;
    const queue = this.load();
    const entry = {
      seq: queue.seq, at: nowIso(), hostId: machineId(), event, taskId, detail,
    };
    const key = this.machineKey();
    entry.keyId = key ? key.keyId : null;
    entry.sig = key ? crypto.createHmac('sha256', key.secret).update(JSON.stringify(entry)).digest('hex') : null;
    appendJsonl(this.paths.queueJournal, entry);
    queue.seq += 1;
    this.save(queue);
    return entry;
  }

  machineKey() {
    if (this._machineKey !== undefined) return this._machineKey;
    const file = path.join(this.paths.base, 'state', 'machine.key');
    if (this.readOnly) {
      this._machineKey = fs.existsSync(file) ? { keyId: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16), secret: fs.readFileSync(file) } : null;
      return this._machineKey;
    }
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    const secret = fs.readFileSync(file);
    this._machineKey = { keyId: crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16), secret };
    return this._machineKey;
  }

  verifySignature(entry) {
    const key = this.machineKey();
    if (!key || !entry || !entry.sig) return false;
    const { sig, ...rest } = entry;
    return crypto.createHmac('sha256', key.secret).update(JSON.stringify(rest)).digest('hex') === sig;
  }

  watchdogRecord(record) {
    if (this.readOnly) return null;
    writeJsonAtomic(this.paths.watchdogFile, record);
    return record;
  }

  readWatchdog() {
    return readJson(this.paths.watchdogFile, null);
  }
}
