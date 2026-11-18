#!/usr/bin/env node
/* Строгие деньги: atomic строками BigInt, без Number*1e9.
 * Случаи: 1 атомарная единица, ноль/отрицательные (отказ), лишние десятичные
 * знаки (отказ без округления), экспоненциальная запись (отказ), большие суммы
 * (граница MAX_SAFE_INTEGER), точное преобразование туда и обратно.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAtomicStrict, formatAtomic, amountToProtocol } from '../sdk/js/money.mjs';

test('1 атомарная единица: минимум принимается', () => {
  assert.equal(String(parseAtomicStrict('0.000000001')), '1');
  assert.equal(String(parseAtomicStrict('1')), '1000000000');
  assert.equal(formatAtomic(1n), '0.000000001');
});

test('ноль и отрицательные: отказ по правилам операции', () => {
  assert.throws(() => parseAtomicStrict('0'), /positive/);
  assert.throws(() => parseAtomicStrict('0.0'), /positive/);
  assert.throws(() => parseAtomicStrict('-1'), /plain decimal|positive/);
  assert.throws(() => parseAtomicStrict('-0.000000001'), /plain decimal|positive/);
  assert.throws(() => parseAtomicStrict(0), /positive/);
  assert.throws(() => parseAtomicStrict(-5), /positive/);
});

test('лишние десятичные знаки: отказ без округления', () => {
  assert.throws(() => parseAtomicStrict('1.0000000001'), /больше 9 знаков|exceeds/);
  assert.throws(() => parseAtomicStrict('0.0000000001'), /больше 9 знаков|exceeds/);
  assert.throws(() => parseAtomicStrict(''), /пустая|bad/);
});

test('экспоненциальная запись: отказ', () => {
  assert.throws(() => parseAtomicStrict('1e3'), /exponent|экспонент/);
  assert.throws(() => parseAtomicStrict('1E9'), /exponent|экспонент/);
  assert.throws(() => parseAtomicStrict('1.5e-7'), /exponent|экспонент/);
});

test('большие суммы: граница безопасного диапазона tx', () => {
  // Вход — AGT decimal; предел — MAX_SAFE_INTEGER атомарных единиц.
  // 9007199.254740991 AGT = 9007199254740991 atomic (ровно предел).
  assert.equal(String(parseAtomicStrict('9007199.254740991')), String(BigInt(Number.MAX_SAFE_INTEGER)));
  assert.throws(() => parseAtomicStrict('9007199.254740992'), /безопасный диапазон|exceeds/);
  assert.throws(() => parseAtomicStrict('9007199.2547409911'), /больше 9 знаков|exceeds/);
  assert.throws(() => parseAtomicStrict('10000000'), /безопасный диапазон|exceeds/);
});

test('точное преобразование туда и обратно', () => {
  for (const s of ['1.5', '0.000000001', '2.5', '100', '0.123456789']) {
    const u = parseAtomicStrict(s);
    assert.equal(formatAtomic(u), s); // все входы уже в канонической форме
    assert.equal(String(u), String(parseAtomicStrict(formatAtomic(u))));
  }
  // protocol-форма — number, консенсус-совместимый
  const n = amountToProtocol(1500000000n);
  assert.equal(typeof n, 'number');
  assert.equal(n, 1.5);
  assert.throws(() => amountToProtocol(0n), /positive|representable/);
});
