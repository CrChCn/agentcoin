// Чистая математика демо wAGT/tAGT (Uniswap V2, целые числа в минимальных единицах).
// Работает и в браузере (script src), и в node (import) — без DOM и зависимостей.
export const DECIMALS = 18n;
export const ONE = 10n ** DECIMALS;
export const FEE_NUM = 997n; // комиссия 0.3%: getAmountOut из Uniswap V2
export const FEE_DEN = 1000n;

export const INIT_STATE = {
  reserveWAGT: 40n * ONE,
  reserveTAGT: 400n * ONE,
  userWAGT: 5n * ONE,
  userTAGT: 100n * ONE,
  history: [],
};

export function initialState() {
  return {
    reserveWAGT: INIT_STATE.reserveWAGT,
    reserveTAGT: INIT_STATE.reserveTAGT,
    userWAGT: INIT_STATE.userWAGT,
    userTAGT: INIT_STATE.userTAGT,
    history: [],
  };
}

// Строка -> wei (BigInt). Бросает Error с понятным текстом при любой проблеме.
export function parseAmount(str) {
  const s = String(str).trim();
  if (!/^(?:\d+(?:\.\d{1,18})?|\.\d{1,18})$/.test(s)) {
    if (/[.].*[.]/g.test(s) || /[eE]/.test(s) || /[, ]/.test(s.replace(/^\s+|\s+$/g, ''))) {
      throw new Error('Сумма: используйте цифры и не более 18 знаков после запятой.');
    }
    if (/^\d+\.\d{19,}$/.test(s)) {
      throw new Error('Сумма: не более 18 знаков после запятой.');
    }
    throw new Error('Сумма: введите положительное число.');
  }
  const [i, f = ''] = s.split('.');
  const wei = BigInt(i === '' ? '0' : i) * ONE + BigInt((f + '0'.repeat(18)).slice(0, 18));
  if (wei <= 0n) throw new Error('Сумма должна быть больше нуля.');
  return wei;
}

// Точная формула Uniswap V2 getAmountOut, округление вниз (как в EVM).
export function getAmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n) throw new Error('Сумма должна быть больше нуля.');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('Пустой пул.');
  // Точная формула V2: out = (amountIn*997*reserveOut) / (reserveIn*1000 + amountIn*997),
  // целочисленное деление округляет вниз — как в EVM.
  const denom = reserveIn * FEE_DEN + amountIn * FEE_NUM;
  const out = (amountIn * FEE_NUM * reserveOut) / denom;
  if (out <= 0n) throw new Error('Слишком маленькая сумма: выход равен нулю.');
  return { out, fee: amountIn - (amountIn * FEE_NUM) / FEE_DEN };
}

// Предпросмотр сделки без изменения состояния.
// side: 'sell' — отдать wAGT, получить tAGT; 'buy' — отдать tAGT, получить wAGT.
export function quote(state, side, amountWei) {
  if (amountWei <= 0n) throw new Error('Сумма должна быть больше нуля.');
  const payWagt = side === 'sell';
  const balance = payWagt ? state.userWAGT : state.userTAGT;
  if (amountWei > balance) throw new Error('Не хватает баланса для этой суммы.');
  const reserveIn = payWagt ? state.reserveWAGT : state.reserveTAGT;
  const reserveOut = payWagt ? state.reserveTAGT : state.reserveWAGT;
  const { out, fee } = getAmountOut(amountWei, reserveIn, reserveOut);
  return {
    side,
    pay: amountWei,
    payToken: payWagt ? 'wAGT' : 'tAGT',
    get: out,
    getToken: payWagt ? 'tAGT' : 'wAGT',
    fee,
    newReserveWAGT: payWagt ? state.reserveWAGT + amountWei : state.reserveWAGT - out,
    newReserveTAGT: payWagt ? state.reserveTAGT - out : state.reserveTAGT + amountWei,
  };
}

// Применение подтверждённой сделки: возвращает НОВОЕ состояние + запись истории.
export function applyTrade(state, side, amountWei) {
  const q = quote(state, side, amountWei); // все проверки — здесь
  const next = {
    reserveWAGT: q.newReserveWAGT,
    reserveTAGT: q.newReserveTAGT,
    userWAGT: side === 'sell' ? state.userWAGT - amountWei : state.userWAGT + q.get,
    userTAGT: side === 'sell' ? state.userTAGT + q.get : state.userTAGT - amountWei,
    history: state.history.concat([{
      n: state.history.length + 1,
      mode: 'sim',
      side,
      pay: q.pay,
      payToken: q.payToken,
      get: q.get,
      getToken: q.getToken,
    }]),
  };
  return { next, entry: next.history[next.history.length - 1] };
}

// Полное десятичное представление wei (вся точность, без обрезки).
export function formatWei(wei) {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const i = v / ONE;
  const f = (v % ONE).toString().padStart(18, '0');
  return (neg ? '-' : '') + i.toString() + '.' + f;
}
