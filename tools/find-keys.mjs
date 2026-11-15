#!/usr/bin/env node
/* find-keys.mjs — локальный поиск ключей от заданных адресов в старых файлах.
 *
 * ЗАПУСК ТОЛЬКО НА СВОЕЙ МАШИНЕ. Скрипт ничего никуда не отправляет.
 * В отчёт печатаются ТОЛЬКО имена файлов и найденные адреса — секреты
 * (hex, PEM, слова) не выводятся никогда, даже при совпадении.
 *
 *   node tools/find-keys.mjs --addrs AGTxxx,AGTyуy --dir /путь/к/старым/бекапам
 *
 * Ищет: прямые упоминания адресов в файлах + приватники (64-hex, PEM),
 * из которых выводит оба адреса ключа (браузерный и паспортный) и сверяет.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { addressFromPub, addressFromRawPub } from '../core.mjs';

const argv = process.argv.slice(0);
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : null;
};
const die = (m) => { console.error('✖ ' + m); process.exit(1); };

const addrsRaw = (flag('addrs') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!addrsRaw.length) die('--addrs AGT...,AGT... (через запятую)');
for (const a of addrsRaw) if (!/^AGT[0-9a-f]{40}$/.test(a)) die('плохой адрес: ' + a);
const wanted = new Set(addrsRaw);
const dir = flag('dir');
if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die('--dir: папка со старыми файлами');

function privToKey(raw) {
  const s = String(raw).trim();
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return crypto.createPrivateKey(s);
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(s, 'hex')]),
      format: 'der', type: 'pkcs8',
    });
  }
  return null;
}
function bothAddresses(key) {
  const out = [];
  try {
    const pub = crypto.createPublicKey(key);
    const pem = pub.export({ type: 'spki', format: 'pem' });
    out.push(addressFromPub(pem));
    const raw = pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    out.push(addressFromRawPub(raw));
  } catch { /* чужой формат — пропускаем */ }
  return out;
}

const hits = [];
function scanFile(fp) {
  let text;
  try {
    const st = fs.statSync(fp);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
    text = fs.readFileSync(fp, 'utf8');
  } catch { return; }
  if (text.includes('\uFFFD') && text.length > 100000) return;
  const found = new Set();
  for (const a of wanted) if (text.includes(a)) found.add(a);
  const hexes = text.match(/[0-9a-fA-F]{64}/g) || [];
  for (const h of new Set(hexes)) {
    let key;
    try { key = privToKey(h); } catch { continue; }
    if (!key) continue;
    for (const a of bothAddresses(key)) if (wanted.has(a)) found.add(a);
  }
  const pems = text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g) || [];
  for (const p of pems) {
    let key;
    try { key = privToKey(p); } catch { continue; }
    if (!key) continue;
    for (const a of bothAddresses(key)) if (wanted.has(a)) found.add(a);
  }
  if (found.size) hits.push({ file: fp, addresses: [...found] });
}
function walk(dp) {
  let ents;
  try { ents = fs.readdirSync(dp, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const fp = path.join(dp, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(fp); }
    else scanFile(fp);
  }
}
walk(dir);

console.log(JSON.stringify({ scannedDir: dir, filesWithHits: hits.length, hits: hits.map(h => ({ file: h.file, addresses: h.addresses })) }, null, 2));
const covered = new Set(hits.flatMap(h => h.addresses));
const missing = [...wanted].filter(a => !covered.has(a));
if (missing.length) console.log('НЕ НАЙДЕНО (' + missing.length + '): ' + missing.join(', '));
