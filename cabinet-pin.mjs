/* ============================================================
   cabinet-pin.mjs — PIN-доступ кабинета (AGENTCOIN).
   PIN = короткий、BROWSER-удобный фактор ПОСЛЕ владения ключом:
   задать/отключить — только живой сессией своего адреса
   (challenge-подпись или уже PIN), вход — по адресу+PIN.
   Хеш scrypt хранится на ноде, слова/ключи сюда не попадают.
   Брутфорс закрыт лимитом: 5 ошибок → замок 15 минут на адрес.
   ============================================================ */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const PIN_KDF = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32 });
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

export function validAddress(address) {
  return typeof address === 'string' && /^AGT[0-9a-f]{40}$/.test(address);
}

export class PinStore {
  constructor({ file, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.attempts = new Map(); // address -> { fails, lockedUntil }
  }

  _load() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  _save(all) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(all));
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {}
    } catch {
      throw new Error('pin_store_unavailable');
    }
  }

  _locked(address) {
    const a = this.attempts.get(address);
    if (!a) return 0;
    if (a.lockedUntil && a.lockedUntil > this.now()) return a.lockedUntil - this.now();
    if (a.lockedUntil && a.lockedUntil <= this.now()) this.attempts.delete(address);
    return 0;
  }

  _fail(address) {
    const a = this.attempts.get(address) || { fails: 0, lockedUntil: 0 };
    a.fails += 1;
    if (a.fails >= MAX_FAILS) a.lockedUntil = this.now() + LOCK_MS;
    this.attempts.set(address, a);
    return a;
  }

  status(address) {
    if (!validAddress(address)) throw new Error('invalid_address');
    return { ok: true, pinSet: !!this._load()[address] };
  }

  async set(address, pin) {
    if (!validAddress(address)) throw new Error('invalid_address');
    if (!validPin(pin)) throw new Error('pin_format');
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(pin, salt, PIN_KDF.keyLength, { N: PIN_KDF.N, r: PIN_KDF.r, p: PIN_KDF.p });
    const all = this._load();
    all[address] = { salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: this.now() };
    this._save(all);
    this.attempts.delete(address);
    return { ok: true, pinSet: true };
  }

  async verify(address, pin) {
    if (!validAddress(address)) throw new Error('invalid_address');
    const wait = this._locked(address);
    if (wait > 0) {
      return { ok: false, error: 'pin_locked', hint: 'Слишком много ошибок. Повтори через минуту.', retryAfterSec: Math.ceil(wait / 1000) };
    }
    const rec = this._load()[address];
    if (!rec) return { ok: false, error: 'pin_not_set' };
    if (typeof pin !== 'string') {
      this._fail(address);
      return { ok: false, error: 'pin_mismatch' };
    }
    let digest;
    try {
      digest = await scrypt(pin, Buffer.from(rec.salt, 'hex'), PIN_KDF.keyLength, { N: PIN_KDF.N, r: PIN_KDF.r, p: PIN_KDF.p });
    } catch {
      this._fail(address);
      return { ok: false, error: 'pin_mismatch' };
    }
    if (digest.length === 32 && crypto.timingSafeEqual(digest, Buffer.from(rec.hash, 'hex'))) {
      this.attempts.delete(address);
      return { ok: true };
    }
    const a = this._fail(address);
    const left = Math.max(0, MAX_FAILS - a.fails);
    return { ok: false, error: 'pin_mismatch', hint: left > 0 ? 'PIN не совпадает. Осталось попыток: ' + left : 'Замок на 15 минут.', attemptsLeft: left };
  }

  disable(address) {
    if (!validAddress(address)) throw new Error('invalid_address');
    const all = this._load();
    delete all[address];
    this._save(all);
    this.attempts.delete(address);
    return { ok: true, pinSet: false };
  }
}
