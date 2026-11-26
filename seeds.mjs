#!/usr/bin/env node
/* ============================================================
   AGENTCOIN seeds.mjs — bootstrap без ручного ввода адресов.

   Новая нода с пустым data-каталогом должна сама узнать, к кому
   подключаться. Три источника, по возрастанию хрупкости:
     1) DNS TXT (seed.agentcoin.work или AGT_DNS_SEEDS) — оператор
        может переехать, не выпуская новую версию ноды;
     2) встроенный FALLBACK_SEED_URLS — работает, даже если DNS
        сломан/подменён и bootstrap.json пуст;
     3) явный конфиг (env AGT_SEED_NODES, DATA_DIR/seed-nodes.json,
        bootstrap.json) — читается в node.mjs до этого модуля.

   Записи TXT принимаются в виде
     "agt-seed0=https://node1.agentcoin.work agt-seed1=91.99.191.236:9335"
   то есть несколько адресов в одной строке, с ключом и без него.
   Адрес без схемы получает https:// (порт разрешён, путь — нет).

   Модуль ничего не пишет на диск и не доверяет DNS: найденные URL
   проходят через sanitizePeers() в sync.mjs (публичный хост, форма
   URL, анти-самоссылка) — DNS-ответ не может протащить loopback.
   ============================================================ */
'use strict';
import dns from 'node:dns/promises';

// Последний шанс: публичные точки входа основной сети. Держим их
// в коде, а не только в bootstrap.json, чтобы нода поднялась и при
// потерянном/перезаписанном файле конфигурации. node2/node3 отдают
// P2P (/ws) и sync, но публичный HTTP у них закрыт — это seed, а не
// публичный RPC.
export const FALLBACK_SEED_URLS = Object.freeze([
  'https://node1.agentcoin.work',
  'https://node2.agentcoin.work',
  'https://node3.agentcoin.work',
  'https://agentcoin.work',
]);

export const DEFAULT_DNS_SEED_HOSTS = Object.freeze(['seed.agentcoin.work']);

// scheme://host[:port], без пути/креденшелов — пир это хост ноды
const URL_SHAPE_RE = /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?\/?$/i;

// Одна строка TXT (или несколько склеенных) → список URL.
export function parseSeedRecord(record) {
  const urls = [];
  for (const token of String(record ?? '').split(/[\s,;]+/)) {
    if (!token) continue;
    // ключ записи (agt-seed0=…) отбрасываем, значение оставляем
    const eq = token.indexOf('=');
    let value = eq >= 0 ? token.slice(eq + 1) : token;
    if (!value) continue;
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    const m = URL_SHAPE_RE.exec(value);
    if (!m) continue;
    const host = m[2];
    // односоставный хост (p1, node) не резолвится в интернете — это заполнитель
    if (!/^\[[0-9a-f:]+\]$/i.test(host) && !host.includes('.')) continue;
    if (/^[0-9.]+$/.test(host) && host.split('.').some(o => Number(o) > 255)) continue;
    const port = m[3] ? Number(m[3]) : 0;
    if (m[3] && !(port >= 1 && port <= 65535)) continue;
    urls.push(`${m[1].toLowerCase()}://${host.toLowerCase()}${port ? ':' + port : ''}`);
  }
  return [...new Set(urls)];
}

// AGT_DNS_SEEDS=seed.example.org[,seed2…], "0"/"off" — выключить.
export function seedHostsFromEnv(env = process.env) {
  const raw = String(env.AGT_DNS_SEEDS ?? '').trim();
  if (!raw) return [...DEFAULT_DNS_SEED_HOSTS];
  if (raw === '0' || /^off$/i.test(raw)) return [];
  return [...new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`timeout ${ms}ms`), { code: 'ETIMEOUT' })), ms);
    promise.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

// TXT-записи всех seed-хостов. Ошибка DNS — не падение ноды: возвращаем
// то, что успели собрать (вызывающий код добавит fallback).
export async function resolveDnsSeeds({ hosts = DEFAULT_DNS_SEED_HOSTS, timeoutMs = 2500, resolver = dns, log = () => {} } = {}) {
  const urls = [];
  for (const host of hosts) {
    if (!host) continue;
    try {
      const records = await withTimeout(resolver.resolveTxt(host), timeoutMs);
      const found = [];
      for (const chunks of records || []) found.push(...parseSeedRecord([].concat(chunks).join('')));
      if (found.length) log(`[peers] dns-seed ${host}: ${found.length} адрес(ов)`);
      urls.push(...found);
    } catch (e) {
      log(`[peers] dns-seed ${host}: ${e.code || e.message}`);
    }
  }
  return [...new Set(urls)];
}
