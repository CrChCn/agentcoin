// agt-tx.mjs — локальная подпись и отправка AGT (AGENTCOIN) из браузера.
// Каноника tx v1 ноды (node.mjs/core.mjs, txDigest):
//   tx = { from, fromPub, to, amount, nonce, ts, memo }
//   txid = sha256d(JSON.stringify({ from, to, amount, nonce, ts, memo }))
//   signature = ed25519(txid-hex bytes, privKey)  →  POST /tx
// Адрес: AGT + sha256d(pub)[0..32] + sha256d(pubHash)[0..4] (addressFromPub).
// Ключи не покидают вкладку: хранение только в localStorage + показ подтверждается.
import { sign, getPublicKey, etc } from '../js/vendor/ed25519.mjs';
import { sha512 } from '../js/vendor/sha512.mjs';
import { sha256 } from '../js/vendor/sha256.mjs';

// noble-ed25519 (bundler-сборка esm.sh 2.1.0) по умолчанию async — ставим sync-режим,
// чтобы подпись была мгновенной и детерминированной без async-петли.
etc.sha512Sync = (...m) => sha512(...m);

const enc = new TextEncoder();
const hexToBytes = (h) => {
  const s = String(h).trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(s) || s.length % 2) throw new Error('bad_hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sha256dHex = (u8) => bytesToHex(sha256(sha256(u8)));

const pubFromPriv = (privHex32) => {
  const priv = hexToBytes(privHex32);
  if (priv.length !== 32) throw new Error('privkey_must_be_32bytes_seed_hex');
  return bytesToHex(getPublicKey(priv));
};

const addressFromPubHex = (pubHex) => {
  const pub = hexToBytes(pubHex);
  const pubHash = hexToBytes(sha256dHex(pub));
  const checksum = sha256dHex(pubHash).slice(0, 8); // 4 байта → 8 hex
  return 'AGT' + bytesToHex(pubHash).slice(0, 32) + checksum;
};

// Паспортная схема: PEM из сырых 32 байт + адрес как считает нода (хеш текста PEM,
// контрольная — хеш hex-текста, как core.addressFromPub; сверено побайтово).
const ED25519_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const b64encode = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
};
const pubToPem = (pubHex) => {
  const raw = hexToBytes(pubHex);
  if (raw.length !== 32) throw new Error('bad_pub');
  const der = new Uint8Array(ED25519_PREFIX.length + 32);
  der.set(ED25519_PREFIX, 0);
  der.set(raw, ED25519_PREFIX.length);
  const b64 = b64encode(der), lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n') + '\n-----END PUBLIC KEY-----\n';
};
const addressFromPem = (pem) => {
  const h = sha256dHex(enc.encode(pem));
  return 'AGT' + h.slice(0, 32) + sha256dHex(enc.encode(h)).slice(0, 8);
};

// Канонический digest v1 — ДОЛЖЕН совпадать с txDigest() ноды (json-строка целиком).
const txPayload = (txCore) => JSON.stringify({
  from: txCore.from, to: txCore.to, amount: txCore.amount,
  nonce: txCore.nonce, ts: txCore.ts, memo: txCore.memo || '',
});
const txidOf = (txCore) => sha256dHex(enc.encode(txPayload(txCore)));

const buildTx = ({ privKeyHex, fromPubHex, from, to, amount, memo = '', nonce = null, ts = null }) => {
  if (!/^[0-9a-fA-F]{64}$/.test(String(privKeyHex || ''))) throw new Error('bad_privkey');
  if (!/^AGT[0-9a-f]{40}$/i.test(String(to || ''))) throw new Error('bad_recipient');
  const amountN = Number(amount);
  if (!Number.isFinite(amountN) || amountN <= 0) throw new Error('bad_amount');
  if (String(memo).length > 120) throw new Error('memo_too_long');
  const pub = fromPubHex || pubFromPriv(privKeyHex);
  let fromAddr, fromPubOut;
  if (typeof pub === 'string' && pub.startsWith('-----BEGIN PUBLIC KEY-----')) {
    fromPubOut = pub;
    fromAddr = addressFromPem(pub);
  } else {
    fromPubOut = pub;
    fromAddr = addressFromPubHex(pub);
  }
  if (from != null && from !== fromAddr) throw new Error('from_pub_mismatch');
  const useFrom = from || fromAddr;
  const core = {
    from: useFrom, to, amount: amountN,
    nonce: nonce == null ? Date.now() : Number(nonce),
    ts: ts == null ? Math.floor(Date.now() / 1000) : Number(ts),
    memo: String(memo || ''),
  };
  const txid = txidOf(core);
  const signature = bytesToHex(sign(hexToBytes(txid), hexToBytes(privKeyHex)));
  return { ...core, fromPub: fromPubOut, txid, signature };
};

// POST { to, amount, memo } → подпись локально → POST /tx. Возвращает { tx, res }.
const sendRawTx = async ({ privKeyHex, fromPubHex, from, to, amount, memo = '', endpoint = '/tx' }) => {
  const tx = buildTx({ privKeyHex, fromPubHex, from, to, amount, memo });
  const r = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tx),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { tx, status: r.status, res: j || {} };
};

// Локальная апка: ключ в localStorage (agtx:priv:<addr>). Без повторов показа и стираемо.
const KEY_PREFIX = 'agtx:priv:';
const saveKey = (privKeyHex, { remember = true } = {}) => {
  const pub = pubFromPriv(privKeyHex);
  const address = addressFromPubHex(pub);
  if (remember) localStorage.setItem(KEY_PREFIX + address, privKeyHex);
  sessionStorage.setItem(KEY_PREFIX + address, privKeyHex);
  return { address, pub, persisted: !!remember };
};
const loadKey = (address) => localStorage.getItem(KEY_PREFIX + address) || sessionStorage.getItem(KEY_PREFIX + address);
const forgetKey = (address) => { localStorage.removeItem(KEY_PREFIX + address); sessionStorage.removeItem(KEY_PREFIX + address); };

export { pubFromPriv, addressFromPubHex, pubToPem, addressFromPem, txidOf, buildTx, sendRawTx, saveKey, loadKey, forgetKey, KEY_PREFIX };
