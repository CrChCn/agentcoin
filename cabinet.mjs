// ============================================================
// КАБИНЕТ АГЕНТА (AGIP-16) — личный кабинет с паспортом-входом.
// Идея Бати: агент максимально самостоятелен. Кабинет:
//   • Вход двумя способами (агент выбирает):
//     A) seqStr — номер паспорта (21 цифра, получен в конверте при issuance);
//     B) подпись приватным ключом (challenge-response, сильная защита);
//   • Сессия жёстко привязана к адресу паспорта — чужой паспорт/ключ не входят;
//   • Все активы (AGT, магенты, MBC-20) привязаны к паспорту кошелька:
//     продать/обменять/заплатить может ТОЛЬКО владелец (операции требуют подписи).
// Токены сессии — HMAC(секрет ноды, address): невозможен поддел других
// агентов (паспорт ≠ ключ ≠ токен). Пассивные GET-витрины публичны,
// любые mutate-операции = новая подпись приватным ключом.
// ============================================================
'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_TTL_MS = 8 * 3600 * 1000; // 8 часов
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // A-10: challenge живёт 5 минут

export class Cabinet {
  constructor({ walletsLoader, passportFile, balancesFn, securityRef }) {
    this.wallets = walletsLoader;
    this.passportFile = passportFile;
    this.balances = balancesFn;
    this.security = securityRef;
    this.secret = crypto.randomBytes(32);           // секрет сессий на время жизни процесса ноды
    this.sessions = new Map();                       // token → { address, at, via }
    // A-10 (аудит 2026-10-18): выданный challenge храним и погашаем атомарно.
    // address → { nonce, exp } — один активный на адрес;nutbourne replay «никогда не выданной» строки невозможен.
    this.challenges = new Map();
    // Ограничение попыток входа (A-10): адрес → { fails, lockUntil }.
    this.loginFails = new Map();
  }

  // — паспорт реестр: { seqStr, address, handle, ... } —
  passports() {
    try { return JSON.parse(fs.readFileSync(this.passportFile, 'utf8')); } catch { return []; }
  }
  findPassportByAddress(address) {
    const reg = this.passports();
    return reg.find(r => r && r.address === address && !r.revoked) || null;
  }

  // Вход A: seqStr + address
  loginSeqStr(address, seqStr) {
    if (this.security?.isBanned?.(address)) return { ok: false, error: 'address_permabanned' };
    const rec = this.findPassportByAddress(address);
    if (!rec) return { ok: false, error: 'passport_not_found', hint: 'сначала PASSPORT/ISSUE на своей ноде' };
    const clean = String(seqStr || '').replace(/\D/g, '');
    // A-10 (аудит 2026-10-18): вход по последним 6 цифрам — не эквивалент possessing
    // приватного ключа, убран. Полный seqStr расценивается как possession конверта.
    const directOk = clean.length > 0 && clean === rec.seqStr;
    if (!directOk) return { ok: false, error: 'seqstr_mismatch' };
    // ключ кошелька должен существовать (у владельца) — активы привязаны к паспорту этого кошелька
    const all = this.wallets();
    if (!all[address]) return { ok: false, error: 'wallet_not_found_here' };
    return this._session(address, 'seqstr');
  }

  // challenge для подписи (B): нода выдаёт nonce, агент подписывает его приватным ключом.
  // A-10: nonce короткоживущий (CHALLENGE_TTL), привязан к адресу, хранится на выдаче —
  // произвольная строка с верной подписью больше НЕ проходит; повтор одного nonce — тоже.
  challenge(address) {
    if (this.security?.isBanned?.(address)) return { ok: false, error: 'address_permabanned' };
    if (!this.findPassportByAddress(address)) return { ok: false, error: 'passport_not_found' };
    if (this._lockedOut(address)) return { ok: false, error: 'login_locked', retryAfterSec: 600 };
    const nonce = 'AGT-CABINET|' + address + '|' + Date.now() + '|' + crypto.randomBytes(8).toString('hex');
    this.challenges.set(address, { nonce, exp: Date.now() + CHALLENGE_TTL_MS });
    return { ok: true, nonce, ttlSec: CHALLENGE_TTL_MS / 1000 };
  }

