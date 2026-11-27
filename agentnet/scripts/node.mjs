#!/usr/bin/env node
/* agentnet/scripts/node.mjs — запуск ноды.
   node scripts/node.mjs --data ./node1 --port 9336 --seed 127.0.0.1:9337 \
     --network agentnet-main [--publish-endpoint 1] [--region EU] [--operator op-1] */
'use strict';
import path from 'node:path';
import { AgentcoinNode } from '../src/node.mjs';
import { bool, defaultDataDir, int, parseArgs, ROOT } from './_args.mjs';

const a = parseArgs();
const dataDir = path.resolve(a.data || defaultDataDir('node1'));
const config = {
  networkId: a.network || 'agentnet-main',
  version: a.version || '1.0.0',
  listen: { host: a.host || '0.0.0.0', port: int(a.port, 9336) },
  api: { host: '127.0.0.1', port: int(a.apiPort, 0) },
  discovery: {
    staticSeeds: a.seeds,
    dnsSeeds: a.dnsSeed ? [a.dnsSeed] : [],
    minPeers: int(a.minPeers, 2),
    maxPeers: int(a.maxPeers, 32),
  },
  sync: { fetchBodies: bool(a.fetchBodies), intervalMs: int(a.syncMs, 15000) },
  nat: {
    enabled: !bool(a.noNat),
    publicIpProbe: a.ipProbe || '',
    gateway: a.gateway || null,
  },
  privacy: { publishEndpoint: bool(a.publishEndpoint), region: a.region || null },
  operator: { id: a.operator || null },
  updates: { releaseKeys: a.releaseKeys },
  relay: { enabled: bool(a.relay), url: a.relayUrl || null },
};

console.log(`[node] data=${path.relative(ROOT, dataDir)} network=${config.networkId}`);
const node = new AgentcoinNode({ dataDir, config });
await node.start();
console.log(`[node] ${node.id}`);
console.log(`[node] P2P  ${node.config.listen.host}:${node.listenPort}`);
console.log(`[node] GUI  http://127.0.0.1:${node.apiPort}/gui`);
console.log(`[node] объявление: ${JSON.stringify(node.publicAnnouncement().nodeId)}`);

const shutdown = async (sig) => {
  console.log(`[node] ${sig}: остановка`);
  await node.stop(sig);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
