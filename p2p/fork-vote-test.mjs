#!/usr/bin/env node
/* ============================================================
   fork-vote-test.mjs — изолированный тест консенсуса (без живых нод).
   1) копирует data/chain.json → data-victim/chain.json (обрезка до forkH);
   2) прогоняет syncOne(victim, attackerUrl) с логами;
   3) печатает итог: высота жертвы, chainValid(strict), strikes пира,
      архив развилок (forks.json).
   Запуск: node p2p/fork-vote-test.mjs <attackerUrl> [forkH]
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blockchain } from '../core.mjs';
import { chainWork } from '../core.mjs';
import { syncOne, peerMetaStatus } from '../sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data-victim');
const SRC = path.join(__dirname, '../data/chain.json');
const attackerUrl = process.argv[2] || 'http://127.0.0.1:9399';
const forkH = Number(process.argv[3]) || 0;

fs.mkdirSync(DATA_DIR, { recursive: true });
// чистая жертва на каждый прогон
for (const f of ['peer-meta.json', 'forks.json', 'mempool.json']) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch {} }
const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
let chain = src.chain;
if (forkH > 0 && forkH < chain.length) {
  chain = chain.slice(0, forkH);
  console.log(`[victim] базовая цепь обрезана до высоты ${forkH - 1} (tip=${chain[chain.length - 1].hash.slice(0, 16)}), state bits=${chain[chain.length - 1].header.difficultyBits}`);
}
fs.writeFileSync(path.join(DATA_DIR, 'chain.json'), JSON.stringify({ ...src, chain }, null, 2));

process.env.AGT_DATA_DIR = DATA_DIR;
const bc = new Blockchain(DATA_DIR);
console.log(`[victim] высота до синка: ${bc.blockCount()}, work=${chainWork(bc.chain)}`);

for (const line of await syncOne(bc, attackerUrl)) console.log('    ' + line);

const v = bc.validate(true);
console.log(`[victim] ← высота после: ${bc.blockCount()}, chainValid(strict)=${v.ok}${v.ok ? '' : ' reason=' + v.reason + ' at ' + v.at}`);
console.log(`[victim] tip=${bc.tip().hash.slice(0, 16)}, state bits=${bc.difficultyBits}`);
console.log(`[victim] peer-meta:`, JSON.stringify(peerMetaStatus()));
if (bc.forks?.length) console.log(`[victim] forks.json:`, JSON.stringify(bc.forks.map(f => ({ forkedFrom: f.forkedFrom, dropped: f.dropped, ourWork: f.ourWork, candWork: f.candWork }))));
process.exit(0);
