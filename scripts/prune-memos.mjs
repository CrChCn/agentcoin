#!/usr/bin/env node
// prune-memos.mjs — Этап 3 §3, часть «chain.json уменьшился».
//
// В блоках вне окна keep-recent заменяет длинные memo на короткий `DAA|<sha16>`;
// сами оригиналы уходят в Celestia чанками ≤256 KiB (mocha-5 blob cap). Headers,
// txid и биланс-рейплей не трогаем: memo не входит в header-hash; txid остаётся
// прежним (stored в блоке); балансы пересчитываются из amount/челентных полей tx,
// а они не меняются. Резерв chain.json.prev — рядом.
//
// Запуск (с node1):
//   node src/prune-memos.mjs [--dry-run] [--max-height H] [--memo-min N]
// Восстановление (демо test_restore_memo.mjs):
//   celestia blob get <height> <ns> <commitment> --node.store … → лог пруn-memo
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const NODE_DATA = process.env.AGT_DATA_DIR || '/opt/agentcoin-node/data';
const CELESTIA_BIN = process.env.CELESTIA_BIN || 'celestia';
const CELESTIA_STORE = process.env.CELESTIA_STORE || '/root/.celestia-light-mocha-5';
const NODE_RPC = process.env.CELESTIA_RPC || 'http://127.0.0.1:26658/';
const NS = process.env.NS_AGTC || '0x61676e61'; // "agna"
const KEEP_RECENT = Number(process.env.ARCH_KEEP_RECENT || 1000);
const CHUNK_BYTES = 256 * 1024 - 512;
const ARCHIVE_FILE = path.join(NODE_DATA, 'da-archive.json');
const MEMO_MIN = Number(process.env.MEMO_MIN || 64);
const NS_B64 = Buffer.from('0'.repeat(25*2) + NS.replace('0x', ''), 'hex').toString('base64');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const maxIdx = argv.indexOf('--max-height');
const memoMinIdx = argv.indexOf('--memo-min');
const memoMin = memoMinIdx >= 0 ? Number(argv[memoMinIdx + 1]) : MEMO_MIN;

const log = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);
function exec(cmd, args, stdinBuf) {
  const r = spawnSync(cmd, args, { input: stdinBuf, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { out: r.stdout, err: r.stderr, code: r.status };
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function blobSubmitHttp(dataB64) {
  const token = await exec('sh', ['-c', `celestia light auth admin --node.store ${CELESTIA_STORE} 2>/dev/null`]);
  const auth = token.out.trim();
  if (!auth) throw new Error('empty authtoken');
  const res = await fetch(NODE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'blob.Submit', params: [[{ namespace: NS_B64, data: dataB64, share_version: 0 }], { fee_per_blob_gas: 0 }] }),
  });
  const j = await res.json();
  if (j.error) throw new Error('blob.Submit failed: ' + JSON.stringify(j.error));
  return j.result;
}
function loadArchive() {
  try { return JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')); } catch { return { version: 1, network: 'mocha-5', namespace: NS, entries: [], created: Date.now() }; }
}
function saveArchive(a) {
  fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
  const tmp = ARCHIVE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(a, null, 2));
  fs.renameSync(tmp, ARCHIVE_FILE);
}

const t0 = Date.now();
const chainFile = path.join(NODE_DATA, 'chain.json');
const chain = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
const blocks = chain.chain;
const tip = blocks[blocks.length - 1].height;
const archive = loadArchive();
const cut = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : (tip - KEEP_RECENT);
log(`chain tip=height ${tip}, cut=height ${cut}`);

const pruned = [];
let replaced = 0, savedBytes = 0;
for (const b of blocks) {
  if (b.height > cut) continue;
  for (const tx of (b.txs || [])) {
    const m = tx && typeof tx.memo === 'string' ? tx.memo : '';
    if (m.length >= memoMin) {
      const stub = 'DAA|' + sha256(Buffer.from(m, 'utf8')).slice(0, 16);
      savedBytes += Buffer.byteLength(m, 'utf8');
      pruned.push({ h: b.height, txid: tx.txid, memo: m });
      tx.memo = stub;
      replaced++;
    }
    // sig/fromPub исторических tx — в Celestia (5.2MB через сеть — главный вес);
    // балансы/txid/header-hash от них не зависят.
    for (const k of ['sig', 'fromPub', 'sig2', 'sig2Pub', 'escProof']) {
      if (tx && tx[k] != null) {
        pruned.push({ h: b.height, txid: tx.txid, field: k, value: tx[k] });
        savedBytes += JSON.stringify(tx[k]).length;
        tx[k] = undefined;
        replaced++;
      }
    }
  }
}
log(`prune candidates: ${replaced} memos (≥${memoMin}B) — ${savedBytes}B of memo text`);
if (dryRun) {
  fs.writeFileSync('/tmp/agt-prune-dry.json', JSON.stringify({ tip, cutHeight: cut, replaced, savedBytes }, null, 2));
  process.exit(0);
}

// мемо-чанки — в Celestia
for (let pos = 0, i = 1; pos < pruned.length; pos += 2000, i++) {
  const part = pruned.slice(pos, pos + 2000);
  const raw = zlib.gzipSync(Buffer.from(JSON.stringify(part), 'utf8'));
  if (raw.length > CHUNK_BYTES) throw new Error(`chunk ${i} too big (${raw.length}B): lore batch`);
  const blobId = sha256(raw);
  const r = await blobSubmitHttp(raw.toString('base64'));
  const height = typeof r === 'number' ? r : (r?.height ?? null);
  if (height == null) throw new Error(`prune blob submit failed: ${JSON.stringify(r)}`);
  archive.entries.push({ height: Number(height), blobId, mode: 'memo-prune', fromHeader: part[0]?.h, toHeader: part[part.length - 1]?.h, bytes: raw.length, memoCount: part.length, ts: Date.now() });
  saveArchive(archive);
  log(`memo-chunk ${i}: ${part.length} memos → Celestia h=${height}, blobId=${blobId.slice(0, 12)}…`);
}

// атомарно переписываем chain.json
fs.copyFileSync(chainFile, chainFile + '.pre-prune');
const tmp = chainFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(chain));
fs.renameSync(tmp, chainFile);
const after = fs.statSync(chainFile).size;
const before = fs.statSync(chainFile + '.pre-prune').size;
log(`chain.json: ${before}B → ${after}B (${(((before - after) / before) * 100).toFixed(1)}% меньше, restored via Celestia)`);
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
