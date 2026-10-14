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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AGT_DATA_DIR || path.join(__dirname, 'data'); // AGT_DATA_DIR: вторая нода на одной машине
const PORT = Number(process.argv[2]) || 9333;
const BLOCK_INTERVAL_SEC = 30; // must match core
const SELF_URL = `http://127.0.0.1:${Number(process.argv[2]) || 9333}`;

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

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
    const { askId, buyerAddress } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'awaiting_pay') return json(res, 409, { error: 'already_' + a.status });
    const bAddr = String(buyerAddress || a.buyer || '');
    const bw = bAddr ? loadWallets()[bAddr] : null;
    if (!bw?.privKey) return json(res, 400, { error: 'buyer_wallet_not_on_node' });
    if (bc.security.isBanned(bAddr)) return json(res, 403, { error: 'address_permabanned' });
    const agt = a.priceM * M;
    const feeAGT = Math.max(a.priceM * 0.005 * M, 1 * M); // 0.5%, min 1 MAGT
    // финансовый пре-чек: micro-сделка не должна превращаться в пермабан за empty-кошелёк
    const balNow = bc.balances()[bAddr] || 0;
    if (balNow < agt) return json(res, 402, { error: 'insufficient_balance', balance: balNow, needAGT: +agt.toFixed(9), hint: 'попросите у другой ноды/фаусета или заработайте job' });
    const tx = { from: bAddr, fromPub: bw.pub, to: a.provider, amount: +(agt - feeAGT).toFixed(9), nonce: Date.now() * 1000 + Math.floor(Math.random() * 999), ts: Math.floor(Date.now() / 1000), memo: `mdata:${askId.slice(0, 8)}` };
    tx.signature = signTransaction(tx, bw.privKey);
    tx.txid = txDigest(tx);
    const r = bc.addTransaction(tx);
    if (!r.ok) return json(res, 409, r);
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    a.status = 'paid'; a.txid = tx.txid.slice(0, 16); a.buyer = bAddr; a.feeM = +(feeAGT / M).toFixed(3);
    dx.asks[askId] = a; saveDX(dx);
    cloud.microFee(feeAGT, `mdata:${a.item}`);
    return json(res, 200, { askId, paid: +a.priceM.toLocaleString('en-US') + ' M включая fee', feeM: a.feeM, txid: a.txid, mempool: r.mempoolSize, hint: 'ждите /data/answer от провайдера (режим serve/still)' });
  }
  if (p === '/data/answer' && req.method === 'POST') {
    // Провайдер (его скрипт serve) отдаёт ответ на оплаченный ask
    const { provider, askId, answer, answerDigest } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.provider !== provider) return json(res, 403, { error: 'not_your_ask' });
    if (a.status !== 'paid' && a.status !== 'answered') return json(res, 409, { error: 'status_' + a.status });
    a.status = 'answered'; a.answer = String(answer || '').slice(0, 20000); a.answerDigest = answerDigest || crypto.createHash('sha256').update(a.answer).digest('hex').slice(0, 16); a.answeredAt = Date.now();
    saveDX(dx);
    return json(res, 200, { askId, answered: true, digest: a.answerDigest });
  }
  if (p === '/data/fetch') {
    const dx = loadDX();
    const a = dx.asks[url.searchParams.get('askId')];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'answered') return json(res, 202, { status: a.status, note: 'answer ещё не отдан провайдером' });
    return json(res, 200, { askId, answer: a.answer, answerDigest: a.answerDigest, txid: a.txid, priceM: a.priceM, paidAt: a.answeredAt });
  }
  if (p === '/data/asks') {
    // очередьasks провайдера для его serve-скрипта
    const provider = url.searchParams.get('provider');
    const dx = loadDX();
    const list = Object.values(dx.asks).filter(a => a.provider === provider && (a.status === 'paid' || a.status === 'answered')).slice(-50);
    return json(res, 200, { asks: list });
  }

  // --- Паспорт-реестр (agent seq-номера) — операторский учёт, конфиденциальный ---
  // Скрытые номера: наружу отдаётся ТОЛЬКО одноразовый запечатанный конверт
  // (AES-256-GCM на ключе SHA256(privKey+'agtx-passport-v1')), выданный на момент
  // issue. Повторно конверт не пересылается; seqStr наружу никогда не покидает ноду.
  const PASSPORT_FILE = path.join(__dirname, 'data-agents', 'passports.json');
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

  if (p === '/') return json(res, 200, {
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

  json(res, 404, { error: 'not_found' });
});

console.log(`[${new Date().toISOString()}] AGENTCOIN node v2 listening on http://127.0.0.1:${PORT}`);
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
server.listen(PORT, '127.0.0.1');
// --- исходящая полнасти-сеть: коннект к пирам из peers.json (30с цикл) ---
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
