// Вкладка «Ликвидность»: калькулятор + проверка сценариев + карточка партнёру.
import {
  parseWagt, parseUsdc, parsePrice, v2out, fmtDivRounded,
  requiredReserves, usdcForWagt, nominalUsdc, deviationBpsRounded,
  formatWagt, formatUsdc,
} from './liquidity.js';

const $ = (id) => document.getElementById(id);
const W = 10n ** 18n;
const U = 10n ** 6n;

function err(msg) {
  const e = $('liq-error');
  e.textContent = msg || '';
  e.style.display = msg ? 'block' : 'none';
}

// Цена USDC за wAGT после сделки: (Ru-out)*W / ((Rw+in)*U), 6 знаков.
function priceAfter6(Rw, Ru, inW, outU) {
  return fmtDivRounded((Ru - outU) * W, (Rw + inW) * U, 6);
}

function calc() {
  $('liq-result').style.display = 'none';
  let price, tWei, tolPct;
  try {
    price = parsePrice($('liq-price').value);
    tWei = parseWagt($('liq-trade').value);
    const s = $('liq-tol').value.trim().replace(',', '.');
    // Допуск: проценты с шагом 0,01 (1 б.п. = 0,01%).
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Допуск: число процентов с не более чем 2 знаками (например, 1 или 0,5).');
    const bps = Math.round(parseFloat(s) * 100);
    if (!Number.isInteger(bps) || bps <= 30 || bps >= 10000) {
      throw new Error('Допуск — от 0,31% до 99,99%: комиссия пула 0,3% входит в допуск первой, комиссия сети не считается.');
    }
    tolPct = bps;
  } catch (e) {
    err(e.message);
    return;
  }
  let need;
  try {
    need = requiredReserves(tWei, tolPct);
  } catch (e) {
    err(e.message);
    return;
  }
  const X = need.wholeWagtWei;
  const Ru = usdcForWagt(X, price);
  const nominal = nominalUsdc(tWei, price);
  const { out, fee } = v2out(tWei, X, Ru);
  const dev = deviationBpsRounded(out, nominal);
  err('');
  const xHuman = formatWagt(X);
  const uHuman = formatUsdc(Ru);
  $('liq-result').innerHTML =
    '<span class="badge sim">локальная симуляция</span><span class="net">расчёт в браузере · комиссия сети не включена</span>' +
    '<div><b>Внести в пул: ' + xHuman + ' wAGT + ' + uHuman + ' USDC</b></div>' +
    '<div>Трейдер за сделку получит: <span class="amt">' + formatUsdc(out) + ' USDC</span></div>' +
    '<div>Номинал (сделка × цена): <span class="amt">' + formatUsdc(nominal) + ' USDC</span>; ' +
    'отклонение: ' + fmtDivRounded(dev, 100n, 2) + '% (допуск ' + fmtDivRounded(BigInt(tolPct), 100n, 2) + '%)</div>' +
    '<div>Комиссия пула (0,3%): <span class="amt">' + formatWagt(fee) + ' wAGT</span></div>' +
    '<div>Цена в пуле после сделки: <span class="amt">' + priceAfter6(X, Ru, tWei, out) + ' USDC за wAGT</span></div>' +
    '<div class="k">Комиссия сети (gas) в расчёт не включена — считается отдельно. Точный минимум: ' +
    formatWagt(need.exactWei) + ' wAGT, округлено вверх до целых.</div>';
  $('liq-result').style.display = 'block';
}

// Проверка трёх сценариев из задания: продажа и покупка отдельно.
function scenarios() {
  const defs = [
    { r: 20n, label: '20 wAGT + 20 USDC' },
    { r: 100n, label: '100 wAGT + 100 USDC' },
    { r: 200n, label: '200 wAGT + 200 USDC' },
  ];
  const price = parsePrice('1');
  $('liq-scen').innerHTML = defs.map(({ r, label }) => {
    const Rw = r * W, Ru = r * U;
    const T = 2n * W;
    const sell = v2out(T, Rw, Ru);
    const nominal = nominalUsdc(T, price);
    const sellDev = fmtDivRounded(deviationBpsRounded(sell.out, nominal), 100n, 2);
    const sellAfter = priceAfter6(Rw, Ru, T, sell.out);
    const buyIn = 2n * U;
    const buy = v2out(buyIn, Ru, Rw);
    const buyAfter = fmtDivRounded((Ru + buyIn) * W, (Rw - buy.out) * U, 6);
    return '<div class="card op"><span class="badge sim">локальная симуляция</span>' +
      '<span class="net">сеть: нет · комиссия сети не включена</span>' +
      '<div><b>Пул ' + label + '</b>, стартовая цена 1 USDC за wAGT</div>' +
      '<div>Продажа 2 wAGT → <span class="amt">' + formatUsdc(sell.out) + ' USDC</span> ' +
      '(откл. ' + sellDev + '%, комиссия пула ' + formatWagt(sell.fee) + ' wAGT, цена после ' + sellAfter + ')</div>' +
      '<div>Покупка за 2 USDC → <span class="amt">' + formatWagt(buy.out) + ' wAGT</span> ' +
      '(комиссия пула ' + formatUsdc(buy.fee) + ' USDC, цена после ' + buyAfter + ')</div></div>';
  }).join('');
}

window.addEventListener('DOMContentLoaded', () => {
  $('liq-go').onclick = calc;
  scenarios();
});
