/* agentnet/peers.mjs — книга известных адресов, штрафы и баны.
   Бан — по nodeId (идентичность), а не по IP: адрес меняется, ключ — нет. */
'use strict';
import { isPort, readJson, writeJsonAtomic, nowIso } from './util.mjs';
import { validateNodeId } from './identity.mjs';

const MAX_KNOWN = 500;

export function validHost(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim();
  if (!h || h.length > 253) return false;
  if (h === '0.0.0.0' || h === '::' || h === 'localhost.localdomain') return false;
  if (h.includes('/') || h.includes('@') || h.includes(' ')) return false;
  if (h.startsWith('[') && h.endsWith(']')) return h.length > 3;
  if (h.includes(':')) return /^[0-9a-f:.]+$/i.test(h) && h.split(':').length >= 3;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h.split('.').every((o) => Number(o) <= 255);
  return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(h);
}

export function normalizeEndpoint(host, port) {
  if (!validHost(host) || !isPort(Number(port))) return null;
  return { host: String(host).trim(), port: Number(port) };
}

export class PeerBook {
  constructor({ dir, file, banThreshold = 100, banMs = 3600000 } = {}) {
    this.dir = dir;
    this.file = file;
    this.banThreshold = banThreshold;
    this.banMs = banMs;
    this.addresses = new Map(); // key host:port → record
    this.bans = new Map(); // nodeId → {until, reason, at}
    this.penalties = new Map(); // nodeId → {score, at, reasons[]}
    this.updatedAt = null;
  }

  load() {
    const raw = readJson(this.file, null);
    if (!raw || typeof raw !== 'object') return this;
    for (const rec of raw.addresses || []) {
      const ep = normalizeEndpoint(rec.host, rec.port);
      if (!ep) continue;
      this.addresses.set(`${ep.host}:${ep.port}`, {
        ...ep,
        nodeId: validateNodeId(rec.nodeId) ? rec.nodeId : null,
        sources: Array.isArray(rec.sources) ? rec.sources.slice(0, 8) : [],
        firstSeen: rec.firstSeen || nowIso(),
        lastSeen: rec.lastSeen || null,
        ok: Number(rec.ok) || 0,
        fails: Number(rec.fails) || 0,
        lastError: rec.lastError || null,
      });
    }
    const now = Date.now();
    for (const [id, ban] of Object.entries(raw.bans || {})) {
      if (!validateNodeId(id)) continue;
      if (!ban || Number(ban.until) <= now) continue;
      this.bans.set(id, { until: Number(ban.until), reason: String(ban.reason || ''), at: ban.at || nowIso() });
    }
    for (const [id, p] of Object.entries(raw.penalties || {})) {
      if (!validateNodeId(id)) continue;
      this.penalties.set(id, {
        score: Math.max(0, Number(p.score) || 0),
        at: p.at || nowIso(),
        reasons: Array.isArray(p.reasons) ? p.reasons.slice(-5) : [],
      });
    }
    this.updatedAt = raw.updatedAt || null;
    return this;
  }

  save() {
    const now = Date.now();
    const addresses = [...this.addresses.values()]
      .sort((a, b) => (b.ok - b.fails) - (a.ok - a.fails))
      .slice(0, MAX_KNOWN);
    const bans = {};
    for (const [id, b] of this.bans) if (b.until > now) bans[id] = b;
    const penalties = {};
    for (const [id, p] of this.penalties) if (p.score > 0) penalties[id] = p;
    this.updatedAt = nowIso();
    try {
      writeJsonAtomic(this.file, {
        version: 1,
        addresses,
        bans,
        penalties,
        updatedAt: this.updatedAt,
      }, 0o600);
    } catch { /* книга — кэш; диск может быть занят цепью */ }
  }

  add({ host, port, nodeId = null, source = 'unknown' } = {}) {
    const ep = normalizeEndpoint(host, port);
    if (!ep) return null;
    const key = `${ep.host}:${ep.port}`;
    let rec = this.addresses.get(key);
    if (!rec) {
      rec = { ...ep, nodeId: null, sources: [], firstSeen: nowIso(), lastSeen: null, ok: 0, fails: 0, lastError: null };
      this.addresses.set(key, rec);
    }
    if (source && !rec.sources.includes(source)) rec.sources.push(source);
    if (validateNodeId(nodeId)) rec.nodeId = nodeId;
    return rec;
  }

  markSeen({ host, port, nodeId, ok = true, error = null } = {}) {
    const ep = normalizeEndpoint(host, port);
    if (!ep) return;
    const rec = this.addresses.get(`${ep.host}:${ep.port}`);
    if (!rec) return;
    rec.lastSeen = nowIso();
    if (ok) { rec.ok++; rec.lastError = null; } else { rec.fails++; rec.lastError = error || 'dial_failed'; }
    if (validateNodeId(nodeId)) rec.nodeId = nodeId;
  }

  endpointOfNode(nodeId) {
    for (const rec of this.addresses.values()) if (rec.nodeId === nodeId) return { host: rec.host, port: rec.port };
    return null;
  }

  isBanned(nodeId, now = Date.now()) {
    const ban = this.bans.get(nodeId);
    if (!ban) return false;
    if (ban.until <= now) { this.bans.delete(nodeId); return false; }
    return true;
  }

  ban(nodeId, reason, ms = this.banMs) {
    if (!validateNodeId(nodeId)) return;
    this.bans.set(nodeId, { until: Date.now() + ms, reason: String(reason || ''), at: nowIso() });
    this.save();
  }

  penalize(nodeId, points = 10, reason = '') {
    if (!validateNodeId(nodeId)) return { score: 0, banned: false };
    const cur = this.penalties.get(nodeId) || { score: 0, at: nowIso(), reasons: [] };
    cur.score = Math.min(1000, cur.score + Math.max(0, points));
    cur.at = nowIso();
    if (reason) cur.reasons = [...cur.reasons.slice(-4), String(reason).slice(0, 80)];
    this.penalties.set(nodeId, cur);
    let banned = false;
    if (cur.score >= this.banThreshold) {
      this.ban(nodeId, reason || 'penalty_threshold');
      banned = true;
    }
    return { score: cur.score, banned };
  }

  reward(nodeId, points = 1) {
    const cur = this.penalties.get(nodeId);
    if (!cur) return;
    cur.score = Math.max(0, cur.score - points);
    if (cur.score === 0) this.penalties.delete(nodeId);
  }

  known({ limit = 32, exclude = new Set(), includeBanned = false } = {}) {
    const now = Date.now();
    const out = [];
    for (const rec of this.addresses.values()) {
      if (exclude.has(`${rec.host}:${rec.port}`)) continue;
      if (rec.nodeId && !includeBanned && this.isBanned(rec.nodeId, now)) continue;
      out.push({ host: rec.host, port: rec.port, nodeId: rec.nodeId, source: rec.sources[0] || 'saved', score: rec.ok - rec.fails });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  snapshot() {
    let banned = 0;
    const now = Date.now();
    for (const b of this.bans.values()) if (b.until > now) banned++;
    return {
      known: this.addresses.size,
      banned,
      penalized: this.penalties.size,
      withNodeId: [...this.addresses.values()].filter((r) => r.nodeId).length,
    };
  }
}
