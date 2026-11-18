/* Единое денежное ядро Agentcoin (браузер + Node SDK + платёжный адаптер).
 * Все атомарные суммы — строки BigInt. Никакого Number * 1e9.
 * Источник точности: core.mjs decimalToScaledUnits/unitsOfAmountBigInt.
 */
import { unitsOfAmountBigInt, MGNT_SCALE } from '../../core.mjs';

export const ATOMIC_SCALE = 9;
export const MGNT_PER_AGT = 1000000000n;
export { MGNT_SCALE };

export function parseAtomicStrict(input) {
  // Принимает decimal-строку или number с round-trip строкой; лишние знаки после запятой — отказ, не округление.
  let s;
  if (typeof input === 'bigint') {
    if (input <= 0n) throw new Error('bad_amount: must be positive integer atomic units');
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) throw new Error('bad_amount: must be positive');
    s = String(input);
  } else if (typeof input === 'string') {
    s = input.trim();
    // Экспонента запрещена на входе (fail-closed, как в mainnet.js): консенсус
    // её разворачивает, но платёжный ввод требует явный decimal без округлений.
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('bad_amount: only plain decimal, no exponent');
  } else {
    throw new Error('bad_amount: unsupported type');
  }
  if (!s) throw new Error('bad_amount: empty');
  // Запрещаем экспоненту с потерей точности — только через точный decimal-путь core.
  const u = unitsOfAmountBigInt(s);
  if (u <= 0n) throw new Error('bad_amount: must be positive integer atomic units');
  if (u > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('bad_amount: exceeds safe tx range');
  // round-trip: число обязано точно представлять атомы (защита от float-артефактов вида 0.1+0.2)
  if (typeof input === 'number') {
    const asNum = Number(u) / 1e9;
    const back = unitsOfAmountBigInt(asNum);
    if (back !== u) throw new Error('bad_amount: not representable as exact atomic units');
  }
  // Строгий отказ на >9 знаков: unitsOfAmountBigInt уже бросает value_exceeds_scale_9
  return u;
}

export function formatAtomic(atomic) {
  const u = BigInt(atomic);
  const whole = u / MGNT_PER_AGT;
  const frac = u % MGNT_PER_AGT;
  if (frac === 0n) return String(whole);
  return `${whole}.${String(frac).padStart(9, '0').replace(/0+$/, '')}`;
}

export function amountToProtocol(amountAtomic) {
  // Сумма для поля tx.amount протокола: КОНСЕНСУС требует number
  // (validateBlockAgainstChain/addTransaction: не-number → 'tx_bad_fields').
  // Строгость без Number*1e9: atomic → точная decimal-строка → Number → обратная
  // сверка; непредставимое — отказ. Строки — только для отображения (formatAtomic).
  const amt = BigInt(amountAtomic);
  if (amt <= 0n) throw new Error('bad_amount: must be positive integer atomic units');
  const n = Number(formatAtomic(amt));
  if (unitsOfAmountBigInt(n) !== amt) throw new Error('bad_amount: not representable as exact protocol number');
  return n;
}

export function equalAtomic(a, b) {
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}
