#!/usr/bin/env node
/* ============================================================
   AGENTCOIN (AGT) — децентрализованная криптовалюта для агентов
   Ядро: блокчейн + PoW + кошельки + транзакции. Zero-dependency.

   Уважение к генезису: берём АРХИТЕКТУРУ генеза с внешнего диска
   (genesis.json BlackLegion: version/timestamp/prev_hash/merkle/
   difficulty/nonce + blockchain_core.py: PoW-шкала + genesis_test.cpp:
   double-SHA256 формулы) и строим нашу цепь с ними как основой.

   Математические механизмы (все формулы внутри):
   1) Хеш-цепь: blockHash = SHA256d(serializedBlockHeader)
      SHA256d(x) = SHA256(SHA256(x)) — как в Bitcoin (genesis_test.cpp).
   2) PoW: блок валиден если SHA256d(header) < target.
      target = 2^256 / difficultyTargetBits → компакт-представление nBits.
      Проще: ведущие нули. difficulty = требуемое число ведущих нулевых
      бит в SHA256d-хеше.
   3) Ретарджет каждые RETARGET_INTERVAL блоков:
        actualTime = time(block[n-1]) - time(block[n-1-RETARGET])
        targetInterval = RETARGET_INTERVAL * BLOCK_INTERVAL_SEC
        newDifficulty = clamp(difficulty * actualTime/targetInterval, min, max)
      — та же логика, что у Bitcoin (клэмп ×4 /1).
   4) Награда за блок: reward = BASE_REWARD / 2^(halvingCount),
      halvingCount = floor(height / HALVING_INTERVAL). Максимум эмиссии
     coins = BASE_REWARD * HALVING_INTERVAL * 2 (геометрическая сумма).
   5) Кошелёк: privKey = случайность; address = 'AGT' + base58ish(
      RIPEMD-Sha попроще: SHA256(pub)).slice(0,32) + checksum(SHA256d).
      Подпись транзакции: HMAC-SHA256(privKey, txDigest) — для агентов
      этого достаточно (не против ASIC-майнеров, а против双人 спуфинга).
   6) Баланс: считаем из реестра (UTXO-lite: балансовая модель с подписями).
   7) Инскрипция данных: op-return поле в TX (агенты пишут свои данные).
   ============================================================ */
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

// ============ Параметры цепи (константы) ============
export const CHAIN_ID = 'AGENTCOIN';
export const TICKER = 'AGT';
export const BLOCK_INTERVAL_SEC = 30;      // блок каждые ~30 сек
export const RETARGET_INTERVAL = 10;       // ретарджет каждые 10 блоков (быстрая демо-цепь)
export const HALVING_INTERVAL = 210_000;   // halving каждые 210k блоков (как Bitcoin)
export const BASE_REWARD = 50;             // 50 AGT за блок (как Bitcoin)
export const MAX_SUPPLY = BASE_REWARD * HALVING_INTERVAL * 2; // ≈ 21М
export const INITIAL_DIFFICULTY_BITS = 16; // старт: 16 ведущих нулевых бит (~40k хешей)
export const MIN_DIFFICULTY_BITS = 8;
export const MAX_DIFFICULTY_BITS = 32;

// Генезис-данные из внешнего диска (уважаем первоисточник):
// d:/BlackLegion/config/generated/genesis.json
export const GENESIS_PARAMS = {
  version: 1,
  timestamp: 1734186400, // из genesis.json BlackLegion (Dec 14 2025)
  prev_hash: '0'.repeat(64),
  // tribute: merkle root Bitcoin genesis tx (из genesis_test.cpp CryptoLab)
  seed_message: 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks',
  chain_id: CHAIN_ID,
};

// ============ Математика хеширования ============
export function sha256d(data) {
  const h1 = crypto.createHash('sha256').update(data).digest();
  return crypto.createHash('sha256').update(h1).digest('hex');
}

function leadingZeroBits(hexHash) {
  let bits = 0;
  for (const ch of hexHash) {
    const v = parseInt(ch, 16);
    if (v === 0) { bits += 4; continue; }
    // считаем старшие нули полубайта
    if (v < 2) bits += 3; else if (v < 4) bits += 2; else if (v < 8) bits += 1;
    break;
  }
  return bits;
}

export function hashMeetsDifficulty(hexHash, difficultyBits) {
  return leadingZeroBits(hexHash) >= difficultyBits;
}

// ============ Блоки ============
export function serializeHeader(header) {
  // каноническая сериализация — любая перестановка полей ломает хеш
  return [
    header.version, header.prevHash, header.merkleRoot,
    header.timestamp, header.difficultyBits, header.nonce, header.chainId,
  ].join('|');
}

export function computeBlockHash(header) {
  return sha256d(serializeHeader(header));
}

