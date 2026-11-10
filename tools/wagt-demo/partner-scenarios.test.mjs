// AGT-DEX-PARTNER: оба сценария пула wAGT/WETH в обе стороны + минимальный
// пул под допуск 1% в обе стороны. Запуск: node tools/wagt-demo/partner-scenarios.test.mjs (exit 0).
//
// Условия: стартовая цена 0,0005 WETH за wAGT — допущение (стороны выбирают
// сами); сделка 2 wAGT; допуск 1% = 100 б.п. в КАЖДОМ направлении отдельно.
// Продажа: v2out(2 wAGT) — округление вниз, как в паре. Покупка ровно 2 wAGT:
// v2in — целочисленное деление вниз + 1, как getAmountIn роутера. Газ сети
// в расчёт НЕ входит и показывается отдельно (карточка партнёру, план).
import assert from 'node:assert/strict';
import {
  v2out, v2in, nominalWeth, parsePrice, formatWeth, fmtDivRounded,
  deviationBps, deviationBpsUp, deviationBpsRounded, deviationBpsUpRounded,
} from './liquidity.js';

const PRICE = parsePrice('0.0005'); // допущение, зафиксировано здесь
const T = 2n * 10n ** 18n; // сделка 2 wAGT
const NOM = nominalWeth(T, PRICE); // ровно 0,001 WETH = 1000000000000000 wei
assert.equal(NOM, 1000000000000000n, 'номинал сделки 2 wAGT — ровно 0,001 WETH');

const TOL = 100n; // 1% в б.п.

// Глубина D = целые wAGT; WETH = 0,0005 × D ровно (xW/2000 без остатка).
function scenario(D) {
  const xW = BigInt(D) * 10n ** 18n;
  const xE = xW / 2000n;
  const sell = v2out(T, xW, xE);
  const buy = v2in(T, xE, xW);
  return {
    D, xW, xE,
    sellOut: sell.out,
    sellAvg: sell.out / 2n, // средняя цена продажи за 1 wAGT, wei (вниз)
    sellDev: deviationBps(sell.out, NOM), // вниз — для проверки допуска
    sellDevShow: deviationBpsRounded(sell.out, NOM),
    buyIn: buy,
    buyAvg: buy / 2n, // средняя цена покупки за 1 wAGT, wei (вниз)
    buyDev: deviationBpsUp(buy, NOM), // вверх — для проверки допуска
    buyDevShow: deviationBpsUpRounded(buy, NOM),
  };
}

function line(tag, s) {
  console.log(`  ${tag} · ${s.D} wAGT + ${formatWeth(s.xE)} WETH`);
  console.log(`    продажа 2 wAGT -> ${formatWeth(s.sellOut)} WETH (средняя ${formatWeth(s.sellAvg)}, откл. ${s.sellDevShow / 100n},${(s.sellDevShow % 100n).toString().padStart(2, '0')}% — ${s.sellDev <= TOL ? 'ПРОХОДИТ' : 'не проходит'})`);
  console.log(`    покупка 2 wAGT -> ${formatWeth(s.buyIn)} WETH (средняя ${formatWeth(s.buyAvg)}, откл. ${s.buyDevShow / 100n},${(s.buyDevShow % 100n).toString().padStart(2, '0')}% — ${s.buyDev <= TOL ? 'ПРОХОДИТ' : 'не проходит'})`);
}

// --- Сценарий A · Пилот: 40 AGT в мост, 40 wAGT + 0,02 WETH в пул ---
const a = scenario(40);
line('A · Пилот', a);
assert.equal(a.sellOut, 949659475163118n, 'A: продажа — точный выход');
assert.equal(a.sellDev, 503n, 'A: продажа 5,03% — мимо допуска');
assert.equal(a.buyIn, 1055798975874994n, 'A: покупка — точный вход');
assert.equal(a.buyDev, 558n, 'A: покупка 5,58% — мимо допуска');

// --- Сценарий B · Рабочий: 283 AGT в мост, 283 wAGT + 0,1415 WETH в пул ---
const b = scenario(283);
line('B · Рабочий', b);
assert.equal(b.sellOut, 990024351389853n, 'B: продажа — точный выход');
assert.equal(b.sellDev, 99n, 'B: продажа 0,99% — проходит');
assert.equal(b.buyIn, 1010147881366520n, 'B: покупка — точный вход');
assert.ok(b.buyDev > TOL, 'B: покупка 1,02% — НЕ проходит (асимметрия +1 wei)');

// --- Ни один сценарий не проходит в обе стороны: минимальный пул ---
let min = null;
for (let D = 284; D < 2000; D++) {
  const s = scenario(D);
  if (s.sellDev <= TOL && s.buyDev <= TOL) { min = s; break; }
}
assert.ok(min, 'найден пул, проходящий в обе стороны');
const prev = scenario(min.D - 1);
assert.ok(prev.sellDev > TOL || prev.buyDev > TOL, 'D-1 не проходит: минимум точный');
line('C · Минимум', min);
assert.equal(min.D, 289, 'минимальная глубина — 289 wAGT');
assert.equal(min.sellOut, 990168182161831n, 'C: продажа — точный выход');
assert.equal(min.buyIn, 1009998637026061n, 'C: покупка — точный вход');
assert.ok(min.sellDev <= TOL && min.buyDev <= TOL, 'C проходит в обе стороны');

// Средняя цена — десятичной строкой без Number (показ для карточки).
assert.equal(fmtDivRounded(a.sellOut, T, 18), '0.000474829737581559', 'A: средняя цена продажи');
assert.equal(fmtDivRounded(b.buyIn, T, 18), '0.000505073940683260', 'B: средняя цена покупки');

console.log('partner-scenarios.test.mjs: OK — A мимо в обе, B продажа 0,99% / покупка 1,02%, минимум в обе стороны 289 wAGT + 0,1445 WETH.');
