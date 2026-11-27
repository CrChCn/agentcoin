'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentcoinNode } from '../src/node.mjs';
import { Indexer } from '../src/indexer.mjs';
import { Portal } from '../src/portal.mjs';
import { randomHex } from '../src/util.mjs';

const dirs = [];
export const silent = () => {};

export function makeNetworkId(prefix = 'test') {
  return `${prefix}-${randomHex(4)}`;
}

export function tempDir(name = 'agentnet') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  dirs.push(dir);
  return dir;
}

export function cleanupAll() {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
  }
}

export async function startTestNode({
  dir = tempDir('node'),
  networkId,
  seeds = [],
  port = 0,
  consent = true,
  fetchBodies = true,
  releaseKeys = [],
  log = null,
  syncMs = 300,
  limits = {},
  version = '1.0.0',
} = {}) {
  const node = new AgentcoinNode({
    dataDir: dir,
    log,
    config: {
      networkId,
      version,
      listen: { host: '127.0.0.1', port },
      api: { host: '127.0.0.1', port: 0 },
      nat: { enabled: false },
      privacy: { publishEndpoint: consent, region: consent ? 'test-region' : null },
      sync: { fetchBodies, intervalMs: syncMs, headersPerBatch: 200, blocksPerBatch: 50 },
      discovery: { staticSeeds: seeds, minPeers: 1, intervalMs: 500, maxPeers: 16 },
      updates: { releaseKeys },
      limits: {
        maxInbound: 16,
        ratePerSecond: 20,
        rateBurst: 60,
        handshakeTimeoutMs: 5000,
        idleTimeoutMs: 30000,
        ...limits,
      },
    },
  });
  await node.start();
  return node;
}

export async function startTestIndexer({ dir = tempDir('indexer'), networkId, seeds, apiPort = 0, log = null } = {}) {
  const idx = new Indexer({
    dataDir: dir,
    seeds,
    log,
    config: { networkId, apiPort, version: '1.0.0' },
  });
  await idx.start();
  return idx;
}

export async function startTestPortal({ dir = tempDir('portal'), indexers, port = 0, log = null } = {}) {
  const portal = new Portal({ dataDir: dir, indexers, port, log, pollMs: 500 });
  await portal.start();
  return portal;
}

export function endpoint(node) {
  return { host: '127.0.0.1', port: node.listenPort };
}

export function sessionOf(node, peerId, direction) {
  return node.sessions.get(`${peerId}:${direction}`) || null;
}

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 5000) });
  return { status: res.status, doc: await res.json() };
}
