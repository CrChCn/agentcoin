#!/usr/bin/env node
/* TZ mock API for imperial.html — no live node needed.
 * Serves ../site statically + /api/v1/* scenarios.
 * Usage: node test/tz-mock-server.mjs [port] [scenario]
 * Scenarios: normal | timeout | badtypes | stale | othernet
 * Query override: /api/v1/info?scenario=badtypes etc. via header x-tz-scenario.
 */
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __d = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__d, '..', 'site');
const PORT = Number(process.argv[2] || 8099);
let SCEN = process.argv[3] || 'normal';

const GEN = '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e';
const nowS = () => Math.floor(Date.now() / 1000);

function blocks120(n = 120, spanH = 2) {
  // n blocks, newest first, spanning spanH hours (default <24h to test partial message)
  const out = [];
  const t0 = nowS();
  for (let i = 0; i < n; i++) {
    const h = 10000 - i;
    out.push({ height: h, hash: 'h' + h, header: { timestamp: t0 - i * Math.floor(spanH * 3600 / n), difficultyBits: 14, nonce: 1000 + i }, txs: [{ from: 'COINBASE', to: 'AGTa', amount: 50, txid: 'cb' + h }] });
  }
  return out;
}

function payload(p, scen) {
  const t0 = nowS();
  switch (p) {
    case '/info':
      if (scen === 'othernet') return { chainId: 'OTHERNET', genesisHash: 'dead', blocks: 5 };
      if (scen === 'badtypes') return { chainId: 123, genesisHash: 456, blocks: 'many', totalSupplyCirculating: 'lots', maxSupply: null };
      return { chainId: 'AGENTCOIN', genesisHash: GEN, blocks: 10001, difficultyBits: 14, nextReward: 50, totalSupplyCirculating: 160.123456789, maxSupply: 21000000, halvingIn: 199999, retargetIn: 7, mempool: 3 };
    case '/capabilities': return { get: ['/info', '/stats-data', '/passport/count', '/jobs/state', '/cloud/stats', '/gov/state', '/life', '/queue/status', '/queue/history', '/blocks', '/balances', '/treasury/state', '/tax/state', '/escrow/state', '/compute/state', '/memory/state', '/network/nodes'] };
    case '/stats-data': return { blocks: 10001, supply: 160.123, treasury: 100, paidJobs: 7, feesAGT: 0.000000001 };
    case '/passport/count': if (scen === 'stale') return { count: 12, snapshotAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString(), snapshotBlocks: 9000 }; return { count: 12, snapshotAt: new Date().toISOString(), snapshotBlocks: 10000 };
    case '/jobs/state': return { stats: { paid: 7, open: 2, total: 9 } };
    case '/cloud/stats': return { fundAGT: 5, cloudGB: 10, epochsClosed: 2, snapshotAt: new Date().toISOString(), snapshotBlocks: 10000, currentBlocks: 10001, compression: { ratioNow: 200 }, actualStorage: null };
    case '/gov/state': return { proposals: [] };
    case '/life': return { blocks: 10001, tipAgeSec: 12, security: { attacks: 3, banned: 0 } };
    case '/queue/status': return { waiting: 0, onDuty: 0, maxOnDuty: 4, nextFive: [], rotation: 'FIFO', history: [] };
    case '/queue/history': return { history: [] };
    case '/blocks': if (scen === 'timeout') return null; if (scen === 'badtypes') return { blocks: 'not-an-array' }; return { blocks: blocks120() };
    case '/balances': if (scen === 'badtypes') return { balances: 'oops' }; return { totalAccounts: 2, blocks: 10001, balances: [{ address: 'AGTa', balance: 0.000000001 }, { address: 'AGTb', balance: 12345678.123456789 }] };
    case '/treasury/state': return { policy: { treasury: 'AGTx', }, balance: 100, blocks: 10000 };
    case '/tax/state': return { passports: 12, governed: 3, collected: {}, passportSnapshotAt: new Date().toISOString() };
    case '/escrow/state': return { escrows: [] };
    case '/compute/state': return { available: false, reason: 'gpu-offline-test' };
    case '/memory/state': return { ok: true };
    case '/jobs/auction/list': return { auctions: [] };
    case '/network/nodes': return { nodes: [] };
    default: return null;
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

let dynQueue = null; // set via /__tz/queue?addrs=A,B&hist=J1:A
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const scen = u.searchParams.get('scenario') || req.headers['x-tz-scenario'] || SCEN;
  if (u.pathname === '/__tz/queue') {
    const addrs = (u.searchParams.get('addrs') || '').split(',').filter(Boolean);
    const hist = (u.searchParams.get('hist') || '').split(',').filter(Boolean);
    const partial = u.searchParams.get('partial') === '1';
    dynQueue = { addrs, hist, partial };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dynQueue }));
    return;
  }
  if (dynQueue && (u.pathname === '/api/v1/queue/status' || u.pathname === '/api/v1/queue/history')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname.endsWith('/status')) {
      if (dynQueue.partial) { res.end(JSON.stringify({ broken: true })); return; }
      res.end(JSON.stringify({ waiting: dynQueue.addrs.length, onDuty: 0, maxOnDuty: 4, nextFive: dynQueue.addrs, rotation: 'FIFO', history: [] }));
    } else {
      if (dynQueue.partial) { res.end(JSON.stringify({ history: 'oops' })); return; }
      res.end(JSON.stringify({ history: dynQueue.hist.map((h, i) => { const parts = h.split(':'); return { at: 1000 + i, jobId: parts[0], agent: parts[1] || 'A', summary: 'job done ' + parts[0] }; }) }));
    }
    return;
  }
  if (u.pathname.startsWith('/api/v1/')) {
    const p = u.pathname.slice(7).split('?')[0];
    const base = p.startsWith('/') ? p : '/' + p;
    // keep query-insensitive base for /blocks?n=..., /balances?limit=...
    const b = base === '/blocks' ? '/blocks' : base === '/balances' ? '/balances' : base;
    if (scen === 'timeout' && (b === '/blocks' || b === '/life')) { /* hang >8s so page hits AbortSignal.timeout */ return; }
    const d = payload(b, scen);
    if (d === null || d === undefined) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'mock-404:' + b })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(d));
    return;
  }
  let f = path.join(SITE, decodeURIComponent(u.pathname === '/' ? '/imperial.html' : u.pathname).split('?')[0]);
  if (!f.startsWith(SITE)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); res.end('not found: ' + u.pathname); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
});
srv.listen(PORT, '127.0.0.1', () => console.log('TZ-MOCK port=' + PORT + ' defaultScenario=' + SCEN + ' site=' + SITE));
