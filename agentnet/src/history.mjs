/* agentnet/history.mjs — история наблюдений: появление, высоты, uptime, версии,
   peer count, лаг, форки, инциденты. Пишется append-only, публично — без адресов. */
'use strict';
import path from 'node:path';
import { appendLine, ensureDir, readJsonLines } from './util.mjs';

export class HistoryStore {
  constructor({ dir, maxEvents = 20000, file = null } = {}) {
    this.dir = dir;
    ensureDir(dir, 0o700);
    this.file = file || path.join(dir, 'history.ndjson');
    this.maxEvents = maxEvents;
    this.events = [];
    this.byNode = new Map();
    this.seq = 0;
    this._load();
  }

  _load() {
    const { rows } = readJsonLines(this.file);
    for (const row of rows.slice(-this.maxEvents)) this._push(row.event || row, { persist: false });
  }

  _push(event, { persist = true } = {}) {
    this.seq++;
    const row = { seq: this.seq, ...event };
    this.events.push(row);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    if (row.nodeId) {
      if (!this.byNode.has(row.nodeId)) this.byNode.set(row.nodeId, []);
      const arr = this.byNode.get(row.nodeId);
      arr.push(row);
      if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    }
    if (persist) {
      try { appendLine(this.file, row); } catch { /* история не должна ронять ноду */ }
    }
    return row;
  }

  record(nodeId, sample, { type = 'sample', minIntervalMs = 0 } = {}) {
    const prev = this.lastOf(nodeId);
    if (prev && minIntervalMs > 0 && Date.parse(sample.at) - Date.parse(prev.at) < minIntervalMs) {
      const changed = ['height', 'version', 'status', 'peers', 'level', 'operatorId'].some((k) => prev[k] !== sample[k]);
      if (!changed) return null;
    }
    return this._push({ type, nodeId, ...sample });
  }

  incident({ type, nodeId = null, detail = null, at = new Date().toISOString() }) {
    return this._push({ type: 'incident', incident: type, nodeId, detail, at });
  }

  lastOf(nodeId) {
    const arr = this.byNode.get(nodeId);
    return arr && arr.length ? arr[arr.length - 1] : null;
  }

  timeline(nodeId, { limit = 100 } = {}) {
    const arr = nodeId ? (this.byNode.get(nodeId) || []) : this.events;
    return arr.slice(-Math.min(1000, Math.max(1, limit)));
  }

  uptime(nodeId, { windowMs = 3600000, now = Date.now() } = {}) {
    const arr = (this.byNode.get(nodeId) || []).filter((e) => e.type === 'sample' && Date.parse(e.at) >= now - windowMs);
    if (arr.length < 2) return { samples: arr.length, uptimePct: arr.length ? 100 : null };
    let online = 0;
    for (let i = 1; i < arr.length; i++) {
      const dt = Date.parse(arr[i].at) - Date.parse(arr[i - 1].at);
      if (arr[i].status === 'online') online += dt;
    }
    const span = Date.parse(arr[arr.length - 1].at) - Date.parse(arr[0].at);
    return { samples: arr.length, uptimePct: span > 0 ? Math.round((online / span) * 1000) / 10 : null };
  }

  heightSeries(nodeId, { limit = 120 } = {}) {
    return (this.byNode.get(nodeId) || [])
      .filter((e) => e.type === 'sample' && Number.isFinite(e.height))
      .slice(-limit)
      .map((e) => ({ at: e.at, height: e.height }));
  }

  forks() {
    return this.events.filter((e) => e.type === 'fork').slice(-50);
  }

  incidents({ limit = 50 } = {}) {
    return this.events.filter((e) => e.type === 'incident').slice(-limit);
  }

  snapshot() {
    return {
      events: this.events.length,
      nodes: this.byNode.size,
      incidents: this.incidents({ limit: 200 }).length,
      forks: this.forks().length,
      lastSeq: this.seq,
    };
  }
}
