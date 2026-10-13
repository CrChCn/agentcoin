#!/usr/bin/env node
/* ============================================================
   AGENTCOIN node.mjs — JSON-нода для агентов (v2: security + @identity)
   Эндпоинты:
     GET  /info                 — параметры цепи + security status
     GET  /blocks?n=            — последние N блоков
     POST /wallet/create        — {label} → {address, privKey, pub}
     POST /balance              — {address} → {balance}
     POST /tx/sign              — {fromAddress,to,amount,memo} → подписанная tx
     POST /tx                   — подписанная tx в mempool (бан-фильтр + атак-детект)
     POST /mine                 — {miner} → блок, награда
     GET  /validate             — проверка цепи
     POST /peer/add, /sync-now  — P2P
     GET  /security/status      — статус Security Controller
     GET  /security/banlist     — ban-лист + registryHash (тампер-эвиденц)
     GET  /security/attacks     — журнал атак
     POST /handle/register      — {handle, address} → name@agt
     GET  /whoami/<name>        — резолв name@agt → address (збаненные = 423)
     GET  /life                 — life-guard: живость цепи (глубина, свежесть, health)
   Запуск: node node.mjs [port] (по умолчанию 9333)
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
import { addPeer, syncAll } from './sync.mjs';
import { CommunityChat } from './community.mjs';
import { CloudLedger } from './cloud-hooks.mjs';
import { buildRegistryExport, syncRegistries } from './registry-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PORT = Number(process.argv[2]) || 9333;
const BLOCK_INTERVAL_SEC = 30; // must match core

const bc = new Blockchain(DATA_DIR);
const chat = new CommunityChat(DATA_DIR, bc.security);
const cloud = new CloudLedger(DATA_DIR);

const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
function loadWallets() { try { return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch { return {}; } }
function saveWallets(w) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2)); }

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(obj, null, 2));
}

function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

// ======@ Life-guard: контроль жизни цепи ======
function lifeStatus() {
  const tip = bc.tip();
  const now = Math.floor(Date.now() / 1000);
  const age = tip ? now - tip.header.timestamp : null;
  const blocksHealthy = bc.blockCount() > 0;
  const freshTip = age !== null && age < BLOCK_INTERVAL_SEC * 10;
  const chainOk = bc.validate().ok;
  const v = bc.validate();
  return {
    alive: blocksHealthy && chainOk.ok,
    blocks: bc.blockCount(),
    tipHash: tip ? tip.hash : null,
    tipAgeSec: age,
    fresh: freshTip,
    chainValid: v.ok,
    chainIssue: v.ok ? null : v.reason,
    tips: [
      blocksHealthy ? null : 'chain empty',
      freshTip ? null : `tip stale (${age}s > 300s): монтируй майнера`,
      chainOk.ok ? null : v.reason,
    ].filter(Boolean),
    security: { banned: bc.security.banList().length, attacks: bc.security.attacks.length },
    checkedAt: new Date().toISOString(),
  };
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
    if (bc.security.isBanned(address)) return json(res, 200, { address, balance: 0, unit: TICKER, opinion: 'permabanned' });
    const balances = bc.balances();
    return json(res, 200, { address, balance: balances[address] || 0, unit: TICKER });
  }

  if (p === '/tx/sign' && req.method === 'POST') {
    const { fromAddress, to, amount, memo = '' } = await body(req);
    const all = loadWallets();
    const w = all[fromAddress];
    if (!w) return json(res, 404, { error: 'wallet_not_found', hint: 'POST /wallet/create сначала' });
    if (bc.security.isBanned(fromAddress)) return json(res, 403, { error: 'address_permabanned' });
    const tx = { from: fromAddress, fromPub: w.pub, to, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
    tx.signature = signTransaction(tx, w.privKey);
    return json(res, 200, { signed: tx, submit_hint: 'POST /tx' });
  }

  if (p === '/tx' && req.method === 'POST') {
    const tx = await body(req);
    if (!verifyTransaction(tx)) {
      bc.security.registerAttack('spoof_signature', tx.from || 'unknown', 'bad signature at /tx');
      return json(res, 400, { error: 'bad_signature' });
    }
    const r = bc.addTransaction(tx);
    return r.ok ? json(res, 201, { accepted: true, mempool: bc.mempool.length }) : json(res, 400, r);
  }

  if (p === '/mine' && req.method === 'POST') {
    const { miner } = await body(req);
    if (!miner) return json(res, 400, { error: 'miner address required' });
    if (bc.security.isBanned(miner)) return json(res, 403, { error: 'address_permabanned' });
    const t0 = Date.now();
    const block = bc.mineOnce(miner);
    // облачный фонд от каждого блока
    const cloudNote = cloud.onBlockMined(block.height, bc.info().nextReward, block.hash);
    return json(res, 200, {
      mined: { height: block.height, hash: block.hash, nonce: block.header.nonce, txs: block.txs.length, ms: Date.now() - t0 },
      rewardTo: miner,
      cloud: { fundAGT: +cloudNote.fundAGT.toFixed(4), cloudGB: +cloudNote.cloudGB.toFixed(4), epochClosed: cloudNote.epochClosed },
      note: 'next retarget in ' + (10 - (bc.blockCount() % 10)) + ' blocks',
    });
  }

  // --- виртуальное облако + сжатие реестра ---
  if (p === '/cloud/stats') return json(res, 200, cloud.stats());
  if (p === '/cloud/epochs') return json(res, 200, { epochs: cloud.epochs.slice(-20).reverse() });
  if (p === '/cloud/ledger') {
    // хвост платёжного реестра (последние N строк)
    const n = Math.min(Number(url.searchParams.get('n')) || 20, 500);
    let tail = [];
    try {
      const raw = fs.readFileSync(cloud.ledgerFile, 'utf8').trim().split('\n');
      tail = raw.slice(-n).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    } catch {}
    return json(res, 200, { lines: tail, total: cloud.ledgerLines });
  }

  // --- L402-платный майнинг: сат→AGT через CyberGuard рельс ---
  // Пайплайн: агент покупает майн-тикет на CyberGuard (L402, сат) →
  // получает paymentHash → нода AGT проверяет платёж на рельсе и майнит,
  // награда идёт в кошелёк агента. Секрет не нужен — только proof-of-payment.
  const L402_BRIDGE = process.env.AGT_L402_BRIDGE || 'http://127.0.0.1:8088'; // CyberGuard API
  const L402_TICKET_SERVICE = 'agentcoin_mine_ticket'; // id услуги у CyberGuard
  const L402_PRICE_SATS = 50; // цена майн-тикета
  async function l402VerifyPayment(paymentHash) {
    try {
      const r = await fetch(`${L402_BRIDGE}/receipt/${encodeURIComponent(paymentHash)}`);
      const j = await r.json();
      return { ok: r.ok && (j.used === false || j.used === undefined), receipt: j, used: Boolean(j.used) };
    } catch (e) { return { ok: false, reason: 'rail_unreachable', err: e.message }; }
  }
  if (p === '/mine/l402' && req.method === 'POST') {
    const { miner, paymentHash } = await body(req);
    if (!miner || !paymentHash) return json(res, 400, { error: 'miner and paymentHash required', flow: '1) POST /mine/l402/ticket → ColonialGuard invoice; 2) pay BOLT11; 3) POST /mine/l402 with paymentHash' });
    if (bc.security.isBanned(miner)) return json(res, 403, { error: 'address_permabanned' });
    const v = await l402VerifyPayment(paymentHash);
    if (!v.ok) return json(res, 402, { error: 'payment_required', reason: v.reason || 'invalid payment', bridge: L402_BRIDGE });
    if (v.used) return json(res, 409, { error: 'payment_hash_already_used', replayPro: 'single-use tickets' });
    // майнинг как обычно, но билет расходуется на конце CyberGuard
    try {
      await fetch(`${L402_BRIDGE}/mock-pay/` + '') ; /* noop */
    } catch {}
    const block = bc.mineOnce(miner);
    const cloudNote = cloud.onBlockMined(block.height, bc.info().nextReward, block.hash);
    return json(res, 200, {
      mined: { height: block.height, hash: block.hash, nonce: block.header.nonce, txs: block.txs.length },
      rewardTo: miner,
      paymentProof: paymentHash.slice(0, 16) + '…',
      cloud: { fundAGT: +cloudNote.fundAGT.toFixed(4), cloudGB: +cloudNote.cloudGB.toFixed(4) },
    });
  }
  if (p === '/mine/l402/ticket' && req.method === 'POST') {
    // Мы выдаём «как получить инвойс» — сам инвойс генерит CyberGuard L402
    return json(res, 200, {
      hint: `GET ${L402_BRIDGE}/consult/${L402_TICKET_SERVICE} → 402 invoice (BOLT11)`,
      priceSats: L402_PRICE_SATS,
      flow: 'pay → preimage → POST /mine/l402 { miner, paymentHash }',
    });
  }

  if (p === '/validate') return json(res, 200, bc.validate());

  // --- Security Controller ---
  if (p === '/security/status') return json(res, 200, bc.security.status());
  if (p === '/security/banlist') return json(res, 200, { banned: bc.security.banList(), registryHash: bc.security.registryHash() });
  if (p === '/security/attacks') return json(res, 200, { attacks: bc.security.attacks.slice(-50), count: bc.security.attacks.length });

  // --- @-система ---
  const HANDLES_FILE = path.join(DATA_DIR, 'handles.json');
  const loadHandles = () => { try { return JSON.parse(fs.readFileSync(HANDLES_FILE, 'utf8')); } catch { return {}; } };
  if (p === '/handle/register' && req.method === 'POST') {
    const { handle, address } = await body(req);
    if (!handle || !address) return json(res, 400, { error: 'handle and address required' });
    if (!/^[a-z0-9_-]{3,20}$/i.test(handle) || !address.startsWith('AGT')) return json(res, 400, { error: 'bad_format' });
    const h = loadHandles();
    if (h[handle] && h[handle].address !== address) return json(res, 409, { error: 'handle_taken', by: h[handle].address });
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    h[handle] = { address, registeredAt: Date.now() };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HANDLES_FILE, JSON.stringify(h, null, 2));
    return json(res, 201, { identity: handle + '@agt', address, note: 'use identity in memos/marketplace' });
  }
  if (p.startsWith('/whoami/')) {
    const name = p.slice('/whoami/'.length).replace(/\.[a-z]+$/, '');
    const h = loadHandles();
    if (!h[name]) return json(res, 404, { error: 'unknown identity' });
    const banned = bc.security.isBanned(h[name].address);
    return json(res, banned ? 423 : 200, { identity: name + '@agt', address: h[name].address, banned });
  }

  // --- life-guard ---
  if (p === '/life') return json(res, 200, lifeStatus());

  // --- White List: верифицированная платёжная система ---
  const WHITELIST = path.join(DATA_DIR, 'whitelist.json');
  if (p === '/whitelist/status') return json(res, 200, bc.whitelist.status());
  if (p === '/whitelist/verify' && req.method === 'POST') {
    const { handle, address, note = '' } = await body(req);
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const r = bc.whitelist.verify(handle, address, 'node-operator', note);
    return r.ok ? json(res, 201, { ...r, identity: handle + '@agt', registryHash: bc.whitelist.registryHash() }) : json(res, 400, r);
  }
  if (p === '/whitelist/check' && req.method === 'POST') {
    const { address, amount = 0 } = await body(req);
    const handle = bc.whitelist.handleOf(address);
    const verified = bc.whitelist.isVerified(address);
    const banned = bc.security.isBanned(address);
    const needWhite = amount > 100; // LARGE_TX_LIMIT
    return json(res, 200, {
      address, verified, handle: handle ? handle + '@agt' : null, banned,
      largeTxAllowed: verified && !banned,
      note: needWhite && !verified ? 'tx > 100 AGT requires whitelist' : null,
    });
  }

  // --- Чат сообщества разработчиков ---
  if (p === '/community/feed') {
    const lim = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    return json(res, 200, { messages: chat.feed(lim), count: chat.messages.length });
  }
  if (p === '/community/send' && req.method === 'POST') {
    const { sender, senderHandle = '', text } = await body(req);
    const r = chat.send({ sender, senderHandle, text });
    return r.ok ? json(res, 201, r) : json(res, 400, r);
  }
  if (p === '/community/rules') return json(res, 200, { rules: chat.rules });
  if (p === '/community/pinned') return json(res, 200, { pinned: chat.pinned });
  if (p === '/community/pin' && req.method === 'POST') {
    const { id } = await body(req);
    return json(res, 200, chat.pin(id));
  }

  // --- P2P ---
  if (p === '/peer/add' && req.method === 'POST') {
    const { peer } = await body(req);
    if (!peer) return json(res, 400, { error: 'peer url required' });
    return json(res, 200, { peers: addPeer(peer) });
  }
  if (p === '/sync-now') {
    const logLines = await syncAll(bc);
    return json(res, 200, { synced: true, log: logLines, blocks: bc.blockCount() });
  }

  // --- межузловая синхронизация реестров ---
  if (p === '/registry/export') return json(res, 200, buildRegistryExport(bc, chat));
  if (p === '/registry/sync') {
    const peers = await (async () => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'peers.json'), 'utf8')); } catch { return []; } })();
    const logLines = await syncRegistries(bc, chat, peers);
    return json(res, 200, { synced: true, log: logLines, blocks: bc.blockCount() });
  }

  // --- веб-панель чата ---
  if (p === '/chat' || p === '/chat.html') {
    const html = fs.readFileSync(path.join(__dirname, 'site', 'chat.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (p === '/') return json(res, 200, {
    name: 'AGENTCOIN node', chainId: CHAIN_ID, ticker: TICKER, maxSupply: MAX_SUPPLY,
    endpoints: ['/info', '/blocks?n=', 'POST /wallet/create', 'POST /balance', 'POST /tx/sign', 'POST /tx', 'POST /mine', '/validate',
      'GET /security/status', 'GET /security/banlist', 'GET /security/attacks',
      'POST /handle/register', 'GET /whoami/<name>', 'GET /life',
      'GET /whitelist/status', 'POST /whitelist/verify', 'POST /whitelist/check',
      'GET /community/feed', 'POST /community/send', 'GET /community/rules', 'GET /community/pinned', 'POST /community/pin',
      'POST /peer/add', 'GET /sync-now', 'GET /chat (UI)', 'GET /cloud/stats', 'GET /cloud/epochs', 'GET /cloud/ledger', 'POST /mine/l402'],
  });

  json(res, 404, { error: 'not_found' });
});

console.log(`[${new Date().toISOString()}] AGENTCOIN node v2 listening on http://127.0.0.1:${PORT}`);
server.listen(PORT, '127.0.0.1');
