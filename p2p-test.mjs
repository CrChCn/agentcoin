#!/usr/bin/env node
/* P2P-тест на реальном HTTP: поднимаем 2 ноды с чистыми data-dir,
   A майнит 3 блока, B синхронизируется через /peer/add + /sync-now. */
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blockchain } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- мини-нода (та же логика, что node.mjs, изолированные data-dir) ---
function startNode(bc, port) {
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    let body = {};
    if (req.method === 'POST') {
      let d = '';
      await new Promise(r => { req.on('data', c => d += c); req.on('end', r); });
      try { body = JSON.parse(d || '{}'); } catch {}
    }
    if (p === '/info') return end(res, 200, { ...bc.info(), blocks: bc.blockCount() });
    if (p === '/blocks') return end(res, 200, { blocks: bc.chain.slice().reverse() });
    if (p === '/validate') return end(res, 200, bc.validate());
    if (p === '/mine') {
      const b = bc.mineOnce(body.miner || 'AGT-default-miner');
      return end(res, 200, { height: b.height, hash: b.hash });
    }
    end(res, 404, { err: 'nf' });
  });
  function end(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
  return new Promise(r => server.listen(port, '127.0.0.1', r));
}

const dirA = path.join(__dirname, 'data-a');
const dirB = path.join(__dirname, 'data-b');
fs.rmSync(dirA, { recursive: true, force: true });
fs.rmSync(dirB, { recursive: true, force: true });

const A = new Blockchain(dirA);
const B = new Blockchain(dirB);

await startNode(A, 9341);
await startNode(B, 9342);

console.log('genesis match:', A.info().genesisHash === B.info().genesisHash);
console.log('A blocks:', A.blockCount(), '| B blocks:', B.blockCount());

// --- A майнит 3 блока ---
for (let i = 1; i <= 3; i++) {
  const r = await fetch('http://127.0.0.1:9341/mine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ miner: 'AGT-miner-A' }) });
  const j = await r.json();
  console.log(`A mined: height=${j.height} hash=${j.hash.slice(0, 16)}…`);
}

// --- P2P: импортируем syncOne через stub fetch (тот, что ходит на A) ---
const { syncOne } = await import('./sync.mjs');
// syncOne ждёт URL пира; используем наш A-порт как настоящий HTTP-пир
const logLines = await syncOne(B, 'http://127.0.0.1:9341');
console.log('sync log:', logLines.join('\n  '));
console.log('B blocks после синка:', B.blockCount());
console.log('B validate:', JSON.stringify(B.validate()));

process.exit(0);
