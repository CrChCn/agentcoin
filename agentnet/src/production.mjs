/* production.mjs — адаптер agentnet к боевой цепи Agentcoin.
 *
 * Правила не переписаны: все функции консенсуса приходят из packaging/node/src/core.mjs
 * (computeBlockHash, hashMeetsDifficulty, merkleRoot, retarget, blockWork,
 * validateBlockAgainstChain, GENESIS_PARAMS). Здесь только клей:
 *   - боевой genesis и chainId AGENTCOIN;
 *   - O(1) проверка сложности для заголовков (зеркало expectedDifficultyBits);
 *   - checkpoint: снимок цепи считается доверенным до высоты snapshot.tip,
 *     новые блоки после checkpoint проверяются полным validateBlockAgainstChain;
 *   - две исторические merkle-аномалии (высоты 2 и 3) зафиксированы явно,
 *     иначе реальный снимок нельзя переиграть текущими правилами.
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { openChain } from './chain.mjs';

export const PRODUCTION_CHAIN_ID = 'AGENTCOIN';
export const LEGACY_MERKLE_EXCEPTIONS = Object.freeze([2, 3]);
export const BIG_PRUNE = 1_000_000_000;

function need(core, names) {
  for (const n of names) {
    if (!core || core[n] === undefined) throw new Error(`production core is missing ${n}`);
  }
}

export function productionGenesisHeader(core) {
  need(core, ['GENESIS_PARAMS']);
  const g = core.GENESIS_PARAMS;
  return {
    version: g.version,
    prevHash: g.prev_hash,
    merkleRoot: core.merkleRoot([{
      txid: core.sha256d(JSON.stringify({
        from: 'COINBASE', to: 'AGT_GENESIS_TREASURY', amount: 0, nonce: 0,
        ts: g.timestamp, memo: g.seed_message,
      })),
      from: 'COINBASE', to: 'AGT_GENESIS_TREASURY', amount: 0, nonce: 0,
      ts: g.timestamp, memo: g.seed_message,
    }]),
    timestamp: g.timestamp,
    difficultyBits: g.difficulty_bits,
    nonce: 0,
    chainId: core.networkChainId(),
  };
}

/**
 * @param {object} core — module namespace packaging/node/src/core.mjs
 * @param {{checkpoint:{height:number,hash:string}, legacyMerkleExceptions?:number[]}} opts
 */
export function createProductionAdapter(core, { checkpoint, legacyMerkleExceptions = LEGACY_MERKLE_EXCEPTIONS } = {}) {
  need(core, ['computeBlockHash', 'hashMeetsDifficulty', 'merkleRoot', 'expectedDifficultyBits', 'blockWork', 'validateBlockAgainstChain', 'networkChainId', 'GENESIS_PARAMS']);
  if (!checkpoint || !Number.isInteger(checkpoint.height) || typeof checkpoint.hash !== 'string') {
    throw new Error('production adapter requires checkpoint {height, hash}');
  }
  const chainId = core.networkChainId();
  if (chainId !== PRODUCTION_CHAIN_ID) {
    throw new Error(`production adapter expects chainId ${PRODUCTION_CHAIN_ID}, got ${chainId} (AGT_CHAIN_ID?)`);
  }
  const exceptions = new Set(legacyMerkleExceptions);
  const adapter = {
    chain: null,
    checkpoint: { height: checkpoint.height, hash: checkpoint.hash },
    legacyMerkleExceptions: exceptions,
    _pending: new Map(),
    _pendingTop: -1,
    stats: { headers: 0, legacyBodies: 0, strictBodies: 0, checkpointBodies: 0 },
    attach(chain) { this.chain = chain; return this; },
    headerAt(height) {
      const rec = this.chain && this.chain.headerAt(height);
      return rec || this._pending.get(height) || null;
    },
    _remember(height, header) {
      if (height < this._pendingTop) this._pending.clear();
      this._pending.set(height, { height, header });
      this._pendingTop = Math.max(this._pendingTop, height);
      if (this._pending.size > 64) {
        const min = Math.min(...this._pending.keys());
        this._pending.delete(min);
      }
    },
    expectedBits(height) {
      if (height === 0) return core.GENESIS_PARAMS.difficulty_bits;
      // core.expectedDifficultyBits читает только length, [0], [n-1] и [n-RETARGET].
      // Отдаём ему view на уже известные заголовки, не копируя 53k массив.
      const self = this;
      const prefix = new Proxy({ length: height }, {
        get(target, prop) {
          if (prop === 'length') return height;
          if (typeof prop === 'string' && /^\d+$/.test(prop)) return self.headerAt(Number(prop));
          return target[prop];
        },
      });
      return core.expectedDifficultyBits(prefix);
    },
    validateHeader(header, prev, height) {
      if (!header || typeof header !== 'object') return 'bad_header';
      if (!Number.isInteger(header.timestamp) || header.timestamp <= 0) return 'bad_timestamp';
      if (header.timestamp > Math.floor(Date.now() / 1000) + 2 * 3600) return 'timestamp_from_future';
      if (header.chainId !== chainId) return 'chainId_mismatch';
      const hash = core.computeBlockHash(header);
      if (height === this.checkpoint.height && hash !== this.checkpoint.hash) return 'checkpoint_mismatch';
      const want = this.expectedBits(height);
      if (header.difficultyBits !== want) return `difficulty_rule_violation:${header.difficultyBits}!=${want}`;
      this._remember(height, header);
      this.stats.headers++;
      return null;
    },
    verifyBody(block, rec) {
      if (!block || !Array.isArray(block.txs)) return 'bad_block';
      const h = rec.height;
      if (h === 0) return null;
      const merkle = core.merkleRoot(block.txs);
      if (h <= this.checkpoint.height) {
        // Историческая часть: снимок доверенный, но целостность тел проверяем.
        // Две высоты (2,3) имеют merkle, не совпадающий с текущей core.merkleRoot —
        // это свойство самой боевой цепи, зафиксировано в отчёте.
        if (merkle !== rec.header.merkleRoot && !exceptions.has(h)) return 'merkle_mismatch';
        if (merkle !== rec.header.merkleRoot) this.stats.checkpointBodies++;
        this.stats.legacyBodies++;
        return null;
      }
      const prefix = [];
      for (let i = 0; i < h; i++) {
        const b = this.chain && this.chain.bodies.get(i);
        if (!b) return 'prefix_missing';
        prefix.push(b);
      }
      const err = core.validateBlockAgainstChain(block, prefix);
      if (err) return err;
      this.stats.strictBodies++;
      return null;
    },
  };
  return adapter;
}

