#!/usr/bin/env node
/* Изолированный тест шлюза: политика — второй затвор отправки. Без сети. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMainnetGateway } from '../sdk/js/mainnet-server.mjs';

function req(url, method = 'GET') {
  return { method, url, __u: new URL(url, 'http://x') };
}
function call(gw, url, method, body) {
  return new Promise((resolve) => {
    const res = { code: 0, obj: null, writeHead(c) { this.code = c; }, end(t) { this.obj = JSON.parse(t); resolve(this); } };
    gw.handle(req(url, method), res, new URL(url, 'http://x'), body || {});
  });
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')); }

test('без политики: отправка только с manualApprove владельца', async () => {
  const d = tmp();
  const gw = createMainnetGateway({ nodeApiBase: 'https://x', storeFile: path.join(d, 's.json'), policyFile: path.join(d, 'no-policy.json') });
  const mk = (o) => call(gw, '/mainnet/obligations', 'POST', o);
  const ob = await mk({ orderId: 'o1', payer: 'AGPp', recipient: 'AGT0000000000000000000000000000000000000000', amountAtomic: '1000', acceptedProof: { state: 'accepted', recipient: 'AGT0000000000000000000000000000000000000000' } });
  assert.equal(ob.obj.settlement.state, 'obligation');
  const denied = await call(gw, '/mainnet/submit', 'POST', { orderId: 'o1', signedTx: { signature: 'xx' } });
  assert.equal(denied.code, 409);
  assert.equal(denied.obj.error, 'no_policy_manual_approve_required');
});

test('политика: сверх лимита — отказ, в лимите — проходит к релею', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'pol.json'), JSON.stringify({ maxPerPaymentAtomic: '1000', maxPerDayAtomic: '1000', autonomous: true, allowedRecipients: null, requireManualApproveAboveAtomic: '500' }));
  const gw = createMainnetGateway({ nodeApiBase: 'https://x', storeFile: path.join(d, 's.json'), policyFile: path.join(d, 'pol.json') });
  const mk = (o) => call(gw, '/mainnet/obligations', 'POST', o);
  // need valid canonical recipient
  const { createWallet } = await import('../core.mjs');
  const exec = createWallet('e');
  await mk({ orderId: 'big', payer: 'AGPp', recipient: exec.address, amountAtomic: '1000', acceptedProof: { state: 'accepted', recipient: exec.address } });
  const over = await call(gw, '/mainnet/submit', 'POST', { orderId: 'big', signedTx: { signature: 'xx' } });
  assert.equal(over.code, 409);
  assert.match(over.obj.error, /manual_approval_required/);
  const oked = await call(gw, '/mainnet/submit', 'POST', { orderId: 'big', signedTx: { signature: 'xx' }, manualApprove: true });
  // подпись 'xx' невалидна → честный отказ релея, но затвор политики пройден
  assert.equal(oked.obj.relay.error, 'bad_signature');
});

test('секрет в теле — отказ до любой логики', async () => {
  const d = tmp();
  const gw = createMainnetGateway({ nodeApiBase: 'https://x', storeFile: path.join(d, 's.json'), policyFile: path.join(d, 'p.json') });
  const r = await call(gw, '/mainnet/preview', 'POST', { orderId: 'o', payer: 'a', recipient: 'b', amountAtomic: '1', privKey: 'zzz' });
  assert.equal(r.code, 400);
  assert.equal(r.obj.error, 'private_key_rejected');
});
