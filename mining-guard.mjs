// Preventive checks for newly requested mining work, not consensus rules.
// Historical chain bytes and balances are unaffected by this module.
import {
  CHAIN_ID, MIN_DIFFICULTY_BITS, MAX_DIFFICULTY_BITS, blockReward, merkleRoot,
} from './core.mjs';

export function isCanonicalMinerAddress(value) {
  return typeof value === 'string' && /^AGT[0-9a-f]{40}$/.test(value);
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const reject = reason => ({ ok: false, reason });

// A thin miner requires the full scheduled reward for its own work. This is a
// client policy; it does not change historical acceptance of underpaid blocks.
export function validateMiningTemplate(template, { miner, tipHash, height } = {}) {
  if (!isCanonicalMinerAddress(miner)) return reject('invalid_miner_address');
  if (!hash(tipHash) || !Number.isSafeInteger(height) || height < 1) return reject('invalid_mining_context');
  if (!object(template) || !object(template.header) || !Array.isArray(template.txs) || !template.txs.length) return reject('invalid_template_shape');
  if (template.height !== height) return reject('template_height_mismatch');
  const { header, txs } = template;
  if (header.prevHash !== tipHash || (template.tipPrevHash !== undefined && template.tipPrevHash !== tipHash)) return reject('template_prev_hash_mismatch');
  if (header.chainId !== CHAIN_ID) return reject('template_chain_id_mismatch');
  if (header.version !== 1 || !Number.isSafeInteger(header.timestamp) || header.timestamp <= 0
      || !Number.isSafeInteger(header.nonce) || header.nonce < 0
      || !Number.isInteger(header.difficultyBits) || header.difficultyBits < MIN_DIFFICULTY_BITS
      || header.difficultyBits > MAX_DIFFICULTY_BITS) return reject('invalid_template_header');
  if (!txs.every(object)) return reject('invalid_template_transaction');
  const coinbases = txs.filter(tx => tx.from === 'COINBASE');
  if (coinbases.length !== 1) return reject('template_coinbase_count');
  if (txs.some(tx => tx.from === 'AGENT_REWARD_POOL')) return reject('template_reserved_sender');
  const coinbase = coinbases[0];
  if (coinbase.to !== miner) return reject('template_reward_recipient_mismatch');
  const expectedReward = blockReward(height);
  if (!Number.isFinite(coinbase.amount) || coinbase.amount <= 0 || coinbase.amount !== expectedReward) return reject('template_reward_amount_mismatch');
  // Compatibility limitation: current merkleRoot trusts supplied txids and
  // legitimate coinbases use time-label txids. Recomputing the root catches a
  // mismatched package, but does NOT prove transaction-content/digest binding
  // or validate ordinary/escrow signatures. Those remain consensus audit work.
  try {
    if (typeof header.merkleRoot !== 'string' || header.merkleRoot !== merkleRoot(txs)) return reject('template_merkle_mismatch');
  } catch { return reject('invalid_template_merkle'); }
  return { ok: true };
}
