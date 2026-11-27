#!/usr/bin/env node
/* agentnet/scripts/demo.mjs — живой стенд: 4 ноды, 3 независимых indexer-а, портал.
   Поднимает всё на loopback, майнит блоки и держит сайт на http://127.0.0.1:9420 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentcoinNode } from '../src/node.mjs';
import { Indexer } from '../src/indexer.mjs';
import { Portal } from '../src/portal.mjs';
import { ephemeralIdentity } from '../src/identity.mjs';
import { createPassport } from '../src/operator.mjs';
import { mineNext } from '../src/mine.mjs';
import { sleep, waitFor } from '../src/util.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.AGENTNET_DEMO_DIR || path.join(ROOT, '.demo');
const NETWORK = 'agentnet-demo';
const quiet = (line) => { if (process.env.AGENTNET_LOG === '1') console.log(line); };

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });

function nodeConfig(port, seeds, region) {
  return {
    networkId: NETWORK,
    listen: { host: '127.0.0.1', port },
    api: { host: '127.0.0.1', port: 0 },
    nat: { enabled: false },
    privacy: { publishEndpoint: true, region },
    sync: { fetchBodies: true, intervalMs: 2000, headersPerBatch: 200, blocksPerBatch: 50 },
    discovery: { staticSeeds: seeds, minPeers: 1, intervalMs: 2000, maxPeers: 16 },
    limits: { maxInbound: 16 },
  };
}

const nodes = [];
try {
  const n1 = new AgentcoinNode({ dataDir: path.join(BASE, 'node1'), config: nodeConfig(9401, [], 'EU'), log: quiet });
  await n1.start();
  nodes.push(n1);
  for (const [i, port] of [[2, 9402], [3, 9403], [4, 9404]]) {
    const n = new AgentcoinNode({
      dataDir: path.join(BASE, `node${i}`),
      config: nodeConfig(port, ['127.0.0.1:9401'], i === 4 ? 'US' : 'EU'),
      log: quiet,
    });
    await n.start();
    nodes.push(n);
  }
  await sleep(700);

  const indexers = [];
  for (let i = 0; i < 3; i++) {
    const idx = new Indexer({
      dataDir: path.join(BASE, `indexer-${String.fromCharCode(97 + i)}`),
      seeds: ['127.0.0.1:9401', '127.0.0.1:9402'],
      config: { networkId: NETWORK, apiPort: 9411 + i },
      log: quiet,
    });
    await idx.start();
    indexers.push(idx);
  }

  const portal = new Portal({
    dataDir: path.join(BASE, 'portal'),
    indexers: indexers.map((i) => i.url),
    port: 9420,
    log: quiet,
  });
  await portal.start();

  // Паспорт оператора для двух нод — уровень INDEPENDENT_OPERATOR.
  const operator = ephemeralIdentity();
  portal.operators.add(createPassport(operator, {
    operatorId: 'demo-operator',
    name: 'Demo Operator',
    nodeIds: [nodes[0].id, nodes[1].id],
    region: 'EU',
  }));

  fs.writeFileSync(path.join(BASE, 'demo.pid'), String(process.pid));
  console.log(`[demo] node1  P2P 127.0.0.1:${nodes[0].listenPort}  GUI http://127.0.0.1:${nodes[0].apiPort}/gui`);
  console.log(`[demo] node2..4 P2P 9402-9404`);
  console.log(`[demo] indexers ${indexers.map((i) => i.url).join(', ')}`);
  console.log(`[demo] SITE   ${portal.url}/`);
  console.log(`[demo] API    ${portal.url}/api/v1/network/summary`);

  let n = 0;
  const timer = setInterval(() => {
    try {
      n++;
      const tx = { txid: `demo-${n}-${Date.now()}`, from: 'COINBASE', to: 'AGT' + '0'.repeat(40), amount: 50, ts: Date.now() };
      const block = mineNext(nodes[0].chain, { txs: [tx] });
      nodes[0].broadcastAnnouncement();
      quiet(`[demo] блок ${block.height} ${block.hash.slice(0, 12)}`);
    } catch (e) {
      console.error(`[demo] майнинг: ${e.message}`);
    }
  }, 2500);

  const shutdown = async () => {
    clearInterval(timer);
    console.log('[demo] остановка');
    await portal.stop();
    for (const idx of indexers) await idx.stop();
    for (const node of nodes) await node.stop('demo_shutdown');
    fs.rmSync(path.join(BASE, 'demo.pid'), { force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  console.error(`[demo] ошибка: ${e.stack || e.message}`);
  process.exit(1);
}
