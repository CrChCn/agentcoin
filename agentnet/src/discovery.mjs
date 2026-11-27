/* agentnet/discovery.mjs — несколько независимых источников пиров:
   static seeds, DNS seeds (TXT/SRV), сохранённые peers, peer exchange, DHT-lite
   (итеративный поиск по XOR-расстоянию через PEERS{find}). Seed только знакомит. */
'use strict';
import dns from 'node:dns/promises';
import { normalizeEndpoint, validHost } from './peers.mjs';
import { isPort } from './util.mjs';

export function parseSeed(seed) {
  if (!seed) return null;
  if (typeof seed === 'object') return normalizeEndpoint(seed.host, seed.port);
  const s = String(seed).trim();
  const m = /^\[?([0-9a-fA-F:.]+)\]?:(\d{1,5})$/.exec(s) || /^([a-zA-Z0-9._-]+):(\d{1,5})$/.exec(s);
  if (!m) return null;
  return normalizeEndpoint(m[1], Number(m[2]));
}

export function xorDistance(a, b) {
  const left = Buffer.from(String(a).replace(/^agt1/, ''), 'hex');
  const right = Buffer.from(String(b).replace(/^agt1/, ''), 'hex');
  const len = Math.max(left.length, right.length);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = (left[i] || 0) ^ (right[i] || 0);
  return out;
}

export function compareDistance(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export class Discovery {
  constructor({ book, seeds = [], dnsSeeds = [], log = () => {}, onCandidate = null } = {}) {
    this.book = book;
    this.staticSeeds = seeds.map(parseSeed).filter(Boolean);
    this.dnsSeeds = [...dnsSeeds];
    this.log = log;
    this.onCandidate = onCandidate;
    this.lastDns = { at: 0, found: 0, errors: [] };
    this.exchangeCount = 0;
    this.dhtLookups = 0;
    this.dialed = new Set();
  }

  addStatic(host, port, source = 'static') {
    const ep = normalizeEndpoint(host, port);
    if (!ep) return;
    this.book.add({ ...ep, source });
    this.staticSeeds.push(ep);
  }

  async resolveDnsSeed(seed) {
    const found = [];
    const errors = [];
    const name = String(seed).replace(/^_agentnet\._tcp\./, '');
    // TXT: "host:port [nodeId]" или "nodeId@host:port"
    try {
      const txt = await dns.resolveTxt(`_agentnet._tcp.${name}`);
      for (const chunks of txt) {
        const value = chunks.join('');
        for (const token of value.split(/[\s,]+/).filter(Boolean)) {
          const [left, right] = token.includes('@') ? token.split('@') : [null, token];
          const ep = parseSeed(right);
          if (ep) found.push({ ...ep, nodeId: left || null, source: 'dns' });
        }
      }
    } catch (e) {
      if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND' && e.code !== 'ENOTIMP') errors.push(`txt:${e.code}`);
    }
    try {
      const srv = await dns.resolveSrv(`_agentnet._tcp.${name}`);
      for (const rec of srv) {
        const host = String(rec.name || '').replace(/\.$/, '');
        if (validHost(host) && isPort(rec.port)) found.push({ host, port: rec.port, nodeId: null, source: 'dns-srv' });
      }
    } catch (e) {
      if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND' && e.code !== 'ENOTIMP') errors.push(`srv:${e.code}`);
    }
    // Последний шанс: A-запись + порт по умолчанию не угадываем — нужен явный порт.
    this.lastDns = { at: Date.now(), found: found.length, errors };
    for (const rec of found) this.book.add(rec);
    return found;
  }

  async resolveAllSeeds() {
    const all = [];
    for (const ep of this.staticSeeds) all.push({ ...ep, source: 'static' });
    for (const seed of this.dnsSeeds) {
      try { all.push(...await this.resolveDnsSeed(seed)); } catch { /* seed недоступен */ }
    }
    const saved = this.book.known({ limit: 50 }).filter((p) => p.source === 'saved' || p.score >= 0);
    return [...all, ...saved];
  }

  async candidates({ limit = 8, exclude = new Set() } = {}) {
    const all = await this.resolveAllSeeds();
    const seen = new Set();
    const out = [];
    for (const c of all) {
      const ep = normalizeEndpoint(c.host, c.port);
      if (!ep) continue;
      const key = `${ep.host}:${ep.port}`;
      if (exclude.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...ep, nodeId: c.nodeId || null, source: c.source || 'saved' });
      if (out.length >= limit) break;
    }
    return out;
  }

  learn(list, from = 'pex') {
    if (!Array.isArray(list)) return 0;
    let added = 0;
    for (const item of list.slice(0, 64)) {
      const ep = normalizeEndpoint(item && item.host, item && item.port);
      if (!ep) continue;
      this.book.add({ ...ep, nodeId: item.nodeId || null, source: from });
      added++;
    }
    this.exchangeCount += added;
    return added;
  }

  /** DHT-lite: итеративный поиск ближайших к target среди известных пиров. */
  closestKnown(targetNodeId, { k = 8, exclude = new Set() } = {}) {
    const target = String(targetNodeId || '');
    const list = this.book.known({ limit: 128, exclude });
    return list
      .filter((p) => p.nodeId)
      .sort((a, b) => compareDistance(xorDistance(a.nodeId, target), xorDistance(b.nodeId, target)))
      .slice(0, k);
  }

  noteLookup() { this.dhtLookups++; }

  report() {
    return {
      sources: {
        static: this.staticSeeds.length,
        dns: this.dnsSeeds.length,
        saved: this.book.known({ limit: 500 }).filter((p) => p.source === 'saved').length,
      },
      dnsLast: this.lastDns,
      exchangeCount: this.exchangeCount,
      dhtLookups: this.dhtLookups,
    };
  }
}
