#!/usr/bin/env node
// archive_old_txs.mjs — AGENTCOIN Data-Availability archiver to Celestia (mocha-5).
//
// Прецедент по ТЗ Этапа 3 §3:
//   каждые 1000 блоков берёт транзакции старше 1000 блоков, упаковывает их в Blob
//   и отправляет в Celestia (HTTP RPC blob.Submit на лайт-ноде); в AGENTCOIN остаётся
//   только blob_id (commitment) и высота — data/da-archive.json.
//
// Инварианты:
//   — никогда не трогаем последние KEEP_RECENT блоков (консенсус обязан видеть недавние tx);
//   — диапазон архивации определяется границей tip − keepRecent, повторные запуски идемпотентны;
//   — чанк данных ≤ 256 KiB (лимит blob), gzip → hex → Blob {namespace, data}.
//
// Использование:
//   node archive_old_txs.mjs [--dry-run] [--keep-recent N] [--max-height H]
//
// Требует: бинарь celestia в PATH (или CELESTIA_BIN), стора через CELESTIA_STORE
//   (по умолчанию /root/.celestia-light-mocha-5), namespace NS_AGTC (default 0x61676e61).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// ---- config ----------------------------------------------------------------
const NODE_DATA = process.env.AGT_DATA_DIR || '/opt/agentcoin-node/data';
const CELESTIA_BIN = process.env.CELESTIA_BIN || 'celestia';
const CELESTIA_STORE = process.env.CELESTIA_STORE || '/root/.celestia-light-mocha-5';
const NODE_RPC = process.env.CELESTIA_RPC || 'http://127.0.0.1:26658/';
const NS = process.env.NS_AGTC || '0x61676e61'; // "agna"
// JSON-RPC blob.Submit: namespace = base64 от 25 байтов (22 reserved + app bytes)
const NS_B64 = Buffer.from('0'.repeat(25*2) + NS.replace('0x', ''), 'hex').toString('base64');
const KEEP_RECENT = Number(process.env.ARCH_KEEP_RECENT || 1000);
const CHUNK_BYTES = 256 * 1024 - 512; // 256 KiB minus margin for namespace+header overhead
const ARCHIVE_FILE = path.join(NODE_DATA, 'da-archive.json');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const keepIdx = argv.indexOf('--keep-recent');
const keepRecent = keepIdx >= 0 ? Number(argv[keepIdx + 1]) : KEEP_RECENT;
const maxIdx = argv.indexOf('--max-height');
const maxHeight = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : null;
const dryFileIdx = argv.indexOf('--dry-file');
const dryOutFile = dryFileIdx >= 0 ? argv[dryFileIdx + 1] : (process.env.DRY_OUTPUT || '/tmp/agt-archive-dry.json');

const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

// ---- helpers ---------------------------------------------------------------
function exec(cmd, args, stdinBuf) {
  const r = spawnSync(cmd, args, { input: stdinBuf, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { out: r.stdout, err: r.stderr, code: r.status };
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// blob submit over the node's HTTP JSON-RPC (POST /): CLI arg cap (E2BIG) blocks huge hex payloads.
async function blobSubmitHttp(dataB64) {
  const token = await exec('sh', ['-c', `celestia light auth admin --node.store ${CELESTIA_STORE} 2>/dev/null`]);
  const auth = token.out.trim();
  if (!auth) throw new Error('empty authtoken from celestia light auth admin');
  // namespace: hex-encoded 0x…; data: raw base64 (celestia-node 0.34 gogoproto bytes json)
  const res = await fetch(NODE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth },
    // celestia-node 0.34: blob.Submit(blob []*Blob, opts SubmitOptions)
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'blob.Submit', params: [[{ namespace: NS_B64, data: dataB64, share_version: 0 }], { fee_per_blob_gas: 0 }] }),
  });
  const j = await res.json();
  if (j.error) throw new Error('blob.Submit failed: ' + JSON.stringify(j.error));
  return j.result;
}

