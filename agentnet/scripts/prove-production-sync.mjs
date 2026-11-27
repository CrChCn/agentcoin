#!/usr/bin/env node
/* prove-production-sync.mjs — доказательство на loopback:
   нода A заполняется реальным снимком цепи Agentcoin (53 709 блоков),
   пустая нода B синхронизирует её по P2P, затем A майнит новый блок
   по боевым правилам, а B принимает его строгой проверкой
   validateBlockAgainstChain после checkpoint.
   Запуск: node scripts/prove-production-sync.mjs [chain.json] */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../../packaging/node/src/core.mjs';
import { AgentcoinNode } from '../src/node.mjs';
import { createProductionAdapter, loadProductionSnapshot, seedProductionChain, openProductionChain } from '../src/production.mjs';
import { waitFor } from '../src/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CHAIN_FILE = process.argv[2] || process.env.AGENTNET_PROD_CHAIN || path.join(ROOT, '../bundle-build/portable/cache/chain.json');
const WORK = path.join(ROOT, '.proof');
const t0 = Date.now();

function config(port, seeds) {
  return {
    networkId: core.networkChainId(),
    listen: { host: '127.0.0.1', port },
    api: { host: '127.0.0.1', port: 0 },
    nat: { enabled: false },
    privacy: { publishEndpoint: false },
    sync: { fetchBodies: true, intervalMs: 500, headersPerBatch: 500, blocksPerBatch: 200 },
    discovery: { staticSeeds: seeds, minPeers: 1, intervalMs: 1000, maxPeers: 8 },
  };
}

function log(line) { console.log(`[proof +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`); }

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const snapshot = loadProductionSnapshot(CHAIN_FILE, core);
log(`snapshot: ${snapshot.doc.chain.length} блоков, genesis ${snapshot.genesisHeader.chainId} ${snapshot.tip.hash.slice(0, 16)}…`);

const adapterA = createProductionAdapter(core, { checkpoint: snapshot.checkpoint });
const chainA = seedProductionChain({
  dataDir: path.join(WORK, 'node-a'), snapshot, core, adapter: adapterA, log,
});
log(`A засеяна: height=${chainA.height}, tip=${chainA.tip.hash.slice(0, 16)}…, bodies=${chainA.bodies.size}`);

const adapterB = createProductionAdapter(core, { checkpoint: snapshot.checkpoint });
const chainB = openProductionChain({
  dataDir: path.join(WORK, 'node-b'), core, adapter: adapterB, genesisHeader: snapshot.genesisHeader,
});
log(`B стартует пустой: height=${chainB.height}, tip=${chainB.tip.hash.slice(0, 16)}…`);

const a = new AgentcoinNode({ dataDir: path.join(WORK, 'node-a'), config: config(0, []), chain: chainA, log });
const b = new AgentcoinNode({ dataDir: path.join(WORK, 'node-b'), config: config(0, []), chain: chainB, log });
await a.start();
await b.start();
chainB.addBlock(snapshot.doc.chain[0], { verify: false }); // genesis body нужен для проверки блока 1
log(`A P2P ${a.listenPort}, B P2P ${b.listenPort}`);

const startedEmpty = chainB.height === 0;
await b.connect({ host: '127.0.0.1', port: a.listenPort });
log('B подключилась к A, пошла синхронизация');

let lastPct = -1;
const progress = setInterval(() => {
  const total = snapshot.tip.height;
  const pct = Math.floor((chainB.height / total) * 100);
  if (pct !== lastPct) {
    lastPct = pct;
    log(`B: headers ${chainB.height}/${total} (${pct}%), bodies ${chainB.bodies.size}/${total + 1}`);
  }
}, 1000);

await waitFor(() => chainB.height === snapshot.tip.height && chainB.tip.hash === snapshot.tip.hash, {
  timeoutMs: 240000, label: 'B догнала tip снимка',
});
log(`B догнала заголовки: height=${chainB.height}, tip=${chainB.tip.hash.slice(0, 16)}…`);

await waitFor(() => chainB.bodies.size >= snapshot.doc.chain.length, {
  timeoutMs: 240000, label: 'B догнала тела',
});
clearInterval(progress);
log(`B догнала тела: bodies=${chainB.bodies.size}`);

// Новый блок после checkpoint: строгая проверка боевыми правилами.
const h = chainA.height + 1;
const bits = adapterA.expectedBits(h);
const miner = core.createWallet('proof-miner');
const ts = Math.floor(Date.now() / 1000);
const cb = {
  from: 'COINBASE', to: miner.address, amount: core.blockReward(h),
  nonce: 0, ts, memo: `block ${h}`,
};
cb.txid = core.txDigest(cb);
const header = {
  version: 1, prevHash: chainA.tip.hash, merkleRoot: core.merkleRoot([cb]),
  timestamp: ts, difficultyBits: bits, nonce: 0, chainId: core.networkChainId(),
};
const mineStart = Date.now();
let hash = '';
while (true) {
  hash = core.computeBlockHash(header);
  if (core.hashMeetsDifficulty(hash, bits)) break;
  header.nonce++;
}
const block = { height: h, hash, header, txs: [cb], minedAt: Date.now(), mineMs: Date.now() - mineStart };
const ah = chainA.addHeaders([{ height: h, hash, header }]);
if (!ah.ok) throw new Error(`A header: ${ah.reason}`);
const ab = chainA.addBlock(block);
if (!ab.ok) throw new Error(`A body: ${ab.reason}`);
log(`A намайнила блок ${h} ${hash.slice(0, 16)}… (${block.mineMs}ms, ${bits} бит), строгая проверка пройдена`);
a.broadcastAnnouncement();

await waitFor(() => chainB.height === h && chainB.tip.hash === hash, { timeoutMs: 30000, label: 'B приняла новый блок' });
await waitFor(() => chainB.bodies.has(h), { timeoutMs: 30000, label: 'B приняла тело нового блока' });
log(`B приняла новый блок ${h} строгой проверкой после checkpoint`);

// Независимая проверка нового блока по телам B.
const prefixB = [];
for (let i = 0; i < h; i++) prefixB.push(chainB.bodies.get(i));
const strictErr = core.validateBlockAgainstChain(chainB.bodies.get(h), prefixB);
if (strictErr) throw new Error(`independent strict validation: ${strictErr}`);

const result = {
  at: new Date().toISOString(),
  chainId: core.networkChainId(),
  genesisHash: chainB.genesisHash,
  snapshot: { file: CHAIN_FILE, height: snapshot.tip.height, tip: snapshot.tip.hash },
  checkpoint: snapshot.checkpoint,
  startedEmpty,
  b: {
    height: chainB.height, tip: chainB.tip.hash, bodies: chainB.bodies.size,
    headers: chainB.headers.length, work: chainB.work.toString(),
  },
  a: { height: chainA.height, tip: chainA.tip.hash, bodies: chainA.bodies.size },
  newBlock: { height: h, hash, bits, mineMs: block.mineMs, strict: true },
  adapter: { a: adapterA.stats, b: adapterB.stats },
  legacy: { merkleExceptions: [...adapterA.legacyMerkleExceptions] },
  elapsedMs: Date.now() - t0,
};
fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

await b.stop('proof_done');
await a.stop('proof_done');
