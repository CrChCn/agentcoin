// AGENTCOIN vector clocks — causal ordering of node-local events.
// Zero-dependency: inc on every accepted tx/block, merge on peer sync.
// A clock is a plain object { nodeId: counter }.
import fs from 'node:fs';
import path from 'node:path';

export function blankClock() { return {}; }

export function inc(clock, nodeId) {
  const c = { ...(clock || {}) };
  c[nodeId] = (c[nodeId] || 0) + 1;
  return c;
}

// Merge a remote clock into local: take element-wise maximum.
export function merge(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > (out[k] || 0)) out[k] = v;
  }
  return out;
}

// Causal comparison: 'before' | 'after' | 'equal' | 'concurrent'.
export function compare(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  let aLess = false, bLess = false;
  for (const k of keys) {
    const x = (a || {})[k] || 0, y = (b || {})[k] || 0;
    if (x < y) aLess = true;
    if (x > y) bLess = true;
  }
  if (!aLess && !bLess) return 'equal';
  if (aLess && !bLess) return 'before';
  if (bLess && !aLess) return 'after';
  return 'concurrent';
}

export function total(c) {
  return Object.values(c || {}).reduce((s, v) => s + (Number.isSafeInteger(v) ? v : 0), 0);
}

// Fail-closed validation for clocks received from peers.
export function sanitizeClock(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length > 64) return null;
  const out = {};
  for (const k of keys) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(k)) return null;
    const n = v[k];
    if (!Number.isSafeInteger(n) || n < 0 || n > 1e12) return null;
    out[k] = n;
  }
  return out;
}

export function vclockFile(dataDir) { return path.join(dataDir, 'vclock.json'); }

export function loadVclock(dataDir) {
  try {
    const d = JSON.parse(fs.readFileSync(vclockFile(dataDir), 'utf8'));
    return sanitizeClock(d && d.clock) || {};
  } catch { return {}; }
}

export function saveVclock(dataDir, clock) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(vclockFile(dataDir), JSON.stringify({ clock: clock || {}, updatedAt: Date.now() }));
  } catch { /* clock is auxiliary — never break consensus I/O */ }
}