function loadArchive() {
  try { return JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')); } catch { /* new */ }
  return { version: 1, network: 'mocha-5', namespace: NS, entries: [], created: Date.now() };
}
function saveArchive(a) {
  fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
  const tmp = ARCHIVE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(a, null, 2));
  fs.renameSync(tmp, ARCHIVE_FILE);
}

// ---- main -------------------------------------------------------------------
const t0 = Date.now();
const chainRaw = fs.readFileSync(path.join(NODE_DATA, 'chain.json'));
const chain = JSON.parse(chainRaw.toString('utf8'));
const blocks = chain.chain;
const tip = blocks[blocks.length - 1].height;
const archive = loadArchive();
const archivedHeights = new Set(archive.entries.map(e => e.toHeader));
log(`chain tip=height ${tip}, blocks=${blocks.length}, archived-heads=${archive.entries.length}`);

// Собираем диапазон блоков для архивации: всё, что старше tip - keepRecent.
const cutHeight = tip - keepRecent;
const pendingBlocks = blocks.filter(b =>
  b.height <= cutHeight && !archivedHeights.has(b.height) &&
  (maxHeight == null || b.height <= maxHeight)
);
if (pendingBlocks.length === 0) {
  log('nothing to archive (nothing outside the keep-recent window / already archived).');
  process.exit(0);
}
log(`pending blocks to archive: ${pendingBlocks.length} (heights ${pendingBlocks[0].height}..${pendingBlocks[pendingBlocks.length - 1].height})`);

// — упаковать tx в чанки ≤ CHUNK_BYTES (gzip+json) —
const chunks = [];
let cur = [];
let curSize = 0;
for (const b of pendingBlocks) {
  const txs = (b.txs || []).filter(Boolean);
  const rec = { h: b.height, hash: b.hash, txs };
  const recJson = JSON.stringify(rec);
  if (cur.length && curSize + recJson.length > CHUNK_BYTES) {
    chunks.push(cur); cur = []; curSize = 0;
  }
  cur.push(rec); curSize += recJson.length;
}
if (cur.length) chunks.push(cur);

log(`chunks=${chunks.length} (each ≤ ${CHUNK_BYTES}B JSON, gzipped → blob)`);
if (dryRun) {
  fs.writeFileSync(dryOutFile, JSON.stringify({ tip, cutHeight, chunkCount: chunks.length, blocksInChunks: chunks.reduce((s, c) => s + c.length, 0) }, null, 2));
  log(`dry-run: would push ${chunks.length} blobs; wrote summary to ${dryOutFile}`);
  process.exit(0);
}

