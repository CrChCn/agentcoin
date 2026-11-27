/* agentnet/util.mjs — канонический JSON, хеши, ожидание условий, атомарные файлы. */
'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
export const sha256hex = (buf) => sha256(buf).toString('hex');
export const sha256d = (buf) => sha256(sha256(buf));
export const sha256dhex = (buf) => sha256d(buf).toString('hex');

export function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomB64u(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
export function b64uDecode(str) {
  return Buffer.from(String(str), 'base64url');
}

export function leadingZeroBits(hexHash) {
  const h = String(hexHash || '');
  let bits = 0;
  for (const ch of h) {
    const v = parseInt(ch, 16);
    if (Number.isNaN(v)) return 0;
    if (v === 0) { bits += 4; continue; }
    bits += Math.clz32(v) - 28;
    return bits;
  }
  return bits;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
    }
    await sleep(intervalMs);
  }
}

export function isHex(value, len) {
  return typeof value === 'string' && value.length === len && /^[0-9a-f]+$/.test(value);
}

export function isPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export class DiskFullError extends Error {
  constructor(cause) {
    super('disk_full');
    this.name = 'DiskFullError';
    this.code = 'DISK_FULL';
    this.cause = cause;
  }
}

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* windows */ }
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${randomHex(4)}`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (e && (e.code === 'ENOSPC' || e.code === 'EDQUOT')) throw new DiskFullError(e);
    throw e;
  }
}

export function writeJsonAtomic(file, obj, mode = 0o600) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

export function appendLine(file, obj) {
  const line = JSON.stringify(obj) + '\n';
  try {
    fs.appendFileSync(file, line, 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOSPC' || e.code === 'EDQUOT')) throw new DiskFullError(e);
    throw e;
  }
}

/**
 * Чтение append-only ndjson с восстановлением после обрыва записи.
 * Возвращает { rows, validBytes } — хвост после последнего перевода строки
 * не считается валидным и при следующем старте будет отрезан.
 */
export function readJsonLines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { rows: [], validBytes: 0 }; }
  const rows = [];
  let offset = 0;
  let validBytes = 0;
  const totalBytes = Buffer.byteLength(text, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    offset += Buffer.byteLength(rawLine, 'utf8') + 1;
    if (!line) { validBytes = Math.min(offset, totalBytes); continue; }
    try {
      rows.push(JSON.parse(line));
      validBytes = Math.min(offset, totalBytes);
    } catch {
      break; // повреждённый хвост: всё после него не доверяем
    }
  }
  return { rows, validBytes };
}

export function truncateTo(file, bytes) {
  try {
    const st = fs.statSync(file);
    if (st.size > bytes) fs.truncateSync(file, bytes);
  } catch { /* noop */ }
}

export function nowIso(ts = Date.now()) {
  return new Date(ts).toISOString();
}

export function bucketOf(nodeId, percent) {
  const h = sha256hex(String(nodeId)).slice(0, 8);
  return (parseInt(h, 16) % 100) < percent;
}
