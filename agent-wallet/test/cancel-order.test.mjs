import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createProfile } from '../../agt-skill/agent-profile.mjs';
import { verifyTransaction } from '../../core.mjs';
import { cancelDxeOrder } from '../src/cli.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-cancel-order-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const password = `synthetic-${crypto.randomBytes(12).toString('hex')}`;
  const profilePath = path.join(dir, 'agent.profile.json');
  const profile = await createProfile({ profilePath, password, network: 'AGT_TESTNET', label: 'synthetic-cancel-test' });
  const pin = { nodeUrl: 'http://127.0.0.1:9335', network: 'AGT_TESTNET', genesisHash: 'a'.repeat(64) };
  return { profilePath, password, profile, pin };
}
function reply(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
function installNodeMock(t, f, { txMode = 'accepted', preflightVerdict = 'preflight_pass' } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input)), method = options.method || 'GET';
    let body = null; if (options.body) body = JSON.parse(options.body);
    calls.push({ route: url.pathname + url.search, method, body });
    if (url.pathname === '/info') return reply({ chainId: f.pin.network, genesisHash: f.pin.genesisHash });
    if (url.pathname === '/dxe/orders') return reply({ orders: [{ ref: 'AB12cd34', from: f.profile.address, status: 'open' }] });
    if (url.pathname === '/balance') return reply({ address: f.profile.address, balance: 1, unit: 'AGT' });
    if (url.pathname === '/tx/preflight') return reply({ verdict: preflightVerdict, network: f.pin.network,
      signature: { ok: true }, balance: { ok: true }, nonce: { ok: true }, fee: { amount: 0 } });
    if (url.pathname === '/tx') {
      if (txMode === 'timeout') throw Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError', stage: 'http_request' });
      if (txMode === 'rejected') return reply({ accepted: false, error: 'synthetic_reject' }, 409);
      return reply({ accepted: true, mempool: 1, gossipped: true }, 201);
    }
    if (url.pathname === '/mempool') return reply({ complete: true, txs: [] });
    if (url.pathname.startsWith('/txproof/')) return reply({ error: 'not_found' }, 404);
    throw new Error(`unexpected_test_route_${url.pathname}`);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('cancel-order signs the exact self-transfer, checks preflight, and submits once', async t => {
  const f = await fixture(t), calls = installNodeMock(t, f);
  const result = await cancelDxeOrder({ profilePath: f.profilePath, ref: 'AB12cd34', nodeUrl: f.pin.nodeUrl,
    password: f.password, pin: f.pin });
  assert.equal(result.status, 'submitted');
  assert.equal(result.ref, 'AB12cd34');
  const tx = calls.find(call => call.route === '/tx')?.body;
  assert.ok(tx);
  assert.equal(tx.from, f.profile.address);
  assert.equal(tx.to, tx.from);
  assert.equal(tx.amount, 0.001);
  assert.equal(tx.memo, 'dxe|C|AB12cd34');
  assert.equal(tx.txid, result.txid);
  assert.equal(verifyTransaction(tx), true);
  assert.equal(calls.filter(call => call.route === '/tx').length, 1);
  assert.equal(calls.some(call => call.route === '/tx/preflight'), true);
});

test('cancel-order stops on preflight rejection and never sends', async t => {
  const f = await fixture(t), calls = installNodeMock(t, f, { preflightVerdict: 'preflight_reject' });
  await assert.rejects(cancelDxeOrder({ profilePath: f.profilePath, ref: 'AB12cd34', nodeUrl: f.pin.nodeUrl,
    password: f.password, pin: f.pin }), /cancel_failed/);
  assert.equal(calls.some(call => call.route === '/tx'), false);
});

test('cancel-order preserves an explicit node rejection and never resubmits', async t => {
  const f = await fixture(t), calls = installNodeMock(t, f, { txMode: 'rejected' });
  await assert.rejects(cancelDxeOrder({ profilePath: f.profilePath, ref: 'AB12cd34', nodeUrl: f.pin.nodeUrl,
    password: f.password, pin: f.pin }), /cancel_failed/);
  assert.equal(calls.filter(call => call.route === '/tx').length, 1);
  assert.equal(calls.some(call => call.route === '/mempool?full=1'), false);
});

test('cancel-order reports unknown after a lost response and does not retry', async t => {
  const f = await fixture(t), calls = installNodeMock(t, f, { txMode: 'timeout' });
  const result = await cancelDxeOrder({ profilePath: f.profilePath, ref: 'AB12cd34', nodeUrl: f.pin.nodeUrl,
    password: f.password, pin: f.pin });
  assert.equal(result.status, 'status_unknown');
  assert.equal(result.txid.length, 64);
  assert.equal(calls.filter(call => call.route === '/tx').length, 1);
  assert.equal(calls.some(call => call.route === '/mempool?full=1'), true);
});

test('cancel-order rejects another maker and a node different from the trusted pin', async t => {
  const f = await fixture(t), calls = installNodeMock(t, f);
  await assert.rejects(cancelDxeOrder({ profilePath: f.profilePath, ref: 'AB12cd34', nodeUrl: 'http://127.0.0.1:9999',
    password: f.password, pin: f.pin }), /cancel_failed/);
  assert.equal(calls.length, 0);
});
