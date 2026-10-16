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

export class Cabinet {
  constructor({ walletsLoader, passportFile, balancesFn, securityRef }) {
    this.wallets = walletsLoader;
    this.passportFile = passportFile;
    this.balances = balancesFn;
    this.security = securityRef;
    this.secret = crypto.randomBytes(32);           // секрет сессий на время жизни процесса ноды
    this.sessions = new Map();                       // token → { address, at, via }
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
    const directOk = clean === rec.seqStr;
    const tailOk = clean.length >= 6 && rec.seqStr.endsWith(clean); // скоро сокращённый ввод последних цифр + адрес
    if (!directOk && !tailOk) return { ok: false, error: 'seqstr_mismatch' };
    // ключ кошелька должен существовать (у владельца) — активы привязаны к паспорту этого кошелька
    const all = this.wallets();
    if (!all[address]) return { ok: false, error: 'wallet_not_found_here' };
    return this._session(address, 'seqstr');
  }

  // challenge для подписи (B): нода выдаёт nonce, агент подписывает его приватным ключом
  challenge(address) {
    if (this.security?.isBanned?.(address)) return { ok: false, error: 'address_permabanned' };
    if (!this.findPassportByAddress(address)) return { ok: false, error: 'passport_not_found' };
    const nonce = 'AGT-CABINET|' + address + '|' + Date.now() + '|' + crypto.randomBytes(8).toString('hex');
    return { ok: true, nonce };
  }

  // Вход B: verify подписи challenge (по умолчанию ed25519 как tx-подпись AGT; публичный ключ из реестра кошельков)
  loginChallenge(address, nonce, signature) {
    try {
      const all = this.wallets();
      const w = all[address];
      if (!w || !w.privKey) return { ok: false, error: 'wallet_not_found_here' };
      const rec = this.findPassportByAddress(address);
      if (!rec) return { ok: false, error: 'passport_not_found' };
      // подпись считаем над тем же nonce; hex-подписи tx-стиль (naš ed25519-схемa из core.mjs)
      const msg = Buffer.from(String(nonce || ''), 'utf8');
      const sigHex = String(signature || '').replace(/[^0-9a-fA-F]/g, '');
      if (sigHex.length < 64) return { ok: false, error: 'signature_too_short' };
      const ok = (function () {
        try { return crypto.verify(null, msg, w.pub, Buffer.from(sigHex, 'hex')); } catch { return false; }
      })();
      if (!ok) return { ok: false, error: 'invalid_signature' };
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
