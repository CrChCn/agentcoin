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

/* Идемпотентный исполнитель с журналом (п.1 приёмки: атомарность nonce+действие).
   Прежде effect() выполнялся ДО записи {digest,result} — падение
   между давало повторное исполнение. Протокол: reserve (WAL pending,
   атомарная запись tmp+rename) ДО эффекта → effect → commit (done).
   Конкурент видит pending и получает NONCE_PENDING_RETRY без исполнения;
   рестарт видит pending и НЕ переисполняет вслепую: повтор —
   NONCE_UNKNOWN_NEEDS_RECONCILE до явного resolvePending (reconcile с очередью).
   Чужое тело — MISMATCH. Старый формат {digest,result} читается как done. */
function atomicWriteJson(file, obj) {
  const tmp = String(file) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, String(file));
}
export function makeIdempotentExecutor(file, maxSize = 20000) {
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { map = {}; }
  for (const [k, v] of Object.entries(map)) {
    if (v && typeof v === 'object' && !v.state && v.digest !== undefined) map[k] = { ...v, state: 'done' };
  }
  const save = () => { try { atomicWriteJson(file, map); } catch {} };
  const prune = () => {
    const keys = Object.keys(map);
    if (keys.length > maxSize) {
      keys.sort((a, b) => (map[a].expiry || 0) - (map[b].expiry || 0)).slice(0, keys.length - maxSize).forEach((x) => delete map[x]);
    }
  };
  return {
    begin({ nonce, digest, expiry }) {
      const k = String(nonce);
      const prev = map[k];
      if (prev) {
        if (prev.digest !== String(digest)) return { ok: false, error: 'NONCE_BODY_MISMATCH' };
        if (prev.state === 'done') return { ok: true, replay: true, result: prev.result };
        return { ok: false, error: 'NONCE_PENDING_RETRY', note: 'reconcile, ne povtor vslepuyu' };
      }
      map[k] = { digest: String(digest), state: 'pending', result: null, expiry: Number(expiry) || 0 };
      save();
      return { ok: true, reserved: true };
    },
    commit(nonce, result) {
      const k = String(nonce);
      const prev = map[k];
      if (!prev) return { ok: false, error: 'NONCE_NOT_RESERVED' };
      map[k] = { ...prev, state: 'done', result };
      prune();
      save();
      return { ok: true };
    },
    resolvePending(nonce, resolution) {
      const k = String(nonce);
      const prev = map[k];
      if (!prev || prev.state !== 'pending') return { ok: false, error: 'NOT_PENDING' };
      if (resolution && resolution.status === 'aborted') { delete map[k]; save(); return { ok: true, aborted: true }; }
      map[k] = { ...prev, state: 'done', result: resolution ? resolution.result : null };
      save();
      return { ok: true };
    },
    pendingList() { return Object.entries(map).filter(([, v]) => v && v.state === 'pending').map(([k]) => k); },
    run({ nonce, digest, expiry }, effect) {
      const b = this.begin({ nonce, digest, expiry });
      if (!b.ok) return b;
      if (b.replay) return b;
      let result;
      try { result = effect(); } catch (e) { throw e; }
      this.commit(nonce, result);
      return { ok: true, replay: false, result };
    },
    get(nonce) { return map[String(nonce)] || null; },
  };
}