export function openProductionChain({ dataDir, core, adapter, genesisHeader, pruneBodies = BIG_PRUNE }) {
  need(core, ['computeBlockHash', 'hashMeetsDifficulty', 'blockWork', 'networkChainId']);
  if (!adapter) throw new Error('adapter required');
  const chain = openChain({
    dir: path.join(dataDir, 'chain'),
    networkId: core.networkChainId(),
    genesisHeader: genesisHeader || productionGenesisHeader(core),
    hashHeader: core.computeBlockHash,
    checkPoW: core.hashMeetsDifficulty,
    workOf: (bits) => BigInt(Math.round(core.blockWork(bits))),
    validateHeader: (header, prev, height) => adapter.validateHeader(header, prev, height),
    verifyBody: (block, rec) => adapter.verifyBody(block, rec),
    pruneBodies,
    maxHeaders: 500000,
  });
  adapter.attach(chain);
  return chain;
}

export function loadProductionSnapshot(file, core) {
  need(core, ['computeBlockHash', 'networkChainId']);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(doc.chain) || doc.chain.length === 0) throw new Error('snapshot has no chain');
  if (doc.chainId !== core.networkChainId()) throw new Error(`snapshot chainId ${doc.chainId} != ${core.networkChainId()}`);
  const genesis = doc.chain[0];
  if (genesis.height !== 0) throw new Error('snapshot does not start at genesis');
  if (core.computeBlockHash(genesis.header) !== genesis.hash) throw new Error('snapshot genesis hash mismatch');
  if (doc.genesisHeader && JSON.stringify(doc.genesisHeader) !== JSON.stringify(genesis.header)) {
    throw new Error('snapshot genesisHeader mismatch');
  }
  if (genesis.header.chainId !== core.networkChainId()) throw new Error('snapshot genesis chainId mismatch');
  const tip = doc.chain[doc.chain.length - 1];
  for (let i = 1; i < doc.chain.length; i++) {
    if (doc.chain[i].height !== i || doc.chain[i].header.prevHash !== doc.chain[i - 1].hash) {
      throw new Error(`snapshot is not contiguous at height ${i}`);
    }
  }
  return {
    file, doc, genesisHeader: genesis.header,
    tip: { height: tip.height, hash: tip.hash },
    checkpoint: { height: tip.height, hash: tip.hash },
    chainId: doc.chainId,
  };
}

/** Заполняет chain-каталог снимком боевой цепи (genesis + все заголовки + тела). */
export function seedProductionChain({ dataDir, snapshot, core, adapter, batch = 5000, log = () => {} }) {
  const chain = openProductionChain({ dataDir, core, adapter, genesisHeader: snapshot.genesisHeader });
  if (chain.height > 0) {
    log(`[seed] уже есть ${chain.height + 1} заголовков, пропускаю`);
    return chain;
  }
  const list = snapshot.doc.chain;
  for (let i = 1; i < list.length; i += batch) {
    const slice = list.slice(i, i + batch).map((b) => ({ height: b.height, hash: b.hash, header: b.header }));
    const res = chain.addHeaders(slice);
    if (!res.ok) throw new Error(`seed headers at ${i}: ${res.reason}`);
    if (i % 25000 === 1) log(`[seed] заголовки ${i + slice.length - 1}/${list.length - 1}`);
  }
  chain.addBlock(list[0], { verify: false });
  const bodyBatch = Math.min(1000, batch);
  for (let i = 1; i < list.length; i += bodyBatch) {
    const res = chain.addBlocks(list.slice(i, i + bodyBatch));
    if (!res.ok) throw new Error(`seed body ${i}: ${res.reason}`);
    if (i % 25000 === 1) log(`[seed] тела ${Math.min(i + bodyBatch - 1, list.length - 1)}/${list.length - 1}`);
  }
  if (chain.height !== snapshot.tip.height || chain.tip.hash !== snapshot.tip.hash) {
    throw new Error(`seed tip mismatch: ${chain.height}/${chain.tip?.hash}`);
  }
  log(`[seed] готово: ${chain.height + 1} заголовков, ${chain.bodies.size} тел, tip ${chain.tip.hash}`);
  return chain;
}
