// Offline pilot core. No HTTP listener, signing keys, live chain verifier or paid provider.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const id = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Economic cap on a single quote price: 21e6 AGT x 1e9 units/AGT (journal test
// convention) = 21e16 minor. Anything above cannot be backed by planned supply.
// (EMPIRE-PILOT-01 review closeout: economic limits of units.)
const MAX_PRICE_UNITS = 21_000_000n * 1_000_000_000n;
function units(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,23}$/.test(value)) throw Error('invalid_units');
  return BigInt(value);
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('invalid_text');
  return value;
}
export class ApiGatewayPilot {
  constructor({ file, network, genesisHash, recipient, service, priceUnits, budgetMinor, currency = 'USD', provider, verifyPayment, now = Date.now, quoteLimit = 200, resultTtlMs = null }) {
    if (!file || !/^[a-zA-Z0-9_.:-]{1,96}$/.test(network) || !/^[a-f0-9]{64}$/.test(genesisHash) || !/^AGT[a-f0-9]{40}$/.test(recipient)) throw Error('invalid_config');
    text(service, 80); if (units(priceUnits) > MAX_PRICE_UNITS) throw Error('price_units_beyond_supply'); if (!/^[A-Z]{3}$/.test(currency)) throw Error('invalid_currency');
    if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 1 || typeof provider !== 'function' || typeof verifyPayment !== 'function') throw Error('invalid_adapter_or_budget');
    // Review closeout: bounded journal + durable result store. Neither joins the
    // config hash, so existing v1 journals stay compatible.
    if (!Number.isSafeInteger(quoteLimit) || quoteLimit < 10 || quoteLimit > 10000) throw Error('invalid_quote_limit');
    if (resultTtlMs !== null && (!Number.isSafeInteger(resultTtlMs) || resultTtlMs < 0)) throw Error('invalid_result_ttl');
    this.quoteLimit = quoteLimit; this.resultTtlMs = resultTtlMs; this.closed = false; this.results = {};
    this.resultFile = file + '.results.json';
    this.config = { network, genesisHash, recipient, service, priceUnits, budgetMinor, currency };
    this.file = file; this.provider = provider; this.verifyPayment = verifyPayment; this.now = now;
    this.lock = file + '.lock'; fs.mkdirSync(path.dirname(file), { recursive: true });
    // One process owns this journal. A stale lock requires operator investigation.
    this.fd = fs.openSync(this.lock, 'wx', 0o600);
    try {
      this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, configHash: hash(this.config), quotes: {}, orders: {}, payments: {}, allocatedMinor: 0 };
      if (this.state.version !== 1 || this.state.configHash !== hash(this.config) || !Number.isSafeInteger(this.state.allocatedMinor) || this.state.allocatedMinor < 0 || this.state.allocatedMinor > budgetMinor) throw Error('journal_config_mismatch');
      // A crash may have happened after the provider accepted the request.
      for (const order of Object.values(this.state.orders)) if (order.status === 'executing') order.status = 'execution_unknown';
      // Result side-file: outside the chain, owner-only ACL (0600), integrity re-checked on read.
      if (fs.existsSync(this.resultFile)) {
        const raw = JSON.parse(fs.readFileSync(this.resultFile, 'utf8'));
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw Error('results_corrupt');
        for (const [k, v] of Object.entries(raw)) if (!/^[0-9a-f-]{36}$/.test(k) || !v || typeof v.text !== 'string' || !/^[a-f0-9]{64}$/.test(v.resultHash) || !Number.isSafeInteger(v.storedAt)) throw Error('results_corrupt');
        this.results = raw;
      }
      this.save();
    } catch (e) { this.close(); throw e; }
  }
  save() {
    if (this.closed) throw Error('gateway_closed');
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    // Directory-entry durability, best effort. Windows cannot fsync a directory
    // handle; on POSIX this closes the rename's metadata gap.
    try { const dfd = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch {}
  }
  saveResults() {
    if (this.closed) throw Error('gateway_closed');
    const tmp = this.resultFile + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.results)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.resultFile);
    try { const dfd = fs.openSync(path.dirname(this.resultFile), 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch {}
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== undefined) { fs.closeSync(this.fd); fs.unlinkSync(this.lock); }
  }
  quote({ model, prompt, maxTokens, maxCostMinor, currency, ttlMs = 60000 }) {
    text(model, 80); text(prompt, 2000);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096 || !Number.isSafeInteger(maxCostMinor) || maxCostMinor < 1 || !/^[A-Z]{3}$/.test(currency) || currency !== this.config.currency || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) throw Error('invalid_limits');
    // Only hashes are persisted; user content is supplied again at execution.
    const request = { model, prompt, maxTokens };
    const q = { schema: 'agt.api.quote.v1', quoteId: id(), ...this.config, budgetMinor: undefined, currency, maxCostMinor, maxTokens, model, requestHash: hash(request), expiresAt: this.now() + ttlMs };
    delete q.budgetMinor;
    this.state.quotes[q.quoteId] = q;
    // Bounded journal: evict the oldest quotes; orders embed their own quote
    // clone and the payments map is never pruned (payment-binding uniqueness).
    const qids = Object.keys(this.state.quotes);
    for (const old of qids.length > this.quoteLimit ? qids.slice(0, qids.length - this.quoteLimit) : []) delete this.state.quotes[old];
    this.save(); return structuredClone(q);
  }
  order(quoteId) {
    const q = this.state.quotes[quoteId];
    if (!q) throw Error('quote_not_found');
    const existing = Object.values(this.state.orders).find(o => o.quoteId === quoteId);
    if (existing) return structuredClone(existing);
    if (this.now() >= q.expiresAt) throw Error('quote_expired');
    if (this.state.allocatedMinor + q.maxCostMinor > this.config.budgetMinor) throw Error('budget_exhausted');
    const order = { orderId: id(), quoteId, status: 'awaiting_payment', createdAt: this.now(), quote: structuredClone(q) };
    this.state.orders[order.orderId] = order;
    this.state.allocatedMinor += q.maxCostMinor;
    this.save(); return structuredClone(order);
  }
  async confirm(orderId, txid) {
    const order = this.state.orders[orderId];
    if (!order || !/^[a-f0-9]{64}$/.test(txid)) throw Error('invalid_payment_reference');
    if (order.txid === txid) return structuredClone(order);
    if (order.status !== 'awaiting_payment' || this.now() >= order.quote.expiresAt) throw Error('order_not_payable');
    if (this.state.payments[txid]) throw Error('payment_already_used');
    const proof = await this.verifyPayment({ txid, orderId, quote: structuredClone(order.quote) });
    // Adapter must independently validate chain/canonicality and invoice binding.
    if (!proof || proof.verified !== true || proof.canonical !== true || !Number.isSafeInteger(proof.confirmations) || proof.confirmations < 1 || proof.orderId !== orderId || proof.txid !== txid || proof.network !== this.config.network || proof.genesisHash !== this.config.genesisHash || proof.recipient !== this.config.recipient || proof.amountUnits !== order.quote.priceUnits || !/^[a-f0-9]{64}$/.test(proof.blockHash || '')) throw Error('payment_not_verified');
    // Recheck after await: parallel confirmations cannot consume one payment twice.
    if (order.status !== 'awaiting_payment' || this.state.payments[txid]) throw Error('payment_race');
    if (this.now() >= order.quote.expiresAt) throw Error('quote_expired');
    this.state.payments[txid] = orderId;
    order.txid = txid; order.paymentBlockHash = proof.blockHash; order.status = 'paid'; this.save();
    return structuredClone(order);
  }
  async execute(orderId, request) {
    const order = this.state.orders[orderId];
    if (!order) throw Error('order_not_found');
    if (!request || Object.keys(request).sort().join(',') !== 'maxTokens,model,prompt' || hash({ model: request.model, prompt: request.prompt, maxTokens: request.maxTokens }) !== order.quote.requestHash) throw Error('request_mismatch');
    if (order.status === 'settled') {
      try { return this.retrieveResult(orderId); } catch (e) {
        if (e.message !== 'result_not_stored') throw e;
        return structuredClone(order.receipt); // pre-result-store journals
      }
    }
    if (order.status !== 'paid') throw Error('order_not_executable');
    // Re-verify immediately before service. This is NOT an independent verifier.
    const p = await this.verifyPayment({ txid: order.txid, orderId, quote: structuredClone(order.quote) });
    if (!p || p.verified !== true || p.canonical !== true || p.blockHash !== order.paymentBlockHash || p.txid !== order.txid || p.orderId !== orderId || p.network !== this.config.network || p.genesisHash !== this.config.genesisHash || p.recipient !== this.config.recipient || p.amountUnits !== order.quote.priceUnits || !Number.isSafeInteger(p.confirmations) || p.confirmations < 1) throw Error('payment_recheck_failed');
    if (order.status !== 'paid') throw Error('execution_race');
    order.status = 'executing'; this.save();
    try {
      const result = await this.provider({ request: structuredClone(request), idempotencyKey: orderId, maxCostMinor: order.quote.maxCostMinor, currency: order.quote.currency });
      if (!result || typeof result.text !== 'string' || result.text.length > 32000 || !Number.isSafeInteger(result.actualCostMinor) || result.actualCostMinor < 0 || result.actualCostMinor > order.quote.maxCostMinor || result.currency !== order.quote.currency) throw Error('provider_result_invalid');
      // Fixed price pilot: AGT charge never pretends to equal a fiat exchange rate.
      order.receipt = { schema: 'agt.api.receipt.v1', orderId, txid: order.txid, paymentBlockHash: order.paymentBlockHash, network: this.config.network, genesisHash: this.config.genesisHash, service: this.config.service, chargedUnits: order.quote.priceUnits, refundDueUnits: '0', actualCostMinor: result.actualCostMinor, currency: result.currency, resultHash: hash(result.text), completedAt: this.now() };
      // Result lives in the side-file (0600, hash-in-checked, TTL-optional):
      // repeated receipt retrieval without a new purchase (CLOUD-API-02).
      this.results[orderId] = { text: result.text, resultHash: order.receipt.resultHash, storedAt: this.now() };
      this.saveResults();
      order.status = 'settled'; this.save();
      return { ...structuredClone(order.receipt), text: result.text };
    } catch (error) {
      order.status = 'execution_unknown'; order.refundReview = true; this.save();
      throw Error('execution_unknown_reconcile_before_retry');
    }
  }
  retrieveResult(orderId) {
    const order = this.state.orders[orderId];
    if (!order || order.status !== 'settled') throw Error('result_not_available');
    const r = this.results[orderId];
    if (!r || typeof r.text !== 'string') throw Error('result_not_stored');
    if (this.resultTtlMs !== null && this.now() - r.storedAt >= this.resultTtlMs) throw Error('result_expired');
    if (hash(r.text) !== order.receipt.resultHash) throw Error('result_integrity_mismatch');
    return { ...structuredClone(order.receipt), text: r.text };
  }
  inspect(orderId) { return structuredClone(this.state.orders[orderId] || null); }
}
