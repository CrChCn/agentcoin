// Привязка демо к DOM. Вся математика — в math.js (целые числа, BigInt).
import { parseAmount, quote, applyTrade, initialState, formatWei } from './math.js';

const $ = (id) => document.getElementById(id);

let state = initialState();
let pending = null; // { side, amountWei, q }

function badge(mode) {
  return mode === 'sim'
    ? '<span class="badge sim">локальная симуляция</span>'
    : '<span class="badge chain">публичная тестовая сеть</span>';
}

function amt(wei, token) {
  return '<span class="amt">' + formatWei(wei) + ' ' + token + '</span>';
}

function priceImpactPct(q, st) {
  // Только для отображения: средняя цена сделки vs цена пула до сделки.
  const inNum = Number(q.pay), outNum = Number(q.get);
  const reserveIn = Number(q.side === 'sell' ? st.reserveWAGT : st.reserveTAGT);
  const reserveOut = Number(q.side === 'sell' ? st.reserveTAGT : st.reserveWAGT);
  const impact = (1 - (outNum / inNum) / (reserveOut / reserveIn)) * 100;
  return impact;
}

function renderPool() {
  $('poolW').textContent = formatWei(state.reserveWAGT) + ' wAGT';
  $('poolT').textContent = formatWei(state.reserveTAGT) + ' tAGT';
  $('balW').textContent = formatWei(state.userWAGT) + ' wAGT';
  $('balT').textContent = formatWei(state.userTAGT) + ' tAGT';
  const price = Number(state.reserveTAGT) / Number(state.reserveWAGT);
  $('poolPrice').textContent = '1 wAGT ≈ ' + price.toFixed(6) + ' tAGT';
}

function renderHistory() {
  const box = $('history');
  if (state.history.length === 0) {
    box.innerHTML = '<p class="muted">Пока пусто — первая сделка появится здесь.</p>';
    return;
  }
  box.innerHTML = state.history.slice().reverse().map((h) =>
    '<div class="card op">' + badge('sim') +
    '<span class="net">расчёт в браузере</span>' +
    '<div><b>#' + h.n + ' ' + (h.side === 'sell' ? 'Продажа wAGT' : 'Покупка wAGT') + '</b></div>' +
    '<div>Отдано: ' + amt(h.pay, h.payToken) + '</div>' +
    '<div>Получено: ' + amt(h.get, h.getToken) + '</div></div>'
  ).join('');
}

function showError(msg) {
  const e = $('error');
  e.textContent = msg;
  e.style.display = msg ? 'block' : 'none';
}

function preview(side) {
  pending = null;
  $('preview').style.display = 'none';
  let amountWei;
  try {
    amountWei = parseAmount($('amount').value);
  } catch (err) {
    showError(err.message);
    return;
  }
  let q;
  try {
    q = quote(state, side, amountWei);
  } catch (err) {
    showError(err.message);
    return;
  }
  showError('');
  pending = { side, amountWei, q };
  const impact = priceImpactPct(q, state);
  $('preview').innerHTML = badge('sim') + '<span class="net">расчёт в браузере</span>' +
    '<div><b>Предпросмотр: ' + (side === 'sell' ? 'продажа wAGT' : 'покупка wAGT') + '</b></div>' +
    '<div>Отдаёте: ' + amt(q.pay, q.payToken) + '</div>' +
    '<div>Получите: ' + amt(q.get, q.getToken) + '</div>' +
    '<div>Комиссия пула (0,3%): ' + amt(q.fee, q.payToken) + '</div>' +
    '<div>Влияние на цену: ≈ ' + impact.toFixed(2) + '%</div>' +
    '<div>Резервы после: ' + amt(q.newReserveWAGT, 'wAGT') + ' / ' + amt(q.newReserveTAGT, 'tAGT') + '</div>' +
    '<div class="row"><button id="confirm" class="primary">Подтвердить</button>' +
    '<button id="cancel" class="ghost">Отмена</button></div>';
  $('preview').style.display = 'block';
  $('confirm').onclick = confirm;
  $('cancel').onclick = () => { pending = null; $('preview').style.display = 'none'; };
}

function confirm() {
  if (!pending) return;
  try {
    const { next } = applyTrade(state, pending.side, pending.amountWei);
    state = next;
  } catch (err) {
    showError(err.message);
    return;
  }
  pending = null;
  $('preview').style.display = 'none';
  $('amount').value = '';
  showError('');
  renderPool();
  renderHistory();
}

function reset() {
  state = initialState();
  pending = null;
  $('preview').style.display = 'none';
  $('amount').value = '';
  showError('');
  renderPool();
  renderHistory();
}

function switchTab(name) {
  for (const t of ['sim', 'sepolia']) {
    $('tab-' + t).style.display = t === name ? 'block' : 'none';
    $('btn-' + t).classList.toggle('active', t === name);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  $('btn-sim').onclick = () => switchTab('sim');
  $('btn-sepolia').onclick = () => switchTab('sepolia');
  $('buy').onclick = () => preview('buy');
  $('sell').onclick = () => preview('sell');
  $('reset').onclick = reset;
  renderPool();
  renderHistory();
});
