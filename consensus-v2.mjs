// FUTURE PROTOCOL CANDIDATE ONLY. Nothing imports or activates this module.
// A trusted checkpoint is a full-content commitment, never the legacy tip hash.
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(createHash('sha256').update(value).digest()).digest('hex');
const ADDRESS = /^AGT[0-9a-f]{40}$/;
const ESCROW = /^ESCROW_[0-9a-f]{10,32}$/;
function plainRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every(k => typeof k === 'string' && Object.getOwnPropertyDescriptor(value, k).enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value'));
}
function exactKeys(value, keys) { return plainRecord(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)); }
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || !Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean)) throw Error('noncanonical_json');
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (plainRecord(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw Error('noncanonical_json');
}
export function transactionId(tx) {
  if (!plainRecord(tx)) throw Error('transaction_not_plain_object');
  const fields = Object.fromEntries(Object.entries(tx).filter(([k]) => k !== 'txid'));
  return hash('AGENTCOIN-TX-V2\n' + canonical(fields));
}
export function prefixContentDigest(prefix) { return hash('AGENTCOIN-PREFIX-V2\n' + canonical(prefix)); }
// Exact decimal interpretation of the supplied JSON numbers, including legacy
// sub-magenta balances. Never round legacy balances onto the new 1e-9 grid.
function decimal(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw Error('invalid_amount');
  const [mantissa, exp = '0'] = String(n).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exp);
  return scale < 0 ? { n: BigInt(whole + fraction) * 10n ** BigInt(-scale), s: 0 } : { n: BigInt(whole + fraction), s: scale };
}
function add(a, b, negative = false) {
  const s = Math.max(a.s, b.s);
  return { n: a.n * 10n ** BigInt(s - a.s) + (negative ? -1n : 1n) * b.n * 10n ** BigInt(s - b.s), s };
}
function equal(a, b) { return add(a, b, true).n === 0n; }
const zero = () => ({ n: 0n, s: 0 });
function newAmount(n) {
  const d = decimal(n);
  if (d.n <= 0n || (d.s > 9 && d.n % 10n ** BigInt(d.s - 9) !== 0n)) throw Error('amount_not_magenta_aligned');
  const units = d.s > 9 ? d.n / 10n ** BigInt(d.s - 9) : d.n * 10n ** BigInt(9 - d.s);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('amount_exceeds_safe_units');
  return d;
}
// Existing receipts do not bind a nonce. Track the authorized economic action,
// not signature/PEM encodings, which can vary without changing authorization.
// This candidate consequently disallows identical-value partial payouts twice.
const escrowAuthorizationKey = tx => canonical({ from: tx.from, to: tx.to, amount: tx.amount, memo: tx.memo, taskHash: tx.escProof?.taskHash ?? null });
const uint = n => Number.isSafeInteger(n) && n >= 0;
export function createConsensusV2(p, policy) {
  for (const key of ['blockReward', 'computeBlockHash', 'hashMeetsDifficulty', 'expectedDifficultyBits', 'merkleRoot', 'verifyTransaction', 'verifyEscrowTx', 'verifySecondSig', 'treasuryPolicy']) {
    if (typeof p?.[key] !== 'function') throw Error('missing_primitive:' + key);
  }
  if (!exactKeys(policy, ['activationHeight', 'legacyCheckpoint', 'allowPartialEscrowSettlements']) || !exactKeys(policy.legacyCheckpoint, ['blockCount', 'contentDigest']) || typeof p.chainId !== 'string' || !p.chainId || !uint(policy?.activationHeight) || policy.activationHeight < 1 || policy.legacyCheckpoint?.blockCount !== policy.activationHeight || !/^[a-f0-9]{64}$/.test(policy.legacyCheckpoint?.contentDigest || '') || typeof policy.allowPartialEscrowSettlements !== 'boolean') throw Error('explicit_activation_checkpoint_and_escrow_policy_required');
  // Snapshot policy against caller mutation. No environment flags or wall clock.
  const activation = policy.activationHeight, checkpoint = policy.legacyCheckpoint.contentDigest;
  const partial = policy.allowPartialEscrowSettlements;
  function validateBlock(block, prefix) {
    try {
      if (!Array.isArray(prefix) || prefix.length < activation) throw Error('prefix_before_activation');
      const legacy = prefix.slice(0, activation);
      if (prefixContentDigest(legacy) !== checkpoint) throw Error('legacy_content_checkpoint_mismatch');
      const balances = new Map(), ids = new Set(), nonces = new Map(), settled = new Set();
      const debitCredit = tx => {
        const amount = decimal(tx.amount);
        if (tx.from && tx.from !== 'COINBASE') balances.set(tx.from, add(balances.get(tx.from) || zero(), amount, true));
        if (tx.to) balances.set(tx.to, add(balances.get(tx.to) || zero(), amount));
      };
      const remember = tx => {
        if (typeof tx.txid === 'string') ids.add(tx.txid);
        if (tx.from !== 'COINBASE' && uint(tx.nonce)) {
          if (!nonces.has(tx.from)) nonces.set(tx.from, new Set());
          nonces.get(tx.from).add(tx.nonce);
        }
        if (ESCROW.test(tx.from || '')) settled.add(tx.from);
      };
      for (const b of legacy) {
        if (!Array.isArray(b?.txs)) throw Error('legacy_invalid_shape');
        for (const tx of b.txs) { debitCredit(tx); remember(tx); }
      }
      // A checkpoint authenticates historical anomalies; it does not repair them.
      // Negative state has no unambiguous safe migration and is refused.
      if ([...balances.values()].some(v => v.n < 0n)) throw Error('legacy_negative_balance_requires_migration');
      const accepted = [...legacy];
      function step(b) {
        if (!b || !b.header || !Array.isArray(b.txs) || b.height !== accepted.length || !uint(b.height)) throw Error('bad_block_shape_or_height');
        const h = b.header, prev = accepted.at(-1);
        if (h.version !== 2 || h.chainId !== p.chainId) throw Error('version_or_chain_id');
        if (![h.timestamp, h.nonce, h.difficultyBits].every(uint) || h.difficultyBits > 256 || !/^[a-f0-9]{64}$/.test(h.prevHash || '') || !/^[a-f0-9]{64}$/.test(h.merkleRoot || '') || !/^[a-f0-9]{64}$/.test(b.hash || '')) throw Error('invalid_header_fields');
        if (!prev || h.prevHash !== prev.hash || h.timestamp <= prev.header.timestamp) throw Error('previous_block_or_time');
        if (h.difficultyBits !== p.expectedDifficultyBits(accepted) || p.computeBlockHash(h) !== b.hash || !p.hashMeetsDifficulty(b.hash, h.difficultyBits)) throw Error('hash_pow_or_difficulty');
        if (b.txs.length === 0 || b.txs[0]?.from !== 'COINBASE' || b.txs.filter(t => t?.from === 'COINBASE').length !== 1) throw Error('exactly_one_first_coinbase');
        for (const tx of b.txs) {
          if (!plainRecord(tx) || !uint(tx.nonce) || !uint(tx.ts) || tx.ts > h.timestamp || typeof tx.memo !== 'string') throw Error('invalid_transaction_fields');
          if (transactionId(tx) !== tx.txid || ids.has(tx.txid)) throw Error('transaction_id_or_replay');
          const amount = newAmount(tx.amount);
          if (!ADDRESS.test(tx.to || '') && !ESCROW.test(tx.to || '')) throw Error('invalid_recipient');
          // Terminal mode uses single-use contract IDs. Reopening a settled ID
          // would lock newly deposited funds, so reject the deposit itself.
          if (!partial && ESCROW.test(tx.to) && settled.has(tx.to)) throw Error('escrow_reopening_forbidden');
          if (tx.from === 'COINBASE') {
            if (!ADDRESS.test(tx.to) || tx.nonce !== b.height || tx.ts !== h.timestamp || !equal(amount, newAmount(p.blockReward(b.height)))) throw Error('invalid_scheduled_coinbase');
          } else {
            if (!ADDRESS.test(tx.from || '') && !ESCROW.test(tx.from || '')) throw Error('reserved_or_invalid_sender');
            if (nonces.get(tx.from)?.has(tx.nonce)) throw Error('sender_nonce_replay');
            const available = balances.get(tx.from) || zero();
            if (add(available, amount, true).n < 0n) throw Error('sequential_overspend');
            const context = accepted.concat([{ height: b.height, header: h, txs: current }]);
            if (ESCROW.test(tx.from)) {
              const id = tx.from.slice(7);
              if (!['escpayout:' + id, 'escrefund:' + id].includes(tx.memo)) throw Error('invalid_escrow_memo');
              if (!partial && settled.has(tx.from)) throw Error('escrow_already_settled');
              // In partial mode replay of a proof (which signs amount, not nonce)
              // is forbidden independently of the transaction ID.
              const proof = escrowAuthorizationKey(tx);
              if (proofs.has(proof)) throw Error('escrow_proof_replay');
              if (!p.verifyEscrowTx(tx, context)?.ok) throw Error('escrow_authorization');
              proofs.add(proof);
            } else if (!p.verifyTransaction(tx)) throw Error('ordinary_signature');
            if (!p.verifySecondSig(tx, p.treasuryPolicy(context))) throw Error('treasury_authorization');
          }
          debitCredit(tx); remember(tx); current.push(tx);
        }
        if (h.merkleRoot !== p.merkleRoot(b.txs)) throw Error('merkle_mismatch');
        accepted.push(b);
      }
      const proofs = new Set();
      for (const b of legacy) for (const tx of b.txs) if (ESCROW.test(tx.from || '')) proofs.add(escrowAuthorizationKey(tx));
      let current;
      for (const b of [...prefix.slice(activation), block]) { current = []; step(b); }
      return { ok: true, reason: null };
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  }
  return Object.freeze({ validateBlock, transactionId });
}
