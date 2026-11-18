#!/usr/bin/env node
/* Изолированные тесты шлюза через API ноды: сеть — stub fetch, секретов и
 * mainnet-касаний нет. Живой опрос прода — отдельным ручным шагом, не здесь.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeApi, MAINNET_GENESIS_HASH } from '../sdk/js/mainnet-node-api.mjs';

const GEN = MAINNET_GENESIS_HASH;
const TIP = '00'.repeat(31) + 'ab';

function stub(routes) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${opts.method || 'GET'} ${u.pathname}${u.search}`;
    const hit = Object.entries(routes).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error('UNEXPECTED_FETCH ' + key);
    const [status, body] = hit[1];
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

const infoOk = [200, { chainId: 'AGENTCOIN', genesisHash: GEN, blocks: 100, mempool: 0 }];
const lifeOk = [200, { blocks: 100, tipHash: TIP, tipAgeSec: 30, fresh: true, chainValid: true }];
const tipBlock = [200, { blocks: [{ height: 99, hash: TIP, header: {}, txs: [] }] }];

function baseRoutes(extra = {}) {
  return {
    'GET /info': infoOk,
    'GET /life': lifeOk,
    'GET /blocks?n=1': tipBlock,
    ...extra,
  };
}

test('сеть: genesis+высота+вершина+синхронизация, не только genesis', async () => {
  const api = createNodeApi({ base: 'https://x', fetchImpl: stub(baseRoutes()) });
  const ev = await api.netEvidence();
  assert.equal(ev.synced, true);
  assert.equal(ev.heightsAgree, true);
  assert.equal(ev.tipAgree, true);
});

test('чужой genesis отвергается', async () => {
  const api = createNodeApi({ base: 'https://x', fetchImpl: stub(baseRoutes({ 'GET /info': [200, { chainId: 'AGENTCOIN', genesisHash: 'dead', blocks: 100 }] })) });
  await assert.rejects(api.netEvidence(), /wrong_genesis/);
});

test('расхождение высоты/вершины = не синхронизировано', async () => {
  const api = createNodeApi({ base: 'https://x', fetchImpl: stub(baseRoutes({ 'GET /life': [200, { blocks: 101, tipHash: 'ff', tipAgeSec: 10, fresh: true, chainValid: true }] })) });
  const ev = await api.netEvidence();
  assert.equal(ev.synced, false);
});

test('несвежая вершина = не синхронизировано', async () => {
  const api = createNodeApi({ base: 'https://x', fetchImpl: stub(baseRoutes({ 'GET /life': [200, { blocks: 100, tipHash: TIP, tipAgeSec: 3600, fresh: false, chainValid: true }] })) });
  const ev = await api.netEvidence();
  assert.equal(ev.synced, false);
});

test('HTML-оболочка вместо JSON = fail-closed, не «данные»', async () => {
  const api = createNodeApi({ base: 'https://x', fetchImpl: stub(baseRoutes({ 'GET /info': [200, '<!DOCTYPE html>'] })) });
  await assert.rejects(api.netEvidence(), /unexpected_upstream/);
});

test('подтверждение: пруф + тело + глубина; чужой получатель/сумма не «оплачено»', async () => {
  const txid = 'a'.repeat(64);
  const tx = { txid, from: 'AGFpayer', to: 'AGPexec', amount: 1, nonce: 5 };
  const blk = { height: 90, hash: 'b90', header: { prevHash: 'b89' }, txs: [tx] };
  const routes = baseRoutes({
    ['GET /api/v1/txproof/' + txid]: [200, { txid, height: 90, blockHash: 'b90', txIndex: 0, merkleBranch: [], header: {} }],
    'GET /blocks?from=90': [200, { blocks: [blk] }],
    'GET /headers?from=90': [200, { headers: [{ height: 90, hash: 'b90', header: {} }, { height: 99, hash: TIP, header: { prevHash: 'b90x' } }] }],
  });
  // Заголовки: разрыв цепочки prevHash → реорг (через noun? строим связную цепочку длины 10)
  const chain = [{ height: 90, hash: 'b90', header: {} }];
  let prev = 'b90';
  for (let h = 91; h <= 99; h++) { const hh = 'h' + h; chain.push({ height: h, hash: hh, header: { prevHash: prev } }); prev = hh; }
  chain[9].hash = TIP;
  routes['GET /headers?from=90'] = [200, { headers: chain }];
  const api = createNodeApi({ base: 'https://x', fetchImpl: stub(routes) });
  const ok = await api.checkConfirmation({ txid, expectTo: 'AGPexec', expectAmountAtomic: 1000000000n, depth: 6 });
  assert.equal(ok.state, 'confirmed');
  assert.equal(ok.confirmations, 10);
  const wrongTo = await api.checkConfirmation({ txid, expectTo: 'AGPother', expectAmountAtomic: 1000000000n, depth: 1 });
  assert.equal(wrongTo.state, 'recipient_mismatch');
  const wrongAmt = await api.checkConfirmation({ txid, expectTo: 'AGPexec', expectAmountAtomic: 2n, depth: 1 });
  assert.equal(wrongAmt.state, 'amount_mismatch');
});

test('потеря ответа: нет пруфа и нет в mempool = pending, не успех и не повтор вслепую', async () => {
  const txid = 'b'.repeat(64);
  const routes = baseRoutes({
    ['GET /api/v1/txproof/' + txid]: [404, { error: 'txid_not_in_chain' }],
    'GET /api/v1/mempool': [200, { version: 1, size: 0, complete: true, txs: [], tipHash: TIP, height: 99 }],
  });
  const api = createNodeApi({ base: 'https://x', fetchImpl: stub(routes) });
  const c = await api.checkConfirmation({ txid, expectTo: 'AGPexec', expectAmountAtomic: 1n, depth: 6 });
  assert.equal(c.state, 'pending');
});

test('есть в mempool = sent, не confirmed', async () => {
  const txid = 'c'.repeat(64);
  const routes = baseRoutes({
    ['GET /api/v1/txproof/' + txid]: [404, { error: 'txid_not_in_chain' }],
    'GET /api/v1/mempool': [200, { version: 1, size: 1, complete: true, txs: [{ txid }], tipHash: TIP, height: 99 }],
  });
  const api = createNodeApi({ base: 'https://x', fetchImpl: stub(routes) });
  const c = await api.checkConfirmation({ txid, expectTo: 'AGPexec', expectAmountAtomic: 1n, depth: 6 });
  assert.equal(c.state, 'sent');
});

test('отправка: несоответствие заказу — отказ без сетевого вызова', async () => {
  let calls = 0;
  const api = createNodeApi({ base: 'https://x', fetchImpl: async () => { calls++; throw new Error('MUST_NOT_FETCH'); } });
  const obligation = { payer: 'AGPp', recipient: 'AGPr', amountAtomic: '1000000000' };
  const r = await api.submitSignedTx({ obligation, signedTx: { from: 'AGPp', to: 'AGPWRONG', amount: 1, signature: 'xx' } });
  assert.equal(r.ok, false);
  assert.equal(calls, 0);
});
