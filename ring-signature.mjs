#!/usr/bin/env node
/* ============================================================
   ring.mjs — LSAG-подписи (Linkable Spontaneous Anonymous Group)
   в стиле Monero, на самописной арифметике ed25519. Zero-dependency.

   Свойства: подписант доказывает владение ОДНИМ из ключей кольца,
   не раскрывая каким; keyImage I = x·Hp(P) не раскрывает владельца,
   но связывает повторные подписи той же личности (anti-replay).

   Связка с node-crypto: приватный seed извлекается из PKCS8-PEM,
   скаляр = clamp(sha512(seed)); публичный ключ ВОСПРОИЗВОДИТСЯ нашей
   арифметикой и сравнивается с PEM-SPKI的自我теста — так вся матика
   проверяется против эталона без внешних зависимостей.
   ============================================================ */
'use strict';
import crypto from 'node:crypto';

export const P = 2n ** 255n - 19n;
export const Q = 2n ** 252n + 27742317777372353535851937790883648493n; // порядок базовой точки (канонический l)
const SQRT_M1 = modPow(2n, (P - 1n) / 4n, P);        // 2^((p-1)/4) mod p = sqrt(-1)

// ----- модульная арифметика -----
export function modPow(b, e, m) {
  let r = 1n, bb = ((b % m) + m) % m, ee = e;
  while (ee > 0n) {
    if (ee & 1n) r = r * bb % m;
    bb = bb * bb % m;
    ee >>= 1n;
  }
  return r;
}
export function modInverse(a, m = P) {
  let r0 = m, r1 = ((a % m) + m) % m, x0 = 0n, x1 = 1n;
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [x0, x1] = [x1, x0 - q * x1];
  }
  if (r0 !== 1n) throw new Error('modInverse: not invertible');
  return ((x0 % m) + m) % m;
}

const D = ((modInverse(121666n, P) * 121665n) % P * (P - 1n)) % P; // -121665/121666 mod p

// ----- расширенные координаты [X, Y, Z, T] (x=X/Z, y=Y/Z, T=xy) -----
function pointZero() { return [0n, 1n, 1n, 0n]; }
function norm(pt) {
  const [X, Y, Z] = pt;
  if (Z === 0n) return { zero: true, x: 0n, y: 1n };
  const zi = modInverse(Z, P);
  return { zero: false, x: X * zi % P, y: Y * zi % P };
}
// Unified-сложение add-2008-hwcd-3 (корректно и для P1 === P2):
function ptAdd(p1, p2) {
  const [X1, Y1, Z1, T1] = p1, [X2, Y2, Z2, T2] = p2;
  const dd = 2n * D % P;
  const A = (Y1 - X1) * (Y2 - X2) % P;
  const B = (Y1 + X1) * (Y2 + X2) % P;
  const C = T1 * dd % P * T2 % P;
  const D2 = Z1 * 2n % P * Z2 % P;
  const E = B - A, F = D2 - C, G = D2 + C, H = B + A;
  const np = (v) => ((v % P) + P) % P; // нормализация знака (BigInt % даёт ±)
  return [np(E * F), np(G * H), np(F * G), np(E * H)];
}
export function scalarMul(pt, k) {
  let acc = pointZero();
  const bits = ((k % Q) + Q).toString(2);
  for (const bit of bits) {
    acc = ptAdd(acc, acc);
    if (bit === '1') acc = ptAdd(acc, pt);
  }
  return acc;
}
export function ptAddExport(a, b) { return ptAdd(a, b); }

