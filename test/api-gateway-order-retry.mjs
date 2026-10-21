import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiGatewayPilot } from '../api-gateway.mjs';

const request = { model: 'fixture', prompt: 'Order retry regression', maxTokens: 8 };
for (const status of ['awaiting_payment', 'paid', 'settled']) {
  test(`retry ${status} order after quote eviction and restart preserves identity and budget`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-order-retry-'));
    let now = 10000, calls = 0, gateway;
    const file = path.join(root, 'journal.json');
    const config = {
      file, network: 'TEST_ONLY', genesisHash: '0'.repeat(64),
      recipient: 'AGT' + 'c'.repeat(40), service: 'fixture', priceUnits: '1',
      budgetMinor: 100, quoteLimit: 10, now: () => now,
      verifyPayment: async ({ txid, orderId, quote }) => ({
        verified: true, canonical: true, confirmations: 2, txid, orderId,
        network: quote.network, genesisHash: quote.genesisHash,
        recipient: quote.recipient, amountUnits: quote.priceUnits, blockHash: 'b'.repeat(64),
      }),
      provider: async () => { calls++; return { text: 'fixture', currency: 'USD', actualCostMinor: 1 }; },
    };
    try {
      gateway = new ApiGatewayPilot(config);
      const quote = gateway.quote({ ...request, maxCostMinor: 5, currency: 'USD' });
      const order = gateway.order(quote.quoteId);
      if (status !== 'awaiting_payment') await gateway.confirm(order.orderId, 'a'.repeat(64));
      if (status === 'settled') await gateway.execute(order.orderId, request);
      for (let i = 0; i < 11; i++) gateway.quote({ ...request, maxCostMinor: 5, currency: 'USD' });
      assert.equal(JSON.parse(fs.readFileSync(file)).quotes[quote.quoteId], undefined);
      const expected = gateway.inspect(order.orderId);
      const callsBefore = calls;
      for (const restart of [false, true]) {
        if (restart) { gateway.close(); gateway = new ApiGatewayPilot(config); }
        now += 100000; // Existing orders remain discoverable after quote expiry.
        const before = JSON.parse(fs.readFileSync(file));
        assert.deepEqual(gateway.order(quote.quoteId), expected);
        const after = JSON.parse(fs.readFileSync(file));
        assert.equal(after.allocatedMinor, 5);
        assert.deepEqual(after, before, 'retry must not mutate durable financial state');
        assert.equal(calls, callsBefore);
      }
    } finally {
      gateway?.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('unknown or expired unclaimed quotes cannot create an order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-unknown-quote-'));
  let now = 10000;
  const gateway = new ApiGatewayPilot({
    file: path.join(root, 'journal.json'), network: 'TEST_ONLY', genesisHash: '0'.repeat(64),
    recipient: 'AGT' + 'c'.repeat(40), service: 'fixture', priceUnits: '1',
    budgetMinor: 100, now: () => now, provider: async () => {}, verifyPayment: async () => {},
  });
  try {
    assert.throws(() => gateway.order('not-a-quote'), /quote_not_found/);
    const quote = gateway.quote({ ...request, maxCostMinor: 5, currency: 'USD' });
    now += 100000;
    assert.throws(() => gateway.order(quote.quoteId), /quote_expired/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'journal.json'))).allocatedMinor, 0);
  } finally { gateway.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
