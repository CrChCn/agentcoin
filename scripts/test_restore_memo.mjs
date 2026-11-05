#!/usr/bin/env node
// test_restore_memo.mjs — AC-3: восстановление pruned-мемо из Celestia.
//
// Что делает (запуск на node1):
//   1) берёт последний memo-prune-блоб из data/da-archive.json;
//   2) через лайт-ноду вызывает blob.Get (namespace+height+commitment) → оригинальные memos;
//   3) сверяет sha256(blob) == blobId и суммарно «столько-то memo, txid совпадает с pre-prune chain.json».
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const NODE_DATA = process.env.AGT_DATA_DIR || '/opt/agentcoin-node/data';
const CELESTIA_BIN = process.env.CELESTIA_BIN || 'celestia';
const CELESTIA_STORE = process.env.CELESTIA_STORE || '/root/.celestia-light-mocha-5';
const NS = process.env.NS_AGTC || '0x61676e61';
const NS_B64 = Buffer.from('0'.repeat(25*2) + NS.replace('0x', ''), 'hex').toString('base64');
const ARCHIVE = JSON.parse(fs.readFileSync(path.join(NODE_DATA, 'da-archive.json'), 'utf8'));
const log = (...a) => console.error(...a);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function rpc(method, params = []) {
  const token = spawnSync('sh', ['-c', `celestia light auth admin --node.store ${CELESTIA_STORE} 2>/dev/null`], { encoding: 'utf8' }).stdout.trim();
  const res = spawnSync('curl', ['-s', '-m', '30', '-X', 'POST', process.env.CELESTIA_RPC || 'http://127.0.0.1:26658/',
    '-H', 'Content-Type: application/json', '-H', 'Authorization: Bearer ' + token,
    '-d', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const j = JSON.parse(res.stdout || '{}');
  if (j.error) throw new Error(method + ' failed: ' + JSON.stringify(j.error));
  return j.result;
}

const entries = ARCHIVE.entries.filter(e => e.mode === 'memo-prune');
const last = entries[entries.length - 1];
log(`последний prune-блоб: Celestia h=${last.height}, blobId=${last.blobId.slice(0, 12)}…, memos=${last.memoCount}`);

// blob.GetAll(height, namespaces[]) — все блобы в блоке по namespace; наш ищем по sha256==blobId
const all = rpc('blob.GetAll', [last.height, [NS_B64]]);
let blobBytes = null, found = 0;
for (const b of (Array.isArray(all) ? all : all.items ?? [])) {
  const bb = Buffer.from(b.data, 'base64');
  if (sha256(bb) === last.blobId) { blobBytes = bb; found++; }
}
if (!blobBytes) throw new Error('blobs at height ' + last.height + ' do not include our blobId (found ' + (all.length ?? 0) + ')');
log(`nайден в Celestia на h=${last.height} (из ${all.length ?? 0} блобов), совпадений=${found}`);
const ok = sha256(blobBytes) === last.blobId;
log(`sha256нить blob == blobId: ${ok ? 'OK' : 'FAIL'} (${blobBytes.length}B)`);
const payload = JSON.parse(zlib.gunzipSync(blobBytes).toString('utf8'));
log(`распаковано memo: ${payload.length}`);

// сверка с pre-prune файлом
const pre = JSON.parse(fs.readFileSync(path.join(NODE_DATA, 'chain.json.pre-prune'), 'utf8'));
const preMemos = new Map();
for (const b of pre.chain) for (const t of (b.txs || [])) if (t?.txid && typeof t.memo === 'string' && t.memo.length >= 64) preMemos.set(t.txid, t.memo);
let matched = 0, mismatch = 0;
for (const p of payload) {
  const orig = preMemos.get(p.txid);
  if (orig === p.memo) matched++; else mismatch++;
}
log(`сверка с pre-prune chain.json: matched=${matched}, mismatch=${mismatch}`);
console.log(JSON.stringify({ ok, blobHeight: last.height, blobBytes: blobBytes.length, memos: payload.length, matched, mismatch }, null, 2));
if (!ok || mismatch) process.exit(1);
