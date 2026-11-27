/* agentnet/guard.mjs — один процесс на каталог ноды.
   Замок содержит pid и случайный токен: чужой живой pid → отказ, мёртвый → перехват. */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, randomHex, readJson, writeJsonAtomic } from './util.mjs';

export class GuardError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'GuardError';
    this.code = 'ALREADY_RUNNING';
    this.holder = holder || null;
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

const heldByThisProcess = new Set();

export function acquireGuard(dir, { pid = process.pid, meta = {} } = {}) {
  ensureDir(dir, 0o700);
  const lockKey = path.resolve(dir);
  if (heldByThisProcess.has(lockKey)) {
    throw new GuardError(`node already running in this process (${lockKey})`, { pid });
  }
  const file = path.join(dir, 'node.lock');
  const existing = readJson(file, null);
  if (existing && existing.pid && existing.pid !== pid) {
    const sameHost = !existing.host || existing.host === os.hostname();
    const alive = sameHost ? pidAlive(existing.pid) : Date.now() - Date.parse(existing.startedAt || 0) < 12 * 3600 * 1000;
    if (alive) throw new GuardError(`node already running (pid ${existing.pid})`, existing);
  }
  const token = randomHex(12);
  const record = { pid, token, host: os.hostname(), startedAt: new Date().toISOString(), ...meta };
  writeJsonAtomic(file, record, 0o600);
  heldByThisProcess.add(lockKey);
  return {
    pid,
    token,
    record,
    release() {
      heldByThisProcess.delete(lockKey);
      const cur = readJson(file, null);
      if (cur && cur.token === token) {
        try { fs.unlinkSync(file); } catch { /* noop */ }
      }
    },
  };
}
