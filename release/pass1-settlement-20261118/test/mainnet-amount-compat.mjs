#!/usr/bin/env node
/* Совместимость строковой суммы с консенсусом (без правок core.mjs).
 * Проверяет: buildTransferTx → подпись → штатная валидация ноды
 * на изолированной цепи с теми же правилами.
 * Консенсус требует tx.amount typeof number (validateBlockAgainstChain и
 * Blockchain.addTransaction: не-number → 'tx_bad_fields'/'bad_fields').
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTransferTx, signTransfer } from '../sdk/js/mainnet-settlement.mjs';
import {
  createWallet, verifyTransaction, txDigest, unitsOfAmountBigInt, Blockchain,
} from '../core.mjs';

const AMOUNTS = [1n, 1500000000n, 2500000000n]; // 1 магент, 1.5 AGT, 2.5 AGT

test('сборка даёт number-сумму, точную в единицах протокола', () => {
  const payer = createWallet('compat-payer');
  const exec = createWallet('compat-exec');
  for (const atomic of AMOUNTS) {
    const tx = buildTransferTx({
      from: payer.address, fromPub: payer.pub, to: exec.address,
      amountAtomic: atomic, nonce: Number(atomic % 1000000n) + 1,
    });
    assert.equal(typeof tx.amount, 'number');
    assert.equal(unitsOfAmountBigInt(tx.amount), atomic);
  }
});

test('подпись штатно проверяется; смена типа ломает байты', () => {
  const payer = createWallet('compat-payer2');
  const exec = createWallet('compat-exec2');
  const tx = buildTransferTx({
    from: payer.address, fromPub: payer.pub, to: exec.address,
    amountAtomic: 1500000000n, nonce: 4242,
  });
  const signed = signTransfer(tx, payer.privKey);
  assert.equal(verifyTransaction(signed), true);
  assert.equal(signed.txid, txDigest(signed));
  // Тот же платёж, но amount строкой: подпись под другими байтами не сходится,
  // нода такой tx отвергает штатным гейтом.
  const stringTwin = { ...signed, amount: '1.5', txid: undefined };
  delete stringTwin.txid;
  assert.equal(verifyTransaction({ ...stringTwin, txid: txDigest(stringTwin) }), false);
});

test('изолированная нода: number-tx проходит гейт типа, string-tx — нет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-chain-'));
  const node = new Blockchain(dir);
  const payer = createWallet('compat-payer3');
  const exec = createWallet('compat-exec3');
  const tx = buildTransferTx({
    from: payer.address, fromPub: payer.pub, to: exec.address,
    amountAtomic: 1000000000n, nonce: 777001,
  });
  const signed = signTransfer(tx, payer.privKey);
  // Строковый двойник отвергается именно гейтом типа (те же правила, что в проде).
  const stringTwin = { ...signed, amount: '1' };
  const rej = node.addTransaction(stringTwin);
  assert.equal(rej.ok, false);
  assert.match(rej.reason, /bad_fields/);
  // Наш tx гейт типа и точности проходит: отказ возможен только по средствам
  // (плательщик не профинансирован в изолированной цепи), но НЕ по форме/сумме.
  const res = node.addTransaction({ ...signed });
  if (res.ok === false) {
    assert.ok(!/bad_fields|tx_amount_not_mgnt_exact/.test(res.reason), `форма/сумма отвергнута: ${res.reason}`);
  }
});
