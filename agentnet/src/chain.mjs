/* agentnet/chain.mjs — хранилище заголовков и тел блоков.
   Правила: headers-first, выбор цепи по суммарной работе, восстановление после
   обрыва записи, продолжение с диска, pruning тел, безопасная остановка при ENOSPC. */
'use strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendLine, canonicalJson, DiskFullError, ensureDir, leadingZeroBits,
  readJsonLines, sha256dhex, truncateTo, writeFileAtomic, writeJsonAtomic,
} from './util.mjs';

export function defaultHashHeader(header) {
  return sha256dhex(Buffer.from(canonicalJson(header), 'utf8'));
}

export function defaultCheckPoW(hash, bits) {
  return leadingZeroBits(hash) >= Number(bits || 0);
}

export function defaultWork(bits) {
  return 1n << BigInt(Math.max(0, Number(bits) || 0));
}

/** Merkle-корень тел: попарный sha256d по txid (или хешу tx), как в Bitcoin-подобных цепях. */
export function merkleRoot(txs) {
  if (!Array.isArray(txs) || txs.length === 0) return '0'.repeat(64);
  let level = txs.map((tx) => (typeof tx?.txid === 'string' ? tx.txid : sha256dhex(Buffer.from(canonicalJson(tx), 'utf8'))));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256dhex(Buffer.from(level[i] + (level[i + 1] || level[i]), 'utf8')));
    }
    level = next;
  }
  return level[0];
}

export function defaultVerifyBody(block, rec) {
  const expected = rec?.header?.merkleRoot;
  if (!expected || expected === '0'.repeat(64)) return null;
  return merkleRoot(block.txs) === expected ? null : 'merkle_mismatch';
}

/** Биткойн-подобный locator: tip, tip-1..tip-9, дальше степени двойки. */
export function buildLocator(heights) {
  const tip = heights.length - 1;
  const out = [];
  let step = 1;
  let h = tip;
  while (h >= 0) {
    out.push(heights[h]);
    if (out.length >= 10) step *= 2;
    h -= step;
  }
  if (!out.includes(heights[0])) out.push(heights[0]);
  return out;
}

export class HeaderChain extends EventEmitter {
  constructor({
    dir,
    networkId = 'agentnet-main',
    genesisHeader = { version: 1, prevHash: '0'.repeat(64), merkleRoot: '0'.repeat(64), timestamp: 0, difficultyBits: 20, nonce: 0 },
    hashHeader = defaultHashHeader,
    checkPoW = defaultCheckPoW,
    workOf = defaultWork,
    validateHeader = null,
    verifyBody = null,
    maxHeaders = 200000,
    pruneBodies = 500,
    io = null,
  } = {}) {
    super();
    this.dir = dir;
    this.networkId = networkId;
    this.genesisHeader = { ...genesisHeader, chainId: genesisHeader.chainId || networkId };
    this.hashHeader = hashHeader;
    this.checkPoW = checkPoW;
    this.workOf = workOf;
    this.validateHeader = validateHeader;
    this.verifyBody = verifyBody;
    this.maxHeaders = maxHeaders;
    this.pruneBodies = pruneBodies;
    this.headers = [];
    this.byHash = new Map();
    this.cumWork = [0n];
    this.bodies = new Map();
    this.bodiesFile = path.join(dir, 'bodies.ndjson');
    this.headersFile = path.join(dir, 'headers.ndjson');
    this.stateFile = path.join(dir, 'chain-state.json');
    this.readOnly = false;
    this.stoppedReason = null;
    this.reorgs = 0;
    this.prunedBefore = 0;
    this.lastError = null;
    this.io = io || { appendFileSync: (...a) => fs.appendFileSync(...a) };
  }

