// Проверки демо: node tools/wagt-demo/quote.test.mjs (exit 0 = всё сошлось).
import assert from 'node:assert/strict';
import { parseAmount, getAmountOut, quote, applyTrade, initialState, formatWei, ONE } from './math.js';

// Независимая реализация формулы V2 (второй парой глаз, целые числа).
function v2out(amountIn, reserveIn, reserveOut) {
  return (amountIn * 997n * reserveOut) / (reserveIn * 1000n + amountIn * 997n);
}

// 1. Контрольный сценарий PR #16: продажа 2 wAGT из резервов 40/400.
{
  const out = getAmountOut(2n * ONE, 40n * ONE, 400n * ONE);
  assert.equal(out.out, 18993189503262370814n, 'продажа 2 wAGT');
  assert.equal(formatWei(out.out), '18.993189503262370814');
  assert.equal(out.out, v2out(2n * ONE, 40n * ONE, 400n * ONE), 'совпадает с независимым расчётом');
}

// 2. Покупка в обратную сторону по обновлённым резервам.
{
  const rW = 42n * ONE;
  const rT = 400n * ONE - 18993189503262370814n;
  assert.equal(rT, 381006810496737629186n, 'резерв tAGT после продажи');
  const back = getAmountOut(9496594751631185407n, rT, rW);
  assert.equal(back.out, v2out(9496594751631185407n, rT, rW), 'покупка совпадает с независимым расчётом');
  assert.ok(back.out > 0n && back.out < 2n * ONE, 'разумный выход покупки');
  console.log('  покупка 9.496594751631185407 tAGT -> ' + formatWei(back.out) + ' wAGT');
}

// 3. Отказы не меняют состояние и историю.
{
  const s0 = initialState();
  const snap = JSON.stringify(s0, (k, v) => typeof v === 'bigint' ? v.toString() : v);
  for (const bad of ['0', '0.0', '-1', '-0.5', 'abc', '', '1.1234567890123456789', '1e3', '1,5', '2 wAGT']) {
    assert.throws(() => parseAmount(bad), Error, JSON.stringify(bad));
  }
  assert.throws(() => quote(s0, 'sell', 6n * ONE), /баланса/, 'нехватка wAGT');
  assert.throws(() => quote(s0, 'buy', 101n * ONE), /баланса/, 'нехватка tAGT');
  assert.equal(JSON.stringify(s0, (k, v) => typeof v === 'bigint' ? v.toString() : v), snap, 'состояние нетронуто');
  assert.equal(s0.history.length, 0, 'история пуста');
}

// 4. Сделка сохраняет средства: пул + пользователь в сумме неизменны (по каждому токену).
{
  let s = initialState();
  const { next } = applyTrade(s, 'sell', 2n * ONE);
  assert.equal(next.reserveWAGT + next.userWAGT, s.reserveWAGT + s.userWAGT, 'wAGT сохраняется');
  assert.equal(next.reserveTAGT + next.userTAGT, s.reserveTAGT + s.userTAGT, 'tAGT сохраняется');
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].mode, 'sim');
  // k не уменьшается (комиссия остаётся в пуле)
  assert.ok(next.reserveWAGT * next.reserveTAGT >= s.reserveWAGT * s.reserveTAGT, 'x*y=k растёт');
}

// 5. Сброс возвращает исходное состояние.
{
  let s = initialState();
  s = applyTrade(s, 'sell', 2n * ONE).next;
  s = applyTrade(s, 'buy', ONE).next;
  assert.equal(s.history.length, 2);
  s = initialState();
  assert.equal(s.reserveWAGT, 40n * ONE);
  assert.equal(s.reserveTAGT, 400n * ONE);
  assert.equal(s.userWAGT, 5n * ONE);
  assert.equal(s.userTAGT, 100n * ONE);
  assert.equal(s.history.length, 0);
}

console.log('quote.test.mjs: OK — продажа 2 wAGT = 18.993189503262370814 tAGT, отказы и сброс в норме.');
