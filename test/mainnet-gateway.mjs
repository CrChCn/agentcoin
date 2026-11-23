#!/usr/bin/env node
/* Изолированный тест шлюза: политика — второй затвор отправки. Без сети.
 * manualApprove — только подписью плательщика settle-approve, флаг отвергается. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMainnetGateway } from '../sdk/js/mainnet-server.mjs';

function req(url, method = 'GET') {
  return { method, socket: { remoteAddress: '127.0.0.1' }, url, __u: new URL(url, 'http://x') };
}
function call(gw, url, method, body) {
  return new Promise((resolve) => {
    const res = { code: 0, obj: null, writeHead(c) { this.code = c; }, end(t) { this.obj = JSON.parse(t); resolve(this); } };
    gw.handle(req(url, method), res, new URL(url, 'http://x'), body || {});
  });
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')); }

test('без политики: отправка только с подписью manualApproveSig владельца', async () => {
  const d = tmp();
  const gw = createMainnetGateway({ nodeApiBase: 'https://x', storeFile: path.join(d, 's.json'), policyFile: path.join(d, 'no-policy.json') });
  const mk = (o) => call(gw, '/mainnet/obligations', 'POST', o);
  const ob = await mk({ orderId: 'o1', payer: 'AGPp', recipient: 'AGT0000000000000000000000000000000000000000', amountAtomic: '1000', acceptedProof: { state: 'accepted', recipient: 'AGT0000000000000000000000000000000000000000' } });
  assert.equal(ob.obj.settlement.state, 'obligation');
  const denied = await call(gw, '/mainnet/submit', 'POST', { orderId: 'o1', signedTx: { signature: 'xx' } });
  assert.equal(denied.code, 409);
  assert.equal(denied.obj.error, 'manual_approve_signature_required');
  const flag = await call(gw, '/mainnet/submit', 'POST', { orderId: 'o1', signedTx: { signature: 'xx' }, manualApprove: true });
  assert.equal(flag.code, 409);
  assert.equal(flag.obj.error, 'manual_approve_signature_required');
});

test('политика: сверх лимита — отказ, с подписью владельца — проходит к релею', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'pol.json'), JSON.stringify({ maxPerPaymentAtomic: '1000', maxPerDayAtomic: '1000', autonomous: true, allowedRecipients: null, requireManualApproveAboveAtomic: '500' }));
  const gw = createMainnetGateway({ nodeApiBase: 'https://x', storeFile: path.join(d, 's.json'), policyFile: path.join(d, 'pol.json') });
  const mk = (o) => call(gw, '/mainnet/obligations', 'POST', o);
  // need valid canonical recipient + payer key for manualApproveSig
  const { createWallet } = await import('../core.mjs');
  const { signAction } = await import('../queue-auth.mjs');
  const payer = createWallet('payer');
  const exec = createWallet('e');
  await mk({ orderId: 'big', payer: payer.address, recipient: exec.address, amountAtomic: '1000', acceptedProof: { state: 'accepted', recipient: exec.address } });
  const over = await call(gw, '/mainnet/submit', 'POST', { orderId: 'big', signedTx: { signature: 'xx' } });
  assert.equal(over.code, 409);
  assert.match(over.obj.error, /manual_approve_signature_required/);
  const nonce = 'gw-' + Date.now();
  const expiry = Date.now() + 5 * 60_000;
  const { signature } = signAction(payer.privKey, { action: 'settle-approve', body: { orderId: 'big', txid: '', amountAtomic: '1000', recipient: exec.address }, nonce, expiry });
  const oked = await call(gw, '/mainnet/submit', 'POST', { orderId: 'big', signedTx: { signature: 'xx' }, manualApproveSig: { address: payer.address, fromPub: payer.pub, signature, nonce, expiry } });
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