  open() {
    ensureDir(this.dir, 0o700);
    const parsed = readJsonLines(this.headersFile);
    const size = (() => { try { return fs.statSync(this.headersFile).size; } catch { return 0; } })();
    if (size > parsed.validBytes) truncateTo(this.headersFile, parsed.validBytes);
    const rows = parsed.rows;
    if (rows.length === 0) {
      const hash = this.hashHeader(this.genesisHeader);
      const rec = { height: 0, hash, header: this.genesisHeader };
      this._applyRecords([rec]);
      try { appendLine(this.headersFile, rec); } catch (e) { this._diskFull(e); }
      this._persistState();
    } else {
      // Валидируем целостность уже записанного: высоты подряд, prevHash, хеш.
      const valid = [];
      let prev = null;
      for (const rec of rows) {
        if (!rec || !rec.header || typeof rec.height !== 'number') break;
        const hash = this.hashHeader(rec.header);
        if (hash !== rec.hash) break;
        if (prev) {
          if (rec.height !== prev.height + 1) break;
          if (rec.header.prevHash !== prev.hash) break;
        } else if (rec.height !== 0) break;
        valid.push(rec);
        prev = rec;
      }
      this._applyRecords(valid);
      if (valid.length < rows.length) {
        this.emit('recovered', { kept: valid.length, dropped: rows.length - valid.length });
      }
      this._loadBodies();
    }
    return this;
  }

  _applyRecords(records) {
    for (const rec of records) {
      if (this.byHash.has(rec.hash)) continue;
      this.headers.push(rec);
      this.byHash.set(rec.hash, rec);
      this.cumWork.push(this.cumWork[this.cumWork.length - 1] + this.workOf(rec.header.difficultyBits));
    }
  }

  _loadBodies() {
    const parsed = readJsonLines(this.bodiesFile);
    const size = (() => { try { return fs.statSync(this.bodiesFile).size; } catch { return 0; } })();
    if (size > parsed.validBytes) truncateTo(this.bodiesFile, parsed.validBytes);
    for (const b of parsed.rows) {
      if (!b || typeof b.height !== 'number') continue;
      if (!this.headers[b.height] || this.headers[b.height].hash !== b.hash) continue;
      this.bodies.set(b.height, b);
    }
  }

  get height() { return this.headers.length - 1; }
  get tip() { return this.headers[this.headers.length - 1]; }
  get genesisHash() { return this.headers[0] ? this.headers[0].hash : null; }
  get work() { return this.cumWork[this.cumWork.length - 1] || 0n; }

  headerAt(height) { return this.headers[height] || null; }
  hasHash(hash) { return this.byHash.has(hash); }

  locator() {
    return buildLocator(this.headers.map((h) => h.hash));
  }

  /** Заголовки после первой найденной точки locator (по возрастанию). */
  headersAfter(locator, limit = 200) {
    if (!Array.isArray(locator)) return [];
    let start = null;
    for (const hash of locator) {
      const rec = this.byHash.get(hash);
      if (rec) { start = rec.height; break; }
    }
    const from = start === null ? 0 : start + 1;
    return this.headers.slice(from, from + Math.max(1, Math.min(2000, limit)))
      .map((r) => ({ height: r.height, hash: r.hash, header: r.header }));
  }