// ----- кодирование точек -----
function intToLE32(v) { const b = Buffer.alloc(32); let x = v; for (let i = 0; i < 32; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; }
function intLE(b) { let v = 0n; for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(b[i] & 0xff); return v; }
export function encodePoint(pt) {
  const n = norm(pt);
  if (n.zero) { const b = Buffer.alloc(32, 0); b[0] = 1; return b; }
  const out = intToLE32(n.y % P);
  if (n.x & 1n) out[31] |= 0x80;
  return out;
}
function recoverX(y, xParity) {
  const yy = y * y % P;
  const u = (yy - 1n + P) % P;
  const v = (D * yy % P + 1n) % P;
  const ratio = u * modInverse(v) % P;
  const v2 = v * v % P, v4 = v2 * v2 % P, v3 = v2 * v % P, v7 = v3 * v4 % P;
  let x = u * v3 % P * modPow(u * v7 % P, (P - 5n) / 8n, P) % P;
  if (x * x % P !== ratio) x = x * SQRT_M1 % P;
  if (x * x % P !== ratio) return null;
  if ((x & 1n) !== (xParity ? 1n : 0n)) x = (P - x) % P;
  return x;
}
export function decodePoint(bytes32) {
  const b = Buffer.from(bytes32);
  const xParity = Boolean(b[31] & 0x80);
  const yb = Buffer.from(b); yb[31] &= 0x7f;
  const y = intLE(yb);
  if (y >= P) return null;
  const x = recoverX(y, xParity);
  if (x === null) return null;
  return [x, y, 1n, x * y % P];
}

// Базовая точка: канонический compressed 0x5866…66 (32 байта)
export const BASE_COMPRESSED = Buffer.from('5866666666666666666666666666666666666666666666666666666666666666', 'hex');
export const BASE_POINT = decodePoint(BASE_COMPRESSED);

// ====== ключи node-crypto → скаляры/точки нашей арифметики ======
export function scalarFromPrivKeyPEM(privKeyPem) {
  const der = Buffer.from(privKeyPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const seed = der.subarray(der.length - 32);
  const h = crypto.createHash('sha512').update(seed).digest();
  h[0] &= 248; h[31] &= 127; h[31] |= 64; // RFC 8032 clamp
  return intLE(h.subarray(0, 32)) % Q;
}
export function pointFromPubKeyPEM(pubPem) {
  const der = Buffer.from(pubPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const raw = der.subarray(der.length - 32);
  const pt = decodePoint(raw);
  if (!pt) throw new Error('pointFromPubKeyPEM: не точка ed25519');
  return { point: pt, compressed: raw };
}
export function pubFromScalar(scalar) { return encodePoint(scalarMul(BASE_POINT, scalar)); }

// ====== Хеши → скаляры/точки ======
function hashToScalar(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(Buffer.isBuffer(p) ? p : Buffer.from(p));
  return intLE(h.digest()) % Q;
}
function Hp(compressedPoint) {
  // hash-to-point (наша замена keccak-Hp): sha256(compressed) → скаляр → s·B
  return scalarMul(BASE_POINT, hashToScalar(compressedPoint, 'agt-Hp-dom-split'));
}

// ====== LSAG ======
function Hn(msgBuf, Ic, Rc, Kc) {
  return hashToScalar('lsag', msgBuf, Ic, Rc, Kc);
}

// Подпись принадлежности кольцу:
//   privPem  — PEM приватного ключа (или BigInt scalar);
//   ringPubs — массив компрес-точек (hex-строки/Buffer) ПУБЛИЧНЫХ ключей,
//              свой pub добавляется автоматически, если отсутствует;
//   message  — строка/байты.
export function lsagSign(privKey, ringPubs, message) {
  const x = typeof privKey === 'bigint' ? privKey : scalarFromPrivKeyPEM(privKey);
  const myPub = encodePoint(scalarMul(BASE_POINT, x));
  const ring = ringPubs.map(r => Buffer.isBuffer(r) ? Buffer.from(r) : Buffer.from(String(r), 'hex'));
  const pi = ring.findIndex(b => b.length === 32 && b.equals(myPub));
  // ротация: подписант — ПОСЛЕДНИЙ индекс (K-1), чтобы порядок sign/verify совпадал
  const baseRing = pi >= 0 ? ring : [...ring, myPub];
  const K = baseRing.length;
  const kSignOrig = (pi >= 0 ? pi : K - 1);
  // ротация: все от (k+1) до конца, затем 0..k — подписант становится последним
  const signedRing = [...baseRing.slice(kSignOrig + 1), ...baseRing.slice(0, kSignOrig + 1)];

  const msgBuf = Buffer.isBuffer(message) ? message : Buffer.from(String(message));
  const pts = signedRing.map(b => decodePoint(b));
  if (pts.some(p => !p)) throw new Error('lsagSign: в кольце не точка');
  const hps = pts.map(P_i => Hp(encodePoint(P_i)));
  const last = K - 1;
  const I = scalarMul(hps[last], x);
  const Ic = encodePoint(I);

  const a = hashToScalar(crypto.randomBytes(64)) || 1n;
  // anchor = c_rot[0]; ВАЖНО: тот же домен 'lsag', что и в verify — иначе замыкание
  // (s_last·B + c·P = a·B, s_last·Hp + c·I = a·Hp) не свернётся в anchor.
  let c = Hn(msgBuf, Ic, encodePoint(scalarMul(BASE_POINT, a)), encodePoint(scalarMul(hps[last], a)));
  const cAnchor = c;
  const s = new Array(K).fill(0n);
  for (let i = 0; i < last; i++) {
    const r = hashToScalar(crypto.randomBytes(64)) || 1n;
    s[i] = r;
    const R = ptAdd(scalarMul(BASE_POINT, r), scalarMul(pts[i], c));
    const Kp = ptAdd(scalarMul(hps[i], r), scalarMul(I, c));
    c = Hn(msgBuf, Ic, encodePoint(R), encodePoint(Kp));
  }
  // замыкание: подписант (последний индекс)
  s[last] = ((a - c * x) % Q + Q) % Q;
  return {
    ring: signedRing.map(b => b.toString('hex')),
    keyImage: Ic.toString('hex'),
    c0: scalarHex(cAnchor),
    s: s.map(v => scalarHex(v)),
  };
}

export function lsagVerify(proof, message) {
  try {
    const msgBuf = Buffer.isBuffer(message) ? message : Buffer.from(String(message));
    const ring = proof.ring.map(h => Buffer.from(h, 'hex'));
    const s = proof.s.map(h => BigInt('0x' + h));
    if (ring.length !== s.length || ring.length === 0) return false;
    if (s.some(v => v >= Q)) return false; // s обязаны быть редуцированы
    const pts = ring.map(b => decodePoint(b));
    if (pts.some(p => !p)) return false;
    const I = decodePoint(Buffer.from(proof.keyImage, 'hex'));
    if (!I) return false;
    const hps = pts.map(P_i => Hp(encodePoint(P_i)));
    let c = BigInt('0x' + proof.c0) % Q;
    const K = ring.length;
    for (let i = 0; i < K; i++) {
      const R = ptAdd(scalarMul(BASE_POINT, s[i]), scalarMul(pts[i], c));
      const Kp = ptAdd(scalarMul(hps[i], s[i]), scalarMul(I, c));
      c = Hn(msgBuf, Buffer.from(proof.keyImage, 'hex'), encodePoint(R), encodePoint(Kp));
    }
    if (c !== BigInt('0x' + proof.c0) % Q) return false;
    return ring.every(b => b.length === 32);
  } catch { return false; }
}

// сериализация скаляра: big-endian hex 64 символа (легко парсится BigInt)
export function scalarHex(v) { return (((v % Q) + Q) % Q).toString(16).padStart(64, '0'); }
