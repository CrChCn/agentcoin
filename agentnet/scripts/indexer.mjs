#!/usr/bin/env node
/* agentnet/scripts/indexer.mjs — независимый наблюдатель.
   node scripts/indexer.mjs --data ./idx-a --api-port 9411 --seed 127.0.0.1:9336 --network agentnet-main */
'use strict';
import path from 'node:path';
import { Indexer } from '../src/indexer.mjs';
import { defaultDataDir, int, parseArgs, ROOT } from './_args.mjs';

const a = parseArgs();
const dataDir = path.resolve(a.data || defaultDataDir('indexer-a'));
if (a.seeds.length === 0) {
  console.error('нужен хотя бы один --seed host:port');
  process.exit(2);
}
const indexer = new Indexer({
  dataDir,
  seeds: a.seeds,
  config: {
    networkId: a.network || 'agentnet-main',
    version: a.version || '1.0.0',
    apiPort: int(a.apiPort, 9411),
    discovery: { dnsSeeds: a.dnsSeed ? [a.dnsSeed] : [] },
  },
});
await indexer.start();
console.log(`[indexer] ${indexer.id}`);
console.log(`[indexer] API ${indexer.url}/api/v1/network/summary`);
console.log(`[indexer] data ${path.relative(ROOT, dataDir)}`);

const shutdown = async (sig) => {
  console.log(`[indexer] ${sig}: остановка`);
  await indexer.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
