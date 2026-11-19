#!/usr/bin/env node
/* Секреты окружения: обнаружение и вымарывание.
   Ключ передаётся процессу агента только через окружение, но CLI может
   случайно напечатать его в stderr, в JSONL или в структурированном ответе.
   Поэтому всё, что адаптер сохраняет на диск, проходит через redactText. */

import fs from 'node:fs';
import path from 'node:path';

import { SECRET_NAME } from './envpolicy.mjs';

const MIN_SECRET_LENGTH = 8;
const IGNORED_NAMES = new Set(['SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'KEYRING_PID']);

/* Строка подключения с паролем: scheme://user:password@host. Значение может
   быть любым (postgres, mysql, redis, amqp), поэтому маскируется по форме, а не
   по имени переменной. */
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

export const REDACTED = '[REDACTED]';

export function maskCredentialUrls(text) {
  return String(text ?? '').replace(CREDENTIAL_URL, (_match, scheme) => `${scheme}${REDACTED}@`);
}

export function secretPairs(env = process.env) {
  const pairs = [];
  for (const [name, value] of Object.entries(env || {})) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    if (IGNORED_NAMES.has(name)) continue;
    if (!SECRET_NAME.test(name)) continue;
    pairs.push({ name, value });
    /* Значение может содержать строку подключения целиком; её пароль тоже
       должен быть вымаран, даже если имя переменной не похоже на секрет. */
    const match = CREDENTIAL_URL.exec(value);
    CREDENTIAL_URL.lastIndex = 0;
    if (match) pairs.push({ name: `${name}#password`, value: match[3] });
  }
  /* Длинные значения вымарываются первыми: иначе короткий ключ может
     разрезать длинный и оставить его хвост. */
  return pairs.sort((a, b) => b.value.length - a.value.length);
}

export function redactText(text, pairs = secretPairs()) {
  let out = String(text ?? '');
  for (const { value } of pairs) {
    if (value && out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return maskCredentialUrls(out);
}

/* Глубокое вымарывание: применяется к структурам перед сериализацией,
   чтобы не сломать JSON подстановкой внутри строки. */
export function redactValue(value, pairs = secretPairs()) {
  if (typeof value === 'string') return redactText(value, pairs);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, pairs));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, pairs);
    return out;
  }
  return value;
}

export function findSecrets(text, pairs = secretPairs()) {
  const value = String(text ?? '');
  return pairs.filter((pair) => pair.value && value.includes(pair.value)).map((pair) => pair.name);
}

/* Обход дерева: нужен и для проверки артефакта, и для тестов утечки. */
export function scanTree(dir, pairs = secretPairs()) {
  const found = [];
  const visit = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      let text = '';
      try {
        text = fs.readFileSync(child, 'utf8');
      } catch {
        continue;
      }
      const hits = findSecrets(text, pairs);
      if (hits.length) found.push({ file: path.relative(dir, child).replace(/\\/g, '/'), names: hits });
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return found;
}
