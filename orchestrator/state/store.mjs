#!/usr/bin/env node
/* Состояние и журнал. Журнал — источник истины: state.json содержит снимок
   задания, но актуальное состояние и данные переходов восстанавливаются
   проигрыванием hash-цепочки событий. Поэтому падение между записью события и
   записью снимка не теряет подтверждённый переход. */

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, canonical, readJson, readJsonl, sha256, writeJsonAtomic } from '../lib/fsx.mjs';

export const STATES = Object.freeze([
  'CREATED',
  'READY',
  'IMPLEMENTING',
  'ARTIFACT_SUBMITTED',
  'REVIEWING',
  'CHANGES_REQUESTED',
  'ACCEPTED',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
]);

export const TRANSITIONS = Object.freeze({
  CREATED: ['READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  READY: ['IMPLEMENTING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  IMPLEMENTING: ['ARTIFACT_SUBMITTED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  ARTIFACT_SUBMITTED: ['REVIEWING', 'CHANGES_REQUESTED', 'BLOCKED', 'FAILED'],
  REVIEWING: ['ACCEPTED', 'CHANGES_REQUESTED', 'BLOCKED', 'FAILED'],
  CHANGES_REQUESTED: ['IMPLEMENTING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  // ACCEPTED не терминален: подмена байта артефакта отменяет приёмку (revoke_acceptance).
  ACCEPTED: ['CHANGES_REQUESTED'],
  BLOCKED: [],
  FAILED: [],
  CANCELLED: [],
});

const ZERO_HASH = '0'.repeat(64);
const nowIso = () => new Date().toISOString();

export class Store {
  constructor(root, { operationId = null, readOnly = false } = {}) {
    this.root = path.resolve(root);
    /* operationId попадает в каждое событие критической секции: по журналу
       видно, какой именно процесс зарезервировал переход. */
    this.operationId = operationId;
    /* readOnly отключает починку снимка: чтение статуса не должно писать без lock. */
    this.readOnly = readOnly;
  }

  stateDir(taskId) { return path.join(this.root, 'state', taskId); }
  stateFile(taskId) { return path.join(this.stateDir(taskId), 'state.json'); }
  journalFile(taskId) { return path.join(this.root, 'logs', taskId, 'events.jsonl'); }

  exists(taskId) {
    return fs.existsSync(this.stateFile(taskId));
  }

  _appendEvent({ taskId, from, to, action, actor, iteration, patch = {}, extra = {} }) {
    const events = this.readJournal(taskId);
    const prevHash = events.length ? events[events.length - 1].hash : ZERO_HASH;
    const event = {
      seq: events.length,
      at: nowIso(),
      type: `state.${to}`,
      taskId,
      action,
      actor,
      from,
      to,
      iteration,
      payload: { ...extra, iteration, operationId: this.operationId, patch },
      prevHash,
    };
    event.hash = sha256(canonical(event));
    appendJsonl(this.journalFile(taskId), event);
    return event;
  }

  init(task, { implementer, reviewer, mode = 'fixture', realAgentsArmed = false }) {
    const taskSha256 = sha256(canonical(task));
    if (this.exists(task.taskId)) {
      const current = this.load(task.taskId);
      if (current.taskSha256 !== taskSha256) {
        throw Object.assign(new Error('taskId already exists with different content: taskId is immutable'), {
          code: 'TASK_ID_REUSED',
        });
      }
      return { created: false, state: current };
    }
    const at = nowIso();
    const base = {
      taskId: task.taskId,
      task,
      taskSha256,
      state: 'CREATED',
      iteration: 0,
      implementer,
      reviewer,
      mode,
      realAgentsArmed,
      createdAt: at,
      updatedAt: at,
      history: [],
      findings: [],
      artifacts: [],
      result: null,
      review: null,
      reason: null,
      seq: 0,
    };
    writeJsonAtomic(this.stateFile(task.taskId), base);
    this._appendEvent({
      taskId: task.taskId,
      from: 'NONE',
      to: 'CREATED',
      action: 'task.created',
      actor: 'orchestrator',
      iteration: 0,
      patch: { reason: 'task accepted, contract constraints validated', mode, realAgentsArmed },
      extra: { taskSha256, mode, realAgentsArmed },
    });
    return { created: true, state: this.load(task.taskId) };
  }

  readJournal(taskId) {
    return readJsonl(this.journalFile(taskId));
  }

  verifyJournal(taskId) {
    const events = this.readJournal(taskId);
    const errors = [];
    let prev = ZERO_HASH;
    events.forEach((event, index) => {
      if (event.seq !== index) errors.push({ seq: index, error: 'seq_gap' });
      if (event.prevHash !== prev) errors.push({ seq: index, error: 'prev_hash_mismatch' });
      const { hash, ...rest } = event;
      const expected = sha256(canonical(rest));
      if (hash !== expected) errors.push({ seq: index, error: 'hash_mismatch' });
      prev = hash;
    });
    return { ok: errors.length === 0, events, errors, head: prev };
  }

  load(taskId) {
    const base = readJson(this.stateFile(taskId), null);
    if (!base) throw Object.assign(new Error(`unknown task ${taskId}`), { code: 'UNKNOWN_TASK' });
    const journal = this.verifyJournal(taskId);
    if (!journal.ok) {
      throw Object.assign(new Error(`journal integrity failure for ${taskId}`), {
        code: 'JOURNAL_CORRUPT',
        errors: journal.errors,
      });
    }
    const state = { ...base, history: [] };
    for (const event of journal.events) {
      state.state = event.to;
      state.iteration = event.iteration;
      if (event.payload && event.payload.patch) Object.assign(state, event.payload.patch);
      state.history.push({
        seq: event.seq,
        at: event.at,
        action: event.action,
        actor: event.actor,
        from: event.from,
        to: event.to,
        iteration: event.iteration,
      });
    }
    state.seq = journal.events.length;
    if (journal.events.length) state.updatedAt = journal.events[journal.events.length - 1].at;
    const taskSha256 = sha256(canonical(state.task));
    if (taskSha256 !== state.taskSha256) {
      throw Object.assign(new Error('task snapshot does not match its recorded hash'), { code: 'TASK_TAMPERED' });
    }
    if (!this.readOnly && (base.state !== state.state || base.iteration !== state.iteration)) {
      writeJsonAtomic(this.stateFile(taskId), state);
    }
    return state;
  }

  transition({ taskId, to, action, actor, payload = {}, reason = null }) {
    const state = this.load(taskId);
    const allowed = TRANSITIONS[state.state] || [];
    if (!allowed.includes(to)) {
      throw Object.assign(new Error(`illegal transition ${state.state} -> ${to}`), {
        code: 'ILLEGAL_TRANSITION',
        from: state.state,
        to,
      });
    }
    if (state.state === 'ACCEPTED' && to === 'CHANGES_REQUESTED' && action !== 'revoke_acceptance') {
      throw Object.assign(new Error('ACCEPTED can only be reopened by revoke_acceptance'), {
        code: 'ACCEPTANCE_REVOKE_REQUIRED',
      });
    }
    const iteration = Number.isInteger(payload.iteration) ? payload.iteration : state.iteration;
    const patch = { ...(payload.patch || {}) };
    if (reason) patch.reason = reason;
    this._appendEvent({ taskId, from: state.state, to, action, actor, iteration, patch, extra: payload });
    const next = this.load(taskId);
    writeJsonAtomic(this.stateFile(taskId), next);
    return next;
  }

  markBlocked(taskId, { action, actor, code, detail, patch = {} }) {
    return this.transition({
      taskId,
      to: 'BLOCKED',
      action,
      actor,
      reason: detail,
      payload: { patch: { ...patch, blockedCode: code, reason: detail } },
    });
  }
}