export function merkleRoot(txs) {
  // попроще, чем Bitcoin: попарный SHA256d по списку txid
  if (txs.length === 0) return '0'.repeat(64);
  let level = txs.map(t => typeof t.txid === 'string' ? t.txid : sha256d(JSON.stringify(t)));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256d(level[i] + (level[i + 1] || level[i])));
    }
    level = next;
  }
  return level[0];
}

export function blockReward(height) {
  const halvings = Math.floor(height / HALVING_INTERVAL);
  return BASE_REWARD / Math.pow(2, halvings); // формула halving
}

// Ретарджет — формула из Bitcoin, клэмп ×4 /1
export function retarget(prevDifficultyBits, actualTimeSec, expectedTimeSec) {
  let d = prevDifficultyBits * (actualTimeSec / expectedTimeSec);
  // bits = log2 relationship: чем быстрее блоки, тем меньше нулей нужно (проще)
  // difficultyBits ↑ = сложнее. если блоки шли быстрее ожидания (actual < expected),
  // actual/expected < 1 → bits ↓ → проще. верно.
  if (d > prevDifficultyBits * 4) d = prevDifficultyBits * 4;
  if (d < prevDifficultyBits / 4) d = prevDifficultyBits / 4;
  const clamped = Math.max(MIN_DIFFICULTY_BITS, Math.min(MAX_DIFFICULTY_BITS, Math.round(d)));
  return clamped;
}

// ============ Кошельки ============
// ed25519: настоящая асимметрия — подпись приватным, проверка публичным.
export function createWallet(label = 'agent') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const pubHash = sha256d(pub);
  const checksum = sha256d(pubHash).slice(0, 8);
  const address = 'AGT' + pubHash.slice(0, 32) + checksum;
  return { label, privKey, pub, pubHash, address, createdAt: Date.now() };
}

export function txDigest(tx) {
  return sha256d(JSON.stringify({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, ts: tx.ts, memo: tx.memo || '' }));
}

export function signTransaction(tx, privKey) {
  const sig = crypto.sign(null, Buffer.from(txDigest(tx), 'hex'), privKey);
  return sig.toString('hex');
}

export function verifyTransaction(tx) {
  if (!tx.signature || !tx.from || !tx.fromPub) return false;
  try {
    return crypto.verify(null, Buffer.from(txDigest(tx), 'hex'), tx.fromPub, Buffer.from(tx.signature, 'hex'));
  } catch { return false; }
}