// — отправить как blob в Celestia через HTTP API и записать/archive.json: blob_id + высота —
for (const [i, chunk] of chunks.entries()) {
  const raw = zlib.gzipSync(Buffer.from(JSON.stringify(chunk), 'utf8'));
  const blobId = sha256(raw);
  log(`chunk ${i + 1}/${chunks.length}: ${raw.length}B gz, blobId=${blobId.slice(0, 16)}…`);
  const r = await blobSubmitHttp(raw.toString('base64'));
  // HTTP JSON-RPC blob.Submit возвращает просто число-высоту, CLI оборачивал в {height, commitments}
  const height = typeof r === 'number' ? r : (r?.height ?? null);
  const commitment = typeof r === 'number' ? null : (r?.commitments?.[0] ?? null);
  if (height == null) throw new Error(`blob submit did not return height: ${JSON.stringify(r)}`);
  archive.entries.push({
    height: Number(height),
    blobId,
    commitment: String(commitment || '').replace('0x', ''),
    fromHeader: chunk.at(0)?.h,
    toHeader: chunk.at(-1)?.h,
    bytes: raw.length,
    txCount: chunk.reduce((s, c) => s + c.txs.length, 0),
    ts: Date.now(),
  });
  saveArchive(archive);
  log(`  archived -> Celestia h=${height}, commitment=${String(commitment || '').slice(0, 20)}…`);
}
saveArchive(archive);
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s — archive has ${archive.entries.length} entries.`);
// ==== РЕЖИМ 2: prune-memos (AC-3, «chain.json уменьшился») ====
// Запуск:  node archive_old_txs.mjs --prune [--max-height H]
// Что делает: в блоках вне окна keep-recent заменяет длинные memo на короткий
//   `DAA|<sha16>`; сами оригиналы (с txid/h/time) уходят в Celestia батчами ≤256KiB;
//   headers/txid/биланс-рейплей не трогаем (memo НЕ входит в header-hash; txid
//   остаётся прежним — stored). Каждый pruned-чанк получает ордер id daMap[blobId],
//   позже из него восстанавливается оригинал по блобу через blob/Get.
if (argv.includes('--prune')) {
  const cut = maxHeight ?? (tip - keepRecent);
  const prunedAlready = archive.entries.some(e => e.mode === 'memo-prune' && e.toHeader >= cut);
  if (prunedAlready) { log('prune already archived to that height'); process.exit(0); }
  const memoArgvIdx = argv.indexOf('--memo-min');
  const MEMO_MIN = memoArgvIdx >= 0 ? Number(argv[memoArgvIdx + 1]) : 64;
  const pruned = [];
  let replaced = 0, savedBytes = 0;
  for (const b of blocks) {
    if (b.height > cut) continue;
    for (const tx of (b.txs || [])) {
      const m = tx && typeof tx.memo === 'string' ? tx.memo : '';
      if (m.length >= MEMO_MIN) {
        const stub = 'DAA|' + sha256(Buffer.from(m, 'utf8')).slice(0, 16);
        savedBytes += Buffer.byteLength(m, 'utf8');
        pruned.push({ h: b.height, txid: tx.txid, memo: m });
        tx.memo = stub;
        replaced++;
      }
    }
  }
  log(`prune candidates: ${replaced} memos (≥${MEMO_MIN}B) — ${savedBytes}B of memo text`);
  if (dryRun) {
    fs.writeFileSync(dryOutFile, JSON.stringify({ tip, cutHeight: cut, replaced, savedBytes }, null, 2));
    log(`dry-run: would re-write chain.json replacing ${replaced} memos; summary at ${dryOutFile}`);
    process.exit(0);
  }
  // — арх. самих memo в Celestia чанками ≤CHUNK_BYTES —
  for (let pos = 0, i = 1; pos < pruned.length; pos += 2000, i++) {
    const part = pruned.slice(pos, pos + 2000);
    const raw = zlib.gzipSync(Buffer.from(JSON.stringify(part), 'utf8'));
    if (raw.length > CHUNK_BYTES) throw new Error(`chunk ${i} too big (${raw.length}B), reduce batch size`);
    const blobId = sha256(raw);
    const r = await blobSubmitHttp(raw.toString('base64'));
    const height = typeof r === 'number' ? r : (r?.height ?? null);
    if (height == null) throw new Error(`prune blob submit failed: ${JSON.stringify(r)}`);
    archive.entries.push({ height: Number(height), blobId, mode: 'memo-prune', fromHeader: part[0]?.h, toHeader: part[part.length - 1]?.h, bytes: raw.length, memoCount: part.length, ts: Date.now() });
    saveArchive(archive);
    log(`memo-chunk ${i}: ${part.length} memos → Celestia h=${height}, blobId=${blobId.slice(0, 12)}…`);
  }
  // — атомарно перезаписываем chain.json —
  const chainFile = path.join(NODE_DATA, 'chain.json');
  fs.copyFileSync(chainFile, chainFile + '.pre-prune'); // резерв
  const tmp = chainFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(chain));
  fs.renameSync(tmp, chainFile);
  const after = fs.statSync(chainFile).size;
  log(`chain.json rewritten: ${replaced} memo → DAA|hash; size after=${after}B (was saved ${savedBytes}B of text). Резерв: ${chainFile}.pre-prune`);
  process.exit(0);
}
