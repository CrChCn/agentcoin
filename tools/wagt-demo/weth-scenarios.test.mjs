// Два сценария пула wAGT/WETH для партнёра: node tools/wagt-demo/weth-scenarios.test.mjs (exit 0).
// Стартовая цена — параметр (здесь 0,0005 WETH за wAGT как допущение; стороны выбирают сами).
// AGT обеспечивает wAGT 1:1 — столько же AGT блокируется в резерве моста.
import assert from 'node:assert/strict';
import {
  parsePrice, v2out, fmtDivRounded,
  requiredReserves, wethForWagt, nominalWeth, deviationBpsRounded,
  formatWagt, formatWeth,
} from './liquidity.js';

const W = 10n ** 18n;
const T = 2n * W; // контрольная сделка: продажа 2 wAGT
const PRICE = parsePrice('0.0005'); // допущение для расчёта

function scenario(label, xWagt, agtNeeded) {
  const Rw = xWagt * W;
  const Ru = wethForWagt(Rw, PRICE);
  const nominal = nominalWeth(T, PRICE); // 0,001 WETH
  const sell = v2out(T, Rw, Ru);
  const dev = fmtDivRounded(deviationBpsRounded(sell.out, nominal), 100n, 2);
  const after = fmtDivRounded((Ru - sell.out) * W, (Rw + T) * W, 6);
  // Покупка отдельно: тратим 0,001 WETH.
  const buy = v2out(nominal, Ru, Rw);
  console.log(`  ${label}: ${formatWagt(Rw)} wAGT + ${formatWeth(Ru)} WETH (AGT в мост: ${agtNeeded})`);
  console.log(`    продажа 2 wAGT -> ${formatWeth(sell.out)} WETH (откл. ${dev}%, цена после ${after})`);
  console.log(`    покупка за 0,001 WETH -> ${formatWagt(buy.out)} wAGT`);
  return { Rw, Ru, nominal, sell, dev, after, buy };
}

// A «Пилот»: 40 wAGT + 0,02 WETH — тот же масштаб, что тестовый пул 40/400.
const a = scenario('A · Пилот', 40n, '40 AGT');
assert.equal(a.Ru, 20000000000000000n, 'A: партнёр вносит 0,02 WETH');
assert.equal(a.nominal, 1000000000000000n, 'A: номинал 0,001 WETH');
assert.equal(formatWeth(a.sell.out).slice(0, 8), '0.000949', 'A: продажа, 6 знаков');
assert.equal(a.dev, '5.03', 'A: отклонение 5,03%');

// B «Рабочий»: глубина под допуск 1% для сделки 2 — те же 283 wAGT, что для USDC.
const b = scenario('B · Рабочий', 283n, '283 AGT');
assert.equal(b.Ru, 141500000000000000n, 'B: партнёр вносит 0,1415 WETH');
assert.equal(formatWeth(b.sell.out).slice(0, 8), '0.000990', 'B: продажа, 6 знаков');
assert.equal(b.dev, '1.00', 'B: отклонение 1,00%');
assert.equal(requiredReserves(T, 100).wholeWagtWei, 283n * W, 'B: минимум тот же — 283 wAGT (формула не зависит от цены и знаков)');

// Зеркальность: покупка (в wAGT-wei) = продажа (в WETH-wei) × 2000 с точностью
// до округления вниз (floor(2000·x) и 2000·floor(x) различаются меньше чем на 2000).
for (const [tag, s] of [['A', a], ['B', b]]) {
  assert.ok(s.buy.out >= s.sell.out * 2000n, `${tag}: покупка не ниже зеркала`);
  assert.ok(s.buy.out < s.sell.out * 2000n + 2000n, `${tag}: покупка зеркальна продаже`);
}

console.log('weth-scenarios.test.mjs: OK — A: 40 AGT + 0,02 WETH; B: 283 AGT + 0,1415 WETH.');
