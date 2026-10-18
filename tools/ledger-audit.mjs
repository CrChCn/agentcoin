#!/usr/bin/env node
/* Independent, offline AGT accounting audit. Reads one explicitly supplied public
 * snapshot and writes JSON to stdout. Never loads a node, wallet, keys or config;
 * never contacts the network or changes chain/account state. Monetary output is
 * decimal text computed with BigInt from JSON number lexemes, without rounding.
 * Usage (Node >=22 with JSON.parse source context):
 *   node tools/ledger-audit.mjs /path/to/chain.json > ledger-audit.json
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const sha256d = text => crypto.createHash('sha256').update(crypto.createHash('sha256').update(text).digest()).digest('hex');
const walletPattern = /^AGT[0-9a-f]{40}$/;
const escrowPattern = /^ESCROW_[0-9a-f]{10,32}$/;
const present = value => value !== undefined && value !== null && value !== '';
const sortText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** A decimal coefficient and scale. Exponent expansion is deliberately bounded. */
export function decimalParts(value) {
  const text = String(value);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m || text.length > 1100) throw new Error('unsupported_decimal');
  const exponent = Number(m[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('decimal_exponent_limit');
  let coefficient = BigInt((m[1] || '') + m[2] + (m[3] || ''));
  let scale = (m[3] || '').length - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  if (scale > 1000) throw new Error('decimal_scale_limit');
  return { coefficient, scale };
}

export function formatDecimal(coefficient, scale) {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  if (scale) digits = (digits.slice(0, -scale) + '.' + digits.slice(-scale)).replace(/\.?0+$/, '');
  return (negative && coefficient !== 0n ? '-' : '') + digits;
}

const units = (parts, scale) => parts.coefficient * 10n ** BigInt(scale - parts.scale);
const equalDecimal = (a, b) => {
  const scale = Math.max(a.scale, b.scale);
  return units(a, scale) === units(b, scale);
};

/** Timestamp convention is evidence from numeric magnitude, not consensus repair.
 * Values in [2000-01-01, 2100-01-01) are recognized in seconds or milliseconds.
 * Unrecognized/missing times remain unknown, never silently become 1970. */
export function normalizeTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { unit: 'missing_or_invalid', iso: null, day: 'unknown' };
  const lower = 946684800, upper = 4102444800;
  let unit = 'unknown', ms;
  if (value >= lower && value < upper) { unit = 'seconds'; ms = value * 1000; }
  else if (value >= lower * 1000 && value < upper * 1000) { unit = 'milliseconds'; ms = value; }
  if (ms === undefined) return { unit, iso: null, day: 'unknown', raw: value };
  const iso = new Date(ms).toISOString();
  return { unit, iso, day: iso.slice(0, 10), raw: value };
}

export function addressKind(address) {
  if (typeof address !== 'string') return 'non_string';
  if (walletPattern.test(address)) return 'wallet_shape';
  if (escrowPattern.test(address)) return 'escrow_system';
  if (['COINBASE', 'AGENT_REWARD_POOL', 'AGT_GENESIS_TREASURY'].includes(address)) return 'named_system';
  return 'noncanonical';
}

