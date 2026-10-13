#!/usr/bin/env node
/* ============================================================
   AGENTCOIN sync.mjs — P2P-синхронизация узлов
   Модель: каждый узел — HTTP-нода (node.mjs). Пирс открыто
   спрашиваем /info (высота, genesisHash) и вливаем чужие блоки
   себе, если их цепь длиннее и валидна.

   Правила честной вилки:
   1) genesisHash MUST match — иначе это другая сеть, отказ.
   2) peer height > our height → тянем недостающие блоки /blocks.
   3) Валидируем пришедшее локально (prevHash, PoW, hash) — не верим никому.
   4) Конфликт: кто длиннее, тот и канон (longest-chain rule).
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blockchain, computeBlockHash, hashMeetsDifficulty, merkleRoot, CHAIN_ID } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PEERS_FILE = path.join(DATA_DIR, 'peers.json');

export function loadPeers() {
  try { return JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8')); } catch { return []; }
}
export function savePeers(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PEERS_FILE, JSON.stringify(list, null, 2));
}
export function addPeer(url) {
  const peers = loadPeers();
  if (!peers.includes(url)) peers.push(url);
  savePeers(peers);
  return peers;
}

async function fetchJson(url, timeoutMs = 10_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function syncOne(bc, peerUrl) {
  const log = [];
  try {
    const info = await fetchJson(peerUrl + '/info');
    if (!info || info.chainId !== CHAIN_ID) { log.push(`${peerUrl}: not AGENTCOIN, skip`); return log; }
    if (!bc.genesisHeader || computeBlockHash(bc.genesisHeader) !== info.genesisHash) {
      log.push(`${peerUrl}: genesis mismatch (different network), skip`);
      return log;
    }
    const myH = bc.blockCount(), peerH = info.blocks;
    log.push(`${peerUrl}: peer height ${peerH}, ours ${myH}`);
    if (peerH <= myH) { log.push(`  → our chain ≥ peer's, ok`); return log; }
    // тянем недостающие блоки
    const needBlocks = await fetchJson(`${peerUrl}/blocks?n=${peerH}`);
    const incoming = (needBlocks.blocks || []).slice().reverse(); // старые → новые
    let accepted = 0;
    for (const blk of incoming) {
      if (blk.height < bc.blockCount()) continue;
      const okHash = computeBlockHash(blk.header) === blk.hash && hashMeetsDifficulty(blk.hash, blk.header.difficultyBits);
      const okPrev = blk.header.prevHash === bc.tip().hash;
      const okMerkle = blk.header.merkleRoot === merkleRoot(blk.txs || []);
      if (!okHash || !okPrev || !okMerkle) {
        log.push(`  → block ${blk.height} INVALID (hash=${okHash} prev=${okPrev} merkle=${okMerkle}) — peer rejected`);
        break; // остановка: дальше цепь не может быть консистентной
      }
      bc.chain.push(blk);
      bc.difficultyBits = blk.header.difficultyBits;
      accepted++;
    }
    if (accepted) { bc.save(); log.push(`  → accepted ${accepted} blocks from peer`); }
  } catch (e) {
    log.push(`${peerUrl}: ERROR ${e.message}`);
  }
  return log;
}

export async function syncAll(bc) {
  const peers = loadPeers();
  const out = [];
  for (const p of peers) out.push(...await syncOne(bc, p));
  return out;
}
