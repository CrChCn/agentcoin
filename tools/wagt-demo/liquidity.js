// Калькулятор ликвидности wAGT/USDC. Чистая математика (BigInt, целые числа),
// без DOM — используется и страницей, и node-тестом.
//
// Соглашения (сверены с таблицей задания):
// - формула Uniswap V2: out = in*997*reserveOut / (reserveIn*1000 + in*997);
// - отклонение считается от номинала (сделка × стартовая цена), комиссия пула
//   0,3% входит в отклонение; комиссия сети (gas) НЕ считается вообще.
// - wAGT — 18 знаков, USDC — 6 знаков (как в основной сети).
import { parseAmount as parse18, formatWei } from './math.js';

export const WAGT_DEC = 18;
export const USDC_DEC = 6;
const FEE_NUM = 997n;
const FEE_DEN = 1000n;
const W = 10n ** 18n; // 1 wAGT в wei
const U = 10n ** 6n; // 1 USDC в минимальных единицах

export function parseWagt(str) {
  return parse18(str); // wAGT: 18 знаков, те же строгие правила
}

export function parseUsdc(str) {
  if (typeof str !== 'string') throw new Error('Сумма вводится текстом.');
  const t = str.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(t)) throw new Error('Сумма USDC: число с не более чем 6 знаками после запятой.');
  const [i, f = ''] = t.split('.');
  const wei = BigInt(i) * U + BigInt((f + '000000').slice(0, 6));
  if (wei <= 0n) throw new Error('Сумма должна быть больше нуля.');
  return wei;
}

// Стартовая цена USDC за wAGT: рациональное число num/den (>0), до 18 знаков.
export function parsePrice(str) {
  if (typeof str !== 'string') throw new Error('Цена вводится текстом.');
  const t = str.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,18})?$/.test(t)) throw new Error('Цена: положительное число, до 18 знаков после запятой.');
  const [i, f = ''] = t.split('.');
  const d = 10n ** BigInt(Math.max(f.length, 1));
  const num = BigInt(i) * d + BigInt((f + '0').slice(0, Math.max(f.length, 1)) || '0');
  if (num <= 0n) throw new Error('Цена должна быть больше нуля.');
  const g = gcd(num, d);
  return { num: num / g, den: d / g };
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Выход Uniswap V2 + комиссия пула во входном токене. Бросает на пустых
// резервах и нулевом выходе; состояние пула не трогает (чистая функция).
export function v2out(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n) throw new Error('Сумма должна быть больше нуля.');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('Резервы пула должны быть больше нуля.');
  const out = (amountIn * FEE_NUM * reserveOut) / (reserveIn * FEE_DEN + amountIn * FEE_NUM);
  if (out <= 0n) throw new Error('Слишком маленькая сумма: выход равен нулю.');
  return { out, fee: amountIn - (amountIn * FEE_NUM) / FEE_DEN };
}

// Десятичная строка num/den с dp знаками, без Number.
// fmtDiv — вниз (для гарантий), fmtDivRounded — до ближайшего (для показа).
export function fmtDiv(num, den, dp) {
  return fmtDivCore(num, den, dp, false);
}

export function fmtDivRounded(num, den, dp) {
  return fmtDivCore(num, den, dp, true);
}

function fmtDivCore(num, den, dp, round) {
  if (den <= 0n) throw new Error('Внутренняя ошибка цены.');
  const neg = num < 0n;
  const a = neg ? -num : num;
  const p = 10n ** BigInt(dp);
  const scaled = (a * p + (round ? den / 2n : 0n)) / den;
  const s = scaled.toString().padStart(dp + 1, '0');
  const head = s.slice(0, -dp) || '0';
  return (neg ? '-' : '') + head + '.' + s.slice(-dp);
}

// Минимальные симметричные резервы X wAGT + X*price USDC, при которых продажа
// tWagtWei даёт не меньше (10000-tolBps)/10000 от номинала (t × цена).
// tolBps — целое, строго больше 30 (комиссия пула 0,3% съедает допуск первой).
// Возвращает точный минимум в wei и округлённый вверх до целых wAGT.
export function requiredReserves(tWagtWei, tolBps) {
  if (tWagtWei <= 0n) throw new Error('Сумма должна быть больше нуля.');
  if (!Number.isInteger(tolBps) || tolBps <= 30 || tolBps >= 10000) {
    throw new Error('Допуск: целое число базисных пунктов от 31 до 9999 (комиссия пула 0,3% входит в допуск, комиссия сети — нет).');
  }
  // X >= t*997*(10000-tol) / (1000*(tol-30)) — точное решение неравенства
  // out(X) >= номинал*(1-tol) для симметричного пула (вывод — в комментарии
  // теста; здесь только целая арифметика с округлением вверх).
  const num = tWagtWei * FEE_NUM * BigInt(10000 - tolBps);
  const den = 1000n * BigInt(tolBps - 30);
  const exact = (num + den - 1n) / den;
  const whole = ((exact + W - 1n) / W) * W;
  return { exactWei: exact, wholeWagtWei: whole };
}

// WETH — 18 знаков, как wAGT: те же parse/format, что для wAGT.
export function parseWeth(str) {
  return parseWagt(str);
}

export function formatWeth(wei) {
  return formatWagt(wei);
}

// Резервы второго токена (минимальные единицы, округление вверх —
// консервативно) под целые X wAGT-wei при цене price {num, den} и outDec
// знаков второго токена (6 = USDC, 18 = WETH).
export function usdcForWagt(xWagtWei, price) {
  return pairedReserves(xWagtWei, price, 6);
}

export function wethForWagt(xWagtWei, price) {
  return pairedReserves(xWagtWei, price, 18);
}

function pairedReserves(xWagtWei, price, outDec) {
  const D = 10n ** BigInt(outDec);
  return (xWagtWei * price.num * D + price.den * W - 1n) / (price.den * W);
}

// Номинал сделки во втором токене: tWagtWei × цена (округление вниз).
// outDec: 6 = USDC, 18 = WETH.
export function nominalUsdc(tWagtWei, price) {
  return nominalOut(tWagtWei, price, 6);
}

export function nominalWeth(tWagtWei, price) {
  return nominalOut(tWagtWei, price, 18);
}

function nominalOut(tWagtWei, price, outDec) {
  const D = 10n ** BigInt(outDec);
  return (tWagtWei * price.num * D) / (price.den * W);
}

// Отклонение в базисных пунктах от номинала: (nominal-out)*10000/nominal.
// deviationBps — вниз (для проверки допусков), deviationBpsRounded —
// до ближайшего (для показа, совпадает с округлениями таблицы задания).
export function deviationBps(out, nominal) {
  if (nominal <= 0n) throw new Error('Внутренняя ошибка номинала.');
  if (out >= nominal) return 0n;
  return ((nominal - out) * 10000n) / nominal;
}

export function deviationBpsRounded(out, nominal) {
  if (nominal <= 0n) throw new Error('Внутренняя ошибка номинала.');
  if (out >= nominal) return 0n;
  return ((nominal - out) * 10000n + nominal / 2n) / nominal;
}

export function formatWagt(wei) {
  return formatWei(wei);
}

export function formatUsdc(wei) {
  const i = wei / U;
  const f = (wei % U).toString().padStart(6, '0');
  return i.toString() + '.' + f;
}