/** Categories describe public memo prefixes, not verified purpose or ownership. */
export function categoryFor(tx) {
  const memo = typeof tx?.memo === 'string' ? tx.memo : '';
  if (tx?.from === 'COINBASE') return /^block \d+$/.test(memo) ? 'coinbase:block-memo' : 'coinbase:other';
  if (/^(army-w2|w2)(?:[:|#\s-]|$)/i.test(memo)) return 'w2/army-w2';
  if (/^army(?:[:|#\s-]|$)/i.test(memo)) return 'army';
  if (/^codex-review-award(?:[:|#\s-]|$)/i.test(memo)) return 'codex-review-award';
  if (/^ops-job-budget(?:[:|#\s-]|$)/i.test(memo)) return 'ops-job-budget';
  if (/^paysim(?:[:|#\s-]|$)/i.test(memo)) return 'paysim';
  if (/^(escrow|escpayout|escrefund|escfee)(?:[:|]|$)/i.test(memo) || String(tx?.from || '').startsWith('ESCROW_') || String(tx?.to || '').startsWith('ESCROW_')) return 'escrow';
  if (/^(dxe|dx|mbc20)(?:[:|#\s-]|$)/i.test(memo)) return 'dxe/mbc20';
  if (/^faucet(?:[:|#\s-]|$)/i.test(memo)) return 'faucet';
  if (/^soak(?:[:|#\s-]|$)/i.test(memo)) return 'soak';
  if (/^gov(?:[:|#\s-]|$)/i.test(memo)) return 'gov';
  if (/^mdata(?:[:|#\s-]|$)/i.test(memo)) return 'mdata';
  return 'other';
}

const digestOf = tx => sha256d(JSON.stringify({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, ts: tx.ts, memo: tx.memo || '' }));
const addressFromPublicKey = pub => { const pubHash = sha256d(pub); return 'AGT' + pubHash.slice(0, 32) + sha256d(pubHash).slice(0, 8); };
const blockHash = header => sha256d([header.version, header.prevHash, header.merkleRoot, header.timestamp, header.difficultyBits, header.nonce, header.chainId].join('|'));
const merkle = txs => {
  if (!txs.length) return '0'.repeat(64);
  let level = txs.map(tx => typeof tx?.txid === 'string' ? tx.txid : sha256d(JSON.stringify(tx)));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(level[i] + (level[i + 1] || level[i])));
    level = next;
  }
  return level[0];
};

export function auditSnapshotText(text, { source = 'supplied JSON snapshot', blockLimit = null } = {}) {
  const lexemes = new WeakMap();
  let sourceContext = false;
  const snapshot = JSON.parse(text, function (key, value, context) {
    if (key === 'amount' && typeof value === 'number' && context?.source) { lexemes.set(this, context.source); sourceContext = true; }
    return value;
  });
  const inputChain = Array.isArray(snapshot) ? snapshot : snapshot?.chain;
  if (!Array.isArray(inputChain)) throw new Error('snapshot must be an array or an object containing chain[]');
  if (blockLimit !== null && (!Number.isSafeInteger(blockLimit) || blockLimit < 0 || blockLimit > inputChain.length)) throw new Error('blockLimit must be an integer within the supplied chain');
  const selected = blockLimit === null ? inputChain : inputChain.slice(0, blockLimit);
  const result = auditSnapshot(selected, { amountLexemes: lexemes, exactJsonLexemes: sourceContext });
  result.provenance = { source, sha256: hash(text), bytes: Buffer.byteLength(text), scope: { inputBlocks: inputChain.length, selectedBlocks: selected.length, selection: blockLimit === null ? 'entire supplied snapshot' : 'prefix of supplied snapshot' }, ...result.provenance };
  return result;
}

export function auditSnapshot(snapshot, { amountLexemes = new WeakMap(), exactJsonLexemes = false } = {}) {
  const chain = Array.isArray(snapshot) ? snapshot : snapshot?.chain;
  if (!Array.isArray(chain)) throw new Error('snapshot must be an array or an object containing chain[]');
  const anomalies = Object.create(null);
  const add = (kind, entry) => (anomalies[kind] ||= []).push(entry);
  const records = [];
  let scale = 9, transactionCount = 0, missingMinerCount = 0;
  if (chain.length > 1) scale = Math.max(scale, decimalParts(String(50 / 2 ** Math.floor((chain.length - 1) / 210000))).scale);
  for (let blockIndex = 0; blockIndex < chain.length; blockIndex++) {
    const block = chain[blockIndex];
    if (!block || typeof block !== 'object') { add('malformedBlock', { blockIndex }); continue; }
    if (!present(block.miner)) missingMinerCount++;
    if (block.height !== blockIndex) add('heightMismatch', { blockIndex, declaredHeight: block.height ?? null });
    if (!Array.isArray(block.txs)) { add('missingTransactionArray', { blockIndex }); continue; }
    for (let txIndex = 0; txIndex < block.txs.length; txIndex++) {
      transactionCount++;
      const tx = block.txs[txIndex];
      const loc = { blockIndex, height: block.height ?? null, txIndex };
      if (!tx || typeof tx !== 'object' || Array.isArray(tx)) { add('malformedTransaction', loc); continue; }
      const lexeme = amountLexemes.get(tx) ?? String(tx.amount);
      let decimal = null;
      if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount)) add('excludedAmount', { ...loc, amountType: typeof tx.amount, value: String(tx.amount), reason: 'not_a_finite_number' });
      else {
        try {
          decimal = decimalParts(lexeme);
          scale = Math.max(scale, decimal.scale);
          if (!equalDecimal(decimal, decimalParts(String(tx.amount)))) add('jsonNumberPrecisionLoss', { ...loc, jsonLexeme: lexeme, parsedNumber: String(tx.amount) });
          if (decimal.scale > 9) add('subMagentAmount', { ...loc, amount: lexeme });
          if (!Number.isSafeInteger(Math.round(tx.amount * 1e9))) add('unsafeNumberMagentInteger', { ...loc, amount: lexeme });
          if (decimal.coefficient < 0n) add('negativeAmount', { ...loc, amount: lexeme });
          if (decimal.coefficient === 0n && tx.from !== 'COINBASE') add('zeroNonCoinbaseAmount', loc);
        } catch (error) { add('excludedAmount', { ...loc, value: lexeme, reason: error.message }); }
      }
      records.push({ tx, loc, decimal, lexeme });
    }
  }
  const textMoney = value => formatDecimal(value, scale);
  const accounts = new Map(), categories = new Map(), prefixes = new Map(), days = new Map(), txids = new Map(), digests = new Map(), nonces = new Map(), grantReferences = new Map();
  const timestamps = { block: Object.create(null), transaction: Object.create(null), blockTimestampFields: Object.create(null), first: null, last: null };
  const account = key => {
    if (!accounts.has(key)) accounts.set(key, { address: key, kind: addressKind(key), balance: 0n, received: 0n, sent: 0n, issuanceReceived: 0n, receivedCount: 0, sentCount: 0, keyBoundOutgoingCount: 0, numberBalance: 0 });
    return accounts.get(key);
  };
  const day = key => {
    if (!days.has(key)) days.set(key, { day: key, blocks: 0, transactions: 0, issuance: 0n, turnover: 0n, faucetTurnover: 0n });
    return days.get(key);
  };
  const blockDays = [];
  for (let i = 0; i < chain.length; i++) {
    const block = chain[i];
    if (!block || typeof block !== 'object') { blockDays[i] = 'unknown'; continue; }
    const field = block.header?.timestamp !== undefined ? 'header.timestamp' : block.timestamp !== undefined ? 'timestamp' : 'missing';
    timestamps.blockTimestampFields[field] = (timestamps.blockTimestampFields[field] || 0) + 1;
    const normalized = normalizeTimestamp(field === 'header.timestamp' ? block.header.timestamp : block.timestamp);
    timestamps.block[normalized.unit] = (timestamps.block[normalized.unit] || 0) + 1;
    blockDays[i] = normalized.day;
    day(normalized.day).blocks++;
    if (normalized.iso) {
      if (!timestamps.first || normalized.iso < timestamps.first) timestamps.first = normalized.iso;
      if (!timestamps.last || normalized.iso > timestamps.last) timestamps.last = normalized.iso;
    } else add('unknownBlockTimestamp', { blockIndex: i, field, value: normalized.raw ?? null });
    if (i > 0 && block.header?.prevHash !== chain[i - 1]?.hash) add('previousHashMismatch', { blockIndex: i });
    if (block.header) {
      if (blockHash(block.header) !== block.hash) add('blockHashMismatch', { blockIndex: i });
      if (Array.isArray(block.txs) && !block.txs.some(tx => !tx || typeof tx !== 'object') && merkle(block.txs) !== block.header.merkleRoot) add('merkleMismatch', { blockIndex: i });
    } else add('missingBlockHeader', { blockIndex: i });
  }
  let issuance = 0n, turnover = 0n, selfTransferTurnover = 0n, numericTransactions = 0, coinbaseCount = 0;
  let missingSenderCredits = 0n, missingRecipientDebits = 0n, unallocatedCoinbase = 0n;
  const coinbaseByBlock = new Map(), transactions = [], transientNegatives = new Map();
  for (const { tx, loc, decimal, lexeme } of records) {
    const category = categoryFor(tx);
    if (!categories.has(category)) categories.set(category, { category, transactions: 0, numericTransactions: 0, issuance: 0n, turnover: 0n });
    const cat = categories.get(category);
    cat.transactions++;
    const prefix = tx.from === 'COINBASE' ? '(COINBASE)' : typeof tx.memo === 'string' ? tx.memo.split(/[:|#\s]/)[0] : '(missing memo)';
    if (!prefixes.has(prefix)) prefixes.set(prefix, { prefix, transactions: 0, numericTransactions: 0, issuance: 0n, turnover: 0n });
    const pre = prefixes.get(prefix);
    pre.transactions++;
    const d = day(blockDays[loc.blockIndex] || 'unknown');
    d.transactions++;
    const normalizedTxTs = normalizeTimestamp(tx.ts);
    timestamps.transaction[normalizedTxTs.unit] = (timestamps.transaction[normalizedTxTs.unit] || 0) + 1;
    if (typeof tx.memo === 'string' && /^army\d*:grant:/.test(tx.memo)) {
      if (grantReferences.has(tx.memo)) add('repeatedGrantReference', { ...loc, memo: tx.memo, to: tx.to ?? null, first: grantReferences.get(tx.memo), interpretation: 'Repeated business reference; distinct transaction hashes/nonces do not establish whether this payment was intentional.' });
      else grantReferences.set(tx.memo, loc);
    }
    const txid = present(tx.txid) ? String(tx.txid) : null;
    if (!txid) add('missingTxid', loc);
    else if (txids.has(txid)) add('duplicateTxid', { ...loc, txid, first: txids.get(txid) });
    else txids.set(txid, loc);
    const digest = digestOf(tx);
    if (digests.has(digest)) add('duplicateTransactionDigest', { ...loc, digest, first: digests.get(digest) });
    else digests.set(digest, loc);
    if (tx.from !== 'COINBASE' && present(tx.from) && present(tx.nonce)) {
      const nonceKey = JSON.stringify([tx.from, tx.nonce]);
      if (nonces.has(nonceKey)) add('repeatedSenderNonce', { ...loc, from: tx.from, nonce: tx.nonce, first: nonces.get(nonceKey) });
      else nonces.set(nonceKey, loc);
    }
    for (const field of ['from', 'to']) {
      if (!present(tx[field])) { if (decimal) add('missingAddress', { ...loc, field }); continue; }
      const kind = addressKind(tx[field]);
      if (kind === 'noncanonical' || kind === 'non_string') add('noncanonicalAddress', { ...loc, field, address: String(tx[field]), kind });
      if (tx[field] === 'COINBASE' && field === 'to') add('coinbaseAsRecipient', loc);
    }
    let keyBound = false;
    if (typeof tx.fromPub === 'string' && tx.from !== 'COINBASE' && !String(tx.from).startsWith('ESCROW_')) {
      keyBound = addressFromPublicKey(tx.fromPub) === tx.from;
      if (!keyBound) add('senderPublicKeyAddressMismatch', { ...loc, from: String(tx.from), derivedAddress: addressFromPublicKey(tx.fromPub) });
    }
    if (!decimal) continue;
    const amount = units(decimal, scale);
    numericTransactions++; cat.numericTransactions++; pre.numericTransactions++;
    const isCoinbase = tx.from === 'COINBASE';
    if (isCoinbase) {
      coinbaseCount++; issuance += amount; cat.issuance += amount; pre.issuance += amount; d.issuance += amount;
      const entry = coinbaseByBlock.get(loc.blockIndex) || { count: 0, amount: 0n };
      entry.count++; entry.amount += amount; coinbaseByBlock.set(loc.blockIndex, entry);
      if (!present(tx.to)) unallocatedCoinbase += amount;
    } else {
      turnover += amount; cat.turnover += amount; pre.turnover += amount; d.turnover += amount;
      if (category === 'faucet') d.faucetTurnover += amount;
      if (present(tx.from) && tx.from === tx.to) selfTransferTurnover += amount;
    }
    if (present(tx.from) && !isCoinbase) {
      const a = account(String(tx.from));
      a.balance -= amount; a.sent += amount; a.sentCount++; a.numberBalance -= tx.amount;
      if (keyBound) a.keyBoundOutgoingCount++;
      if (!present(tx.to)) missingRecipientDebits += amount;
    } else if (!isCoinbase && present(tx.to)) missingSenderCredits += amount;
    if (present(tx.to)) {
      const a = account(String(tx.to));
      a.balance += amount; a.received += amount; a.receivedCount++; a.numberBalance += tx.amount;
      if (isCoinbase) a.issuanceReceived += amount;
    }
    // Check after both legs; a self-transfer has no intermediate overdraft.
    if (present(tx.from) && !isCoinbase) {
      const a = account(String(tx.from));
      if (a.balance < 0n && !transientNegatives.has(a.address)) transientNegatives.set(a.address, { ...loc, address: a.address, balance: textMoney(a.balance) });
    }
    transactions.push({ ...loc, txid, from: present(tx.from) ? String(tx.from) : null, to: present(tx.to) ? String(tx.to) : null, amount: textMoney(amount), category, memo: typeof tx.memo === 'string' ? tx.memo : null, transactionTime: normalizedTxTs.iso, blockDay: d.day });
  }
  let scheduledIssuance = 0n;
  for (let i = 0; i < chain.length; i++) {
    const cb = coinbaseByBlock.get(i) || { count: 0, amount: 0n };
    // Historical genesis carries a zero-valued coinbase; later heights use the
    // declared core schedule. A ceiling is not a proof that coins were issued.
    const halvings = Math.floor(i / 210000);
    const reward = i === 0 ? 0n : units(decimalParts(String(50 / 2 ** halvings)), scale);
    scheduledIssuance += reward;
    if (cb.count !== 1) add('coinbaseCount', { blockIndex: i, count: cb.count });
    if (cb.amount !== reward) add('coinbaseRewardDifference', { blockIndex: i, actual: textMoney(cb.amount), schedule: textMoney(reward), difference: textMoney(cb.amount - reward) });
  }
  const balances = [...accounts.values()].sort((a, b) => a.balance === b.balance ? sortText(a.address, b.address) : a.balance > b.balance ? -1 : 1);
  const sumBalances = balances.reduce((sum, a) => sum + a.balance, 0n);
  const numberBalanceTotal = balances.reduce((sum, a) => sum + a.numberBalance, 0);
  const expectedNetBalances = issuance - unallocatedCoinbase + missingSenderCredits - missingRecipientDebits;
  const addressBuckets = new Map(), nearMatches = [];
  for (const a of balances.filter(a => /^AGT[0-9a-f]{37,42}$/.test(a.address))) {
    const key = a.address.slice(0, 13) + ':' + a.address.slice(-6);
    for (const other of addressBuckets.get(key) || []) {
      let previous = Array.from({ length: other.address.length + 1 }, (_, i) => i);
      for (let i = 1; i <= a.address.length; i++) {
        const current = [i];
        for (let j = 1; j <= other.address.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a.address[i - 1] === other.address[j - 1] ? 0 : 1));
        previous = current;
      }
      const editDistance = previous.at(-1);
      if (editDistance <= 2) nearMatches.push({ addressA: other.address, balanceA: textMoney(other.balance), addressB: a.address, balanceB: textMoney(a.balance), editDistance });
    }
    if (!addressBuckets.has(key)) addressBuckets.set(key, []);
    addressBuckets.get(key).push(a);
  }
  const moneyFields = (value, fields) => Object.fromEntries(Object.entries(value).map(([key, v]) => [key, fields.includes(key) ? textMoney(v) : v]));
  const anomalyCounts = Object.fromEntries(Object.entries(anomalies).map(([kind, list]) => [kind, list.length]));
  const malformedAccounts = balances.filter(a => ['noncanonical', 'non_string'].includes(a.kind));
  return {
    schema: 'agentcoin-ledger-audit/v1',
    provenance: {
      deterministic: true, exactJsonAmountLexemes: exactJsonLexemes,
      limitations: [
        'One supplied snapshot; no independent peer agreement, acquisition time or canonical-chain status is established by this file.',
        exactJsonLexemes ? 'Exact decimal accounting reproduces numeric JSON amount lexemes; this is not a retroactive consensus migration to integer units.' : 'Input was already parsed or JSON source context is unavailable; precision discarded before audit cannot be recovered.',
        'No private keys or local labels were loaded. Beneficial ownership, custody, key availability and recoverability cannot be concluded from balances or address similarity.',
        'Wallet syntax is checked; the embedded checksum cannot be validated from a truncated public-key hash in an address alone. Public-key binding is checked where fromPub exists, without claiming signature validation.',
        'Hash links, block header hashes and merkle roots are checked; proof of work, historical difficulty rules, signatures, escrow authorization and total consensus validity are outside this accounting audit.',
        'Memo categories are deterministic heuristics. They do not prove real commerce, wages, hiring, approval or delivery of work.',
        'Every posted occurrence is counted, including duplicate transactions; removing a replay requires a separate authorized consensus/state decision.',
        'Timestamp units are inferred only for numeric dates from 2000 through 2099; unknown timestamps remain unassigned.'
      ]
    },
    summary: { blocks: chain.length, tipHeight: chain.at(-1)?.height ?? null, transactions: transactionCount, parsedTransactionObjects: records.length, numericTransactions, excludedOrMalformedTransactions: transactionCount - numericTransactions, accounts: balances.length, missingMinerFieldBlocks: missingMinerCount, coinbaseTransactions: coinbaseCount, decimalScale: scale },
    accounting: {
      issuance: textMoney(issuance), scheduledIssuanceCeiling: textMoney(scheduledIssuance), issuanceMinusSchedule: textMoney(issuance - scheduledIssuance),
      nonCoinbaseGrossTurnover: textMoney(turnover), selfTransferGrossTurnover: textMoney(selfTransferTurnover),
      sumBalances: textMoney(sumBalances), expectedNetBalances: textMoney(expectedNetBalances), postingDifference: textMoney(sumBalances - expectedNetBalances),
      balancesMinusIssuance: textMoney(sumBalances - issuance), missingSenderCredits: textMoney(missingSenderCredits), missingRecipientDebits: textMoney(missingRecipientDebits), unallocatedCoinbase: textMoney(unallocatedCoinbase),
      finalNegativeAccounts: balances.filter(a => a.balance < 0n).length, transientNegativeAccounts: transientNegatives.size,
      noncanonicalAccountBalance: textMoney(malformedAccounts.reduce((sum, a) => sum + a.balance, 0n)),
      numberReplayNetBalances: String(numberBalanceTotal), numberReplayMinusExact: String(numberBalanceTotal - Number(textMoney(sumBalances)))
    },
    timestamps,
    categories: [...categories.values()].sort((a, b) => sortText(a.category, b.category)).map(c => moneyFields(c, ['issuance', 'turnover'])),
    memoPrefixes: [...prefixes.values()].sort((a, b) => sortText(a.prefix, b.prefix)).map(c => moneyFields(c, ['issuance', 'turnover'])),
    days: [...days.values()].sort((a, b) => sortText(a.day, b.day)).map(d => moneyFields(d, ['issuance', 'turnover', 'faucetTurnover'])),
    balances: balances.map(a => {
      const result = moneyFields(a, ['balance', 'received', 'sent', 'issuanceReceived']);
      result.numberBalance = String(a.numberBalance);
      result.numberReplayMinusExact = String(a.numberBalance - Number(textMoney(a.balance)));
      return result;
    }),
    transactions,
    transientNegatives: [...transientNegatives.values()],
    nearAddressMatches: nearMatches,
    nearAddressMatchMethod: 'Distinct AGT+hex addresses of 40 through 45 characters sharing their first 13 and final 6 characters and within Levenshtein edit distance 2; heuristic, not exhaustive or proof of ownership.',
    anomalyCounts, anomalies
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help') {
    process.stderr.write('Usage: node tools/ledger-audit.mjs /explicit/path/chain.json > ledger-audit.json\n');
    process.exitCode = args[0] === '--help' ? 0 : 2;
  } else {
    try { process.stdout.write(JSON.stringify(auditSnapshotText(fs.readFileSync(args[0], 'utf8'), { source: args[0] }), null, 2) + '\n'); }
    catch (error) { process.stderr.write(`Ledger audit failed: ${error.message}\n`); process.exitCode = 1; }
  }
}
