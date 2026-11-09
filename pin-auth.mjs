// PIN-auth для кабинета: запасной вход по адресу + PIN (4–6 цифр).
// PIN — только альтернатива паспортной подписи, не замена: устанавливается и
// отключается только живой сессией паспорта; сессии выдаёт Cabinet.
// Хранение: scrypt-хеш (salt 16 байт, N=16384/r=8/p=1, ключ 32 байта) в
// <dataDir>/pin-auth.json. Антибрут: 5 неверных попыток подряд → замок 10 мин
// на адрес (в памяти; сессии и так живут в памяти ноды).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ADDR_RE = /^AGT[0-9a-f]{40}$/;
const PIN_RE = /^[0-9]{4,6}$/;
// Тест/оператор может смягчить антибрут (по прецеденту AGT_SESSION_CAP); вне
// диапазона — значения по умолчанию: 5 попыток, замок 10 минут.
function numEnv(name, def, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
}
const MAX_FAILS = numEnv('AGT_PIN_MAX_FAILS', 5, 1, 100);
const LOCK_MS = numEnv('AGT_PIN_LOCK_MS', 10 * 60_000, 100, 3_600_000);

function scryptHash(pin, saltHex) {
  return crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

export class PinAuth {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'pin-auth.json');
    this.locks = new Map(); // address -> { fails, lockedUntil }
  }
  _read() {
    try {
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (r && typeof r === 'object' && r.pins && typeof r.pins === 'object') return r.pins;
    } catch {}
    return {};
  }
  _write(pins) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, pins }, null, 2));
    fs.renameSync(tmp, this.file);
  }
  hasPin(address) {
    if (!ADDR_RE.test(address || '')) return false;
    return Boolean(this._read()[address]);
  }
  setPin(address, pin) {
    if (!ADDR_RE.test(address || '')) return { ok: false, error: 'invalid_address' };
    if (!PIN_RE.test(pin || '')) return { ok: false, error: 'pin_must_be_4_6_digits', hint: 'PIN — 4–6 цифр.' };
    const pins = this._read();
    const salt = crypto.randomBytes(16).toString('hex');
    pins[address] = { salt, hash: scryptHash(pin, salt), set: Date.now() };
    this._write(pins);
    this.locks.delete(address);
    return { ok: true, pinSet: true };
  }
  disable(address) {
    if (!ADDR_RE.test(address || '')) return { ok: false, error: 'invalid_address' };
    const pins = this._read();
    delete pins[address];
    this._write(pins);
    this.locks.delete(address);
    return { ok: true, pinSet: false };
  }
  verify(address, pin) {
    if (!ADDR_RE.test(address || '')) return { ok: false, error: 'invalid_address' };
    if (!PIN_RE.test(pin || '')) return { ok: false, error: 'pin_must_be_4_6_digits', hint: 'PIN — 4–6 цифр.' };
    const now = Date.now();
    const lock = this.locks.get(address);
    if (lock && lock.lockedUntil > now) return { ok: false, error: 'pin_locked_try_later', hint: 'Слишком много неверных попыток. Подождите 10 минут или войдите по паспорту.' };
    const rec = this._read()[address];
    if (!rec) return { ok: false, error: 'pin_not_set', hint: 'PIN не настроен. Сначала войди по паспорту и настрой PIN в разделе «Безопасность».' };
    let match = false;
    try {
      match = crypto.timingSafeEqual(Buffer.from(scryptHash(pin, rec.salt), 'hex'), Buffer.from(rec.hash, 'hex'));
    } catch { match = false; }
    if (match) { this.locks.delete(address); return { ok: true }; }
    // Сброс счётчика — только если БЫЛ замок и он истёк (lockedUntil: 0 замком не является).
    const fails = (lock && lock.lockedUntil > 0 && lock.lockedUntil <= now ? 0 : (lock?.fails || 0)) + 1;
    if (fails >= MAX_FAILS) {
      this.locks.set(address, { fails, lockedUntil: now + LOCK_MS });
      return { ok: false, error: 'pin_locked_try_later', hint: 'Слишком много неверных попыток. Подождите 10 минут или войдите по паспорту.' };
    }
    this.locks.set(address, { fails, lockedUntil: 0 });
    return { ok: false, error: 'pin_invalid', hint: 'Неверный PIN.', attemptsLeft: MAX_FAILS - fails };
  }
}
