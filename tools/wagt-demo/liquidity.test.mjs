// Проверки калькулятора ликвидности: node tools/wagt-demo/liquidity.test.mjs (exit 0).
import assert from 'node:assert/strict';
import {
  parseWagt, parseUsdc, parsePrice, v2out, fmtDiv,
  requiredReserves, usdcForWagt, nominalUsdc, deviationBps, deviationBpsRounded,
  formatWagt, formatUsdc, fmtDivRounded,
} from './liquidity.js';

const W = 10n ** 18n;
const U = 10n ** 6n;
const T = 2n * W; // сделка из таблицы задания: продажа 2 wAGT
const PRICE1 = parsePrice('1');

// Независимая реализация формулы V2 (второй парой глаз).
function v2ref(amountIn, rIn, rOut) {
  return (amountIn * 997n * rOut) / (rIn * 1000n + amountIn * 997n);
}

// 1. Три сценария задания: продажа 2 wAGT, цена 1 USDC.
const table = [
  { r: 20n, out4: '1.8132', dev: '9.34', price4: '0.8267' },
  { r: 100n, out4: '1.9550', dev: '2.25', price4: '0.9612' },
  { r: 200n, out4: '1.9743', dev: '1.28', price4: '0.9803' },
];
for (const { r, out4, dev, price4 } of table) {
  const Rw = r * W, Ru = r * U;
  const { out, fee } = v2out(T, Rw, Ru);
  assert.equal(out, v2ref(T, Rw, Ru), `сценарий ${r}: совпадает с независимым расчётом`);
  assert.equal(formatUsdc(out).slice(0, 6), out4, `сценарий ${r}: получит USDC`);
  const devBps = deviationBps(out, nominalUsdc(T, PRICE1));
  assert.equal(fmtDiv(deviationBpsRounded(out, nominalUsdc(T, PRICE1)), 100n, 2), dev, `сценарий ${r}: отклонение %`);
  const priceAfterHuman = fmtDivRounded((Ru - out) * W, (Rw + T) * U, 4);
  assert.equal(priceAfterHuman, price4, `сценарий ${r}: цена после`);
  assert.equal(fee, T - (T * 997n) / 1000n, `сценарий ${r}: комиссия пула 0,3%`);
  console.log(`  пул ${r}/${r}: продажа 2 wAGT -> ${formatUsdc(out)} USDC, откл. ${fmtDiv(deviationBpsRounded(out, nominalUsdc(T, PRICE1)), 100n, 2)}%, цена после ${priceAfterHuman}`);
}

// 2. Покупка отдельно: потратить 2 USDC на покупку wAGT из пула 20/20.
// Симметричный пул: зеркальная сделка даёт зеркальный выход.
{
  const Rw = 20n * W, Ru = 20n * U;
  const sell = v2out(T, Rw, Ru);
  const buy = v2out(2n * U, Ru, Rw); // тратим столько USDC, сколько wAGT продавали
  // Зеркальность симметричного пула: та же цифра 1,8132 (целое деление может
  // различаться в последних единицах, первые 4 знака совпадают).
  assert.equal(formatWagt(buy.out).slice(0, 6), '1.8132', 'покупка: получит wAGT');
  assert.ok(sell.out > buy.out * U / W - U && sell.out < buy.out * U / W + U, 'покупка и продажа — зеркальны');
  console.log(`  пул 20/20: покупка за 2 USDC -> ${formatWagt(buy.out)} wAGT, комиссия пула ${formatUsdc(buy.fee)} USDC`);
}

// 3. Требуемые резервы под допуск 1% при сделке 2 и цене 1.
// Находка: точный целочисленный расчёт даёт 283/283, а не 282/282 —
// при 282/282 отклонение 1,00002%: мимо допуска на 0,00002 п.п. из-за
// округления вниз в самом пуле («примерно 282» из задания — верно лишь
// приблизительно, на бумаге без учёта floor). Строгие сравнения — целыми.
{
  const { exactWei, wholeWagtWei } = requiredReserves(T, 100);
  assert.equal(wholeWagtWei, 283n * W, 'целые резервы 283 wAGT');
  assert.ok(exactWei > 282n * W && exactWei <= 283n * W, 'точный минимум между 282 и 283');
  const price = PRICE1;
  const nominal = nominalUsdc(T, price);
  const Ru = usdcForWagt(wholeWagtWei, price);
  assert.equal(Ru, 283n * U, 'парные резервы 283 USDC');
  const { out } = v2out(T, wholeWagtWei, Ru);
  assert.ok(out * 10000n >= nominal * 9900n, '283/283: в допуске 1% строгим сравнением');
  const out282 = v2out(T, 282n * W, usdcForWagt(282n * W, price)).out;
  assert.ok(out282 * 10000n < nominal * 9900n, '282/282: строгим сравнением вне допуска');
  console.log(`  допуск 1%: внести 283 wAGT + 283 USDC -> ${formatUsdc(out)} USDC (откл. ${fmtDiv(deviationBpsRounded(out, nominal), 100n, 2)}%); 282/282 даёт ${formatUsdc(out282)} — мимо на 0,00002 п.п.`);
}

// 4. Допуск уже/уже комиссии пула недостижим даже бесконечной глубиной.
for (const bad of [30, 29, 0, -5, 10000]) {
  assert.throws(() => requiredReserves(T, bad), Error, `допуск ${bad} б.п.`);
}

// 5. Отказы входов не роняют модуль и не дают нулей.
for (const bad of ['0', '-1', 'abc', '', '1.1234567', '1e3']) {
  assert.throws(() => parseUsdc(bad), Error, JSON.stringify(bad));
}
assert.throws(() => parsePrice('0'), Error, 'нулевая цена');
assert.throws(() => parsePrice('-2'), Error, 'отрицательная цена');
assert.throws(() => v2out(0n, 1n, 1n), Error, 'нулевой вход');
assert.throws(() => v2out(1n, 0n, 1n), Error, 'пустой резерв');

console.log('liquidity.test.mjs: OK — 3 сценария, покупка/продажа, резервы 283/283, отказы.');