// ============ Цепь ============
export class Blockchain {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'chain.json');
    this.mempool = [];
    this.history = [];
    this.load();
    if (this.blockCount() === 0) this.createGenesis();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.chain = d.chain || [];
        this.difficultyBits = d.difficultyBits ?? INITIAL_DIFFICULTY_BITS;
        this.genesisHeader = d.genesisHeader || null;
      }
    } catch { /* новый файл */ }
    if (!this.chain) this.chain = [];
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      chainId: CHAIN_ID, chain: this.chain, difficultyBits: this.difficultyBits,
      genesisHeader: this.genesisHeader,
    }, null, 2));
  }

  blockCount() { return this.chain.length; }
  tip() { return this.chain[this.chain.length - 1] || null; }

  // ---- Genesis ----
  createGenesis() {
    const coinbaseTx = {
      txid: '', from: 'COINBASE', to: 'AGT_GENESIS_TREASURY', amount: 0,
      nonce: 0, ts: GENESIS_PARAMS.timestamp, memo: GENESIS_PARAMS.seed_message,
    };
    coinbaseTx.txid = sha256d(JSON.stringify({ from: coinbaseTx.from, to: coinbaseTx.to, amount: 0, nonce: 0, ts: coinbaseTx.ts, memo: coinbaseTx.memo }));
    const header = {
      version: GENESIS_PARAMS.version,
      prevHash: GENESIS_PARAMS.prev_hash,
      merkleRoot: merkleRoot([coinbaseTx]),
      timestamp: GENESIS_PARAMS.timestamp,
      // из genesis.json BlackLegion difficulty: 486604799 — берём её как стартовый отсчёт,
      // но наша бит-шкала проще: считаем INITIAL_DIFFICULTY_BITS, уважая дату генезиса
      difficultyBits: null,      // подберём ниже (майнинг генезиса)
      nonce: 0,
      chainId: CHAIN_ID,
    };
    // майним генезис с INITIAL_DIFFICULTY_BITS
    header.difficultyBits = INITIAL_DIFFICULTY_BITS;
    const t0 = Date.now();
    while (true) {
      const h = computeBlockHash(header);
      if (hashMeetsDifficulty(h, header.difficultyBits)) break;
      header.nonce++;
    }
    const hash = computeBlockHash(header);
    this.genesisHeader = header;
    this.chain.push({ height: 0, hash, header, txs: [coinbaseTx], minedAt: Date.now(), mineMs: Date.now() - t0 });
    this.difficultyBits = INITIAL_DIFFICULTY_BITS;
    this.save();
  }

  // ---- Транзакции ----
  addTransaction(tx) {
    // базовая валидация
    if (!tx.from || !tx.to || typeof tx.amount !== 'number' || tx.amount <= 0) return { ok: false, reason: 'bad_fields' };
    if (!verifyTransaction(tx)) return { ok: false, reason: 'bad_signature' };
    const balances = this.balances();
    if ((balances[tx.from] || 0) < tx.amount) return { ok: false, reason: 'insufficient_funds' };
    this.mempool.push(tx);
    return { ok: true, mempoolSize: this.mempool.length };
  }

  // ---- Майнинг ----
  headHeaderTemplate() {
    const tip = this.tip();
    return {
      version: 1,
      prevHash: tip.hash,
      merkleRoot: merkleRoot(this.mempool.length ? this.mempool : [this.coinbaseTxTemplate()]),
      timestamp: Math.floor(Date.now() / 1000),
      difficultyBits: this.nextDifficulty(),
      nonce: 0,
      chainId: CHAIN_ID,
    };
  }

  coinbaseTxTemplate() {
    return { txid: 'coinbase-' + Date.now(), from: 'COINBASE', to: 'AGENT_REWARD_POOL', amount: blockReward(this.blockCount()), nonce: this.blockCount(), ts: Math.floor(Date.now() / 1000), memo: 'block ' + this.blockCount() };
  }

  nextDifficulty() {
    const n = this.blockCount();
    if (n === 0 || n % RETARGET_INTERVAL !== 0) return this.difficultyBits;
    // формула ретарджет: сравниваем фактическое время последних RETARGET_INTERVAL блоков с ожидаемым
    const last = this.chain[n - 1];
    const prevAnchor = this.chain[n - RETARGET_INTERVAL];
    if (!last || !prevAnchor) return this.difficultyBits;
    const actual = last.header.timestamp - prevAnchor.header.timestamp;
    const expected = RETARGET_INTERVAL * BLOCK_INTERVAL_SEC;
    return retarget(this.difficultyBits, actual, expected);
  }

  mineOnce(minerAddress, onProgress) {
    const t0 = Date.now();
    const coinbase = { ...this.coinbaseTxTemplate(), to: minerAddress };
    const txs = this.mempool.length ? [...this.mempool, coinbase] : [coinbase];
    const header = this.headHeaderTemplate();
    header.merkleRoot = merkleRoot(txs);
    while (true) {
      const h = computeBlockHash(header);
      if (hashMeetsDifficulty(h, header.difficultyBits)) {
        const block = { height: this.blockCount(), hash: h, header, txs, minedAt: Date.now(), mineMs: Date.now() - t0, miner: minerAddress };
        this.chain.push(block);
        this.mempool = [];
        this.difficultyBits = header.difficultyBits;
        this.save();
        return block;
      }
      header.nonce++;
      if (onProgress && header.nonce % 50_000 === 0) onProgress(header.nonce);
    }
  }

  // ---- Балансы (из транзакций блоков) ----
  balances() {
    const b = {};
    for (const blk of this.chain) {
      for (const tx of blk.txs || []) {
        if (tx.from && tx.from !== 'COINBASE') b[tx.from] = (b[tx.from] || 0) - tx.amount;
        if (tx.to) b[tx.to] = (b[tx.to] || 0) + tx.amount;
      }
    }
    return b;
  }

  // ---- Валидация ----
  validate() {
    for (let i = 1; i < this.chain.length; i++) {
      const blk = this.chain[i], prev = this.chain[i - 1];
      if (blk.header.prevHash !== prev.hash) return { ok: false, at: i, reason: 'prevHash mismatch' };
      if (computeBlockHash(blk.header) !== blk.hash) return { ok: false, at: i, reason: 'hash mismatch' };
      if (!hashMeetsDifficulty(blk.hash, blk.header.difficultyBits)) return { ok: false, at: i, reason: 'PoW fail' };
    }
    return { ok: true, blocks: this.blockCount() };
  }

  info() {
    const b = this.balances();
    return {
      chainId: CHAIN_ID, ticker: TICKER, blocks: this.blockCount(),
      difficultyBits: this.difficultyBits,
      nextReward: blockReward(this.blockCount()),
      totalSupplyCirculating: Object.entries(b).reduce((s, [, v]) => s + Math.max(0, v), 0),
      maxSupply: MAX_SUPPLY,
      halvingIn: HALVING_INTERVAL - (this.blockCount() % HALVING_INTERVAL),
      genesisHash: this.genesisHeader ? computeBlockHash(this.genesisHeader) : null,
      genesisNonce: this.genesisHeader?.nonce,
      genesisSeed: GENESIS_PARAMS.seed_message.slice(0, 40) + '...',
      mempool: this.mempool.length,
      retargetIn: RETARGET_INTERVAL - (this.blockCount() % RETARGET_INTERVAL),
    };
  }
}