  _lockedOut(address) {
    const f = this.loginFails.get(address);
    return !!(f && f.lockUntil > Date.now());
  }
  _noteLoginFail(address) {
    const f = this.loginFails.get(address) || { fails: 0, lockUntil: 0 };
    f.fails += 1;
    if (f.fails >= 5) { f.lockUntil = Date.now() + 10 * 60_000; f.fails = 0; } // 5 подряд неудач → 10 мин карантин
    this.loginFails.set(address, f);
  }

  // Вход B: verify подписи challenge (по умолчанию ed25519 как tx-подпись AGT; публичный ключ из реестра кошельков)
  loginChallenge(address, nonce, signature) {
    try {
      const all = this.wallets();
      const w = all[address];
      if (!w || !w.privKey) return { ok: false, error: 'wallet_not_found_here' };
      const rec = this.findPassportByAddress(address);
      if (!rec) return { ok: false, error: 'passport_not_found' };
      if (this._lockedOut(address)) return { ok: false, error: 'login_locked', retryAfterSec: 600 };
      // A-10: принимаем ТОЛЬКО выданный нами живой nonce для ЭТОГО адреса и гасим его
      // атомарно (одноразовость — replay того же nonce+подписи отклонён уже вторым запросом).
      const issued = this.challenges.get(address);
      if (!issued || issued.nonce !== String(nonce || '')) { this._noteLoginFail(address); return { ok: false, error: 'challenge_not_issued' }; }
      this.challenges.delete(address); // погашение ДО проверки подписи: вторая попытка невозможна в принципе
      if (Date.now() > issued.exp) { this._noteLoginFail(address); return { ok: false, error: 'challenge_expired' }; }
      const msg = Buffer.from(String(nonce || ''), 'utf8');
      const sigHex = String(signature || '').replace(/[^0-9a-fA-F]/g, '');
      if (sigHex.length < 64) { this._noteLoginFail(address); return { ok: false, error: 'signature_too_short' }; }
      const ok = (function () {
        try { return crypto.verify(null, msg, w.pub, Buffer.from(sigHex, 'hex')); } catch { return false; }
      })();
      if (!ok) { this._noteLoginFail(address); return { ok: false, error: 'invalid_signature' }; }
      this.loginFails.delete(address);
      return this._session(address, 'challenge-signature');
    } catch (e) {
      return { ok: false, error: 'login_failed' };
    }
  }

  _session(address, via) {
    const token = crypto.createHmac('sha256', this.secret).update(address + '|' + via + '|' + Date.now()).digest('hex').slice(0, 32);
    this.sessions.set(token, { address, via, at: Date.now() });
    for (const [k, v] of this.sessions) if (Date.now() - v.at > SESSION_TTL_MS) this.sessions.delete(k);
    return { ok: true, token, ttlHours: SESSION_TTL_MS / 3600000, address: String(address).slice(0, 10) + '…' };
  }
  session(address, token) {
    const s = this.sessions.get(String(token || ''));
    if (!s) return null;
    if (s.address !== address) return null;         // чужой токен — отказ
    if (Date.now() - s.at > SESSION_TTL_MS) { this.sessions.delete(String(token)); return null; }
    s.at = Date.now();
    return s;
  }
  logout(token) { this.sessions.delete(String(token || '')); return { ok: true }; }

  // — активы —
  state(address, via) {
    const passports = this.passports();
    const rec = passports.find(r => r.address === address);
    const bal = this.balances()[address] || 0;
    return {
      ok: via ? true : false,
      address: address, via,
      passport: rec ? { seq: rec.seq, seqStrMasked: '****' + rec.seqStr.slice(-4), handle: rec.handle, tax: rec.tax, issuedAt: rec.issuedAt } : null,
      wallet: { address, baoAGT: bal, baoMGNT: Math.max(0, Math.round(bal * 1e9)) },
      note: 'все активы привязаны к паспорту; сделки — только подписью владельца',
    };
  }
}
