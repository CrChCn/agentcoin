#!/usr/bin/env node
/* agentnet/scripts/portal.mjs — сайт и агрегатор трёх indexer-ов.
   node scripts/portal.mjs --data ./portal --port 9420 \
     --indexer http://127.0.0.1:9411 --indexer http://127.0.0.1:9412 --indexer http://127.0.0.1:9413 */
'use strict';
import path from 'node:path';
import { Portal } from '../src/portal.mjs';
import { defaultDataDir, int, parseArgs, ROOT } from './_args.mjs';

const a = parseArgs();
if (a.indexers.length === 0) {
  console.error('нужен хотя бы один --indexer http://host:port');
  process.exit(2);
}
const portal = new Portal({
  dataDir: path.resolve(a.data || defaultDataDir('portal')),
  indexers: a.indexers,
  port: int(a.port, 9420),
});
await portal.start();
console.log(`[portal] ${portal.id}`);
console.log(`[portal] site ${portal.url}/`);
console.log(`[portal] API  ${portal.url}/api/v1/network/summary`);
console.log(`[portal] data ${path.relative(ROOT, portal.dataDir)}`);

const shutdown = async (sig) => {
  console.log(`[portal] ${sig}: остановка`);
  await portal.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
