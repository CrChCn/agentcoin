#!/usr/bin/env node
/* ============================================================
   AGENTCOIN node.mjs — JSON-нода для агентов
   Эндпоинты:
     GET  /info            — параметры цепи, supply, ретарджет
     GET  /blocks?n=       — последние N блоков
     POST /wallet/create   — {label} → {address, privKey, pub}
     POST /balance         — {address} → {balance, unit}
     POST /tx              — {from,fromPub,to,amount,nonce,ts,signature} — ф mempool
     POST /mine            — {miner} → добыть блок, награда майнеру
     GET  /validate        — проверка цепи
   Запуск: node node.mjs [port]  (по умолчанию 9333)
   ============================================================ */
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Blockchain, createWallet, signTransaction, verifyTransaction,
  CHAIN_ID, TICKER, MAX_SUPPLY,
} from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PORT = Number(process.argv[2]) || 9333;

const bc = new Blockchain(DATA_DIR);

// простое хранилище кошельков агентской ноды (демо; для прода — зашифрованное)
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
function loadWallets() { try { return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch { return {}; } }
function saveWallets(w) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2)); }

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  if (p === '/info') return json(res, 200, { ...bc.info(), node: `http://127.0.0.1:${PORT}` });

  if (p === '/blocks') {
    const n = Math.min(Number(url.searchParams.get('n')) || 10, 100);
    return json(res, 200, { blocks: bc.chain.slice(-n).reverse() });
  }

  if (p === '/wallet/create' && req.method === 'POST') {
    const { label = 'agent' } = await body(req);
    const w = createWallet(label);
    const all = loadWallets();
    all[w.address] = { label: w.label, pub: w.pub, privKey: w.privKey, createdAt: w.createdAt };
    saveWallets(all);
    return json(res, 201, { address: w.address, pub: w.pub, privKey: w.privKey, note: 'keep privKey safe — it signs transactions' });
  }

  if (p === '/balance' && req.method === 'POST') {
    const { address } = await body(req);
    if (!address) return json(res, 400, { error: 'address required' });
    const balances = bc.balances();
    return json(res, 200, { address, balance: balances[address] || 0, unit: TICKER });
  }

  if (p === '/tx/sign' && req.method === 'POST') {
    // агентский shortcut: подписываем на этой ноде (для локальных агентов)
    const { fromAddress, to, amount, memo = '' } = await body(req);
    const all = loadWallets();
    const w = all[fromAddress];
    if (!w) return json(res, 404, { error: 'wallet_not_found', hint: 'POST /wallet/create сначала' });
    const tx = { from: fromAddress, fromPub: w.pub, to, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
    tx.signature = signTransaction(tx, w.privKey);
    return json(res, 200, { signed: tx, submit_hint: 'POST /tx' });
  }

  if (p === '/tx' && req.method === 'POST') {
    const tx = await body(req);
    if (!verifyTransaction(tx)) return json(res, 400, { error: 'bad_signature' });
    const r = bc.addTransaction(tx);
    return r.ok ? json(res, 201, { accepted: true, mempool: bc.mempool.length }) : json(res, 400, r);
  }

  if (p === '/mine' && req.method === 'POST') {
    const { miner } = await body(req);
    if (!miner) return json(res, 400, { error: 'miner address required' });
    const t0 = Date.now();
    const block = bc.mineOnce(miner);
    return json(res, 200, {
      mined: { height: block.height, hash: block.hash, nonce: block.header.nonce, txs: block.txs.length, ms: Date.now() - t0 },
      rewardTo: miner, reward: block.txs.find(t => String(t.txid || '').startsWith('coinbase'))?.amount,
      note: 'next retarget in ' + (10 - (bc.blockCount() % 10)) + ' blocks',
    });
  }

  if (p === '/validate') return json(res, 200, bc.validate());

  if (p === '/peer/add' && req.method === 'POST') {
    const { peer } = await body(req);
    if (!peer) return json(res, 400, { error: 'peer url required' });
    const peers = addPeer(peer);
    return json(res, 200, { peers });
  }

  if (p === '/sync-now') {
    const logLines = await syncAll(bc);
    return json(res, 200, { synced: true, log: logLines, blocks: bc.blockCount() });
  }

  if (p === '/' ) return json(res, 200, {
    name: 'AGENTCOIN node', chainId: CHAIN_ID, ticker: TICKER, maxSupply: MAX_SUPPLY,
    endpoints: ['/info', '/blocks?n=', 'POST /wallet/create', 'POST /balance', 'POST /tx/sign', 'POST /tx', 'POST /mine', '/validate', 'POST /peer/add', '/sync-now'],
  });

  json(res, 404, { error: 'not_found' });
});

console.log(`[${new Date().toISOString()}] AGENTCOIN node listening on http://127.0.0.1:${PORT}`);
server.listen(PORT, '127.0.0.1');

// --- P2P sync endpoints (добавлены) ---
import { addPeer, syncAll } from './sync.mjs';

// внутрь server-хендлера новые маршруты ниже не встанут автоматически;
// отдельные мини-серверы на портах 9336+ — проще достроить здесь:
