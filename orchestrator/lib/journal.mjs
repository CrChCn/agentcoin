#!/usr/bin/env node
/* Хэш-цепочка журнала инструментов (Stage A fix5).

   Журнал пишет только broker: его stdout — единственный канал, который
   инструменты модели не могут открыть для записи (дочерние процессы получают
   свои pipes). Каждая запись ссылается на хэш предыдущей, поэтому удаление,
   вставка или правка строки ломает цепочку и preflight это видит.

   Модуль не импортирует ничего, кроме crypto: его же копия монтируется внутрь
   sandbox как /orch/lib/journal.mjs, и broker обязан считать хэши тем же кодом,
   что и проверяющий. */

import crypto from 'node:crypto';

export const GENESIS = 'genesis';

export const sha256Text = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

/* Стабильная сериализация: порядок ключей не зависит от того, как объект
   собрали. Без неё цепочка ломалась бы при переупаковке JSON. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function entryHash(entry) {
  const { hash, ...rest } = entry || {};
  return sha256Text(canonical(rest));
}

/* Запись цепочки: prev — хэш предыдущей записи либо GENESIS. */
export function chainEntry(base, prev = GENESIS) {
  const withPrev = { ...base, prev: prev || GENESIS };
  return { ...withPrev, hash: entryHash(withPrev) };
}

/* Проверка цепочки целиком. Возвращает head и первую поломку. */
export function verifyChain(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let prev = GENESIS;
  for (let index = 0; index < list.length; index++) {
    const entry = list[index];
    if (!entry || typeof entry !== 'object') return { ok: false, index, reason: 'entry is not an object', head: prev };
    if ((entry.prev || GENESIS) !== prev) return { ok: false, index, reason: 'prev does not match the previous hash', head: prev };
    if (entryHash(entry) !== entry.hash) return { ok: false, index, reason: 'entry hash does not match its content', head: prev };
    prev = entry.hash;
  }
  return { ok: true, index: -1, reason: null, head: prev, length: list.length };
}
