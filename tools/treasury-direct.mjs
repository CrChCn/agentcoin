#!/usr/bin/env node
/* treasury-direct.mjs — прямой расход казны 2-of-3 БЕЗ кабинетного op-маршрута.
 * Тот же бумажник, та же математика (txid + 2 подписи), но сборка и подпись
 * локально, отправка — POST /tx. Запасной путь, пока чинится /cabinet/op-submit.
 *
 *   node tools/treasury-direct.mjs --to AGT... --amount 100000 --memo пицца \
 *     --k1 treasury.key --k2 signer2.key [--api https://agentcoin.work]
 *
 * --k1/--k2: 64-hex приватник, PEM-приватник или 24 слова (фраза = сырая
 * энтропия 1-в-1 как на странице /wallet). Значение можно дать inline (осядет
 * в истории шелла!) или путём к файлу — файл безопаснее, после отправки сотри.
 * В сеть уходят только адрес, публичные ключи и подписи. Приватники — никогда.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressFromPub, addressFromRawPub, txDigest } from '../core.mjs';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const API = (flag('api') || process.env.AGT_API || 'https://agentcoin.work').replace(/\/+$/, '');
const die = (msg, code = 1) => { console.error('✖ ' + msg); process.exit(code); };

const to = flag('to');
const amount = Number(flag('amount'));
const memo = String(flag('memo') || '');
if (!/^AGT[0-9a-f]{40}$/.test(to || '')) die('--to: нужен AGT-адрес');
if (!Number.isFinite(amount) || amount <= 0) die('--amount: положительное число');
if (memo.length > 120) die('--memo: максимум 120 символов');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDLIST = fs.readFileSync(path.join(__dirname, '..', 'bip39-english.txt'), 'utf8').split(/\s+/).filter(Boolean);

function readSecret(v) {
  if (!v) return null;
  if (fs.existsSync(v) && fs.statSync(v).isFile()) return fs.readFileSync(v, 'utf8').trim();
  return String(v).trim();
}

// 24 слова → 32 байта сырой энтропии, 1-в-1 как wordsToPrivLocal на /wallet.
function wordsToPriv(text) {
  const w = String(text).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (w.length !== 24) throw new Error('need24');
  let bits = '';
  for (const word of w) {
    const idx = WORDLIST.indexOf(word);
    if (idx < 0) throw new Error('неизвестное слово: ' + word);
    bits += idx.toString(2).padStart(11, '0');
  }
  const ent = Uint8Array.from(bits.slice(0, 256).match(/.{8}/g).map(h => parseInt(h, 2)));
  const h0 = crypto.createHash('sha256').update(ent).digest()[0];
  let hb = '';
  for (let k = 0; k < 8; k++) hb += ((h0 >> (7 - k)) & 1) ? '1' : '0';
  if (hb !== bits.slice(256, 264)) throw new Error('checksum слов не совпал');
  return Buffer.from(ent);
}

function privToKey(raw) {
  const s = String(raw || '').trim();
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return crypto.createPrivateKey(s);
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(s, 'hex')]),
      format: 'der', type: 'pkcs8',
    });
  }
  if (s.split(/\s+/).filter(Boolean).length === 24) {
    const ent = wordsToPriv(s);
    return crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), ent]),
      format: 'der', type: 'pkcs8',
    });
  }
  throw new Error('ключ: 64-hex, PEM-приватник или 24 слова');
}

function pemOf(key) {
  const raw = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
  const b64 = Buffer.from(raw).toString('base64');
  // Канонический PEM — тот же формат, что строит страница (строки по 64).
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const b64full = Buffer.concat([prefix, Buffer.from(raw)]).toString('base64');
  const lines = [];
  for (let i = 0; i < b64full.length; i += 64) lines.push(b64full.slice(i, i + 64));
  return { pem: '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n') + '\n-----END PUBLIC KEY-----\n', rawHex: Buffer.from(raw).toString('hex') };
}

async function api(path_, body) {
  const r = await fetch(API + path_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

const k1 = privToKey(readSecret(flag('k1')));
const k2 = privToKey(readSecret(flag('k2')));
if (!flag('k1') || !flag('k2')) die('нужны --k1 и --k2');
if (String(flag('k1')).length < 200 && !fs.existsSync(String(flag('k1'))) && String(flag('k1')).split(/\s+/).length < 2)
  console.error('⚠ ключ inline попал в историю шелла — в следующий раз используй файл (--k1 путь).');

const p1 = pemOf(k1), p2 = pemOf(k2);
const st = await fetch(API + '/treasury/state').then(r => r.json());
const policy = st && st.policy;
if (!policy) die('нет активной политики казны');
if (addressFromPub(p1.pem) !== policy.treasury) die('ключ --k1 не разворачивается в адрес казны ' + policy.treasury);
let sig2Pub = null;
if ((policy.signers || []).includes(addressFromRawPub(p2.rawHex))) sig2Pub = p2.rawHex;
else if ((policy.signers || []).includes(addressFromPub(p2.pem))) sig2Pub = p2.pem;
if (!sig2Pub) die('ключ --k2 не входит в политику казны');
if (sig2Pub === p1.pem) die('второй подписант должен отличаться от ключа входа');

const bal = await api('/balance', { address: policy.treasury });
if (!((bal.json && bal.json.balance) >= amount)) die('в казне не хватает: ' + JSON.stringify(bal.json));

const tx = { from: policy.treasury, fromPub: p1.pem, to, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
tx.txid = txDigest(tx);
// Пояс и подтяжки: проверяем обе подписи локально ДО отправки.
tx.signature = crypto.sign(null, Buffer.from(tx.txid, 'hex'), k1).toString('hex');
tx.sig2 = crypto.sign(null, Buffer.from(tx.txid, 'hex'), k2).toString('hex');
tx.sig2Pub = sig2Pub;
const ok1 = crypto.verify(null, Buffer.from(tx.txid, 'hex'), p1.pem, Buffer.from(tx.signature, 'hex'));
const vk2 = sig2Pub.length > 100 ? sig2Pub : crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(sig2Pub, 'hex')]), format: 'der', type: 'spki' });
const ok2 = crypto.verify(null, Buffer.from(tx.txid, 'hex'), vk2, Buffer.from(tx.sig2, 'hex'));
if (!ok1 || !ok2) die('локальная проверка подписей не сошлась — отправка отменена');

const out = await api('/tx', tx);
console.log(JSON.stringify({ accepted: out.json.accepted || false, mempool: out.json.mempool ?? null, reason: out.json.reason || out.json.error || null, txid: tx.txid }, null, 2));
if (!out.json.accepted) process.exit(2);
console.log('✓ принято сетью, жди включения в блок. Проверь: ' + API + '/balance ' + to);
