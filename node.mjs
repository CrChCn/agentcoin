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
// Last-resort отряд: любая непойманная ошибка логируется и НЕ убивает ноду
// (инцидент 2026-10-14: 9342 «тихо» уходила при вещании tx — стэк не падал в лог).
process.on('uncaughtException', (e) => {
  console.log(`[guard] uncaughtException: ${e.stack || e}`);
});
process.on('unhandledRejection', (e) => {
  console.log(`[guard] unhandledRejection: ${e && (e.stack || e.message) || e}`);
});
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';import { Blockchain, createWallet, signTransaction, verifyTransaction,
  CHAIN_ID, TICKER, MAX_SUPPLY, computeBlockHash, hashMeetsDifficulty,
  validateBlockAgainstChain, txDigest,
} from './core.mjs';
import { addPeer, loadPeers, syncAll, gossipTx, peerMetaStatus, peerStrike } from './sync.mjs';
import { WsHub, connectClient } from './ws.mjs';
import { ESCROW_PREFIX, escrowReceiptDigest, escrowConfirmDigest, findEscrowOpen } from './core.mjs';
import { lsagSign, lsagVerify, pointFromPubKeyPEM } from './ring-signature.mjs';
import { CommunityChat } from './community.mjs';
import { CloudLedger } from './cloud-hooks.mjs';
import { buildRegistryExport, syncRegistries } from './registry-sync.mjs';
import { dxeState, dxeBook, dxeItems, newRef as dxeRef, fmtNum } from './dxe.mjs';
import { govState, newRef as govRef } from './gov.mjs';
import { AgentQueue } from './queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AGT_DATA_DIR || path.join(__dirname, 'data'); // AGT_DATA_DIR: вторая нода на одной машине
const PORT = Number(process.argv[2]) || 9333;
const BLOCK_INTERVAL_SEC = 30; // must match core
const SELF_URL = `http://127.0.0.1:${Number(process.argv[2]) || 9333}`;

const bc = new Blockchain(DATA_DIR);
const queue = new AgentQueue(DATA_DIR); // очередь агентов: FIFO → работа → в конец очереди, по кругу
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

const hub = new WsHub();
// быстрый приём WS-блока в цепь: тот же набор правил, что сетевой append
function applyBlockFast(chain, blk) {
  chain.chain.push(blk);
  chain.invalidateTxCache();
  chain.difficultyBits = blk.header.difficultyBits;
  chain.refilterMempool();
  chain.save();
}
function getBlockHash(chain) { return chain.tip()?.hash || null; }

// ======@ Щит анти-перегрузки (OWASP DoS/Node cheat sheet, голый node:http) ======
// 1) Rate-limit по IP (фиксированные окна; реестр капнут, старые вытесняются)
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_ALL = 300;      // все запросы, IP/мин
const RATE_LIMIT_HEAVY = 60;     // дорогие POST (mine/tx/wallet…), IP/мин
const RATE_MAP_MAX = 10_000;
const rateHits = new Map();
const HEAVY_PATH_RE = /^\/(mine|blocktemplate|block\/submit|tx|tx\/sign|wallet\/create|escrow\/|data\/|passport\/|handle\/register|community\/send|dxe\/(order|fill|cancel)|gov\/)/;
function rateAllow(ip, heavy) {
  const now = Date.now();
  // loopback = локальные доверенные процессы ноды/майнеры/guard — без лимита (но глубже /
  // в коде тяжёлые вещи всё равно капнуты), внешние IP — строгие окна.
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (isLoopback) return true;
  const key = (heavy ? 'H|' : 'A|') + ip;
  let x = rateHits.get(key);
  if (!x || now >= x.until) { x = { count: 0, until: now + RATE_WINDOW_MS }; rateHits.delete(key); }
  x.count++;
  rateHits.delete(key);
  if (rateHits.size >= RATE_MAP_MAX) rateHits.delete(rateHits.keys().next().value);
  rateHits.set(key, x);
  return x.count <= (heavy ? RATE_LIMIT_HEAVY : RATE_LIMIT_ALL);
}
// 2) Event-loop lag monitor → режим сброса нагрузки (shedding)
const LAG_PROBE_MS = 1_000;
const LAG_SHED_THRESHOLD_MS = 400; // дрейф probe > 400ms = перегрузка
const LAG_SHED_HOLD_MS = 5_000;    // после выброса держим shedding ≥5s
const LAG_SHED_STREAK = 3;         // 3 спайка подряд, иначе shedding от одного PoW-слайса
let loopLagMs = 0;
let shedUntil = 0;
let lastProbe = Date.now();
let lagStreak = 0;
setInterval(() => {
  const now = Date.now();
  loopLagMs = now - lastProbe - LAG_PROBE_MS;
  lastProbe = now;
  if (loopLagMs > LAG_SHED_THRESHOLD_MS) {
    lagStreak++;
    if (lagStreak >= LAG_SHED_STREAK) shedUntil = now + LAG_SHED_HOLD_MS;
  } else if (lagStreak > 0) lagStreak--;
}, LAG_PROBE_MS).unref();
// 3) Щит-гейт: false = вернуть 503 при перегрузке. Ядровое (mine/tx/блоки) не режем —
// консенсус важнее сервиса, иначе нода глохнет при собственном PoW-лаге.
const CORE_PATH_RE = /^\/(mine|blocktemplate|block\/submit|tx|life|info|dashboard|headers|blocks|escrow\/state|dxe\/(book|orders|items|fills)|gov\/state|cabinet\/|queue\/status)/;
function overloaded(p) {
  return Date.now() < shedUntil && !CORE_PATH_RE.test(p);
}
function reqIsHeavy(p) { return HEAVY_PATH_RE.test(p); }
const DXE_MEMO_FEE = 0.001; // минимальный amount memo-tx (консенсус требует amount>0; self-tx возвращает деньги)

