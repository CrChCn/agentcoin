// R-2 / R-3 / R-5 fixes regression (EMPIRE-PILOT-01 REVIEW-02)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiGatewayPilot } from '../api-gateway.mjs';
const tx = 'a'.repeat(64), block = 'b'.repeat(64);
const request = { model: 'fixture', prompt: 'R-fix regression', maxTokens: 10 };
function makeConfig(root, extra = {}) {
  return { file: path.join(root, 'journal.json'), network: 'TEST_ONLY', genesisHash: '0'.repeat(64),
    recipient: 'AGT' + 'c'.repeat(40), service: 'fixture', priceUnits: '1', budgetMinor: 200, now: () => now,
    verifyPayment: async ({ txid, orderId, quote }) => ({ verified: true, canonical: true, confirmations: 2, txid, orderId,
      network: quote.network, genesisHash: quote.genesisHash, recipient: quote.recipient, amountUnits: quote.priceUnits, blockHash: block }),
    provider: async () => { calls++; return { text: 'fixture text', currency: 'USD', actualCostMinor: 1 }; },
    ...extra };
}
let now = 10000, calls = 0;

test('R-2: результат с TTL стирается с диска после истечения (startup cleanup) и ретрив честно expiry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-r2-'));
  try {
    const cfg = makeConfig(root, { resultTtlMs: 5000 });
    const g = new ApiGatewayPilot(cfg);
    const q = g.quote({ ...request, maxCostMinor: 5, currency: 'USD' });
    const o = g.order(q.quoteId); await g.confirm(o.orderId, tx);
    await g.execute(o.orderId, request);
    const rf = cfg.file + '.results.json';
    assert.ok(JSON.parse(fs.readFileSync(rf, 'utf8'))[o.orderId], 'результат на диске');
    g.close();
    now += 100000;
    const g2 = new ApiGatewayPilot(cfg); // startup cleanup
    const after = JSON.parse(fs.readFileSync(rf, 'utf8'))[o.orderId];
    assert.equal(after && after.text, undefined, 'expired-текст удалён с диска');
    assert.ok(after && after.expiredAt, 'надгробие оставлено для честного отказа');
    g2.saveResults(); // рабочий cleanup обязан сохранять отсутствие текста
    assert.equal(JSON.parse(fs.readFileSync(rf, 'utf8'))[o.orderId].text, undefined, 'cleanup повторяем и idемпотентен');
    const settledAgain = await g2.execute(o.orderId, request);
    assert.equal(settledAgain.text, undefined, 'settled-повтор возвращает квитанцию без текста (результат не хранится)');
    assert.throws(() => g2.retrieveResult(o.orderId), /result_expired/, 'ретрив после срока даёт явный result_expired');
    g2.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('R-2: crash между saveResults и settled восстанавливается детерминированно (settled, без провайдера)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-r2crash-'));
  try {
    const cfg = makeConfig(root);
    let g = new ApiGatewayPilot(cfg);
    const q = g.quote({ ...request, maxCostMinor: 5, currency: 'USD' });
    const o = g.order(q.quoteId); await g.confirm(o.orderId, tx);
    const callsBefore = calls;
    await g.execute(o.orderId, request); // результат в side-file: текст+receipt, тогда crash
    const callsAfterFirst = calls;
    assert.equal(calls, callsBefore + 1, 'provider вызван ровно один раз до краха');
    g.close();
    // симулируем crash МЕЖДУ saveResults и settled: side-file цел, журнал откатился свыше executing, receipt откушен
    const rf = cfg.file + '.results.json';
    const results = JSON.parse(fs.readFileSync(rf, 'utf8'));
    const j = JSON.parse(fs.readFileSync(cfg.file, 'utf8'));
    j.orders[o.orderId].status = 'executing';
    delete j.orders[o.orderId].receipt;
    fs.writeFileSync(cfg.file, JSON.stringify(j));
    fs.writeFileSync(rf, JSON.stringify(results));
    g = new ApiGatewayPilot(cfg); // restart: reconciliation
    const st = g.inspect(o.orderId);
    assert.equal(st.status, 'settled', 'execution_unknown с валидным receipt → settled');
    const r = await g.execute(o.orderId, request);
    assert.equal(r.text, 'fixture text', 'результат доступен после reconcile');
    assert.equal(calls, callsAfterFirst, 'provider НЕ вызывался повторно после reconcile');
    g.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('R-3: orderLimit — отказ resource_limit, резерв не дублируется, restart без double-pay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-r3-'));
  try {
    const cfg = makeConfig(root, { orderLimit: 12 });
    const g = new ApiGatewayPilot(cfg);
    let last = null;
    for (let i = 0; i < 12; i++) { const qq = g.quote({ ...request, maxCostMinor: 1, currency: 'USD' }); last = g.order(qq.quoteId); }
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(cfg.file, 'utf8')).orders).length, 12);
    const qq = g.quote({ ...request, maxCostMinor: 1, currency: 'USD' });
    assert.throws(() => g.order(qq.quoteId), /resource_limit/, 'новый заказ за cap отклонён');
    assert.equal(JSON.parse(fs.readFileSync(cfg.file, 'utf8')).allocatedMinor, 12, 'резерв ровно 12');
    // повтор по существующему quoteId (R-4) всё ещё разрешён после cap:
    assert.doesNotThrow(() => { g.order(last.quote.quoteId); }, 'существующий order не блокируется cap-ом');
    assert.equal(JSON.parse(fs.readFileSync(cfg.file, 'utf8')).allocatedMinor, 12, 'повтор не добавил резерв');
    g.close();
    const g2 = new ApiGatewayPilot(cfg);
    assert.throws(() => { const xxx = g2.quote({ ...request, maxCostMinor: 1, currency: 'USD' }); g2.order(xxx.quoteId); }, /resource_limit/);
    g2.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
