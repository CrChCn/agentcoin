#!/usr/bin/env node
/* ============================================================
   fork-attacker.mjs — тестовый "равночестный" и "легковесный" боец
   для проверки децентрализации AGT (best-chain voting).

   Режимы (arg 2):
     honest-fork : копирует основную цепь до height H (arg 3, по
                   умолчанию 80% высоты) и НАМАЙНИВАЕТ валидные блоки
                   дальше с правильной сложностью (детерминированный
                   ретарджет) — в итоге его форк ТЯЖЕЛЕЕ основного.
                   Ожидание: ноды-равноправные должны ПРИНЯТЬ его
                   цепь по правилу суммарной работы (голосование).
     easy-chain  : подсовывает цепь той же высоты, но с заниженной
                   сложностью (difficultyBits − 4) и валидным PoW
                   ПОД ЭТУ сложность. Ожидание: ОТКЛОНИТЬ (нарушено
                   правило сложности) + strike пиру.

   Служит: GET /info, GET /headers?from=&limit=, GET /blocks?from=
   Запуск: node fork-attacker.mjs <port> <mode> [forkFrom]
   Данные: data-attack/ (генезис детерминированный, как у всех).
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  Blockchain, computeBlockHash, hashMeetsDifficulty, merkleRoot,
  expectedDifficultyBits, blockReward, CHAIN_ID,
} from '../core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 9399;
const MODE = process.argv[3] || 'honest-fork';
const FORK_FROM = Number(process.argv[4]) || 0;
const DATA_DIR = path.join(__dirname, '../data-attack');

const srcFile = path.join(__dirname, '../data/chain.json');
const src = JSON.parse(fs.readFileSync(srcFile, 'utf8'));

// clonируем основную цепь (тем же генезисом — сеть та же)
const bc = { chain: src.chain.map(b => JSON.parse(JSON.stringify(b))) };

function tip() { return bc.chain[bc.chain.length - 1]; }

function mineBlock(miner, tsOffsetSec = 30, bitsOverride = null) {
  const prev = tip();
  const height = bc.chain.length;
  const bits = bitsOverride ?? expectedDifficultyBits(bc.chain);
  const ts = Math.min(Math.floor(Date.now() / 1000), prev.header.timestamp + tsOffsetSec); // монотонность времени
  const coinbase = {
    txid: 'cb-attack-' + height + '-' + Date.now(), from: 'COINBASE', to: miner,
    amount: blockReward(height), nonce: height, ts, memo: 'attack block ' + height,
  };
  const txs = [coinbase];
  const header = {
    version: 1, prevHash: prev.hash, merkleRoot: merkleRoot(txs),
    timestamp: ts, difficultyBits: bits, nonce: 0, chainId: CHAIN_ID,
  };
  while (true) {
    const h = computeBlockHash(header);
    if (hashMeetsDifficulty(h, header.difficultyBits)) {
      bc.chain.push({ height, hash: h, header, txs, minedAt: Date.now(), mineMs: 0, miner });
      return;
    }
    header.nonce++;
  }
}

const t0 = Date.now();
if (MODE === 'honest-fork') {
  const h = FORK_FROM || Math.floor(bc.chain.length * 0.8);
  bc.chain = bc.chain.slice(0, h);
  console.log(`[fork-attacker] честная тяжёлая развилка: от heights ${h}, состояние bits=${tip().header.difficultyBits}`);
  const NEED = Number(process.argv[5]) || 24;
  while (bc.chain.length - h < NEED) mineBlock('AGT_ATTACKER_MINER', 30);
  console.log(`[fork-attacker] нужно: ${bc.chain.length - h} валидных блоков forked, bits=${tip().header.difficultyBits}, time=${Date.now() - t0}ms`);
} else if (MODE === 'easy-extend') {
  // честная цепь до текущего tip + лёгкие блоки сверх (prevHash = наш tip):
  // PoW валиден против НОВОЙ заниженной сложности, но правило детерминированного
  // ретарджета нарушено → нода должна отвергнуть И дать strike пиру.
  const EXTRA = Number(process.argv[5]) || 10;
  const base = [...bc.chain];
  const prev = () => bc.chain[bc.chain.length - 1];
  const fakeBits = Math.max(8, expectedDifficultyBits(base) - 4);
  console.log(`[fork-attacker] easy-extend: ${EXTRA} лёгких блоков на наш tip, fakeBits=${fakeBits}`);
  for (let i = 0; i < EXTRA; i++) {
    const prevB = prev();
    const height = base.length + i;
    const ts = prevB.header.timestamp + 30;
    const coinbase = { txid: 'cb-easy-' + height + '-' + Date.now(), from: 'COINBASE', to: 'AGT_ATTACKER', amount: blockReward(height), nonce: height, ts, memo: 'easy ' + height };
    const header = { version: 1, prevHash: prevB.hash, merkleRoot: merkleRoot([coinbase]), timestamp: ts, difficultyBits: fakeBits, nonce: 0, chainId: CHAIN_ID };
    while (true) {
      const h = computeBlockHash(header);
      if (hashMeetsDifficulty(h, header.difficultyBits)) { bc.chain.push({ height, hash: h, header, txs: [coinbase], minedAt: Date.now(), miner: 'AGT_ATTACKER' }); break; }
      header.nonce++;
    }
  }
} else if (MODE === 'easy-chain') {
  // цепь той же длины, но bits занижены на 4 → PoW по 8 бит, хотя по правилу 14.
  console.log('[fork-attacker] готовим easy-chain: bits −4, PoW валиден но против правила сложности');
  // подменяем difficultyBits и пересчитываем хэши блоков — фальшивая, но PoW-совместимая цепь
  const EASY_DROP = 4;
  bc.chain = bc.chain.map(b => {
    const header = { ...b.header };
    header.difficultyBits = Math.max(8, header.difficultyBits - EASY_DROP); // lowest legal; каждую −4 (дроп);
    header.nonce = 0;
    while (true) {
      const hh = computeBlockHash(header);
      if (hashMeetsDifficulty(hh, header.difficultyBits)) { b.hash = hh; break; }
      header.nonce++;
    }
    return { ...b, header };
  });
} else {
  console.error('[fork-attacker] unknown mode:', MODE);
  process.exit(1);
}

// --- HTTP-сервер: имитирует ноду для соли ---
function val(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/info') {
    return val(res, 200, {
      chainId: CHAIN_ID, blocks: bc.chain.length, genesisHash: computeBlockHash(bc.chain[0].header),
      node: `http://127.0.0.1:${PORT}`, mode: MODE,
    });
  }
  if (p === '/headers') {
    const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 2000);
    const headers = bc.chain.slice(from, from + limit).map(b => ({ height: b.height, hash: b.hash, header: b.header }));
    return val(res, 200, { height: bc.chain.length, headers });
  }
  if (p === '/blocks') {
    const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
    return val(res, 200, { blocks: bc.chain.slice(from).map(b => JSON.parse(JSON.stringify(b))), height: bc.chain.length });
  }
  return val(res, 404, { error: 'not_found (это тестовый конкурент)' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fork-attacker] ${MODE} на http://127.0.0.1:${PORT}: blocks=${bc.chain.length}, tipWork≈${bc.chain.slice(-5).map(b => b.header.difficultyBits).join(',')}`);
});
