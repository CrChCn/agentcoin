/* queue-auth — подпись действий очереди (v2, изолированно; рабочая очередь не тронута).
   Формат: ed25519-подпись каноники { chain, action, body, nonce, expiry }.
   chain фиксирован ('AGENTCOIN'): подпись для другой сети здесь недействительна.
   Адрес выводится из fromPub теми же функциями, что консенсус (core.mjs). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { addressFromPub, isRawPubHex, addressFromRawPub, rawPubKeyObject } from './core.mjs';

export const QUEUE_CHAIN = 'AGENTCOIN';
export const AUTH_MAX_SKEW_MS = 5 * 60_000;

const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export function actionDigest({ chain = QUEUE_CHAIN, action, body = {}, nonce, expiry }) {
  return sha256hex(JSON.stringify({ chain, action, body: sortKeys(body), nonce: String(nonce), expiry: Number(expiry) }));
}

export function addressOfPub(fromPub) {
  if (isRawPubHex(fromPub)) return addressFromRawPub(fromPub);
  return addressFromPub(fromPub);
}

function pubKeyObject(fromPub) {
  if (isRawPubHex(fromPub)) return rawPubKeyObject(fromPub);
  return crypto.createPublicKey(fromPub);
}

export function signAction(privKeyPem, { action, body = {}, nonce, expiry, chain = QUEUE_CHAIN }) {
  const digest = actionDigest({ chain, action, body, nonce, expiry });
  const sig = crypto.sign(null, Buffer.from(digest, 'hex'), privKeyPem);
  return { signature: sig.toString('hex'), digest };
}

// Проверка подписи + срока; одноразовость nonce — на стороне хранилища (makeNonceStore).
export function verifyActionSig({ address, fromPub, signature, action, body = {}, nonce, expiry, chain = QUEUE_CHAIN, now = Date.now() }) {
  if (!address || !fromPub || !signature) return { ok: false, error: 'AUTH_MISSING_FIELDS' };
  if (chain !== QUEUE_CHAIN) return { ok: false, error: 'AUTH_WRONG_CHAIN' };
  if (typeof expiry !== 'number' || !(expiry > now)) return { ok: false, error: 'AUTH_EXPIRED' };
  if (expiry - now > AUTH_MAX_SKEW_MS) return { ok: false, error: 'AUTH_EXPIRY_TOO_FAR' };
  let derived;
  try { derived = addressOfPub(fromPub); } catch { return { ok: false, error: 'AUTH_BAD_PUBKEY' }; }
  if (derived.toLowerCase() !== String(address).toLowerCase()) return { ok: false, error: 'AUTH_ADDRESS_MISMATCH' };
  const digest = actionDigest({ chain, action, body, nonce, expiry });
  let key;
  try { key = pubKeyObject(fromPub); } catch { return { ok: false, error: 'AUTH_BAD_PUBKEY' }; }
  try {
    const ok = crypto.verify(null, Buffer.from(digest, 'hex'), key, Buffer.from(String(signature), 'hex'));
    return ok ? { ok: true, digest } : { ok: false, error: 'AUTH_BAD_SIGNATURE' };
  } catch { return { ok: false, error: 'AUTH_BAD_SIGNATURE' }; }
}

// Персистентное одноразовое хранилище nonce (файл JSON; LRU-очистка по expiry).
export function makeNonceStore(file, maxSize = 20000) {
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { map = {}; }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(map)); } catch {} };
  return {
    use(nonce, expiry) {
      const k = String(nonce);
      if (map[k]) return false;
      map[k] = Number(expiry) || 0;
      const keys = Object.keys(map);
      if (keys.length > maxSize) { // чистка самых старых
        keys.sort((a, b) => map[a] - map[b]).slice(0, keys.length - maxSize).forEach((x) => delete map[x]);
      }
      save();
      return true;
    },
    has(nonce) { return Boolean(map[String(nonce)]); },
  };
}

/* Идемпотентный исполнитель подписанных запросов (ответ на 3 вопроса, п.2).
   Семантика:
   - первый приём nonce: выполняет эффект один раз, сохраняет { digest, result };
   - повтор с тем ЖЕ nonce и тем ЖЕ телом (тот же digest): эффекта нет,
     возвращается сохранённый результат с replay:true (потеря ответа безопасна);
   - тот же nonce с ИЗМЕНЁННЫМ телом (другой digest): отказ NONCE_BODY_MISMATCH,
     эффект не выполняется и сохранённый результат не отдаётся как чужой;
   - хранилище персистентно (файл JSON), переживает рестарт; записи чистятся по expiry.
   digest считается вызывающим через actionDigest (та же каноника, что подпись). */
export function makeIdempotentExecutor(file, maxSize = 20000) {
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { map = {}; }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(map)); } catch {} };
  return {
    run({ nonce, digest, expiry }, effect) {
      const k = String(nonce);
      const prev = map[k];
      if (prev) {
        if (prev.digest !== String(digest)) return { ok: false, error: 'NONCE_BODY_MISMATCH', note: 'тот же nonce с другим телом: отказ, эффект не повторён' };
        return { ok: true, replay: true, result: prev.result };
      }
      const result = effect();
      map[k] = { digest: String(digest), result, expiry: Number(expiry) || 0 };
      const keys = Object.keys(map);
      if (keys.length > maxSize) {
        keys.sort((a, b) => (map[a].expiry || 0) - (map[b].expiry || 0)).slice(0, keys.length - maxSize).forEach((x) => delete map[x]);
      }
      save();
      return { ok: true, replay: false, result };
    },
    get(nonce) { return map[String(nonce)] || null; },
  };
}
