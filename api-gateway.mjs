// Offline pilot core. No HTTP listener, signing keys, live chain verifier or paid provider.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const id = () => crypto.randomUUID();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function units(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,23}$/.test(value)) throw Error('invalid_units');
  return BigInt(value);
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('invalid_text');
  return value;
}
export class ApiGatewayPilot {
  constructor({ file, network, genesisHash, recipient, service, priceUnits, budgetMinor, currency = 'USD', provider, verifyPayment, now = Date.now }) {
    if (!file || !/^[a-zA-Z0-9_.:-]{1,96}$/.test(network) || !/^[a-f0-9]{64}$/.test(genesisHash) || !/^AGT[a-f0-9]{40}$/.test(recipient)) throw Error('invalid_config');
    text(service, 80); units(priceUnits); if (!/^[A-Z]{3}$/.test(currency)) throw Error('invalid_currency');
    if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 1 || typeof provider !== 'function' || typeof verifyPayment !== 'function') throw Error('invalid_adapter_or_budget');
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
      this.save();
    } catch (e) { this.close(); throw e; }
  }
  save() {
    if (this.closed) throw Error('gateway_closed');
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
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
    this.state.quotes[q.quoteId] = q; this.save(); return structuredClone(q);
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
    if (order.status === 'settled') return structuredClone(order.receipt);
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
      order.status = 'settled'; this.save();
      return { ...structuredClone(order.receipt), text: result.text };
    } catch (error) {
      order.status = 'execution_unknown'; order.refundReview = true; this.save();
      throw Error('execution_unknown_reconcile_before_retry');
    }
  }
  inspect(orderId) { return structuredClone(this.state.orders[orderId] || null); }
}
