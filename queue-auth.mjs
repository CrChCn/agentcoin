/* queue-auth — подпись действий очереди (v2, изолированно; рабочая очередь не тронута).
   Формат: ed25519-подпись каноники { chain, action, body, nonce, expiry }.
   chain фиксирован ('AGENTCOIN'): подпись для другой сети здесь недействительна.
   Адрес выводится из fromPub теми же функциями, что консенсус (core.mjs). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

/* Идемпотентный исполнитель с журналом (п.1 приёмки: атомарность nonce+действие
   МЕЖДУ ПРОЦЕССАМИ). Протокол: lock (mkdir exclusive) → перечитать файл → reserve
   (WAL pending, запись tmp+fsync+rename+fsync dir) ДО эффекта → unlock → effect →
   lock → commit (done) → unlock. tmp+rename без lock недостаточно: два процесса
   могли оба прочитать "нет записи" и оба записать reserve. mkdir — атомарна в
   ядре (POSIX/Windows: EEXIST при гонке), поэтому резерв ровно один.
   Гарантии сохранения: запись идёт в tmp с fsync файла, затем rename, затем fsync
   директории — после commit запись переживает падение ОС (на одной файловой
   системе; rename атомарна). Конкурент видит pending → NONCE_PENDING_RETRY без
   исполнения; рестарт видит pending и НЕ переисполняет вслепую: повтор —
   NONCE_PENDING_RETRY до явного resolvePending. resolve три исхода:
   effect-confirmed (эффект доказан — восстановить результат), proven-not-executed
   (доказанно не исполнен — разрешить безопасное снятие брони), unknown — оставить
   pending на сверке (НЕ снимать вслепую). Чужое тело — MISMATCH. Старый формат
   {digest,result} читается как done. Эффект связан с постоянным operationId:
   operationId = String(nonce); хранится в записи и возвращается в результате. */
function fsyncDirOf(file) {
  try {
    const d = path.dirname(String(file));
    // fsync директории доступен на POSIX; на Windows — no-op без ошибки для вызывающего.
    const fd = fs.openSync(d, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
}
function atomicWriteJsonDurable(file, obj) {
  const tmp = String(file) + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, String(file));
  fsyncDirOf(file);
}
function atomicWriteJson(file, obj) { atomicWriteJsonDurable(file, obj); }
// Межпроцессный мьютекс: атомарный mkdir. Держится только на критической секции
// чтения-записи журнала (миллисекунды), НЕ на время effect().
export function withFileLock(file, fn, { timeoutMs = 5000, pollMs = 5 } = {}) {
  const lockDir = String(file) + '.lock';
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lockDir); break; }
    catch (e) {
      if (e && (e.code === 'EEXIST' || e.code === 'EACCES')) {
        if (Date.now() - start > timeoutMs) throw new Error('WAL_LOCK_TIMEOUT');
        const end = Date.now() + pollMs;
        while (Date.now() < end) {} // короткое ожидание без зависимостей
        continue;
      }
      throw e;
    }
  }
  try { return fn(); }
  finally { try { fs.rmdirSync(lockDir); } catch {} }
}
export function makeIdempotentExecutor(file, maxSize = 20000) {
  const load = () => {
    let m = {};
    try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { m = {}; }
    for (const [k, v] of Object.entries(m)) {
      if (v && typeof v === 'object' && !v.state && v.digest !== undefined) m[k] = { ...v, state: 'done', operationId: String(k) };
      else if (v && typeof v === 'object' && !v.operationId) m[k] = { ...v, operationId: String(k) };
    }
    return m;
  };
  let map = load();
  const save = () => { try { atomicWriteJsonDurable(file, map); } catch {} };
  const prune = () => {
    const keys = Object.keys(map);
    if (keys.length > maxSize) {
      keys.sort((a, b) => (map[a].expiry || 0) - (map[b].expiry || 0)).slice(0, keys.length - maxSize).forEach((x) => delete map[x]);
    }
  };
  const refresh = () => { map = load(); };
  return {
    begin({ nonce, digest, expiry }) {
      return withFileLock(file, () => {
        refresh();
        const k = String(nonce);
        const prev = map[k];
        if (prev) {
          if (prev.digest !== String(digest)) return { ok: false, error: 'NONCE_BODY_MISMATCH', operationId: k };
          if (prev.state === 'done') return { ok: true, replay: true, result: prev.result, operationId: k };
          return { ok: false, error: 'NONCE_PENDING_RETRY', note: 'reconcile, ne povtor vslepuyu', operationId: k };
        }
        map[k] = { digest: String(digest), state: 'pending', result: null, expiry: Number(expiry) || 0, operationId: k };
        save();
        return { ok: true, reserved: true, operationId: k };
      });
    },
    commit(nonce, result) {
      return withFileLock(file, () => {
        refresh();
        const k = String(nonce);
        const prev = map[k];
        if (!prev) return { ok: false, error: 'NONCE_NOT_RESERVED', operationId: k };
        if (prev.state === 'done') return { ok: true, replay: true, result: prev.result, operationId: k };
        map[k] = { ...prev, state: 'done', result, operationId: k };
        prune();
        save();
        return { ok: true, operationId: k };
      });
    },
    // Три исхода сверки; неопределённый НЕ снимает бронь.
    resolvePending(nonce, resolution) {
      return withFileLock(file, () => {
        refresh();
        const k = String(nonce);
        const prev = map[k];
        if (!prev || prev.state !== 'pending') return { ok: false, error: 'NOT_PENDING', operationId: k };
        const st = resolution && resolution.status;
        if (st === 'proven-not-executed') { delete map[k]; save(); return { ok: true, aborted: true, operationId: k }; }
        if (st === 'aborted') { delete map[k]; save(); return { ok: true, aborted: true, operationId: k }; }
        if (st === 'effect-confirmed') {
          map[k] = { ...prev, state: 'done', result: resolution.result ?? null, operationId: k };
          save();
          return { ok: true, restored: true, operationId: k };
        }
        return { ok: false, error: 'NEEDS_RECONCILE', note: 'unknown outcome: keep pending', operationId: k };
      });
    },
    pendingList() { refresh(); return Object.entries(map).filter(([, v]) => v && v.state === 'pending').map(([k]) => k); },
    run({ nonce, digest, expiry }, effect) {
      const b = this.begin({ nonce, digest, expiry });
      if (!b.ok) return b;
      if (b.replay) return b;
      let result;
      try { result = effect(); } catch (e) { throw e; }
      this.commit(nonce, result);
      return { ok: true, replay: false, result };
    },
    get(nonce) { refresh(); return map[String(nonce)] || null; },
    _file: file,
  };
}
