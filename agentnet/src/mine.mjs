/* agentnet/mine.mjs — добыча блока для стендов: заголовок + тело + PoW-подбор nonce. */
'use strict';
import { defaultHashHeader, merkleRoot } from './chain.mjs';
import { leadingZeroBits } from './util.mjs';

export function mineNext(chain, { bits = 0, txs = [], timestamp = null, nonceLimit = 2_000_000 } = {}) {
  const prev = chain.tip;
  if (!prev) throw new Error('chain_not_open');
  const height = chain.height + 1;
  const header = {
    version: 1,
    prevHash: prev.hash,
    merkleRoot: merkleRoot(txs),
    timestamp: Math.floor((timestamp || Date.now()) / 1000),
    difficultyBits: bits,
    nonce: 0,
    chainId: chain.networkId,
  };
  let hash = '';
  for (let nonce = 0; nonce < nonceLimit; nonce++) {
    header.nonce = nonce;
    hash = defaultHashHeader(header);
    if (leadingZeroBits(hash) >= bits) break;
  }
  if (leadingZeroBits(hash) < bits) throw new Error('pow_not_found');
  const res = chain.addHeaders([{ height, hash, header }]);
  if (!res.ok) throw new Error(`mine_header:${res.reason}`);
  const body = chain.addBlock({ height, hash, header, txs });
  if (!body.ok) throw new Error(`mine_body:${body.reason}`);
  return { height, hash, header, txs };
}

export function mineMany(chain, count, opts = {}) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(mineNext(chain, opts));
  return out;
}

export function coinbaseTx(txid, amount = 50) {
  return { txid, from: 'COINBASE', to: 'AGT' + '0'.repeat(40), amount, ts: Date.now() };
}
