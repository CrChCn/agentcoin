/* agentnet/config.mjs — раскладка каталогов ноды и конфигурация по умолчанию. */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './util.mjs';

export const NETWORK_ID = 'agentnet-main';
export const PROTOCOL_VERSION = 1;

export const DEFAULT_CONFIG = {
  protocol: PROTOCOL_VERSION,
  networkId: NETWORK_ID,
  version: '1.0.0',
  listen: { host: '0.0.0.0', port: 19444 },
  api: { host: '127.0.0.1', port: 0 },
  discovery: {
    staticSeeds: [],
    dnsSeeds: [],
    minPeers: 2,
    maxPeers: 32,
    intervalMs: 15000,
  },
  sync: {
    headersPerBatch: 200,
    blocksPerBatch: 50,
    fetchBodies: false,
    intervalMs: 15000,
    maxHeaders: 200000,
    pruneBodies: 500,
  },
  nat: {
    enabled: true,
    publicIpProbe: '',
    upnp: true,
    natpmp: true,
    gateway: null,
    timeoutMs: 1500,
  },
  relay: { enabled: false, url: null },
  privacy: { publishEndpoint: false, region: null },
  operator: { id: null, passport: null },
  updates: { releaseKeys: [], channel: 'stable' },
  limits: {
    maxPeers: 32,
    maxInbound: 16,
    maxEnvelopeBytes: 64 * 1024,
    maxHeadersBytes: 512 * 1024,
    maxBlocksBytes: 2 * 1024 * 1024,
    ratePerSecond: 20,
    rateBurst: 60,
    idleTimeoutMs: 120000,
    handshakeTimeoutMs: 10000,
    banThreshold: 100,
    banMs: 3600000,
  },
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function mergeConfig(base, extra) {
  if (!isObject(extra)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    out[k] = isObject(v) && isObject(base[k]) ? mergeConfig(base[k], v) : v;
  }
  return out;
}

export const PATHS = {
  keys: 'keys',
  chain: 'chain',
  peers: 'peers',
  logs: 'logs',
  state: 'state',
  guard: 'guard',
  history: 'history',
};

export function ensureLayout(dir) {
  ensureDir(dir, 0o700);
  for (const sub of Object.values(PATHS)) ensureDir(path.join(dir, sub), 0o700);
  return dir;
}

export function configPath(dir) {
  return path.join(dir, 'config.json');
}

export function loadConfig(dir, overrides = {}) {
  ensureLayout(dir);
  const stored = readJson(configPath(dir), null);
  const base = mergeConfig(DEFAULT_CONFIG, stored && stored.__user ? stored.__user : stored || {});
  return mergeConfig(base, overrides);
}

export function saveConfig(dir, config) {
  ensureLayout(dir);
  writeJsonAtomic(configPath(dir), config, 0o600);
}

export function dataPaths(dir) {
  return {
    dir,
    keys: path.join(dir, PATHS.keys),
    chain: path.join(dir, PATHS.chain),
    peers: path.join(dir, PATHS.peers),
    logs: path.join(dir, PATHS.logs),
    state: path.join(dir, PATHS.state),
    guard: path.join(dir, PATHS.guard),
    history: path.join(dir, PATHS.history),
    peersFile: path.join(dir, PATHS.peers, 'peers.json'),
    bansFile: path.join(dir, PATHS.peers, 'bans.json'),
    stateFile: path.join(dir, PATHS.state, 'node-state.json'),
    lockFile: path.join(dir, PATHS.guard, 'node.lock'),
  };
}

export function existsDir(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}