  /**
   * Добавляет пачку заголовков. Возвращает {ok, added, reorg} или {ok:false, reason}.
   * Ветка может ответвляться от любой известной высоты; принимается только если
   * суммарная работа строго больше текущей.
   */
  addHeaders(list, { now = Date.now() } = {}) {
    if (this.readOnly) return { ok: false, reason: 'read_only' };
    if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: 'empty' };
    if (list.length > 5000) return { ok: false, reason: 'batch_too_large' };
    const temp = new Map();
    const added = [];
    let forkHeight = null;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || !raw.header || typeof raw.header !== 'object') {
        return { ok: false, reason: 'bad_header' };
      }
      const header = raw.header;
      const hash = this.hashHeader(header);
      if (raw.hash && raw.hash !== hash) return { ok: false, reason: 'hash_mismatch' };
      if (temp.has(hash) || this.byHash.has(hash)) continue;
      const prev = temp.get(header.prevHash) || this.byHash.get(header.prevHash);
      if (!prev) return { ok: false, reason: 'orphan_header' };
      const height = prev.height + 1;
      if (raw.height !== undefined && raw.height !== height) return { ok: false, reason: 'height_mismatch' };
      if (height > this.maxHeaders) return { ok: false, reason: 'chain_too_long' };
      if (!this.checkPoW(hash, header.difficultyBits)) return { ok: false, reason: 'pow_fail' };
      if (typeof header.timestamp !== 'number' || !Number.isFinite(header.timestamp)) {
        return { ok: false, reason: 'bad_timestamp' };
      }
      if (header.timestamp > now + 2 * 3600 * 1000) return { ok: false, reason: 'timestamp_from_future' };
      if (this.validateHeader) {
        const err = this.validateHeader(header, prev, height);
        if (err) return { ok: false, reason: err };
      }
      temp.set(hash, { height, hash, header });
      added.push({ height, hash, header });
      if (prev.height < this.height && forkHeight === null) forkHeight = prev.height;
    }
    if (added.length === 0) return { ok: true, added: 0, reorg: null };

    if (forkHeight === null) {
      this._append(added);
      return { ok: true, added: added.length, reorg: null };
    }

    const branch = added.filter((r) => r.height > forkHeight);
    if (branch.length === 0) return { ok: true, added: 0, reorg: null };
    // Непрерывность ветки от forkHeight+1
    let expected = forkHeight + 1;
    for (const rec of branch) {
      if (rec.height !== expected) return { ok: false, reason: 'non_contiguous_branch' };
      expected++;
    }
    let branchWork = this.cumWork[forkHeight + 1] || 0n;
    for (const rec of branch) branchWork += this.workOf(rec.header.difficultyBits);
    if (branchWork <= this.work) {
      return { ok: false, reason: 'not_heavier', forkHeight, branchWork: branchWork.toString() };
    }
    const oldTip = this.tip;
    this.headers = this.headers.slice(0, forkHeight + 1);
    this._rebuildIndex();
    this._append(branch);
    this._rewriteHeaders();
    this.reorgs++;
    const reorg = {
      forkHeight,
      oldTip: { height: oldTip.height, hash: oldTip.hash },
      newTip: { height: this.height, hash: this.tip.hash },
      work: this.work.toString(),
    };
    this.emit('reorg', reorg);
    return { ok: true, added: branch.length, reorg };
  }

  _append(records) {
    if (records.length === 0) return;
    this._applyRecords(records);
    try {
      const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
      this.io.appendFileSync(this.headersFile, text, 'utf8');
    } catch (e) {
      this._diskFull(e);
    }
    this._persistState();
  }

  _rewriteHeaders() {
    try {
      writeFileAtomic(this.headersFile, this.headers.map((r) => JSON.stringify(r)).join('\n') + '\n', 0o600);
    } catch (e) {
      this._diskFull(e);
    }
    this._persistState();
  }

  _rebuildIndex() {
    this.byHash = new Map();
    this.cumWork = [0n];
    for (const rec of this.headers) {
      this.byHash.set(rec.hash, rec);
      this.cumWork.push(this.cumWork[this.cumWork.length - 1] + this.workOf(rec.header.difficultyBits));
    }
    for (const height of [...this.bodies.keys()]) {
      if (height > this.height || this.headers[height].hash !== this.bodies.get(height).hash) this.bodies.delete(height);
    }
  }

  _persistState() {
    try {
      writeJsonAtomic(this.stateFile, {
        networkId: this.networkId,
        genesisHash: this.genesisHash,
        height: this.height,
        tipHash: this.tip ? this.tip.hash : null,
        work: this.work.toString(),
        reorgs: this.reorgs,
        prunedBefore: this.prunedBefore,
        updatedAt: new Date().toISOString(),
      }, 0o600);
    } catch { /* состояние восстановимо из headers.ndjson */ }
  }

  _diskFull(e) {
    if (!(e instanceof DiskFullError) && !(e && (e.code === 'ENOSPC' || e.code === 'EDQUOT'))) throw e;
    this.lastError = 'disk_full';
    if (!this.readOnly) {
      this.readOnly = true;
      this.stoppedReason = 'disk_full';
      this.emit('diskfull', { at: new Date().toISOString() });
    }
  }

  /** Тела блоков: проверка всех, затем одна запись на пачку. */
  addBlocks(blocks, { verify = true } = {}) {
    if (this.readOnly) return { ok: false, reason: 'read_only' };
    if (!Array.isArray(blocks) || blocks.length === 0) return { ok: true, added: 0 };
    if (blocks.length > 2000) return { ok: false, reason: 'batch_too_large' };
    const stored = [];
    const seen = new Set();
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || !block.header || !Array.isArray(block.txs)) {
        return { ok: false, reason: 'bad_block' };
      }
      const hash = this.hashHeader(block.header);
      const rec = this.byHash.get(hash);
      if (!rec) return { ok: false, reason: 'unknown_header' };
      if (block.hash && block.hash !== hash) return { ok: false, reason: 'hash_mismatch' };
      if (block.height !== undefined && block.height !== rec.height) return { ok: false, reason: 'height_mismatch' };
      if (this.bodies.has(rec.height) || seen.has(rec.height)) continue;
      if (verify) {
        const err = this.verifyBody
          ? this.verifyBody(block, rec, this.headers)
          : defaultVerifyBody(block, rec);
        if (err) return { ok: false, reason: err };
      }
      seen.add(rec.height);
      stored.push({ height: rec.height, hash, header: rec.header, txs: block.txs });
    }
    if (stored.length === 0) return { ok: true, added: 0, duplicate: true };
    const text = stored.map((b) => JSON.stringify(b)).join('\n') + '\n';
    try {
      this.io.appendFileSync(this.bodiesFile, text, 'utf8');
    } catch (e) {
      this._diskFull(e);
      return { ok: false, reason: 'disk_full' };
    }
    for (const b of stored) this.bodies.set(b.height, b);
    if (this.bodies.size > this.pruneBodies) this.prune();
    return { ok: true, added: stored.length };
  }

  /** Тело одного блока. */
  addBlock(block, opts = {}) {
    if (!block || typeof block !== 'object' || !block.header) return { ok: false, reason: 'bad_block' };
    const hash = this.hashHeader(block.header);
    const rec = this.byHash.get(hash);
    if (!rec) return { ok: false, reason: 'unknown_header' };
    if (this.bodies.has(rec.height)) return { ok: true, duplicate: true, height: rec.height };
    const res = this.addBlocks([block], opts);
    if (!res.ok) return res;
    return { ok: true, height: rec.height, duplicate: res.added === 0 };
  }

  blocksFrom(from, limit = 50) {
    const out = [];
    for (let h = Math.max(0, from); h <= this.height && out.length < limit; h++) {
      const b = this.bodies.get(h);
      if (b) out.push(b);
    }
    return out;
  }

  missingBodies(from = 0, limit = 50) {
    const out = [];
    // генезис — только заголовок: тела с высоты 1
    for (let h = Math.max(1, from); h <= this.height && out.length < limit; h++) {
      if (!this.bodies.has(h)) out.push(h);
    }
    return out;
  }

  prune() {
    const keep = Math.max(1, this.pruneBodies);
    const heights = [...this.bodies.keys()].sort((a, b) => a - b);
    if (heights.length <= keep) return 0;
    const drop = heights.slice(0, heights.length - keep);
    for (const h of drop) this.bodies.delete(h);
    this.prunedBefore = Math.max(this.prunedBefore, drop[drop.length - 1] + 1);
    try {
      const text = [...this.bodies.values()]
        .sort((a, b) => a.height - b.height)
        .map((b) => JSON.stringify(b)).join('\n') + '\n';
      writeFileAtomic(this.bodiesFile, text, 0o600);
    } catch (e) {
      this._diskFull(e);
    }
    return drop.length;
  }

  snapshot() {
    const tip = this.tip;
    return {
      networkId: this.networkId,
      genesisHash: this.genesisHash,
      height: this.height,
      tipHash: tip ? tip.hash : null,
      tipTime: tip ? tip.header.timestamp : null,
      chainwork: this.work.toString(),
      headers: this.headers.length,
      bodies: this.bodies.size,
      prunedBefore: this.prunedBefore,
      reorgs: this.reorgs,
      readOnly: this.readOnly,
      stoppedReason: this.stoppedReason,
    };
  }
}

export function openChain(opts) {
  return new HeaderChain(opts).open();
}
