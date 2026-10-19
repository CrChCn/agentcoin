#!/usr/bin/env node
// Offline proposal generator only. Never writes chain, policy or runtime files.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { CHAIN_ID, computeBlockHash } from '../core.mjs';
import { prefixContentDigest } from '../consensus-v2.mjs';
export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const uint = n => Number.isSafeInteger(n) && n >= 0;
export async function proposeCheckpoint({ snapshotPath, trustedGenesisHash }) {
  if (typeof snapshotPath !== 'string' || !snapshotPath || !HEX.test(trustedGenesisHash || '')) throw Error('snapshot_and_explicit_trusted_genesis_required');
  const before = await fs.lstat(snapshotPath);
  if (!before.isFile() || before.isSymbolicLink()) throw Error('snapshot_must_be_regular_nonsymlink');
  if (before.size === 0 || before.size > MAX_SNAPSHOT_BYTES) throw Error('snapshot_size_limit');
  const file = await fs.open(snapshotPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw Error('snapshot_changed_during_open');
    const chunks = []; let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, MAX_SNAPSHOT_BYTES + 1 - total));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); total += bytesRead;
      if (total > MAX_SNAPSHOT_BYTES) throw Error('snapshot_size_limit');
    }
    const after = await file.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw Error('snapshot_changed_during_read');
    bytes = Buffer.concat(chunks, total);
  } finally { await file.close(); }
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (Array.isArray(parsed.chain) === Array.isArray(parsed.blocks))) throw Error('snapshot_requires_exactly_one_chain_or_blocks_array');
  const chain = parsed.chain || parsed.blocks;
  if (!chain.length) throw Error('empty_snapshot');
  for (const key of ['height', 'blockCount']) if (Object.hasOwn(parsed, key) && parsed[key] !== chain.length) throw Error('snapshot_count_mismatch:' + key);
  if (chain[0]?.hash !== trustedGenesisHash) throw Error('trusted_genesis_mismatch');
  for (let i = 0; i < chain.length; i++) {
    const b = chain[i], h = b?.header;
    if (!b || b.height !== i || !h || !Array.isArray(b.txs) || !HEX.test(b.hash || '') || !HEX.test(h.prevHash || '') || (typeof h.merkleRoot !== 'string' || !h.merkleRoot.length || h.merkleRoot.length > 4096) || ![h.version, h.timestamp, h.difficultyBits, h.nonce].every(uint) || h.difficultyBits > 256 || h.chainId !== CHAIN_ID) throw Error('invalid_block_shape_or_height:' + i);
    if (h.prevHash !== (i ? chain[i - 1].hash : '0'.repeat(64))) throw Error('header_link_mismatch:' + i);
    if (computeBlockHash(h) !== b.hash) throw Error('header_hash_mismatch:' + i);
  }
  return {
    schemaVersion: 1, kind: 'AGENTCOIN_CONSENSUS_V2_CHECKPOINT_PROPOSAL',
    enabled: false, activationHeight: null,
    blockCount: chain.length, tipHeight: chain.length - 1, tipHash: chain.at(-1).hash,
    trustedGenesisHash, sourceBytes: bytes.length,
    sourceSHA256: createHash('sha256').update(bytes).digest('hex'),
    contentDigest: prefixContentDigest(chain),
    assurance: 'Header structure and links checked only. Historical authorization, issuance and transaction-content authenticity are NOT certified. Independent full-history reconciliation and explicit coordinated activation are required.',
  };
}
export async function runCheckpointCLI(args = process.argv.slice(2), stdout = process.stdout) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--snapshot', '--trusted-genesis'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, args[i])) throw Error('usage: --snapshot FILE --trusted-genesis HEX64');
    options[args[i]] = args[i + 1];
  }
  const result = await proposeCheckpoint({ snapshotPath: options['--snapshot'], trustedGenesisHash: options['--trusted-genesis'] });
  stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCheckpointCLI().catch(error => { console.error('checkpoint_proposal_failed:', error.message); process.exitCode = 1; });
}
