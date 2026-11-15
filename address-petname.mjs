/* ============================================================
   address-petname.mjs — человекочитаемый отпечаток адреса.
   3 слова из фиксированного словаря BIP39-2048 (тот же файл,
   что использует bip39-lite.mjs). Детерминированно:
   sha256('agentcoin-petname-v1:' + address) → первые 33 бита →
   3 индекса по 11 бит → 3 слова.
   Это ТОЛЬКО витрина: на консенсус, подписи и паспорта не влияет.
   Старые паспорта и адреса работают без изменений.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDLIST_PATH = path.join(__dirname, 'bip39-english.txt');

let _words = null;
export function petnameWords() {
  if (_words) return _words;
  const list = fs.readFileSync(WORDLIST_PATH, 'utf8').split(/\r?\n/).map(w => w.trim()).filter(Boolean);
  if (list.length !== 2048) throw new Error('petname wordlist corrupt: ' + list.length + ' (expected 2048)');
  _words = list;
  return _words;
}

export function validateAddress(address) {
  if (typeof address !== 'string' || !/^AGT[0-9a-f]{40}$/.test(address)) throw new Error('invalid_address');
  return address;
}

/** Детерминированные 3 слова для адреса. Формат: 'word-word-word'. */
export function addressPetname(address) {
  validateAddress(address);
  const digest = crypto.createHash('sha256').update('agentcoin-petname-v1:' + address, 'utf8').digest();
  const bits = Array.from(digest.subarray(0, 5)).map(b => b.toString(2).padStart(8, '0')).join('').slice(0, 33);
  const list = petnameWords();
  const out = [];
  for (let i = 0; i < 3; i++) out.push(list[parseInt(bits.slice(i * 11, (i + 1) * 11), 2)]);
  return out.join('-');
}

/** Короткий адрес для витрины: AGTxxxx…xxxx (первые/последние 5 hex). */
export function shortAddress(address) {
  validateAddress(address);
  return address.slice(0, 8) + '…' + address.slice(-4);
}

/** Единый формат витрины: 'handle · слово-слово-слово · AGTxx…xx' (handle опционален). */
export function formatIdentity({ handle, address }) {
  validateAddress(address);
  const pet = addressPetname(address);
  const short = shortAddress(address);
  const cleanHandle = typeof handle === 'string' && handle.trim() ? handle.trim().slice(0, 64) : null;
  return (cleanHandle ? cleanHandle + ' · ' : '') + pet + ' · ' + short;
}
