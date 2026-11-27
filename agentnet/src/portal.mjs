/* agentnet/portal.mjs — агрегатор: сравнивает независимые indexer-ы, поднимает
   MULTI_OBSERVED/PUBLIC_REACHABLE, считает консенсус и форки, отдаёт сайт.
   Собственный ключ подписи; чужие подписи проверяются, ключи indexer-ов пинятся. */
'use strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateIdentity } from './identity.mjs';
import { NetworkApi, verifySignedResponse } from './api.mjs';
import { EventHub } from './events.mjs';
import { HistoryStore } from './history.mjs';
import { OperatorRegistry } from './operator.mjs';
import { classifyHeads, classifyStatus, detectForks, evaluateReadiness, mergeObservations, LEVEL_RANK } from './truth.mjs';
import { publicNode } from './privacy.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Portal {
  constructor({ dataDir, indexers = [], host = '127.0.0.1', port = 0, siteDir = null, log = null, pollMs = 1500 } = {}) {
    this.dataDir = dataDir;
    ensureDir(dataDir, 0o700);
    this.identity = loadOrCreateIdentity(dataDir);
    this.indexers = indexers.map((u) => String(u).replace(/\/$/, ''));
    this.siteDir = siteDir || path.join(__dirname, 'site');
    this.history = new HistoryStore({ dir: path.join(dataDir, 'history') });
    this.operators = new OperatorRegistry({ file: path.join(dataDir, 'operators.json'), maxNodesPerOperator: 5 });
    this.hub = new EventHub();
    this.api = new NetworkApi({
      identity: this.identity,
      host,
      port,
      siteDir: this.siteDir,
      hub: this.hub,
      log: log || (() => {}),
      ttlMs: 10000,
    });
    this.pinsFile = path.join(dataDir, 'indexer-keys.json');
    this.pins = readJson(this.pinsFile, {}) || {};
    this.pollMs = pollMs;
    this.sources = [];
    this.nodes = [];
    this.forks = [];
    this.genesisHash = null;
    this.prev = new Map();
    this.prevForks = new Set();
    this.lastRefresh = null;
    this.timers = [];
    this.log = log || ((line) => { if (process.env.AGENTNET_LOG !== '0') console.log(line); });
    this.startedAt = Date.now();
    this.refreshCount = 0;
  }

  get id() { return this.identity.nodeId; }
  get url() { return this.api.url; }

  async start() {
    this._registerRoutes();
    await this.api.start();
    await this.refresh();
    const t = setInterval(() => { this.refresh().catch(() => {}); }, this.pollMs);
    if (t.unref) t.unref();
    this.timers.push(t);
    this.log(`[portal] ${this.id} → ${this.url}, indexers: ${this.indexers.join(', ')}`);
    return this;
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.api.stop();
  }

  _registerRoutes() {
    this.api
      .route('summary', () => this.summary())
      .route('nodes', ({ params }) => {
        if (params && params.length > 0) {
          return { node: this.publicNodes().find((n) => n.nodeId === params[0]) || null };
        }
        return { nodes: this.publicNodes() };
      })
      .route('edges', () => ({ edges: this.edges() }))
      .route('eventlog', () => ({ hub: this.hub.snapshot(), events: this.hub.since(0).slice(-200) }))
      .route('history', ({ query }) => {
        const nodeId = query.get('nodeId');
        const limit = Math.min(Number(query.get('limit')) || 200, 1000);
        return {
          nodeId,
          timeline: this.history.timeline(nodeId, { limit }),
          uptime: nodeId ? this.history.uptime(nodeId) : null,
          incidents: this.history.incidents({ limit: 50 }),
          forks: this.history.forks(),
        };
      })
      .route('consensus', () => this.consensus())
      .route('operators', () => ({ operators: this.operators.list(), summary: this.operators.snapshot() }))
      .route('indexers', () => ({ indexers: this.sources, portalId: this.id }));
  }

  async refresh() {
    const now = Date.now();
    const results = await Promise.all(this.indexers.map((url) => this._fetchIndexer(url, now)));
    this.sources = results.map((r) => ({
      url: r.url,
      indexerId: r.indexerId || null,
      ok: r.ok,
      error: r.error || null,
      observedAt: r.observedAt || null,
      observations: r.observations ? r.observations.length : 0,
    }));

    const observations = results.flatMap((r) => (r.ok ? r.observations : []));
    const indexerIds = new Set(results.filter((r) => r.ok && r.indexerId).map((r) => r.indexerId));
    const merged = mergeObservations(observations).filter((n) => !indexerIds.has(n.nodeId));

    const genesisVotes = new Map();
    for (const o of observations) {
      if (!o.genesisHash) continue;
      genesisVotes.set(o.genesisHash, (genesisVotes.get(o.genesisHash) || 0) + 1);
    }
    const genesis = [...genesisVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || this.genesisHash;
    this.genesisHash = genesis || null;

    const nodes = merged.map((n) => {
      const operator = this.operators.verifyNode(n.nodeId);
      const status = classifyStatus(n, { now });
      const readiness = evaluateReadiness({ ...n, operator }, { now, genesisHash: this.genesisHash, minObservers: 2 });
      return {
        ...n,
        operator,
        status,
        level: readiness.level,
        ready: readiness.ready && status === 'online',
        reasons: readiness.reasons,
      };
    });

    const forks = detectForks(nodes.filter((n) => n.status === 'online'));
    this._publishDiff(nodes, forks, now);
    this.nodes = nodes;
    this.forks = forks;
    this.lastRefresh = new Date(now).toISOString();
    this.refreshCount++;

    for (const n of nodes) {
      this.history.record(n.nodeId, {
        at: new Date(now).toISOString(),
        height: n.height,
        tipHash: n.tipHash,
        version: n.version,
        peers: n.peers,
        status: n.status,
        level: n.level,
        operatorId: n.operatorId,
      }, { minIntervalMs: 10000 });
    }
    for (const f of forks) {
      if (!this.prevForks.has(`${f.height}:${f.branches.map((b) => b.hash).sort().join(',')}`)) {
        this.history.incident({ type: 'fork', detail: f, at: new Date(now).toISOString() });
      }
    }
    this.prevForks = new Set(forks.map((f) => `${f.height}:${f.branches.map((b) => b.hash).sort().join(',')}`));
    return this.summary();
  }

  async _fetchIndexer(url, now) {
    try {
      const res = await fetch(`${url}/api/v1/network/observations`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { url, ok: false, error: `http_${res.status}` };
      const doc = await res.json();
      const pinned = this.pins[url] || null;
      const v = verifySignedResponse(doc, { expectedKind: 'observations', pubkeyPem: pinned });
      if (!v.ok) return { url, ok: false, error: v.reason, indexerId: doc.sourceIndexer || null };
      if (!pinned) {
        this.pins[url] = doc.pubkey;
        try { writeJsonAtomic(this.pinsFile, this.pins, 0o600); } catch { /* пин восстановится */ }
      }
      return {
        url,
        ok: true,
        indexerId: doc.sourceIndexer,
        observedAt: doc.observedAt,
        observations: Array.isArray(doc.data.observations) ? doc.data.observations : [],
        forkCount: Array.isArray(doc.data.forks) ? doc.data.forks.length : 0,
      };
    } catch (e) {
      return { url, ok: false, error: e.message };
    }
  }

  _publishDiff(nodes, forks, now) {
    const cur = new Map(nodes.map((n) => [n.nodeId, n]));
    for (const n of nodes) {
      const prev = this.prev.get(n.nodeId);
      if (!prev) {
        this.hub.publish('node.discovered', { nodeId: n.nodeId, height: n.height, version: n.version });
      } else {
        if (prev.status !== n.status) {
          this.hub.publish(n.status === 'offline' ? 'node.offline' : n.status === 'stale' ? 'node.stale' : 'node.ready', {
            nodeId: n.nodeId, status: n.status, height: n.height,
          });
        }
        if (!prev.ready && n.ready) this.hub.publish('node.ready', { nodeId: n.nodeId, level: n.level, height: n.height });
        if ((LEVEL_RANK[n.level] || 0) > (LEVEL_RANK[prev.level] || 0)) {
          this.hub.publish('node.handshake', { nodeId: n.nodeId, level: n.level });
        }
        if (prev.height !== n.height) this.hub.publish('node.sync_progress', { nodeId: n.nodeId, height: n.height, delta: (n.height || 0) - (prev.height || 0) });
        if (prev.version !== n.version && n.version) this.hub.publish('version.outdated', { nodeId: n.nodeId, from: prev.version, to: n.version });
      }
      const latest = this.latestVersion(nodes);
      if (latest && n.version && n.version !== latest) {
        if (!prev || prev.outdated !== true) this.hub.publish('version.outdated', { nodeId: n.nodeId, version: n.version, latest });
        n.outdated = true;
      } else {
        n.outdated = false;
      }
    }
    for (const [nodeId, prev] of this.prev) {
      if (!cur.has(nodeId)) this.hub.publish('node.offline', { nodeId, removed: true });
    }
    const forkKeys = new Set(forks.map((f) => `${f.height}:${f.branches.map((b) => b.hash).sort().join(',')}`));
    for (const key of forkKeys) {
      if (!this.prevForks.has(key)) {
        const fork = forks.find((f) => `${f.height}:${f.branches.map((b) => b.hash).sort().join(',')}` === key);
        this.hub.publish('fork.detected', fork);
      }
    }
    for (const key of this.prevForks) {
      if (!forkKeys.has(key)) {
        const [height] = key.split(':');
        this.hub.publish('fork.resolved', { height: Number(height) });
      }
    }
    this.prev = new Map(nodes.map((n) => [n.nodeId, { ...n }]));
  }

  latestVersion(nodes) {
    const versions = nodes.map((n) => n.version).filter(Boolean);
    if (versions.length === 0) return null;
    return versions.sort((a, b) => compareVersions(b, a))[0];
  }

  publicNodes() {
    return this.nodes
      .map((n) => ({
        ...publicNode(n, { now: Date.now() }),
        operatorName: n.operator ? n.operator.name : null,
        outdated: Boolean(n.outdated),
      }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }

  edges() {
    const out = [];
    const nodeIds = new Set(this.nodes.map((n) => n.nodeId));
    for (const src of this.sources) {
      if (!src.ok || !src.indexerId) continue;
      for (const n of this.nodes) if (nodeIds.has(n.nodeId)) out.push([src.indexerId, n.nodeId]);
    }
    return out;
  }

  summary() {
    const live = this.nodes.filter((n) => n.status === 'online');
    const heights = live.map((n) => n.height).filter(Number.isFinite);
    const versions = {};
    for (const n of live) if (n.version) versions[n.version] = (versions[n.version] || 0) + 1;
    return {
      portalId: this.id,
      generatedAt: this.lastRefresh || new Date().toISOString(),
      genesisHash: this.genesisHash,
      nodes: this.nodes.length,
      online: live.length,
      ready: live.filter((n) => n.ready).length,
      publicReachable: live.filter((n) => ['PUBLIC_REACHABLE', 'INDEPENDENT_OPERATOR'].includes(n.level)).length,
      behindNat: live.filter((n) => n.natStatus && !['PUBLIC', 'PORT_FORWARDED', 'IPV6_PUBLIC'].includes(n.natStatus)).length,
      operators: new Set(live.filter((n) => n.operator && n.operator.verified).map((n) => n.operator.operatorId)).size,
      regions: new Set(live.map((n) => n.region).filter(Boolean)).size,
      height: heights.length ? Math.max(...heights) : null,
      forks: this.forks.length,
      versions,
      indexers: {
        configured: this.indexers.length,
        online: this.sources.filter((s) => s.ok).length,
        sources: this.sources,
      },
      history: this.history.snapshot(),
      events: this.hub.snapshot(),
      consensus: this.consensusSummary(),
    };
  }

  consensusSummary() {
    const disagreements = this.disagreements();
    return {
      status: this.forks.length > 0 ? 'FORK' : disagreements.length > 0 ? 'INDEXER_DIVERGENCE' : 'CONSISTENT',
      disagreements: disagreements.length,
      forks: this.forks.length,
      indexersOnline: this.sources.filter((s) => s.ok).length,
    };
  }

  disagreements() {
    // Расхождение indexer-ов — только разный hash на ОДНОЙ высоте.
    // Разные высоты — это лаг наблюдения (LAGGING/ADVANCED), не форк и не дивергенция.
    const out = [];
    for (const n of this.nodes) {
      const byHeight = new Map();
      for (const o of n.observers || []) {
        if (!Number.isFinite(o.height) || !o.tipHash) continue;
        if (!byHeight.has(o.height)) byHeight.set(o.height, new Map());
        const hashes = byHeight.get(o.height);
        if (!hashes.has(o.tipHash)) hashes.set(o.tipHash, []);
        hashes.get(o.tipHash).push(o.indexerId);
      }
      const branches = [];
      for (const [height, hashes] of byHeight) {
        if (hashes.size < 2) continue;
        for (const [tipHash, indexers] of hashes) branches.push({ height, tipHash, indexers });
      }
      if (branches.length > 0) out.push({ nodeId: n.nodeId, branches });
    }
    return out;
  }

  consensus() {
    const disagreements = this.disagreements();
    const status = this.forks.length > 0 ? 'FORK' : disagreements.length > 0 ? 'INDEXER_DIVERGENCE' : 'CONSISTENT';
    return {
      status,
      portalId: this.id,
      generatedAt: this.lastRefresh,
      genesisHash: this.genesisHash,
      indexers: this.sources,
      agreement: {
        nodes: this.nodes.length,
        multiObserved: this.nodes.filter((n) => (LEVEL_RANK[n.level] || 0) >= LEVEL_RANK.MULTI_OBSERVED).length,
        publicReachable: this.nodes.filter((n) => ['PUBLIC_REACHABLE', 'INDEPENDENT_OPERATOR'].includes(n.level)).length,
        ready: this.nodes.filter((n) => n.ready).length,
      },
      disagreements,
      forks: this.forks,
      rules: {
        differentHeights: 'LAGGING/ADVANCED — не форк',
        sameHeightDifferentHash: 'DIVERGENT/FORK',
        ready: ['signature', 'genesis', 'fresh', 'challenge', '>=2 observers', 'common block'],
      },
    };
  }
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function startPortal(opts) {
  const portal = new Portal(opts);
  await portal.start();
  return portal;
}
