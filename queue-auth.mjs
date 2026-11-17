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
// Восстановление после аварии: внутри lockDir лежит info.json {pid, at}. Если процесс
// умер, держа lock (kill -9 / падение ОС), lockDir остаётся; следующий владелец сносит
// его и забирает (mkdir снова атомарна — побеждает ровно один). Условие кражи строгое:
// живой держатель — никогда; мёртвый pid — только после grace 2с (переходный teardown
// pid и флэп проверки живости не крадут свежий lock, иначе два держателя в секции =
// двойной эффект); lock без pid (legacy) — после staleMs=15с. Критическая секция —
// миллисекунды, живой держатель так долго lock не держит. Без восстановления любая
// авария в секции давала бы вечный WAL_LOCK_TIMEOUT — закрыто здесь + тестом crash-holding-lock.
export const WAL_LOCK_STALE_MS = 15000;
// Выдержка для мёртвого держателя: даже при мёртвом pid сносим только lock старше
// grace — это закрывает переходные состояния teardown/reuse pid и короткие
// флэпы проверки живости: ложная кража свежего lock = двойной эффект (1-in-N
// флак гонки двух процессов). Цена — восстановление после kill -9 занимает ~2с
// вместо мгновенного, что укладывается в тайм-аут ожидания lock (5с).
export function lockInfo(file) {
  const lockDir = String(file) + '.lock';
  try {
    const raw = fs.readFileSync(path.join(lockDir, 'info.json'), 'utf8');
    return { ...JSON.parse(raw), lockDir };
  } catch {
    try { const st = fs.statSync(lockDir); return { at: st.mtimeMs, lockDir, legacy: true }; }
    catch { return null; }
  }
}
export function pidAlive(pid) {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  if (n === process.pid) return true;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
export const WAL_LOCK_DEAD_GRACE_MS = 2000;
export function recoverStaleLock(file, { staleMs = WAL_LOCK_STALE_MS, deadGraceMs = WAL_LOCK_DEAD_GRACE_MS } = {}) {
  const info = lockInfo(file);
  if (!info) return { ok: true, recovered: false, reason: 'no-lock' };
  const age = Date.now() - Number(info.at || 0);
  // Кража — только застарелого lock: живой держатель — никогда; мёртвый pid —
  // только после grace (переходный teardown pid + флэп живости не должны красть
  // свежий lock, иначе два держателя в секции = двойной эффект). Без pid
  // (legacy-остатки) — только по полному staleMs.
  const holderDead = info.pid !== undefined && !pidAlive(info.pid);
  const threshold = holderDead ? Math.min(Number(staleMs), Number(deadGraceMs)) : Number(staleMs);
  if (!(age > threshold)) return { ok: false, error: 'LOCK_ACTIVE', ageMs: Math.max(0, Math.round(age)) };
  try { fs.unlinkSync(path.join(String(file) + '.lock', 'info.json')); } catch {}
  try { fs.rmdirSync(String(file) + '.lock'); } catch (e) { return { ok: false, error: 'LOCK_RECOVER_RACE' }; }
  return { ok: true, recovered: true, ageMs: Math.round(age) };
}
export function withFileLock(file, fn, { timeoutMs = 5000, pollMs = 5, staleMs = WAL_LOCK_STALE_MS, deadGraceMs = WAL_LOCK_DEAD_GRACE_MS } = {}) {
  const lockDir = String(file) + '.lock';
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      try { fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: process.pid, at: Date.now() })); } catch {}
      break;
    }
    catch (e) {
      if (e && (e.code === 'EEXIST' || e.code === 'EACCES')) {
        // Протухший lock — снести и повторить борьбу за mkdir. Порог — как в
        // recoverStaleLock: живой — никогда; мёртвый — после grace; без pid — staleMs.
        const info = lockInfo(file);
        const age = info ? Date.now() - Number(info.at || 0) : 0;
        const dead = info && info.pid !== undefined && !pidAlive(info.pid);
        const threshold = dead ? Math.min(Number(staleMs), Number(deadGraceMs)) : Number(staleMs);
        if (process.env.AGT_WAL_DEBUG && info && (age > threshold)) {
          try { fs.appendFileSync(process.env.AGT_WAL_DEBUG, JSON.stringify({ t: Date.now(), me: process.pid, stoleFrom: info.pid, ageMs: Math.round(age), dead: !!dead, file: String(file) }) + '\n'); } catch {}
        }
        if (info && (age > threshold)) {
          const r = recoverStaleLock(file, { staleMs, deadGraceMs });
          if (r.ok && r.recovered) continue; // гонку за снос выиграл — пробуем mkdir снова
        }
        if (Date.now() - start > timeoutMs) throw new Error('WAL_LOCK_TIMEOUT');
        const end = Date.now() + pollMs;
        while (Date.now() < end) {} // короткое ожидание без зависимостей
        continue;
      }
      throw e;
    }
  }
  try { return fn(); }
  finally {
    try { fs.unlinkSync(path.join(lockDir, 'info.json')); } catch {}
    try { fs.rmdirSync(lockDir); } catch {}
  }
}
/* Область уникальности nonce: ключ = address|nonce (адрес — нижний регистр).
   Без scope (старые вызовы/тесты) — глобальный ключ nonce (обратная совместимость).
   Зачем: один и тот же текст nonce у РАЗНЫХ адресов обязан не мешать друг другу
   (иначе чужой nonce = вечный NONCE_BODY_MISMATCH = межпользовательский DoS).
   Один адрес + один nonce = идемпотентность по digest (§4 спеки). */
