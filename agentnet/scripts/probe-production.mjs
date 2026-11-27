#!/usr/bin/env node
/* probe-production.mjs — проверка реального снимка цепи правилами packaging/node/core.mjs. */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENESIS_PARAMS, computeBlockHash, hashMeetsDifficulty, merkleRoot,
  expectedDifficultyBits, validateBlockAgainstChain, networkChainId,
} from '../../packaging/node/src/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(HERE, '../../bundle-build/portable/cache/chain.json');
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const chain = doc.chain || [];
const t0 = Date.now();
console.log(`file=${file} chainId=${doc.chainId} blocks=${chain.length}`);

const gh = computeBlockHash(doc.genesisHeader || chain[0].header);
console.log(`genesis headerHash=${gh} blockHash=${chain[0].hash} network=${networkChainId()} genesisBits=${GENESIS_PARAMS.difficulty_bits}`);
if (gh !== chain[0].hash) throw new Error('genesis hash mismatch');
if (doc.chainId !== networkChainId()) throw new Error('chainId mismatch');

let hFail = null;
for (let i = 0; i < chain.length; i++) {
  const b = chain[i];
  if (b.height !== i) { hFail = { i, why: 'height', got: b.height }; break; }
  if (i > 0 && b.header.prevHash !== chain[i - 1].hash) { hFail = { i, why: 'prev' }; break; }
  if (computeBlockHash(b.header) !== b.hash) { hFail = { i, why: 'hash' }; break; }
  if (!hashMeetsDifficulty(b.hash, b.header.difficultyBits)) { hFail = { i, why: 'pow' }; break; }
  const want = i === 0 ? GENESIS_PARAMS.difficulty_bits : expectedDifficultyBits(chain.slice(0, i));
  if (b.header.difficultyBits !== want) { hFail = { i, why: 'difficulty', got: b.header.difficultyBits, want }; break; }
}
console.log(hFail ? `HEADER FAIL ${JSON.stringify(hFail)}` : `headers OK all ${chain.length} in ${Date.now() - t0}ms`);

let merkleBad = 0;
const samples = [];
for (let i = 1; i < chain.length; i++) {
  if (merkleRoot(chain[i].txs || []) !== chain[i].header.merkleRoot) {
    merkleBad++;
    if (samples.length < 8) samples.push(i);
  }
}
console.log(`merkle mismatches: ${merkleBad}; first: ${samples.join(',')} (${Date.now() - t0}ms)`);

let fullBad = 0;
const reasons = new Map();
for (let i = 1; i < Math.min(chain.length, 3000); i++) {
  const err = validateBlockAgainstChain(chain[i], chain.slice(0, i));
  if (err) { fullBad++; reasons.set(err, (reasons.get(err) || 0) + 1); }
}
console.log(`validateBlockAgainstChain first 3000: bad=${fullBad} reasons=${JSON.stringify([...reasons])} (${Date.now() - t0}ms)`);
