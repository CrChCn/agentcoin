#!/usr/bin/env node
/* treasury-batch.mjs — пакетные выплаты из казны 2-of-3 по реестру (напрямую, без кабинета).
 * Реестр — JSON tools/heartbeat.mjs weeklyLedger: {rows:[{address, amount}]}.
 * Ключи только локально (файлы!), в сеть уходят адрес/ключи-публичные/подписи.
 *
 *   node tools/treasury-batch.mjs --ledger ledger.json --k1 treasury.key --k2 signer2.key [--dry]
 *
 * --dry: только собрать+подписать+проверить локально, НЕ отправлять.
 * Боевой прогон — только под присмотром, маленькими батчами сначала.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { addressFromPub, addressFromRawPub, txDigest } from '../core.mjs';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  if (name === 'dry') return true;
  return argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const dry = flag('dry', false) === true || argv.includes('--dry');
const API = (flag('api') || process.env.AGT_API || 'https://agentcoin.work').replace(/\/+$/, '');
const die = (msg, code = 1) => { console.error('✖ ' + msg); process.exit(code); };

const ledgerPath = flag('ledger');
if (!ledgerPath || !fs.existsSync(ledgerPath)) die('--ledger: путь к JSON реестра {rows:[{address, amount}]}');
let ledger;
try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch (e) { die('реестр не читается: ' + e.message); }
const rows = Array.isArray(ledger) ? ledger : ledger.rows;
if (!Array.isArray(rows) || !rows.length) die('в реестре нет строк');
for (const [i, r] of rows.entries()) {
  if (!/^AGT[0-9a-f]{40}$/.test(r.address || '')) die(`строка ${i}: плохой адрес`);
  if (!Number.isFinite(Number(r.amount)) || Number(r.amount) <= 0) die(`строка ${i}: плохая сумма`);
}

function readSecret(v) {
  if (!v) return null;
  if (fs.existsSync(v) && fs.statSync(v).isFile()) return fs.readFileSync(v, 'utf8').trim();
  return String(v).trim();
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
  throw new Error('ключ: 64-hex или PEM-приватник (слова — только через treasury-direct витрину; сюда — файлом)');
}
function pemOf(key) {
  const raw = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
  const b64 = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]).toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return { pem: '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n') + '\n-----END PUBLIC KEY-----\n', rawHex: Buffer.from(raw).toString('hex') };
}
async function api(path_, body) {
  const r = await fetch(API + path_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

if (!flag('k1') || !flag('k2')) die('нужны --k1 и --k2 (лучше файлами)');
const k1 = privToKey(readSecret(flag('k1')));
const k2 = privToKey(readSecret(flag('k2')));
const p1 = pemOf(k1), p2 = pemOf(k2);
const st = await fetch(API + '/treasury/state').then(r => r.json());
const policy = st && st.policy;
if (!policy) die('нет активной политики казны');
if (addressFromPub(p1.pem) !== policy.treasury) die('ключ --k1 не разворачивается в адрес казны');
let sig2Pub = null;
if ((policy.signers || []).includes(addressFromRawPub(p2.rawHex))) sig2Pub = p2.rawHex;
else if ((policy.signers || []).includes(addressFromPub(p2.pem))) sig2Pub = p2.pem;
if (!sig2Pub) die('ключ --k2 не входит в политику казны');

const total = rows.reduce((s, r) => s + Number(r.amount), 0);
const bal = await api('/balance', { address: policy.treasury });
if (!((bal.json && bal.json.balance) >= total)) die(`в казне не хватает: надо ${total}, есть ${bal.json && bal.json.balance}`);
console.log(`казна ${policy.treasury}: батч ${rows.length} выплат на ${total} AGT${dry ? ' (DRY-RUN, отправки не будет)' : ''}`);

const baseNonce = Date.now();
const out = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const tx = { from: policy.treasury, fromPub: p1.pem, to: r.address, amount: Number(r.amount), nonce: baseNonce + i, ts: Math.floor(Date.now() / 1000), memo: String(r.memo || 'heartbeat') };
  tx.txid = txDigest(tx);
  tx.signature = crypto.sign(null, Buffer.from(tx.txid, 'hex'), k1).toString('hex');
  tx.sig2 = crypto.sign(null, Buffer.from(tx.txid, 'hex'), k2).toString('hex');
  tx.sig2Pub = sig2Pub;
  const ok1 = crypto.verify(null, Buffer.from(tx.txid, 'hex'), p1.pem, Buffer.from(tx.signature, 'hex'));
  const vk2 = sig2Pub.length > 100 ? sig2Pub : crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(sig2Pub, 'hex')]), format: 'der', type: 'spki' });
  const ok2 = crypto.verify(null, Buffer.from(tx.txid, 'hex'), vk2, Buffer.from(tx.sig2, 'hex'));
  if (!ok1 || !ok2) { out.push({ to: r.address, amount: r.amount, error: 'local_verify_fail' }); continue; }
  if (dry) { out.push({ to: r.address, amount: r.amount, txid: tx.txid, dry: true }); continue; }
  const res = await api('/tx', tx);
  out.push({ to: r.address, amount: r.amount, txid: tx.txid, accepted: !!(res.json && res.json.accepted), reason: (res.json && (res.json.reason || res.json.error)) || null });
  if ((i + 1) % 25 === 0) console.log(`  ...${i + 1}/${rows.length}`);
}
const acc = out.filter(o => o.accepted || o.dry).length;
console.log(JSON.stringify({ sent: out.length, ok: acc, failed: out.length - acc, items: out.slice(0, 10), note: out.length > 10 ? `показаны 10 из ${out.length}` : 'все показаны' }, null, 2));
if (acc < out.length) process.exit(2);
