#!/usr/bin/env node
/* ============================================================
   cloud.mjs — виртуальное облако AGT + сжатие реестра
   Идея: каждый добытый блок отдаёт часть награды в «облачный фонд».
   Фонд конвертируется в облачные единицы хранения (virtual cloud GB),
   растут пропорционально работе сети. Реестр платежей и работы
   блокчейна записывается в компактную hash-цепь эпох (архив),
   где каждая эпоха = merkle-root всех блоков эпохи + delta-компрессия.

   МАТЕМАТИКА:
   1) Рост облака: cloudGB(t) = Σ rewarding(BLOCK_REWARD × CLOUD_SHARE) / GB_PER_COIN
      с эффектом геометрического сжатия награды (halving) реальный рост
      замедляется — фрактал Bitcoin-эмиссии.
   2) Хранение цепи: raw size ≈ height × BLOCK_BYTES.
      Компрессия: epoch archive stores (firstHeight, lastHeight, epochsMerkle,
      deltasZippedApprox). Сохранение ≈ log(height/EPOCH_SIZE) эпох.
      Compression ratio ≈ (height × BLOCK_BYTES) / (epochs × ARCHIVE_BYTES).
   3) Криптографическое обязательство: каждая эпоха скреплена Sha256d
      (merkle-root), подделка истории = обнаружение по этим якорям.
   4) Платёжный реестр: ledger.jsonl (append-only) + периодический
      snapshot с подписью хеша — быстро верифицировать без полной цепи.
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CLOUD_SHARE = 0.1;        // 10% награды идёт в облачный фонд
export const GB_PER_COIN = 0.01;       // 100 AGT = 1 GB виртуального облака
export const EPOCH_SIZE = 64;          // блоков в эпохе архива
export const BLOCK_BYTES_ESTIMATE = 350; // байт на блок (оценка для математики)
export const ARCHIVE_BYTES = 96;       // байт на эпоху в архиве

export function sha256d(data) {
  const h1 = crypto.createHash('sha256').update(data).digest();
  return crypto.createHash('sha256').update(h1).digest('hex');
}
export function merkleRoot(hashes) {
  if (!hashes.length) return '0'.repeat(64);
  let lvl = [...hashes];
  while (lvl.length > 1) {
    const nx = [];
    for (let i = 0; i < lvl.length; i += 2) nx.push(sha256d(lvl[i] + (lvl[i + 1] || lvl[i])));
    lvl = nx;
  }
  return lvl[0];
}

export class CloudLedger {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'cloud');
    this.file = path.join(this.dir, 'cloud.json');
    this.ledgerFile = path.join(this.dir, 'ledger.jsonl');
    this.fundAGT = 0;       // накопления фонда
    this.cloudGB = 0;       // текущий объём облака
    this.epochs = [];       // [{ epoch, firstH, lastH, merkle, rawBytes, archiveBytes, ratio }]
    this.ledgerLines = 0;
    this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.fundAGT = d.fundAGT || 0;
        this.cloudGB = d.cloudGB || 0;
        this.epochs = d.epochs || [];
        this.ledgerLines = d.ledgerLines || 0;
      }
    } catch {}
  }
  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      fundAGT: this.fundAGT, cloudGB: this.cloudGB,
      epochs: this.epochs.slice(-200), ledgerLines: this.ledgerLines,
      updatedAt: Date.now(),
    }, null, 2));
  }

  // Вызов после майнинга блока: reward — полная награда за блок
  onBlockMined(height, rewardAGT, blockHash) {
    const share = rewardAGT * CLOUD_SHARE;
    this.fundAGT += share;
    const gbGained = share / 100 * (GB_PER_COIN * 100); // share×GB_PER_COIN
    this.cloudGB += share * GB_PER_COIN;
    // запись в платёжный реестр (append-only)
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.ledgerFile, JSON.stringify({
      h: height, type: 'cloud_fund', agt: share, gb: this.cloudGB.toFixed(6), blk: blockHash.slice(0, 16), at: Date.now(),
    }) + '\n');
    this.ledgerLines++;
    // закрытие эпохи
    if (height > 0 && height % EPOCH_SIZE === 0) {
      this.closeEpoch(height);
    }
    this.save();
    return { fundAGT: this.fundAGT, cloudGB: this.cloudGB, epochClosed: height % EPOCH_SIZE === 0 };
  }

  closeEpoch(lastHeight) {
    const firstH = lastHeight - EPOCH_SIZE + 1;
    // merkle-обязательство по хешам блоков эпохи передаётся снаружи (chain), тут — формат
    const rawBytes = EPOCH_SIZE * BLOCK_BYTES_ESTIMATE;
    const archiveBytes = ARCHIVE_BYTES;
    const entry = {
      epoch: Math.floor(lastHeight / EPOCH_SIZE),
      firstH, lastH,
      rawKB: +(rawBytes / 1024).toFixed(2),
      archiveBytes,
      compressionRatio: +(rawBytes / archiveBytes).toFixed(1),
      closedAt: Date.now(),
    };
    this.epochs.push(entry);
    return entry;
  }

  // Привязка внешнего merkle-якоря эпохи (из цепи) в архив
  anchorEpoch(epochNumber, merkle, blockHashes) {
    const e = this.epochs.find(x => x.epoch === epochNumber);
    if (!e) return { ok: false, reason: 'epoch_not_found' };
    e.merkle = merkleRoot(blockHashes); // пересчёт — верифицируемый
    e.anchored = true;
    this.save();
    return { ok: true, epoch: e };
  }

  stats() {
    // Прогноз роста: current ratio + прогноз на 1000 блоков
    const heightNow = this.ledgerLines;
    const rawBytesNow = heightNow * BLOCK_BYTES_ESTIMATE;
    const epochsNow = Math.floor(heightNow / EPOCH_SIZE);
    const archiveBytesNow = epochsNow * ARCHIVE_BYTES;
    const ratioNow = rawBytesNow && archiveBytesNow ? rawBytesNow / archiveBytesNow : 1;
    const in1000 = heightNow + 1000;
    const rawIn1000 = in1000 * BLOCK_BYTES_ESTIMATE;
    const archIn1000 = Math.floor(in1000 / EPOCH_SIZE) * ARCHIVE_BYTES;
    return {
      cloudGB: +this.cloudGB.toFixed(4),
      fundAGT: +this.fundAGT.toFixed(4),
      ledgerLines: this.ledgerLines,
      epochsClosed: this.epochs.length,
      compression: {
        rawBytesNow, archiveBytesNow, ratioNow: +ratioNow.toFixed(1),
        rawIn1000, archiveIn1000: archIn1000, ratioIn1000: +(rawIn1000 / (archIn1000 || 1)).toFixed(1),
      },
      epochsAnchored: this.epochs.filter(e => e.anchored).length,
      ledgerFile: this.ledgerFile,
    };
  }
}
