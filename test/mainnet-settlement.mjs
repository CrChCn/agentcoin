#!/usr/bin/env node
/* Изолированный тест адаптера нативных расчётов (без mainnet, без секретов).
 * Проверяет: chainId/genesis-gate, атомарные суммы, превью, политику,
 * orderId→obligation→signed→txid идемпотентность, подтверждения и реорг,
 * разделение приёмки/оплаты, запрет второго платежа, отказ эскроу-термина.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAINNET_CHAIN_ID, MAINNET_GENESIS_HASH, CONFIRM_DEPTH_DEFAULT,
  assertMainnetChainId, assertMainnetGenesis, toAtomic, fromAtomic,
  previewTransfer, buildTransferTx, signTransfer,
  openSettlementStore, checkSpendPolicy, findTxInChain, checkConfirmation,
} from '../sdk/js/mainnet-settlement.mjs';
import { createWallet, signTransaction, txDigest, addressFromPub } from '../core.mjs';

test('chainId и genesis: чужая сеть отвергается', () => {
  assert.throws(() => assertMainnetChainId('TESTNET'), /wrong_network/);
  assert.throws(() => assertMainnetGenesis('deadbeef'), /wrong_genesis/);
  assert.doesNotThrow(() => assertMainnetChainId(MAINNET_CHAIN_ID));
  assert.doesNotThrow(() => assertMainnetGenesis(MAINNET_GENESIS_HASH));
});

test('суммы: только целые атомарные единицы', () => {
  assert.equal(String(toAtomic(1)), '1000000000');
  assert.equal(String(toAtomic('2.5')), '2500000000');
  assert.equal(fromAtomic(2500000000n), '2.5');
  assert.throws(() => toAtomic(0), /bad_amount/);
  assert.throws(() => toAtomic(-1), /bad_amount/);
  // float-артефакт с >9 знаками отвергается
  assert.throws(() => toAtomic(0.0000000001), /bad_amount|not/);
});

test('превью показывает заказ/получателя/сумму/комиссию, эскроу нет', () => {
  const w = createWallet('exec');
  const p = previewTransfer({ orderId: 'ord-1', payer: 'AGTpayer', recipient: w.address, amountAtomic: 500000000n });
  assert.equal(p.kind, 'direct-transfer');
  assert.equal(p.escrow, false);
  assert.equal(p.amountAtomic, '500000000');
  assert.equal(p.feeAtomic, '0');
  assert.equal(p.network, 'AGENTCOIN');
  assert.ok(!/эскроу/i.test(JSON.stringify(p)));
});

test('политика: автономно только внутри лимитов владельца', () => {
  const w = createWallet('exec2');
  const policy = { maxPerPaymentAtomic: 1000000000n, maxPerDayAtomic: 2000000000n, autonomous: true, allowedRecipients: [w.address], requireManualApproveAboveAtomic: 500000000n };
  assert.ok(checkSpendPolicy({ policy, amountAtomic: 100000000n, recipient: w.address }).ok);
  assert.equal(checkSpendPolicy({ policy, amountAtomic: 5000000000n, recipient: w.address }).ok, false);
  assert.equal(checkSpendPolicy({ policy, amountAtomic: 100000000n, recipient: 'AGT0000000000000000000000000000000000000000' }).ok, false);
  // выше порога — только с ручным подтверждением
  const r = checkSpendPolicy({ policy, amountAtomic: 800000000n, recipient: w.address });
  assert.equal(r.ok, false);
  assert.match(r.reason, /manual_approval_required/);
  assert.ok(checkSpendPolicy({ policy, amountAtomic: 800000000n, recipient: w.address, manualApprove: true }).ok);
  // без политики — отказ, не тихий пропуск
  assert.equal(checkSpendPolicy({ policy: null, amountAtomic: 1n, recipient: w.address }).ok, false);
});

test('обязательство только после приёмки; оплата отделена', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msett-'));
  const store = openSettlementStore(path.join(dir, 's.json'));
  const bad = store.createObligation({ orderId: 'o1', payer: 'A', recipient: 'B', amountAtomic: 10n, acceptedProof: { state: 'open' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no_obligation/);
  const w = createWallet('exec3');
  const good = store.createObligation({ orderId: 'o1', payer: 'A', recipient: w.address, amountAtomic: 10n, acceptedProof: { state: 'accepted', recipient: w.address } });
  assert.equal(good.state, 'obligation');
  assert.equal(good.signedTx, null);
  assert.equal(good.txid, null);
});

test('подпись локальна; повтор шлёт те же байты, второй платёж запрещён', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msett-'));
  const store = openSettlementStore(path.join(dir, 's.json'));
  const payer = createWallet('payer');
  const exec = createWallet('exec');
  store.createObligation({ orderId: 'o2', payer: payer.address, recipient: exec.address, amountAtomic: 1000000000n, acceptedProof: { state: 'accepted', recipient: exec.address } });
  const tx = buildTransferTx({ from: payer.address, fromPub: payer.pub, to: exec.address, amountAtomic: 1000000000n, nonce: 777 });
  // сайт/сервер ключ не получает: signTransfer вызывается только локально
  assert.ok(!('privKey' in tx));
  const signed = signTransfer(tx, payer.privKey);
  assert.equal(signed.signature.length > 10, true);
  const a1 = store.attachSignedTx('o2', signed);
  assert.equal(a1.state, 'sent');
  assert.ok(a1.txid);
  const a2 = store.attachSignedTx('o2', signed);
  assert.equal(a2.replay, true);
  assert.equal(a2.txid, a1.txid);
  const other = signTransfer({ ...tx, nonce: 778, txid: undefined }, payer.privKey);
  const refused = store.attachSignedTx('o2', { ...other, txid: txDigest(other) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /second_payment_refused/);
});

test('подтверждение: глубина + реорг; нехватка — честный отказ', () => {
  const payer = createWallet('p');
  const exec = createWallet('e');
  const tx = { from: payer.address, to: exec.address, amount: 1, nonce: 1, txid: 'txid-abc' };
  const mk = (hash, prevHash) => ({ height: 0, hash, header: { prevHash }, txs: [] });
  const chain = [
    { ...mk('h0', '0'.repeat(64)), height: 0, txs: [] },
    { ...mk('h1', 'h0'), height: 1, txs: [tx] },
    { ...mk('h2', 'h1'), height: 2, txs: [] },
  ];
  const f = findTxInChain(chain, 'txid-abc');
  assert.equal(f.height, 1);
  const shallow = checkConfirmation(chain, { txid: 'txid-abc', expectTo: exec.address, expectAmountAtomic: 1000000000n, depth: 6 });
  assert.equal(shallow.state, 'sent');
  assert.equal(shallow.confirmations, 2);
  const deep = checkConfirmation(chain, { txid: 'txid-abc', expectTo: exec.address, expectAmountAtomic: 1000000000n, depth: 2 });
  assert.equal(deep.state, 'confirmed');
  const wrongAmt = checkConfirmation(chain, { txid: 'txid-abc', expectTo: exec.address, expectAmountAtomic: 2n, depth: 1 });
  assert.equal(wrongAmt.state, 'amount_mismatch');
  const wrongTo = checkConfirmation(chain, { txid: 'txid-abc', expectTo: payer.address, expectAmountAtomic: 1000000000n, depth: 1 });
  assert.equal(wrongTo.state, 'recipient_mismatch');
  const reorged = [
    { ...mk('h0', '0'.repeat(64)), height: 0, txs: [] },
    { ...mk('h1b', 'h0'), height: 1, txs: [] },
    { ...mk('h2b', 'h1b'), height: 2, txs: [] },
  ];
  // tx выпал из канонической цепи → pending/сверка, не «оплачено»
  const r = checkConfirmation(reorged, { txid: 'txid-abc', expectTo: exec.address, expectAmountAtomic: 1000000000n, depth: 1 });
  assert.equal(r.state, 'pending');
  assert.equal(CONFIRM_DEPTH_DEFAULT, 6);
});