export function nonceKey(nonce, scope) {
  const n = String(nonce);
  if (n.includes('|')) throw new Error('NONCE_HAS_SEPARATOR');
  if (!scope) return n;
  const s = String(scope).toLowerCase();
  if (!s || s.includes('|')) throw new Error('NONCE_SCOPE_BAD');
  return s + '|' + n;
}
export function makeIdempotentExecutor(file, maxSize = 20000) {
  const load = () => {
    let m = {};
    try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { m = {}; }
    for (const [k, v] of Object.entries(m)) {
      if (v && typeof v === 'object' && !v.state && v.digest !== undefined) m[k] = { ...v, state: 'done', operationId: v.operationId || String(k).split('|').pop() };
      else if (v && typeof v === 'object' && !v.operationId) m[k] = { ...v, operationId: String(k).split('|').pop() };
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
    begin({ nonce, digest, expiry, scope }) {
      return withFileLock(file, () => {
        refresh();
        const k = nonceKey(nonce, scope);
        const opId = String(nonce);
        const prev = map[k];
        if (prev) {
          if (prev.digest !== String(digest)) return { ok: false, error: 'NONCE_BODY_MISMATCH', operationId: opId };
          if (prev.state === 'done') return { ok: true, replay: true, result: prev.result, operationId: opId };
          return { ok: false, error: 'NONCE_PENDING_RETRY', note: 'reconcile, ne povtor vslepuyu', operationId: opId };
        }
        map[k] = { digest: String(digest), state: 'pending', result: null, expiry: Number(expiry) || 0, operationId: opId, scope: scope ? String(scope).toLowerCase() : null };
        save();
        return { ok: true, reserved: true, operationId: opId };
      });
    },
    commit(nonce, result, scope = null) {
      const realScope = scope || null; // scope третьим аргументом; без него — поиск голого и scoped-ключей
      return withFileLock(file, () => {
        refresh();
        // Обратная совместимость: commit(nonce, result) без scope ищет и голый, и scoped-ключи с этим nonce.
        let k = null;
        try { k = nonceKey(nonce, realScope || null); } catch { return { ok: false, error: 'NONCE_SCOPE_BAD', operationId: String(nonce) }; }
        let prev = map[k];
        if (!prev && !realScope) {
          const hit = Object.keys(map).find((kk) => kk === String(nonce) || kk.endsWith('|' + String(nonce)));
          if (hit) { k = hit; prev = map[hit]; }
        }
        const opId = String(nonce);
        if (!prev) return { ok: false, error: 'NONCE_NOT_RESERVED', operationId: opId };
        if (prev.state === 'done') return { ok: true, replay: true, result: prev.result, operationId: opId };
        map[k] = { ...prev, state: 'done', result, operationId: opId };
        prune();
        save();
        return { ok: true, operationId: opId };
      });
    },
    // Три исхода сверки; неопределённый НЕ снимает бронь.
    resolvePending(nonce, resolution, scope) {
      return withFileLock(file, () => {
        refresh();
        let k;
        try { k = nonceKey(nonce, scope || (resolution && resolution.scope) || null); } catch { return { ok: false, error: 'NONCE_SCOPE_BAD', operationId: String(nonce) }; }
        let prev = map[k];
        if ((!prev || prev.state !== 'pending') && !(scope || (resolution && resolution.scope))) {
          const hit = Object.keys(map).find((kk) => (kk === String(nonce) || kk.endsWith('|' + String(nonce))) && map[kk] && map[kk].state === 'pending');
          if (hit) { k = hit; prev = map[hit]; }
        }
        const opId = String(nonce);
        if (!prev || prev.state !== 'pending') return { ok: false, error: 'NOT_PENDING', operationId: opId };
        const st = resolution && resolution.status;
        if (st === 'proven-not-executed') { delete map[k]; save(); return { ok: true, aborted: true, operationId: opId }; }
        if (st === 'aborted') { delete map[k]; save(); return { ok: true, aborted: true, operationId: opId }; }
        if (st === 'effect-confirmed') {
          map[k] = { ...prev, state: 'done', result: resolution.result ?? null, operationId: opId };
          save();
          return { ok: true, restored: true, operationId: opId };
        }
        return { ok: false, error: 'NEEDS_RECONCILE', note: 'unknown outcome: keep pending', operationId: opId };
      });
    },
    pendingList() { refresh(); return Object.entries(map).filter(([, v]) => v && v.state === 'pending').map(([k]) => k); },
    run({ nonce, digest, expiry, scope }, effect) {
      const b = this.begin({ nonce, digest, expiry, scope });
      if (!b.ok) return b;
      if (b.replay) return b;
      let result;
      try { result = effect(); } catch (e) { throw e; }
      this.commit(nonce, result, scope || null);
      return { ok: true, replay: false, result };
    },
    get(nonce, scope) {
      refresh();
      if (scope) return map[nonceKey(nonce, scope)] || null;
      return map[String(nonce)] || Object.entries(map).find(([kk]) => kk.endsWith('|' + String(nonce)))?.[1] || null;
    },
    _file: file,
  };
}