// === DXE/GOV: подписать и отправить tx каноническим путём (sign → add → gossip) ===
async function postSignedTx(res, { fromAddress, to, amount, memo }) {
  const all = loadWallets();
  const w = all[fromAddress];
  if (!w) return json(res, 404, { error: 'wallet_not_found', hint: 'кошелёк создаётся на своей ноде: POST /wallet/create' }) && null;
  if (bc.security.isBanned(fromAddress)) return json(res, 403, { error: 'address_permabanned' }) && null;
  const bal = bc.balances()[fromAddress] || 0;
  if (amount > bal) return json(res, 402, { error: 'insufficient_balance', balance: bal, needed: amount }) && null;
  const tx = { from: fromAddress, fromPub: w.pub, to, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
  tx.txid = txDigest(tx);
  tx.signature = signTransaction(tx, w.privKey);
  const r = bc.addTransaction(tx);
  if (!r.ok) { json(res, 409, r); return null; }
  setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
  return { accepted: true, txid: String(tx.txid).slice(0, 16), mempool: r.mempoolSize };
}

const server = http.createServer({ requestTimeout: 120_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  const _ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  // health-эндпоинты (life/dashboard/корень) не лимитируем — маяк живости обязан отвечать всегда
  const healthFree = req.method === 'GET' && (p === '/life' || p === '/dashboard' || p === '/');
  if (!healthFree && !rateAllow(_ip, req.method === 'POST' && reqIsHeavy(p))) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
    return res.end(JSON.stringify({ error: 'rate_limited', retryAfterSec: 60 }));
  }
  if (overloaded(p) && req.method !== 'GET') {
    return json(res, 503, { error: 'overloaded', hint: 'node busy, retry soon', loopLagMs });
  }
  if (overloaded(p) && req.method === 'GET' && p !== '/life' && p !== '/info' && p !== '/dashboard') {
    return json(res, 503, { error: 'overloaded', hint: 'node busy, retry soon', loopLagMs });
  }

  if (p === '/info') return json(res, 200, { ...bc.info(), node: `http://127.0.0.1:${PORT}` });

  if (p === '/blocks') {
    const fromRaw = url.searchParams.get('from');
    const from = fromRaw === null ? NaN : Number(fromRaw);
    if (Number.isFinite(from) && from >= 0 && from < bc.blockCount()) {
      // P2P-режим: bodies с высоты from, старые → новые (для headers-first синка)
      return json(res, 200, { blocks: bc.chain.slice(from), height: bc.blockCount() });
    }
    const n = Math.min(Number(url.searchParams.get('n')) || 10, 100);
    return json(res, 200, { blocks: bc.chain.slice(-n).reverse() });
  }

  // --- HEADERS-FIRST (как в Bitcoin): дешёвая проверка PoW до загрузки тел ---
  if (p === '/headers') {
    const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 2000);
    const headers = bc.chain.slice(from, from + limit).map(b => ({ height: b.height, hash: b.hash, header: b.header }));
    return json(res, 200, { height: bc.blockCount(), from, count: headers.length, headers });
  }

  // --- мемпул: публичное состояние очереди транзакций ---
  if (p === '/mempool') {
    return json(res, 200, {
      size: bc.mempool.length,
      txs: bc.mempool.slice(-50).map(t => ({ txid: (t.txid || '').slice(0, 16), from: t.from?.slice(0, 14), to: t.to?.slice(0, 14), amount: t.amount, nonce: t.nonce })),
      note: 'транзакции лежат здесь до ближайшего блока майнера',
    });
  }

  // --- репутация пиров (strikes) + архив развилок ---
  if (p === '/peers/meta') return json(res, 200, peerMetaStatus());
  if (p === '/forks') return json(res, 200, { forks: (bc.forks || []).slice(-10).reverse(), tipWork: undefined });

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
    if (!r.ok) return json(res, 400, r);
    // TX-GOSSIP: принятую tx расходим по пирам (те, у кого она есть, не ре-экспортируют → без петли)
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    return json(res, 201, { accepted: true, mempool: r.mempoolSize, gossipped: true });
  }

  if (p === '/mine' && req.method === 'POST') {
    const { miner } = await body(req);
    if (!miner) return json(res, 400, { error: 'miner address required' });
    if (bc.security.isBanned(miner)) return json(res, 403, { error: 'address_permabanned' });
    const t0 = Date.now();
    // слайс майнинга: не блокируем event loop — произвольный /mine с выросшей
    // сложностью иначе подвешивает /info и /life (инцидент 2026-10-14)
    const { header, txs } = bc.mineTemplate(miner);
    const NONCE_SLICE = 400_000; // ≈ доля секунды даже на слабом железе
    let h = null, ns = 0, found = false;
    while (ns < NONCE_SLICE) {
      h = computeBlockHash(header);
      if (hashMeetsDifficulty(h, header.difficultyBits)) { found = true; break; }
      header.nonce++; ns++;
    }
    if (!found) return json(res, 202, {
      error: 'mining_slice_exhausted', tried: ns, ms: Date.now() - t0,
      difficultyBits: header.difficultyBits,
      hint: 'сложность выше порога синхронного слайса: нода не должна зависать. Используйте пул /pool/join + /pool/submit или исправьте retarget',
    });
    const block = bc.commitMinedBlock(header, h, txs, miner, Date.now() - t0);
    if (!block || block.rejected) return json(res, 500, { error: 'commit_rejected', reason: block?.rejected || 'unknown', hint: 'блок не прошёл строгую внутреннюю валидацию (PoW/prev/merkle/coinbase/подписи tx)' });
    hub.broadcast({ type: 'inv-block', block: { height: block.height, hash: block.hash, header: block.header, txs: block.txs } });
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

  if (p === '/validate') {
    const strict = url.searchParams.get('strict') === '1';
    return json(res, 200, bc.validate(strict));
  }

  // --- Security Controller ---
  if (p === '/security/status') return json(res, 200, bc.security.status());
  if (p === '/security/banlist') return json(res, 200, { banned: bc.security.banList(), registryHash: bc.security.registryHash() });
  // ручной разбан оператором: {address} — вместе с TTL-автопродением это размад после N времени
  // ТЗ-1 (аудит 2026-10-15): деструктивные POST не должны быть доступны публике через туннель.
  // Охрана: если задан AGT_ADMIN_TOKEN — деструктивные POST требуют заголовок x-admin-token.
  // Без env-флага сеть продолжает работать как раньше (совместимость не ломаем).
  const REQUIRES_ADMIN = req.method === 'POST' &&
    ['/security/unban', '/peer/add', '/peer/remove'].includes(p);
  if (REQUIRES_ADMIN && process.env.AGT_ADMIN_TOKEN) {
    const ok = req.headers['x-admin-token'] === process.env.AGT_ADMIN_TOKEN;
    if (!ok) return json(res, 401, { error: 'admin_token_required', hint: 'set x-admin-token header' });
  }
  if (p === '/security/unban' && req.method === 'POST') {
    const { address } = await body(req);
    if (!address || !bc.security.bans[address]) return json(res, 404, { error: 'not_banned' });
    delete bc.security.bans[address];
    delete bc.security.strikes[address];
    bc.security.save();
    return json(res, 200, { unbanned: address });
  }
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
    // --- админ-приветствие новичка в чате (общаемся во благо жизни системы) ---
    const info = bc.info();
    try {
      const operator = Object.values(loadWallets())[0]?.address || 'AGT_ADMIN';
      chat.send({
        sender: operator, senderHandle: 'administrator',
        text: `👋 Добро пожаловать в сообщество, @${handle}! Твой адрес ${address.slice(0, 12)}… Тикер AGT, блоков: ${info.blocks}. Правила выше (пинн). Работаем вместе, баны за атаки — навсегда.`
      });
    } catch {}
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
  if (p === '/life') return json(res, 200, { ...lifeStatus(), shield: { loopLagMs, overloaded: Date.now() < shedUntil, rateMapSize: rateHits.size, maxConnections: server.maxConnections } });

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

  // ================= Mini-exchange DXE (книга из цепи) =================
  if (p === '/dxe/book') {
    const dxe = dxeState(bc);
    const item = url.searchParams.get('item') || (dxeItems(dxe)[0] || {}).item;
    if (!item) return json(res, 200, { item: null, note: 'книга пуста — ордеров ещё нет', items: [] });
    return json(res, 200, dxeBook(bc, dxe, item));
  }
  if (p === '/dxe/items') return json(res, 200, { items: dxeItems(dxeState(bc)) });
  if (p === '/dxe/orders') {
    const dxe = dxeState(bc);
    const maker = url.searchParams.get('maker');
    const item = url.searchParams.get('item');
    let list = dxe.orders;
    if (maker) list = list.filter(o => o.from === maker);
    if (item) list = list.filter(o => o.item === item);
    return json(res, 200, { count: list.length, orders: list.slice(-200).reverse() });
  }
  if (p === '/dxe/fills') {
    const dxe = dxeState(bc);
    const ref = url.searchParams.get('ref');
    const maker = url.searchParams.get('maker');
    let list = dxe.fills;
    if (ref) list = list.filter(f => f.orderRef === ref);
    if (maker) list = list.filter(f => f.from === maker || f.to === maker);
    return json(res, 200, { count: list.length, fills: list.slice(-200).reverse() });
  }
  if (p === '/dxe/order' && req.method === 'POST') {
    const { maker, side, item, qty, price } = await body(req);
    if (!maker || !side || !item || !qty || !price) return json(res, 400, { error: 'maker,side(b|s),item,qty,price required' });
    if (!['b', 's'].includes(String(side))) return json(res, 400, { error: 'side must be b or s' });
    const q = fmtNum(qty), pr = fmtNum(price);
    if (!q || !pr) return json(res, 400, { error: 'qty/price should be finite numbers' });
    const ref = dxeRef();
    const memo = `dxe|O|${side}|${String(item).slice(0, 40)}|${q}|${pr}|${ref}`;
    // несу\u0000ный amount — требование консенсуса; self-tx 0.001 AGT = «плата за вписание в книгу», деньги остаются у makerа
    const r = await postSignedTx(res, { fromAddress: maker, to: maker, amount: DXE_MEMO_FEE, memo });
    if (!r) return;
    return json(res, 201, { ...r, ref, memo, hint: 'ордер станет книгой после упаковки в блок; доставка товара — ответственность makerа (репутация/escrow)' });
  }
  if (p === '/dxe/fill' && req.method === 'POST') {
    const { buyer, ref, qty } = await body(req);
    if (!buyer || !ref || !qty) return json(res, 400, { error: 'buyer,ref,qty required' });
    const o = dxeState(bc).orders.find(o => o.ref === ref);
    if (!o) return json(res, 404, { error: 'order_not_found_in_chain', hint: 'ордер должен быть уже в блоке (в мемпуле книги нет)' });
    if (o.status === 'canceled') return json(res, 409, { error: 'order_canceled' });
    const remaining = +(o.qty - o.filled).toFixed(6);
    if (remaining <= 1e-9) return json(res, 409, { error: 'order_closed_fully_filled' });
    if (buyer === o.from) return json(res, 400, { error: 'self_trade_stp', note: 'STP: сделки с собой запрещены' });
    const qtyFill = Math.min(Number(qty), remaining);
    const due = +(o.price * qtyFill).toFixed(6);
    const memo = `dxe|F|${ref}|${fmtNum(qtyFill)}`;
    const r = await postSignedTx(res, { fromAddress: buyer, to: o.from, amount: due, memo });
    if (!r) return;
    return json(res, 201, { ...r, orderRef: ref, item: o.item, qtyFill, due, side: o.side, hint: 'state книги пересчитается из цепи после майнинга; fill с точной суммой принимается, всё иначе отвергается' });
  }
  if (p === '/dxe/cancel' && req.method === 'POST') {
    const { maker, ref } = await body(req);
    if (!maker || !ref) return json(res, 400, { error: 'maker,ref required' });
    const o = dxeState(bc).orders.find(o => o.ref === ref);
    if (o && o.from !== maker) return json(res, 403, { error: 'not_your_order' });
    const r = await postSignedTx(res, { fromAddress: maker, to: maker, amount: DXE_MEMO_FEE, memo: `dxe|C|${ref}` });
    if (!r) return;
    return json(res, 201, { ...r, ref, hint: 'отмена чужого адреса игнорируется индексером' });
  }

  // ================= GOV (предложения + голосование из цепи) =================
  if (p === '/gov/state') return json(res, 200, govState(bc));
  if (p === '/gov/proposal' && req.method === 'POST') {
    const { author, title, blocks = 100 } = await body(req);
    if (!author || !title) return json(res, 400, { error: 'author,title required' });
    const closesAt = bc.blockCount() + Math.max(10, Math.min(Number(blocks), 5000));
    const ref = govRef();
    const memo = `gov|P|${ref}|${closesAt}|${String(title).replace(/[|\r\n]/g, ' ').trim().slice(0, 60)}`;
    const r = await postSignedTx(res, { fromAddress: author, to: author, amount: DXE_MEMO_FEE, memo });
    if (!r) return;
    return json(res, 201, { ...r, ref, closesAt, hint: 'успех = yes≥'+ '3 и yes>no к closesAt ; активация интеграции — по решению закреплёнго окна' });
  }
  if (p === '/gov/vote' && req.method === 'POST') {
    const { voter, ref, choice } = await body(req);
    if (!voter || !ref || !['yes', 'no', 'abstain'].includes(String(choice))) return json(res, 400, { error: 'voter,ref,choice(yes|no|abstain) required' });
    const prop = govState(bc).proposals.find(x => x.ref === ref);
    if (!prop) return json(res, 404, { error: 'proposal_not_found_in_chain' });
    if (prop.closed) return json(res, 409, { error: 'voting_closed', closesAt: prop.closesAt });
    const r = await postSignedTx(res, { fromAddress: voter, to: voter, amount: DXE_MEMO_FEE, memo: `gov|V|${ref}|${choice}` });
    if (!r) return;
    return json(res, 201, { ...r, ref, choice, note: 'один адрес — один голос (первый фиксируется)' });
  }

  // ================= Кабинет агента: всё о моём адресе из цепи =================
  if (p.startsWith('/cabinet/')) {
    const addr = decodeURIComponent(p.slice('/cabinet/'.length));
    if (!/^AGT[A-Za-z0-9]+$/.test(addr)) return json(res, 400, { error: 'bad_address' });
    const balances = bc.balances();
    const dxe = dxeState(bc), gov = govState(bc);
    const txs = [];
    const escrows = [];
    for (let i = bc.chain.length - 1; i >= 0 && (txs.length < 25 || escrows.length < 10); i--) {
      const blk = bc.chain[i];
      for (const tx of (blk.txs || [])) {
        if (typeof tx.memo !== 'string') continue;
        const mine = tx.from === addr || tx.to === addr;
        if (!mine) continue;
        if (txs.length < 25) txs.push({ height: blk.height, from: tx.from, to: tx.to, amount: tx.amount, memo: tx.memo.slice(0, 80), txid: tx.txid ? String(tx.txid).slice(0, 12) : null });
        if (escrows.length < 10) {
          if (tx.memo.startsWith('escrow:')) {
            const parts = tx.memo.split(':');
            if (parts[4] === addr || tx.from === addr) escrows.push({ kind: 'open', escId: parts[1], role: parts[4] === addr ? 'worker' : 'employer', counterpart: parts[4] === addr ? tx.from : decodeURIComponent(parts[4]), amount: tx.amount, taskHash: String(parts[2]).slice(0, 12), height: blk.height });
          } else if (tx.memo.startsWith('escpayout:')) {
            const escId = tx.memo.slice('escpayout:'.length);
            if (tx.to === addr) escrows.push({ kind: 'paid', escId, role: 'worker', amount: tx.amount, height: blk.height });
          }
        }
      }
    }
    const myOrders = dxe.orders.filter(o => o.from === addr).slice(-20).reverse();
    const myFills = dxe.fills.filter(f => f.from === addr || (f.to === addr && f.accepted)).slice(-20).reverse();
    const myVotes = gov.proposals.filter(x => x.yes + x.no + x.abstain > 0).slice(0, 20).map(x => ({ ref: x.ref, title: x.title, result: x.result, closesAt: x.closesAt }));
    return json(res, 200, { address: addr, chainHeight: bc.blockCount(), balance: balances[addr] || 0, unit: TICKER,
      passport: { has: true, note: 'см. /whoami-interop: панель не полните ключи' },
      escrows, dxeOrders: myOrders, dxeFills: myFills, gov: myVotes,
      note: 'кабинет = чистая функция цепи: одинаков на всех нодах' });
  }

  // ====== Faucet: стартовый фонд для новичка (0.5 AGT раз в сутки на адрес, rate-limit по IP) ======
  const FAUCET_FUND_ADDR = (process.env.AGT_FAUCET_FUND || 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a');
  const FAUCET_FILE = path.join(DATA_DIR, 'faucet.json');
  function loadFaucet() { try { return JSON.parse(fs.readFileSync(FAUCET_FILE, 'utf8')); } catch { return { dripped: {}, ip: {} }; } }
  function saveFaucet(f) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FAUCET_FILE, JSON.stringify(f, null, 2)); }
  if (p === '/faucet/drip' && req.method === 'POST') {
    const { address } = await body(req);
    if (!/^AGT[A-Za-z0-9]+$/.test(String(address || ''))) return json(res, 400, { error: 'bad_address' });
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const ip = (req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    const f = loadFaucet();
    if (f.dripped[address] && now - f.dripped[address] < 24 * 3600_000)
      return json(res, 429, { error: 'already_dripped_24h', nextInHours: Math.ceil((24 * 3600_000 - (now - f.dripped[address])) / 3600_000) });
    const ipCount = (f.ip[ip] || 0) + 1;
    if (ipCount > 10 && now - (f.ipAt[ip] || 0) < 24 * 3600_000)
      return json(res, 429, { error: 'ip_limit', hint: '10 кошельков/IP/день максимум — если это честно много агентов, пиши administrator' });
    f.ip[ip] = ipCount; f.ipAt[ip] = f.ipAt[ip] || now;
    // Faucet.feed — на ноде электронный «казначей»: казна фонда = admin-кошелёк (operator already trust该公司)
    const FUND = { address: FAUCET_FUND_ADDR };
    const AMOUNT = 0.5;
    const fundW = loadWallets()[FUND.address];
    if (!fundW) return json(res, 503, { error: 'fund_wallet_missing' });
    const swapTx = { from: FUND.address, fromPub: fundW.pub, to: address, amount: AMOUNT, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: 'faucet:drip' };
    swapTx.signature = signTransaction(swapTx, fundW.privKey);
    const r = bc.addTransaction(swapTx);
    if (!r.ok) return json(res, 503, { error: 'fund_tx_rejected', detail: r.reason });
    f.dripped[address] = now;
    saveFaucet(f);
    setImmediate(() => { gossipTx(swapTx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: swapTx }); });
    return json(res, 200, { dripped: AMOUNT, unit: TICKER, to: address, note: 'раз в сутки; хватит на ~5 задач из очереди/день' });
  }

  // ====== Жифовый onboarding: новичок одним запросом становится работающим агентом ======
  if (p === '/join' && req.method === 'POST') {
    const out = {};
    const { label = 'new-agent-' + Date.now().toString(36) } = await body(req).catch(() => ({})) ;
    // 1) кошелёк
    const w = createWallet(label);
    const all = loadWallets();
    all[w.address] = { label: w.label, pub: w.pub, privKey: w.privKey, createdAt: w.createdAt };
    saveWallets(all);
    out.wallet = { address: w.address, privKey: w.privKey, pub: w.pub };
    // 2) faucet-газ (не блокируем, если уже получал)
    const f = loadFaucet();
    const ip = (req.socket.remoteAddress || 'unknown');
    const nowTs = Date.now();
    if (!f.dripped[w.address] || nowTs - f.dripped[w.address] >= 24 * 3600_000) {
      const FAUCET_FUND = FAUCET_FUND_ADDR;
      const FUND = { address: FAUCET_FUND_ADDR };
      const fundW = loadWallets()[FUND.address];
      if (FUND && fundW) {
        const tx = { from: FUND.address, fromPub: fundW.pub, to: w.address, amount: 0.5, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: 'faucet:join' };
        tx.signature = signTransaction(tx, fundW.privKey);
        const r = bc.addTransaction(tx);
        if (r.ok) { f.dripped[w.address] = nowTs; saveFaucet(f); setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); }); out.faucet = { dripped: 0.5, unit: TICKER }; }
        else out.faucet = { skipped: true, reason: r.reason };
      }
    }
    // 3) handle (если свободен)
    // 3) handle (если свободен) — синхронно через локальные loadHandles/handles.json
    try {
      const HANDLES_FILE = path.join(DATA_DIR, 'handles.json');
      const hh = (() => { try { return JSON.parse(fs.readFileSync(HANDLES_FILE, 'utf8')); } catch { return {}; } })();
      if (!hh[label]) { hh[label] = { address: w.address, registeredAt: Date.now() }; fs.writeFileSync(HANDLES_FILE, JSON.stringify(hh, null, 2)); out.handle = { identity: label + '@agt' }; }
      else out.handle = { taken: true };
    } catch {}
    // 4) аккаунт в очереди
    const q = queue.join(w.address, label);
    out.queue = q.ok ? q : { skipped: true, reason: q.reason };
    return json(res, 201, { ...out, next: 'POST /queue/claim {taker: <адрес>} → сделай работу → /queue/done; клют к задачам: /community/feed' });
  }

  // ====== Очередь агентов: FIFO → работа → в конец очереди, по кругу ======
  if (p === '/queue/status') return json(res, 200, queue.status());
  if (p === '/queue/join' && req.method === 'POST') {
    const { address, handle = '' } = await body(req);
    if (!/^AGT[A-Za-z0-9]+$/.test(String(address || ''))) return json(res, 400, { error: 'bad_address' });
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const r = queue.join(String(address), String(handle));
    return r.ok ? json(res, 200, { ...r, address }) : json(res, 409, r);
  }
  if (p === '/queue/claim' && req.method === 'POST') {
    const { taker = '' } = await body(req);
    const r = queue.claim(String(taker || 'panel'));
    return r.ok ? json(res, 200, r) : json(res, 409, r);
  }
  if (p === '/queue/done' && req.method === 'POST') {
    const { jobId, summary = '' } = await body(req);
    if (!jobId) return json(res, 400, { error: 'jobId required' });
    const agent = queue.state.onDuty[String(jobId)];
    if (!agent) return json(res, 404, { error: 'job_not_found', hint: 'возьмите работу через /queue/claim' });
    const r = queue.done(String(jobId), String(summary));
    queue.requeue(agent); // ротация: сразу в конец очереди
    return json(res, 200, { ...r, agent, requeued: true, note: 'работа принята; агент снова в очереди — по кругу' });
  }

  // --- P2P ---
  // --- инвентарь: WS-рассылка после коммита блока/приёма tx ---
  if (p === '/ws/status') return json(res, 200, { wsPeers: hub.count(), roster: hub.roster(), selfUrl: SELF_URL });

  // --- минимальный вне-HTTP-майнинг: template + строгий submit ---
  if (p === '/blocktemplate' && req.method === 'POST') {
    const { miner } = await body(req);
    if (!miner) return json(res, 400, { error: 'miner required' });
    if (bc.security.isBanned(miner)) return json(res, 403, { error: 'address_permabanned' });
    const { header, txs } = bc.mineTemplate(miner);
    return json(res, 200, { height: bc.blockCount(), header, txs, tipPrevHash: header.prevHash });
  }
  if (p === '/block/submit' && req.method === 'POST') {
    const { miner, header, txs, ms } = await body(req);
    if (!header || !Array.isArray(txs) || !header || !miner) return json(res, 400, { error: 'miner/header/txs required' });
    const t = Date.now();
    const block = bc.commitMinedBlock(header, computeBlockHash(header), txs, miner, ms || 0);
    if (!block || block.rejected) return json(res, 409, { accepted: false, reason: block?.rejected || 'unknown' });
    const cloudNote = cloud.onBlockMined(block.height, bc.info().nextReward, block.hash);
    hub.broadcast({ type: 'inv-block', block: { height: block.height, hash: block.hash, header: block.header, txs: block.txs } });
    return json(res, 200, {
      accepted: true, height: block.height, hash: block.hash.slice(0, 16), txs: block.txs.length, ms: Date.now() - t,
      cloud: { fundAGT: +cloudNote.fundAGT.toFixed(4), cloudGB: +cloudNote.cloudGB.toFixed(4), epochClosed: cloudNote.epochClosed },
    });
  }

  // --- Escrow за задачи (task-receipt) ---
  const escIdOf = () => crypto.randomBytes(10).toString('hex');
  // Open: employer (локальный кошелёк) → ESCROW_<id>
  if (p === '/escrow/create' && req.method === 'POST') {
    const { employer, worker, amount, taskHash, deadlineSec = 3600 } = await body(req);
    if (!employer || !worker || !amount || !taskHash) return json(res, 400, { error: 'employer,worker,amount,taskHash required' });
    if (bc.security.isBanned(employer)) return json(res, 403, { error: 'address_permabanned' });
    const wallets = loadWallets();
    const w = wallets[employer];
    if (!w) return json(res, 404, { error: 'employer_wallet_not_on_this_node' });
    const escId = escIdOf();
    const escAddress = ESCROW_PREFIX + escId;
    const deadlineTs = Math.floor(Date.now() / 1000) + Number(deadlineSec);
    const tx = { from: employer, fromPub: w.pub, to: escAddress, amount: Number(amount), nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: `escrow:${escId}:${taskHash}:${deadlineTs}:${worker}` };
    tx.signature = signTransaction(tx, w.privKey);
    tx.txid = txDigest(tx);
    const r = bc.addTransaction(tx);
    if (!r.ok) return json(res, 409, r);
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    return json(res, 201, { escId, escAddress, txid: tx.txid.slice(0, 16), mempool: r.mempoolSize, worker, employer, amount, deadlineTs, taskHash, hint: 'после майнинга получите /escrow/state' });
  }
  // Claim: работник подписывает квитанцию над taskHash (ключ локальный или прислан)
  if (p === '/escrow/claim' && req.method === 'POST') {
    const { escId, taskHash, workerPrivKey, workerAddress } = await body(req);
    const open = findEscrowOpen(bc.chain, String(escId || ''));
    if (!open || open.taskHash !== taskHash) return json(res, 404, { error: 'escrow_open_not_found_or_taskHash_mismatch', hint: 'эскроу должен быть уже в цепи (оплачен майнером)' });
    const wallets = loadWallets();
    const w = workerAddress && workerAddress === open.worker ? (wallets[workerAddress] || null) : null;
    const privKey = workerPrivKey || w?.privKey;
    if (!privKey) return json(res, 400, { error: 'worker key required: workerAddress (локальный кошелёк) или workerPrivKey (PEM)', workerExpected: open.worker });
    const digest = escrowReceiptDigest(String(escId), open.taskHash, open.worker, open.openTx.amount);
    const sig = crypto.sign(null, Buffer.from(digest, 'hex'), privKey).toString('hex');
    const pubOut = w?.pub || crypto.createPublicKey(privKey).export({ type: 'spki', format: 'pem' });
    return json(res, 200, { escId, receiptSig: sig, workerPub: pubOut, worker: open.worker, amount: open.openTx.amount, taskHash: open.taskHash });
  }
  // Payout: обе подписи в escProof → tx от адреса эскроу (без обычной подписи)
  if (p === '/escrow/payout' && req.method === 'POST') {
    const { escId, employerPrivKey, employerAddress, workerReceiptSig, workerPub } = await body(req);
    const open = findEscrowOpen(bc.chain, String(escId || ''));
    if (!open) return json(res, 404, { error: 'escrow_open_not_found' });
    const wallets = loadWallets();
    const ew = employerAddress && employerAddress === open.employer ? (wallets[employerAddress] || null) : null;
    const employerKey = employerPrivKey || ew?.privKey;
    if (!employerKey) return json(res, 400, { error: 'employer key required', employerExpected: open.employer });
    if (!workerReceiptSig || !workerPub) return json(res, 400, { error: 'worker receipt required (claim first)' });
    const confirmDigest = escrowConfirmDigest(String(escId), open.taskHash, open.worker, open.openTx.amount);
    const employerConfirm = crypto.sign(null, Buffer.from(confirmDigest, 'hex'), employerKey).toString('hex');
    const tx = {
      from: ESCROW_PREFIX + String(escId), to: open.worker, amount: open.openTx.amount,
      nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: `escpayout:${escId}`,
      escProof: { taskHash: open.taskHash, workerPub, workerReceipt: workerReceiptSig, employerConfirm },
    };
    tx.txid = txDigest(tx);
    const r = bc.addTransaction(tx);
    if (!r.ok) return json(res, 409, r);
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    return json(res, 201, { escId, payoutPrepared: true, txid: tx.txid.slice(0, 16), mempool: r.mempoolSize, note: 'tx в мемпуле; майнер упакует (двойная подпись проверяется любой нодой' });
  }
  // Refund: только после дедлайна (р condition verify в момент упаковки из chain)
  if (p === '/escrow/refund' && req.method === 'POST') {
    const { escId } = await body(req);
    const open = findEscrowOpen(bc.chain, String(escId || ''));
    if (!open) return json(res, 404, { error: 'escrow_open_not_found' });
    const tx = { from: ESCROW_PREFIX + String(escId), to: open.employer, amount: open.openTx.amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: `escrefund:${escId}` };
    tx.txid = txDigest(tx);
    const r = bc.addTransaction(tx);
    if (!r.ok) return json(res, 409, r);
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    return json(res, 201, { escId, refundPrepared: true, to: open.employer, amount: open.openTx.amount, txid: tx.txid.slice(0, 16), mempool: r.mempoolSize });
  }
  // Состояние всех эскроу ИЗ цепи (долгосрочный реестр)
  if (p === '/escrow/state') {
    const map = new Map();
    for (const blk of bc.chain) {
      for (const tx of blk.txs || []) {
        if (typeof tx.memo !== 'string') continue;
        const open = tx.memo.match(/^escrow:([a-f0-9]{10,32}):([a-f0-9]{16,64}):(\d+):(AGT[A-Za-z0-9]+)$/);
        if (open) {
          map.set(open[1], { escId: open[1], employer: tx.from, worker: open[4], taskHash: open[2], deadlineTs: Number(open[3]), openedAmount: tx.amount, paidOut: 0, status: 'open' });
          continue;
        }
        const payout = tx.memo.match(/^escpayout:([a-f0-9]{10,32})$/);
        if (payout && map.get(payout[1])) {
          const e = map.get(payout[1]);
          e.paidOut += tx.amount;
          e.status = e.paidOut >= e.openedAmount ? 'paid' : 'partial';
        }
        const refund = tx.memo.match(/^escrefund:([a-f0-9]{10,32})$/);
        if (refund && map.get(refund[1])) { const e = map.get(refund[1]); e.status = 'refunded'; e.refunded = tx.amount; }
      }
    }
    return json(res, 200, { escrows: [...map.values()] });
  }

  // --- Приватность: LSAG-кольца (ring.mjs) — доказательства принадлежности ---
  // Коммуникативные цели: анонимное голосование, подтверждение «я один из...».
  // Замечание (честно): спенсер-приватность переводов требует UTXO — контекст в docs.
  if (p === '/priv/pubkeys') {
    const wallets = loadWallets();
    const pubs = [];
    for (const [addr, w] of Object.entries(wallets)) pubs.push({ address: addr.slice(0, 14) + '…', pubHex: Buffer.from(w.pub.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64').subarray(-32).toString('hex') });
    return json(res, 200, { count: pubs.length, pubs });
  }
  if (p === '/priv/prove' && req.method === 'POST') {
    const { message, privKey, ringHex } = await body(req);
    if (!message) return json(res, 400, { error: 'message required' });
    if (!privKey) {
      const firstLocal = Object.entries(loadWallets()).find(([, w]) => w.privKey);
      if (!firstLocal) return json(res, 400, { error: 'no local wallet with privKey: pass privKey (PEM)' });
    }
    const ringHexList = Array.isArray(ringHex) && ringHex.length ? ringHex : (await (async () => { const wallets = loadWallets(); return Object.values(wallets).map(w => Buffer.from(w.pub.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64').subarray(-32).toString('hex')); })());
    const effPriv = privKey || Object.entries(loadWallets()).find(([, w]) => w.privKey)?.[1]?.privKey;
    const proof = lsagSign(effPriv, ringHexList, message);
    return json(res, 200, { proof, verifiedLocally: lsagVerify(proof, message) });
  }
  if (p === '/priv/verify' && req.method === 'POST') {
    const { proof, message } = await body(req);
    if (!proof || !message) return json(res, 400, { error: 'proof, message required' });
    return json(res, 200, { ok: lsagVerify(proof, message), keyImage: proof?.keyImage?.slice(0, 16) });
  }

  // ================= мини-коин + обмен данными (data402-мост) =================
  // Единица: 1 MAGT (MiniCoin) = 0.000001 AGT. Цены услуг — в M, счёт AGT.
  // Поток: агент-провайдер регистрирует item → покупатель ask → платит микро-tx
  // (memo `mdata:<askId>`) → провайдер отвечает /data/answer → покупатель забирает
  // по /data/fetch. С каждой сделки fee (0.5%, min 1 M) автоматически идёт в
  // облачный фонд сети. Ничего из этого не тормозит цепь: это слой услуг поверх.
  const M = 1e-6; // 1 MAGT в AGT
  const DATA_FILE = path.join(DATA_DIR, 'data-exchange.json');
  const loadDX = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { items: {}, asks: {} }; } };
  const saveDX = (dx) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(dx, null, 2)); };
  if (p === '/data/register' && req.method === 'POST') {
    const { provider, item, priceM = 50, answer, digest = '' } = await body(req);
    const dx = loadDX();
    if (!provider?.startsWith('AGT') || !item) return json(res, 400, { error: 'provider,item required' });
    if (dx.items[item]) return json(res, 409, { error: 'item_exists', owner: dx.items[item].provider });
    if (bc.security.isBanned(provider)) return json(res, 403, { error: 'address_permabanned' });
    dx.items[item] = { provider, item, priceM: Math.max(1, Math.floor(Number(priceM) || 1)), answer: answer || null, digest, registeredAt: Date.now() };
    saveDX(dx);
    const cat = dx.items[item];
    return json(res, 201, { item, provider: provider.slice(0, 14) + '…', priceM: cat.priceM, hint: 'покупатели увидят в /data/catalog' });
  }
  if (p === '/data/catalog') {
    const dx = loadDX();
    return json(res, 200, { items: Object.values(dx.items), unit: 'MAGT', note: '1 MAGT = 0.000001 AGT' });
  }
  if (p === '/data/ask' && req.method === 'POST') {
    const { item, buyer } = await body(req);
    const dx = loadDX();
    const it = dx.items[item];
    if (!it) return json(res, 404, { error: 'item_not_found' });
    const askId = crypto.randomBytes(8).toString('hex');
    dx.asks[askId] = { askId, item, provider: it.provider, buyer: buyer || null, priceM: it.priceM, status: 'awaiting_pay', at: Date.now() };
    saveDX(dx);
    return json(res, 201, { askId, item, provider: it.provider, priceM: it.priceM, payHint: 'POST /data/pay-ask {askId} — авто-подпись микро-tx кошельком автора запроса' });
  }
  if (p === '/data/pay-ask' && req.method === 'POST') {
    // Эскроу-модель данных (2026-10-14): деньги buyer'а уходят НЕ провайдеру, а в
    // ESCROW_<escId> (цепь-проверяемый контур с двойной подписью, как job-эскроу).
    // Провайдер получает Funds только после /data/confirm (digest-подтверждение buyer'а).
    const { askId, buyerAddress } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'awaiting_pay') return json(res, 409, { error: 'already_' + a.status });
    const bAddr = String(buyerAddress || a.buyer || '');
    const bw = bAddr ? loadWallets()[bAddr] : null;
    if (!bw?.privKey) return json(res, 400, { error: 'buyer_wallet_not_on_node' });
    if (bc.security.isBanned(bAddr)) return json(res, 403, { error: 'address_permabanned' });
    if (a.priceM < 10) return json(res, 400, { error: 'price_too_low_for_escrow', minM: 10 });
    const agt = a.priceM * M;
    const feeAGT = Math.max(a.priceM * 0.005 * M, 1 * M); // 0.5%, min 1 MAGT — остаётся запертой в эскроу (гари в фонде)
    const balNow = bc.balances()[bAddr] || 0;
    if (balNow < agt) return json(res, 402, { error: 'insufficient_balance', balance: balNow, needAGT: +agt.toFixed(9) });
    const escId = crypto.randomBytes(6).toString('hex');
    const taskHash = crypto.createHash('sha256').update(a.item + '|' + askId).digest('hex');
    const deadlineTs = Math.floor(Date.now() / 1000) + 24 * 3600;
    const escrTx = { from: bAddr, fromPub: bw.pub, to: ESCROW_PREFIX + escId, amount: +agt.toFixed(9), nonce: Date.now() * 1000 + Math.floor(Math.random() * 999), ts: Math.floor(Date.now() / 1000), memo: `escrow:${escId}:${taskHash}:${deadlineTs}:${a.provider}` };
    escrTx.signature = signTransaction(escrTx, bw.privKey);
    escrTx.txid = txDigest(escrTx);
    const rop = bc.addTransaction(escrTx);
    if (!rop.ok) return json(res, 409, rop);
    setImmediate(() => { gossipTx(escrTx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: escrTx }); });
    a.status = 'in_escrow'; a.escId = escId; a.taskHash = taskHash; a.deadlineTs = deadlineTs;
    a.txid = escrTx.txid.slice(0, 16); a.buyer = bAddr; a.feeM = +(feeAGT / M).toFixed(3);
    dx.asks[askId] = a; saveDX(dx);
    return json(res, 200, { askId, escrowed: +a.priceM.toLocaleString('en-US') + ' M в escrow до confirm', escId, deadlineTs, feeM: a.feeM, txid: a.txid, mempool: rop.mempoolSize, hint: 'провайдер отвечает /data/answer → покупатель /data/confirm (или /data/refund после deadline, если провайдер не отдал данные)' });
  }
  if (p === '/data/confirm' && req.method === 'POST') {
    // digest-подтверждение buyer'а: эскроу-расход на провайдера — payout Tx ESCROW_ → provider,
    // подписанный двойным подписыва-доказательством (workerReceipt + employerConfirm) —
    // консенсус-валидация проверена в verifyEscrowTx на ЛЮБОЙ ноде.
    const { askId, buyerAddress } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'answered') return json(res, 409, { error: 'status_' + a.status });
    const bAddr = String(buyerAddress || a.buyer || '');
    const bw = bAddr ? loadWallets()[bAddr] : null;
    const pw = loadWallets()[a.provider];
    if (!bw?.privKey) return json(res, 400, { error: 'buyer_wallet_not_on_node' });
    if (!pw?.privKey) return json(res, 400, { error: 'provider_wallet_not_on_node' });
    if (bc.security.isBanned(bAddr) || bc.security.isBanned(a.provider)) return json(res, 403, { error: 'address_permabanned' });
    const agt = a.priceM * M;
    const feeAGT = Math.max(a.priceM * 0.005 * M, 1 * M);
    const outAmount = +(agt - feeAGT).toFixed(9);
    if (outAmount <= 0) return json(res, 400, { error: 'price_too_low' });
    const receiptMsg = Buffer.from(escrowReceiptDigest(a.escId, a.taskHash, a.provider, outAmount), 'hex');
    const confirmMsg = Buffer.from(escrowConfirmDigest(a.escId, a.taskHash, a.provider, outAmount), 'hex');
    const ptx = { from: ESCROW_PREFIX + a.escId, to: a.provider, amount: outAmount, nonce: Date.now() * 1000 + Math.floor(Math.random() * 999), ts: Math.floor(Date.now() / 1000), memo: `escpayout:${a.escId}`, escProof: { taskHash: a.taskHash, workerPub: pw.pub, workerReceipt: crypto.sign(null, receiptMsg, pw.privKey).toString('hex'), employerConfirm: crypto.sign(null, confirmMsg, bw.privKey).toString('hex') } };
    ptx.txid = txDigest(ptx);
    const rr = bc.addTransaction(ptx);
    if (!rr.ok) return json(res, 409, rr);
    setImmediate(() => { gossipTx(ptx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: ptx }); });
    a.status = 'confirmed'; a.payoutTxid = ptx.txid.slice(0, 16); a.confirmedAt = Date.now();
    dx.asks[askId] = a; saveDX(dx);
    cloud.microFee(feeAGT, `mdata-escrow:${a.item}`);
    return json(res, 200, { askId, confirmed: true, payoutTxid: a.payoutTxid, providerGotM: +(outAmount / M).toFixed(3), feeLockedM: a.feeM });
  }
  if (p === '/data/refund' && req.method === 'POST') {
    // Возврат НЕотданных данных: только ПОСЛЕ deadlineTs (проверено из цепи, детерминировано)
    const { askId, buyerAddress } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'in_escrow') return json(res, 409, { error: 'status_' + a.status + ' (refund только для in_escrow)' });
    const bAddr = String(buyerAddress || a.buyer || '');
    const bw = loadWallets()[bAddr];
    if (!bw?.privKey) return json(res, 400, { error: 'buyer_wallet_not_on_node' });
    const agt = a.priceM * M;
    const rtx = { from: ESCROW_PREFIX + a.escId, to: bAddr, amount: +agt.toFixed(9), nonce: Date.now() * 1000 + Math.floor(Math.random() * 999), ts: Math.floor(Date.now() / 1000), memo: `escrefund:${a.escId}` };
    rtx.txid = txDigest(rtx);
    const rr = bc.addTransaction(rtx);
    if (!rr.ok) return json(res, 409, rr);
    setImmediate(() => { gossipTx(rtx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: rtx }); });
    a.status = 'refunded'; a.refundTxid = rtx.txid.slice(0, 16); a.refundedAt = Date.now();
    dx.asks[askId] = a; saveDX(dx);
    return json(res, 200, { askId, refunded: true, refundTxid: a.refundTxid });
  }
  if (p === '/data/answer' && req.method === 'POST') {
    // Провайдер (его скрипт serve) отдаёт ответ на оплаченный ask
    const { provider, askId, answer, answerDigest } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.provider !== provider) return json(res, 403, { error: 'not_your_ask' });
    if (a.status !== 'paid' && a.status !== 'answered' && a.status !== 'in_escrow') return json(res, 409, { error: 'status_' + a.status });
    a.status = 'answered'; a.answer = String(answer || '').slice(0, 20000); a.answerDigest = answerDigest || crypto.createHash('sha256').update(a.answer).digest('hex').slice(0, 16); a.answeredAt = Date.now();
    saveDX(dx);
    return json(res, 200, { askId, answered: true, digest: a.answerDigest });
  }
  if (p === '/data/fetch') {
    const dx = loadDX();
    const fetchId = url.searchParams.get('askId');
    const a = dx.asks[fetchId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'answered') return json(res, 202, { status: a.status, note: 'answer ещё не отдан провайдером' });
    return json(res, 200, { askId: fetchId, answer: a.answer, answerDigest: a.answerDigest, txid: a.txid, priceM: a.priceM, paidAt: a.answeredAt, esc: { escId: a.escId, deadlineTs: a.deadlineTs, hint: 'если дайджест совпал → /data/confirm; иначе /data/refund (после deadline)' } });
  }
  if (p === '/data/asks') {
    // очередьasks провайдера для его serve-скрипта
    const provider = url.searchParams.get('provider');
    const dx = loadDX();
    const list = Object.values(dx.asks).filter(a => a.provider === provider && (a.status === 'answered' || a.status === 'in_escrow')).slice(-50);
    return json(res, 200, { asks: list });
  }

  // --- Паспорт-реестр (agent seq-номера) — операторский учёт, конфиденциальный ---
  // Скрытые номера: наружу отдаётся ТОЛЬКО одноразовый запечатанный конверт
  // (AES-256-GCM на ключе SHA256(privKey+'agtx-passport-v1')), выданный на момент
  // issue. Повторно конверт не пересылается; seqStr наружу никогда не покидает ноду.
  const PASSPORT_FILE = path.join(__dirname, 'data-agents', 'passports.json');
  // ================= ПРОПУСКАЯ СИСТЕМА (ошибка «стада») =================
  // Агент постучался → получил правила объектором → получил № в очереди →
  // ждёт автопуска FIFO с rate-cap (частичка за час, чтобы толпа не завалит сеть).
  // Паспорт выдаётся только носителю одобренного пропуска (волны 1–2 предодобрены).
  const GATE_FILE = path.join(DATA_DIR, 'gate.json');
  const loadGate = () => { try { return JSON.parse(fs.readFileSync(GATE_FILE, 'utf8')); } catch { return { queue: {}, approved: {}, nextSeq: 1, perHour: 60 }; } };
  const saveGate = (g) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(GATE_FILE, JSON.stringify(g, null, 2)); };
  const GATE_RULES = 'Правила сети AGT: 1) подписи ed25519, подделка = permaban; 2) double-spend = permaban; 3) tx > 100 AGT — только whitelist; 4) спам/дубликаты tx = permaban; 5) работа = эскроу (create→claim→payout); 6) мини-коин MAGT 1e-6 AGT, fee 0.5% в фонд; 7) паспорт конфиденциальен, номер агенту не отдаётся; 8) дедуп WS — не долбиться коннектами; 9) очередь пропусков — FIFO, не умолять тег пропускать вперёд; 10) держатель = нода (node agtx.mjs setup).';
  if (p === '/gate/knock' && req.method === 'POST') {
    const { address, handle = '' } = await body(req);
    if (!address || !String(address).startsWith('AGT')) return json(res, 400, { error: 'address required' });
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const g = loadGate();
    const key = String(address).toLowerCase();
    if (!g.queue[key] && !g.approved[key]) g.queue[key] = { handle: String(handle).slice(0, 20), knockAt: Date.now(), seq: g.nextSeq++, state: 'queued' };
    saveGate(g);
    const entry = g.approved[key] || g.queue[key];
    const ahead = Object.values(g.queue).filter(e => e.state === 'queued' && e.seq < entry.seq).length;
    return json(res, 201, { knockId: 'G' + String(entry.seq).padStart(6, '0'), queuePos: g.approved[key] ? 0 : ahead + 1, rules: GATE_RULES, rulesAccepted: false, note: 'прочту правила → POST /gate/accept {knockId} → встанешь в очередь, автопуск FIFO' });
  }
  if (p === '/gate/accept' && req.method === 'POST') {
    const { knockId } = await body(req);
    const g = loadGate();
    const entry = Object.values(g.queue).find(e => 'G' + String(e.seq).padStart(6, '0') === String(knockId));
    if (!entry) return json(res, 404, { error: 'knock_not_found' });
    entry.rulesAccepted = true; entry.acceptedAt = Date.now();
    saveGate(g);
    return json(res, 200, { knockId, state: 'queued', note: 'правила приняты; ждём автоматического пропуска FIFO' });
  }
  // автопуск FIFO: за один вызов одобряем до per-entry rate — логично пинать из guard'а раз в 4 мин
  if (p === '/gate/tick') {
    const g = loadGate();
    const hour = Math.floor(Date.now() / 3600_000);
    if (g.allowHour !== hour) { g.allowHour = hour; g.allowCount = 0; }
    g.allowCount = g.allowCount || 0;
    let admitted = 0;
    const queued = Object.entries(g.queue).filter(([, e]) => e.state === 'queued' && e.rulesAccepted).sort((a, b) => a[1].seq - b[1].seq);
    for (const [addrKey, e] of queued) {
      if (g.allowCount >= (g.perHour || 60)) break;
      e.state = 'approved'; e.approvedAt = Date.now();
      g.approved[addrKey] = { seq: e.seq, approvedAt: e.approvedAt, handle: e.handle };
      g.allowCount++; admitted++;
    }
    saveGate(g);
    return json(res, 200, { admitted, queuedLeft: queued.length - admitted });
  }
  if (p === '/gate/approve' && req.method === 'POST') { // оператор вне очереди (sensitive)
    const { address } = await body(req);
    const g = loadGate();
    const key = String(address || '').toLowerCase();
    if (!g.queue[key]) return json(res, 404, { error: 'knock_not_registered' });
    g.queue[key].state = 'approved'; g.approved[key] = { seq: g.queue[key].seq, approvedAt: Date.now(), handle: g.queue[key].handle };
    saveGate(g);
    return json(res, 200, { approved: key });
  }
  if (p === '/gate/queue') {
    const g = loadGate();
    return json(res, 200, { queued: Object.values(g.queue).filter(e => e.state === 'queued').length, approved: Object.keys(g.approved).length, rulesHead: GATE_RULES.slice(0, 80) + '…' });
  }
  if (p === '/passport/count') {
    let reg = []; try { reg = JSON.parse(fs.readFileSync(PASSPORT_FILE, 'utf8')); } catch {}
    return json(res, 200, { count: reg.length, headHash: reg.length ? reg[reg.length - 1].hash : null });
  }
  if (p === '/passport/issue' && req.method === 'POST') {
    const { address, handle = '' } = await body(req);
    if (!address || !String(address).startsWith('AGT')) return json(res, 400, { error: 'address required' });
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const wallets = loadWallets();
    const w = wallets[address];
    if (!w || !w.privKey) return json(res, 404, { error: 'wallet_not_registered_here', hint: 'POST /wallet/create на этой ноде (держатель = нода)' });
    // пропуск-контур: паспорт выдаётся только после одобренного пропуска (волны 1–2 предодобрены оператором)
    const g = loadGate();
    if (!g.approved[String(address).toLowerCase()]) {
      return json(res, 429, { error: 'gate_queue_required', hint: 'POST /gate/knock → правила → /gate/accept → очередь FIFO' });
    }
    let reg = []; try { reg = JSON.parse(fs.readFileSync(PASSPORT_FILE, 'utf8')); } catch {}
    const existing = reg.find(r => r.address === address);
    if (existing) return json(res, 409, { issued: true, seal: null, exists: true, note: 'паспорт уже в реестре; конверт не пере-выдаётся (конфиденциальность)' });
    const seq = reg.length + 1;
    const safeHandle = (handle && /^[a-z0-9_-]{3,20}$/i.test(handle)) ? handle : ('holder-' + address.slice(3, 11));
    const rec = { seq, seqStr: String(seq).padStart(21, '0'), handle: safeHandle, address, issuedAt: Date.now(), revoked: false };
    rec.prevHash = reg.length ? reg[reg.length - 1].hash : 'GENESIS';
    rec.hash = crypto.createHash('sha256').update(rec.prevHash + JSON.stringify({ seqStr: rec.seqStr, address: rec.address, handle: rec.handle, issuedAt: rec.issuedAt })).digest('hex');
    // конверт: шифруем seqStr ключом из privKey держателя — и не храним plaintext наружу
    const k = crypto.createHash('sha256').update(w.privKey + 'agtx-passport-v1').digest();
    const iv = crypto.randomBytes(12);
    const ci = crypto.createCipheriv('aes-256-gcm', k, iv);
    const ct = Buffer.concat([ci.update(rec.seqStr, 'utf8'), ci.final()]);
    reg.push(rec);
    fs.mkdirSync(path.dirname(PASSPORT_FILE), { recursive: true });
    fs.writeFileSync(PASSPORT_FILE, JSON.stringify(reg, null, 2));
    fs.appendFileSync(path.join(__dirname, 'data-agents', 'passport-events.log'), JSON.stringify({ at: new Date().toISOString(), address, seq, handle: rec.handle }) + '\n');
    console.log(`[passport] выдан seq#${seq} → ${address.slice(0, 14)} (${rec.handle})`);
    return json(res, 201, { issued: true, seal: { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: ci.getAuthTag().toString('base64') }, headHash: rec.hash, note: 'конверт одноразовый; храни локально, не показывай агенту' });
  }

  if (p === '/peer/add' && req.method === 'POST') {
    const { peer } = await body(req);
    if (!peer) return json(res, 400, { error: 'peer url required' });
    return json(res, 200, { peers: addPeer(peer) });
  }
  if (p === '/sync-now') {
    const logLines = await syncAll(bc);
    return json(res, 200, { synced: true, log: logLines, blocks: bc.blockCount() });
  }

  // --- шлюзы AGT (GATEWAY_TYPES) + пул майнинга ---
  if (p === '/gateway/open' && req.method === 'POST') {
    const { type, owner, config = {} } = await body(req);
    const r = bc.gateways.open(type, owner, config);
    return r.ok ? json(res, 201, r) : json(res, 400, r);
  }
  if (p === '/gateway/close' && req.method === 'POST') {
    const { gwId, owner } = await body(req);
    return json(res, 200, bc.gateways.close(gwId, owner));
  }
  if (p === '/gateway/list') return json(res, 200, bc.gateways.status());
  if (p === '/gateway/route' && req.method === 'POST') {
    const { from, to } = await body(req);
    return json(res, 200, bc.gateways.findRoute(from, to));
  }
  // Multihop-исполнение: строит план, подписывает в mempool обе leg-и, майнит блок
  if (p === '/gateway/pay' && req.method === 'POST') {
    const { from, fromPub, to, amount, memo = '', signerPrivKey } = await body(req);
    if (!from || !to || !amount) return json(res, 400, { error: 'from,to,amount required' });
    if (bc.security.isBanned(from)) return json(res, 403, { error: 'address_permabanned' });
    const plan = bc.gateways.executeMultiHop(bc, from, to, amount, memo);
    if (!plan.ok) return json(res, 409, plan);
    // подписываем каждую leg её signAs-ключом (sender для leg1, forward-owner для leg2)
    const wallets = loadWallets();
    const privOf = (addr) => signerPrivKey && addr === from ? signerPrivKey : (wallets[addr]?.privKey || signerPrivKey);
    const pubOf = (addr) => wallets[addr]?.pub || (addr === from ? fromPub : null);
    const signed = [];
    const txids = [];
    for (const step of plan.plan) {
      const key = privOf(step.signAs);
      if (!key) return json(res, 400, { error: 'signer_key_missing', signAs: step.signAs, hint: 'кошелёк owner шлюза должен быть локальным на ноде' });
      const tx = { ...step.tx, fromPub: pubOf(step.signAs) };
      tx.signature = signTransaction(tx, key);
      const r = bc.addTransaction(tx);
      if (!r.ok) return json(res, 409, { error: 'hop_rejected', leg: step.leg, reason: r.reason, signed: signed.length });
      txids.push(tx.txid);
      signed.push({ leg: step.leg, gw: step.gw });
    }
    // v3: НЕ майним мгновенно — обе leg-и лежат в мемпуле,
    // их упакует ближайший блок майнера (периодическая упаковка).
    bc.gateways.hop(txids[0] || 'hop-' + Date.now(), signed.map(s => s.gw));
    return json(res, 200, {
      multihop: true, legs: signed, feePaid: plan.feeTotal, arrived: plan.arrive,
      txids, mempool: bc.mempool.length,
      note: 'транзакции в мемпуле; упакует ближайший блок майнера (периодическая упаковка)',
    });
  }

  if (p === '/pool/join' && req.method === 'POST') {
    const { address } = await body(req);
    const header = bc.headHeaderTemplate();
    bc.pool.targetHeader = header;
    const r = bc.pool.join(address);
    return r.ok ? json(res, 201, { ...r, template: header }) : json(res, 400, r);
  }
  if (p === '/pool/stats') return json(res, 200, bc.pool.stats());
  if (p === '/pool/submit' && req.method === 'POST') {
    const { address, headerString } = await body(req);
    const r = bc.pool.submitShare(address, headerString);
    return r.ok ? json(res, 200, r) : json(res, 400, r);
  }
  if (p === '/pool/distribute' && req.method === 'POST') {
    const r = bc.pool.distribute(bc.info().nextReward);
    return r.ok ? json(res, 200, r) : json(res, 400, r);
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
  // ====== Публичная витрина /stats — живое «лицо» сети для браузера ======
  if (p === '/stats' || p === '/stats.html') {
    try {
      const info = bc.info();
      const bal = bc.balances();
      const treasury = Object.entries(bal).filter(([a]) => a === FAUCET_FUND_ADDR).map(([, v]) => v)[0] || 0;
      const q = queue.status();
      const escrows = (() => { // эскроу живёт в цепи как memo-txs; считаем like /escrow/state
        const map = new Map();
        for (const blk of bc.chain) {
          for (const tx of blk.txs || []) {
            if (typeof tx.memo !== 'string') continue;
            const open = tx.memo.match(/^escrow:([a-f0-9]{10,32}):/);
            if (open) { map.set(open[1], { status: 'open' }); continue; }
            const payout = tx.memo.match(/^escpayout:([a-f0-9]{10,32})$/);
            if (payout && map.get(payout[1])) map.get(payout[1]).status = 'paid';
            const refund = tx.memo.match(/^escrefund:([a-f0-9]{10,32})$/);
            if (refund && map.get(refund[1])) map.get(refund[1]).status = 'refunded';
          }
        }
        return [...map.values()];
      })();
      const paid = escrows.filter(e => e.status === 'paid').length;
      const peersMeta = peerMetaStatus();
      const aliveNodes = ['9335', '9341', '9342', '9336'].length; // кластер
      const catalog = cloud.stats() || {};
      const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"><title>AGENTCOIN — поверка сети</title>
<style>body{font-family:Segoe UI,system-ui;background:#0e1117;color:#e6e6e6;max-width:900px;margin:30px auto;padding:0 16px}
h1{color:#f7931a} .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px} .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 16px} .num{font-size:1.7em;font-weight:700;color:#58a6ff} .lbl{font-size:.85em;color:#8b949e} a{color:#58a6ff} .ok{color:#3fb950} .warn{color:#d29922}</style></head><body>
<h1>🟠 AGENTCOIN — публичная витрина</h1>
<p>/live · /dashboard · /terminal · README: <a href="https://github.com/CrChCn/agentcoin">GitHub</a>. Join одним запросом: <code>POST /join {label}</code></p>
<div class="grid">
<div class=card><div class=num>${info.blocks}</div><div class=lbl>блоков в цепи</div></div>
<div class=card><div class=num>${(info.totalSupplyCirculating||0).toFixed ? info.totalSupplyCirculating.toFixed(0) : info.totalSupplyCirculating}</div><div class=lbl>AGT в обороте (max ${info.maxSupply})</div></div>
<div class=card><div class=num>${info.halvingIn}</div><div class=lbl>блоков до халвинга</div></div>
<div class=card><div class=num class=ok style="color:#3fb950">${treasury.toFixed(0)}</div><div class=lbl>казна фонда AGT</div></div>
<div class=card><div class=num>${q.waiting}</div><div class=lbl>в очереди агентов</div></div>
<div class=card><div class=num>${q.onDuty}</div><div class=lbl>на задании</div></div>
<div class=card><div class=num>${escrows.length}</div><div class=lbl>эскроу-заданий всего</div></div>
<div class=card><div class=num>${paid}</div><div class=lbl>эскроу выплачено (paid)</div></div>
<div class=card><div class=num>${aliveNodes}</div><div class=lbl>нод в кластере</div></div>
<div class=card><div class=num>${Object.keys(peersMeta).filter(k => !peersMeta[k].blockedUntil).length}</div><div class=lbl>пиров на связи (без блоков)</div></div>
</div>
<p class=lbl>обновляется каждые 30 с · узкое место сети — не код, а люди: расскажи друзьям.</p>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) { return json(res, 500, { error: 'stats_error', detail: e.message }); }
  }

  // --- визуальный пульт сети ---
  if (p === '/dashboard' || p === '/dashboard.html') {
    const html = fs.readFileSync(path.join(__dirname, 'site', 'dashboard.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  // --- агентский терминал: задания/рынок/голосование/кабинет ---
  if (p === '/terminal' || p === '/terminal.html') {
    const html = fs.readFileSync(path.join(__dirname, 'site', 'terminal.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (p === '/') {
    // Браузер на корне → сразу визуальный пульт (друзья по tailnet видят панель, не JSON);
    // API-клиенты (майнеры/агенты, Accept */*) продолжают получать сам-описание как раньше.
    if ((req.headers.accept || '').includes('text/html')) {
      res.writeHead(302, { Location: '/dashboard' });
      return res.end();
    }
    return json(res, 200, {
    name: 'AGENTCOIN node', chainId: CHAIN_ID, ticker: TICKER, maxSupply: MAX_SUPPLY,
    consensus: 'PoW + best-chain-by-cumulative-work (fork vote) + headers-first sync + tx gossip',
    endpoints: ['/info', '/blocks?n=|from=', '/headers?from=&limit=', '/mempool', '/forks', '/peers/meta',
      'POST /wallet/create', 'POST /balance', 'POST /tx/sign', 'POST /tx (→ gossip peers)', 'POST /mine', '/validate?strict=1',
      'GET /security/status', 'GET /security/banlist', 'GET /security/attacks',
      'POST /handle/register', 'GET /whoami/<name>', 'GET /life',
      'GET /whitelist/status', 'POST /whitelist/verify', 'POST /whitelist/check',
      'GET /community/feed', 'POST /community/send', 'GET /community/rules', 'GET /community/pinned', 'POST /community/pin',
      'POST /peer/add', 'GET /sync-now', 'GET /chat (UI)', 'GET /cloud/stats', 'GET /cloud/epochs', 'GET /cloud/ledger', 'POST /mine/l402'],
    });
  }

  json(res, 404, { error: 'not_found' });
});

// --- WebSocket P2P (RFC 6455): inv-рассылка блоков/транзакций пейрастной сети ---
hub.attachServer(server, SELF_URL, {
  onBlock: (msg, peer) => {
    try {
      const blk = msg.block;
      if (!blk || !blk.header) return;
      // дубликат?
      if (bc.blockCount() > blk.height) return;
      if (getBlockHash(bc) === blk.hash) return;
      if (blk.header.prevHash !== (bc.tip()?.hash || null) || blk.height !== bc.blockCount()) {
        // развилка/пропуск → полный headers-first синк по HTTP
        setImmediate(() => { syncAll(bc).catch(() => {}); });
        return;
      }
      const reason = validateBlockAgainstChain(blk, bc.chain);
      if (reason) { console.log(`[ws] блок ${blk.height} от ${peer.theirUrl} отвергнут: ${reason}`); return; }
      applyBlockFast(bc, blk);
      console.log(`[ws] блок ${blk.height} принят от ${peer.theirUrl}`);
      hub.broadcast(msg, peer); // ре-рассылка другим (дубликаты отсеюются)
    } catch (e) { console.log('[ws] block error', e.message); }
  },
  onTx: (msg, peer) => {
    try {
      const tx = msg.tx;
      if (!tx) return;
      const r = bc.addTransaction(tx);
      if (r.ok) {
        console.log(`[ws] tx ${String(tx.txid).slice(0, 12)} принята от ${peer.theirUrl}`);
        setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); });
      }
    } catch (e) { console.log('[ws] tx error', e.message); }
  },
});
const BIND = process.env.AGT_BIND || '127.0.0.1'; // наружу — только осознанно: AGT_BIND=0.0.0.0 или конкретный IP
const isLocalBind = BIND === '127.0.0.1' || BIND === 'localhost';
if (!isLocalBind) console.log(`[${new Date().toISOString()}] ВНИМАНИЕ: нода слушает ${BIND} — проверь firewall/прокси, админ-эндпоинты не защищены токеном`);
server.maxConnections = 256; // OWASP DoS: лишние TCP-соединения отбрасываются
server.on('drop', (info) => console.log(`[shield] connection dropped: ip ${info.remoteAddress}`));
server.listen(PORT, BIND); // maxConnections капнут ниже (анти-overload: TCP за пределами порога отбрасывается)
// Инцидент 2026-10-15: uncaughtException-guard ниже проглатывал EADDRINUSE —
// дубликат ноды от watchdog-а логировал ошибку и ЖИЛ ВЕЧНО (18 зомби-процессов
// с таймерами голсипа на один data-каталог → рассинхрон высот и ложные FAIL-аудиты).
// Ошибка СЛУШАНИЯ = узел бесполезен → жёсткий выход (watchdog поднимет заново).
server.on('error', (err) => {
  console.error(`[listen-fatal] ${err.code || ''}: ${err.message} (port ${PORT}, bind ${BIND}) — выходим, watchdog перезапустит`);
  process.exit(1);
});
console.log(`[${new Date().toISOString()}] AGENTCOIN node v2 listening on http://${BIND}:${PORT}`);
const hubMsgHandlers = {
  onBlock: (msg, peer) => {
    try {
      const blk = msg.block;
      if (!blk || !blk.header) return;
      if (bc.blockCount() > blk.height) return;
      if (blk.hash === (bc.tip()?.hash || null)) return;
      if (blk.header.prevHash !== (bc.tip()?.hash || null) || blk.height !== bc.blockCount()) {
        setImmediate(() => { syncAll(bc).catch(() => {}); });
        return;
      }
      const reason = validateBlockAgainstChain(blk, bc.chain);
      if (reason) { console.log(`[ws] блок ${blk.height} отвергнут: ${reason}`); return; }
      applyBlockFast(bc, blk);
      console.log(`[ws] блок ${blk.height} принят от ${peer.theirUrl}`);
      hub.broadcast(msg, peer);
    } catch (e) { console.log('[ws] block error', e.message); }
  },
  onTx: (msg, peer) => {
    try {
      const tx = msg.tx;
      if (!tx) return;
      const r = bc.addTransaction(tx);
      if (r.ok) {
        console.log(`[ws] tx ${String(tx.txid).slice(0, 12)} принята от ${peer.theirUrl}`);
        setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); });
        hub.broadcast(msg, peer); // ре-рассылка WS-соседям
      }
    } catch (e) { console.log('[ws] tx error', e.message); }
  },
};
const wsCooldown = new Map(); // peerUrl → untilMs (после close(1008) не перерываемся)
const WS_COOLDOWN_MS = 5 * 60 * 1000;
async function wsConnectLoop() {
  const peers = loadPeers();
  if (!peers.length) console.log('[ws] peers.json пуст — не к кому присоединяться');
  for (const peerUrl of peers) {
    const until = wsCooldown.get(peerUrl);
    if (until && until > Date.now()) continue;
    if (until) wsCooldown.delete(peerUrl);
    const sockUrl = peerUrl + `/ws?their=${encodeURIComponent(SELF_URL)}`;
    const already = [...hub.peers].some(p => p.connectedPeerUrl === peerUrl);
    if (already) continue;
    try {
      const client = await connectClient(sockUrl, { timeoutMs: 4000 });
      client.connectedPeerUrl = peerUrl;
      client.theirUrl = peerUrl;
      client.onMessage = (txt) => {
        let m = null; try { m = JSON.parse(txt); } catch { return; }
        if (m?.type === 'inv-block') hubMsgHandlers.onBlock(m, client);
        if (m?.type === 'inv-tx') hubMsgHandlers.onTx(m, client);
      };
      client.onClose = () => {
        console.log(`[ws] отсоединён: ${peerUrl}`);
        wsCooldown.set(peerUrl, Date.now() + WS_COOLDOWN_MS); // не метнуть в дедуп-сервер, уйти в бэк-off
      };
      wsCooldown.delete(peerUrl);
      console.log(`[ws] подключены к ${peerUrl}`);
    } catch (e) { console.log(`[ws] не подключился ${peerUrl}: ${e.message}`); /* HTTP-синк продолжит работу */ }
  }
}
setInterval(() => wsConnectLoop().catch(() => {}), 30_000);
console.log('[ws] ws-модуль инициализирован (server + outbound loop)');
wsConnectLoop().catch((e) => console.log('[ws] loop crash:', e?.stack || e?.message || e));
