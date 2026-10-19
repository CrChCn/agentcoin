/** Offline payment-intent journal. Callers supply signed transactions and trusted full observations.
 * Observations must come from the caller's trusted, consensus-validating source;
 * header/merkle linkage alone cannot decide fork choice or repair vulnerable consensus.
 * A successful submission is never payment confirmation. No keys or network are accessed here. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { txDigest, verifyTransaction, addressFromPub, computeBlockHash, merkleRoot } from './core.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
function stable(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
  return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}';
}
function fail(reason) { throw new Error('payment_intent_' + reason); }
function decimal(s) {
  if (typeof s !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(s)) fail('amount');
  const [i, f = ''] = s.split('.');
  const units = BigInt(i) * 1000000000n + BigInt(f.padEnd(9, '0'));
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) fail('amount_range');
  const out = i + (f.replace(/0+$/, '') ? '.' + f.replace(/0+$/, '') : '');
  return out;
}
function terms(input) {
  if (!input || typeof input.taskRef !== 'string' || !input.taskRef.trim() || input.taskRef !== input.taskRef.trim()) fail('task_ref');
  for (const key of ['sender', 'recipient']) if (!/^AGT[0-9a-f]{40}$/.test(input[key])) fail(key);
  if (!input.evidence || input.evidence.accepted !== true || typeof input.evidence.ref !== 'string' || !input.evidence.ref.trim() || !/^[a-f0-9]{64}$/.test(input.evidence.sha256)) fail('evidence');
  return { taskRef: input.taskRef, sender: input.sender, recipient: input.recipient, amount: decimal(input.amount), evidence: { accepted: true, ref: input.evidence.ref, sha256: input.evidence.sha256 } };
}
function validateTx(t, tx) {
  if (!tx || tx.from !== t.sender || tx.to !== t.recipient || typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || Number(t.amount) !== tx.amount || decimal(tx.amount < 0.000001 ? tx.amount.toFixed(9) : String(tx.amount)) !== t.amount) fail('transaction_terms');
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || !Number.isSafeInteger(tx.ts) || tx.ts < 0 || typeof tx.memo !== 'string') fail('transaction_fields');
  if (!/^[a-f0-9]{64}$/.test(tx.txid) || tx.txid !== txDigest(tx) || !verifyTransaction(tx) || addressFromPub(tx.fromPub) !== t.sender) fail('transaction_signature_or_digest');
  // JSON roundtrip excludes unsupported values and prevents caller mutation after prepare.
  if (stable(JSON.parse(JSON.stringify(tx))) !== stable(tx)) fail('transaction_json');
}
/** Pure plan validation: no journal, keys, callbacks or network access. */
export function inspectPaymentPlan(input, signedTx) {
  const t = terms(input);
  validateTx(t, signedTx);
  return { paymentId: hash(stable(t)), terms: t, txid: signedTx.txid };
}
async function privateJournalParent(file) {
  const parent = path.dirname(file);
  const roots = [];
  for (let current = parent; ; current = path.dirname(current)) {
    roots.unshift(current);
    if (path.dirname(current) === current) break;
  }
  // Check every existing ancestor BEFORE creating directories. This deliberately
  // rejects symlink aliases such as macOS /var; callers must use realpath first.
  for (const current of roots) {
    try {
      const st = await fs.lstat(current);
      if (!st.isDirectory() || st.isSymbolicLink()) fail('unsafe_parent');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(parent);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('unsafe_parent');
  if (process.platform !== 'win32' && ((st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid()))) fail('parent_not_private_owned');
}
export class PaymentIntentJournal {
  constructor({ file, genesisHash, now = Date.now, maxObservationAgeMs = 30000 }) { if (!path.isAbsolute(file)) fail('absolute_path_required'); if (!/^[a-f0-9]{64}$/.test(genesisHash)) fail('trusted_genesis_required'); this.file = file; this.genesisHash = genesisHash; if (typeof now !== 'function' || !Number.isSafeInteger(maxObservationAgeMs) || maxObservationAgeMs <= 0) fail('clock_config'); this.now = now; this.maxObservationAgeMs = maxObservationAgeMs; }
  async locked(fn) {
    await privateJournalParent(this.file);
    const lockFile = this.file + '.lock';
    let lock;
    try { lock = await fs.open(lockFile, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') fail('locked_manual_recovery_required'); throw e; }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, created: new Date().toISOString() })); await lock.sync(); return await fn(); }
    finally { await lock.close(); await fs.unlink(lockFile); }
  }
  async readRegularFile() {
    const stat = await fs.lstat(this.file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('journal_not_regular_file');
    return fs.readFile(this.file, 'utf8');
  }
  async load() {
    let raw;
    try { raw = await this.readRegularFile(); } catch (e) { if (e.code === 'ENOENT') return { version: 1, records: {} }; throw e; }
    let envelope;
    try { envelope = JSON.parse(raw); } catch { fail('corrupt_journal'); }
    const d = envelope.data;
    if (!d || d.version !== 1 || !d.records || typeof d.records !== 'object' || Array.isArray(d.records) || envelope.sha256 !== hash(stable(d))) fail('corrupt_journal');
    for (const [key, r] of Object.entries(d.records)) {
      try {
        const t = terms(r.terms);
        if (key !== hash(t.taskRef) || r.paymentId !== hash(stable(t)) || !['prepared', 'submitted', 'unknown', 'confirmed'].includes(r.state) || !Number.isSafeInteger(r.attempts) || r.attempts < 0) fail('record');
        validateTx(t, r.transaction);
      } catch { fail('corrupt_journal'); }
    }
    return d;
  }
  async save(d) {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    const f = await fs.open(temp, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify({ data: d, sha256: hash(stable(d)) }) + '\n'); await f.sync(); } finally { await f.close(); }
    await fs.rename(temp, this.file);
    // Windows may prohibit opening directories. File fsync + atomic rename still apply;
    // directory-entry crash durability depends on OS/filesystem support.
    let dir;
    try { dir = await fs.open(path.dirname(this.file), 'r'); await dir.sync(); }
    catch (e) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(e.code)) throw e; }
    finally { if (dir) await dir.close(); }
  }
  async prepare(input, signedTx) {
    return this.locked(async () => {
      const d = await this.load(), t = terms(input), key = hash(t.taskRef), paymentId = hash(stable(t));
      const old = d.records[key];
      if (old && old.paymentId !== paymentId) fail('task_terms_conflict');
      validateTx(t, signedTx);
      if (old) { if (stable(old.transaction) !== stable(signedTx)) fail('transaction_conflict'); return structuredClone(old); }
      const r = { paymentId, terms: t, transaction: JSON.parse(JSON.stringify(signedTx)), state: 'prepared', attempts: 0, retryAuthorized: false };
      d.records[key] = r; await this.save(d); return structuredClone(r);
    });
  }
  async inspect(taskRef) { return this.locked(async () => structuredClone((await this.load()).records[hash(taskRef)] ?? null)); }
  async reconcile(taskRef, observation) {
    return this.locked(async () => {
      const d = await this.load(), r = d.records[hash(taskRef)]; if (!r) fail('not_found');
      const o = observation, a = o?.anchor, chain = o?.chain;
      if (!o || Object.keys(o).sort().join(',') !== 'anchor,chain,complete,mempool,observedAt' || !a || Object.keys(a).sort().join(',') !== 'genesisHash,height,tipHash') fail('observation_fields');
      const now = this.now();
      if (!Number.isSafeInteger(o.observedAt) || o.observedAt > now || now - o.observedAt > this.maxObservationAgeMs || (r.lastAttemptAt !== undefined && o.observedAt <= r.lastAttemptAt)) fail('stale_observation');
      if (o?.complete !== true || !a || a.genesisHash !== this.genesisHash || !Array.isArray(chain) || !chain.length || !Array.isArray(o.mempool) || !/^[a-f0-9]{64}$/.test(a.genesisHash) || !/^[a-f0-9]{64}$/.test(a.tipHash) || a.height !== chain.length - 1 || chain[0].hash !== a.genesisHash || chain.at(-1).hash !== a.tipHash) fail('incomplete_observation');
      for (let i = 0; i < chain.length; i++) if (!Array.isArray(chain[i].txs) || computeBlockHash(chain[i].header) !== chain[i].hash || chain[i].header.merkleRoot !== merkleRoot(chain[i].txs) || (i && chain[i].header?.prevHash !== chain[i - 1].hash)) fail('unanchored_observation');
      let confirmed = false, pending = false, confirmation = null;
      for (const [isChain, list] of [[true, chain.flatMap(b => b.txs)], [false, o.mempool]]) for (const tx of list) {
        if (tx?.txid === r.transaction.txid) {
          if (stable(tx) !== stable(r.transaction)) fail('txid_content_conflict');
          if (isChain) { confirmed = true; const blockHeight = chain.findIndex(b => b.txs.includes(tx)); confirmation = { blockHeight, blockHash: chain[blockHeight].hash, txid: tx.txid }; } else pending = true;
        }
        if (tx?.from === r.transaction.from && tx.nonce === r.transaction.nonce && tx.txid !== r.transaction.txid) fail('nonce_conflict');
      }
      const observationId = hash(stable({ anchor: a, mempool: o.mempool.map(tx => hash(stable(tx))).sort() }));
      const fresh = observationId !== r.lastObservationId;
      r.state = confirmed ? 'confirmed' : pending ? 'submitted' : r.attempts ? 'unknown' : 'prepared';
      r.retryAuthorized = !confirmed && !pending && fresh;
      r.lastObservationId = observationId; r.observedAt = o.observedAt; r.anchor = structuredClone(a); r.confirmation = confirmation;
      await this.save(d); return structuredClone(r);
    });
  }
  async submit(taskRef, callback, { dryRun = true } = {}) {
    return this.locked(async () => {
      const d = await this.load(), r = d.records[hash(taskRef)]; if (!r) fail('not_found');
      if (dryRun !== false) return { dryRun: true, record: structuredClone(r) };
      if (r.state === 'confirmed') fail('already_confirmed');
      if (!r.retryAuthorized || !Number.isSafeInteger(r.observedAt) || this.now() - r.observedAt > this.maxObservationAgeMs || this.now() < r.observedAt) fail('reconcile_required');
      if (typeof callback !== 'function') fail('submit_callback');
      r.retryAuthorized = false; r.attempts++; r.state = 'unknown'; r.lastAttemptAt = this.now();
      // Durable exact transaction and ambiguous state exist BEFORE any external side effect.
      await this.save(d);
      try {
        const response = await callback(structuredClone(r.transaction));
        r.state = 'submitted'; await this.save(d);
        return { record: structuredClone(r), response };
      } catch (e) { throw new Error('payment_intent_submission_unknown', { cause: e }); }
    });
  }
}
