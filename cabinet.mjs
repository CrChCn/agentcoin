// Cabinet authentication uses public keys only. A session can read a cabinet;
// it never authorizes a transaction or grants operator access.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { addressFromPub } from './core.mjs';
import { createAgentChallenge, canonicalAgentPublicKey, AGENT_IDENTITY_DOMAIN, isRawAgentPubHex, rawAgentPubToPem, addressFromRawAgentPub, bindPubToAddress } from './agent-identity.mjs';
import { PinStore, validPin } from './cabinet-pin.mjs';

const SESSION_TTL_MS = 8 * 3600_000;
// Поддержка сырого ключа живёт в agent-identity.mjs (isRawAgentPubHex /
// rawAgentPubToPem / addressFromRawAgentPub). TOFU принимает обе формы:
// PEM — через canonicalAgentPublicKey, hex — через браузерную схему.
const MAX_CHALLENGES = 1000;
const MAX_SESSIONS = 1000;
const MAX_OPS = 1000; // AGIP-46: живых заявок на подпись операций на ноду
const OP_TTL_MS = 5 * 60_000; // так же, как login-challenge: подписать успеет — иначе перевыпустить
// AGIP-44 STAGE-1 (2026-10-18, решение оператора): максимум ОДНОВРЕМЕННО активных
// сессий на паспорт. Не IP-лимит и не email — владение остаётся у ключа; кап
// ограничивает число живых session-токенов одного агента (анти-Сибила: комнаты
// токенов/клиентов, а не честная переносимость между нодами). Порта при попытке 8-го
// входа — выталкивается старейшая живая сессия ТОГО ЖЕ агента (честный агент не
// отрезается от доступа, а комната с 8+ мёртвыми вкладками — самоочищается). Env
// AGT_SESSION_CAP меняет значение (тест/оператор), вне диапазона [1..MAX_SESSIONS] → 7.
const DEFAULT_SESSION_CAP = 7;
function sessionCap() {
  const n = Number(process.env.AGT_SESSION_CAP);
  return Number.isFinite(n) && n >= 1 && n <= MAX_SESSIONS ? Math.floor(n) : DEFAULT_SESSION_CAP;
}
export class Cabinet {
  constructor({ walletsLoader = () => ({}), passportFile, pinFile, balancesFn, securityRef,
    identityRegistry, now = Date.now }) {
    this.wallets = walletsLoader; this.passportFile = passportFile;
    // PIN-хранилище опционально: без pinFile PIN-маршруты отвечают pin_store_unavailable.
    this.pins = pinFile ? new PinStore({ file: pinFile, now }) : null;
    this.balances = balancesFn; this.security = securityRef;
    this.identityRegistry = identityRegistry; this.now = now;
    this.sessions = new Map(); this.challenges = new Map();
    // AGIP-46: заявки на подписание операций. Отдельный стор — login-challenge не может
    // израсходоваться как подтверждение операции и наоборот. Живёт только в RAM (5 мин).
    this.opRequests = new Map();
    // Запомненные публичные ключи (адрес → PEM/hex): только публичное, только RAM.
    // Позволяют key-only сессиям (в т.ч. после перезагрузки страницы или входа
    // по PIN) готовить операции без повторного ввода ключа. Привязка каждый
    // раз перепроверяется через bindPubToAddress — подобрать чужой нельзя.
    this.knownPub = new Map();
    this.fallbackFingerprint = 'sha256:' + crypto.randomBytes(32).toString('hex');
  }

  // ---- AGIP-46: заявка на подпись операции (только живой сессией своего адреса) ----
  stashOp(address, token, data) {
    try {
      if (!this.session(address, token)) throw new Error('session_required');
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_op_data');
      if (!['send', 'order', 'job-claim'].includes(data.kind)) throw new Error('unsupported_op_kind');
      if (data.address !== address) throw new Error('op_address_mismatch');
      this._pruneOps();
      if (this.opRequests.size >= MAX_OPS) throw new Error('op_capacity');
      if ([...this.opRequests.values()].filter(o => o.address === address).length >= 20) throw new Error('op_address_capacity');
      const opId = crypto.randomBytes(16).toString('hex');
      this.opRequests.set(opId, { opId, kind: data.kind, address, passportPub: data.passportPub || null,
        data: { ...data, passportPub: undefined }, expiresAt: this.now() + OP_TTL_MS });
      return { ok: true, opId, ttlSec: OP_TTL_MS / 1000 };
    } catch (e) { return { ok: false, error: e.message || 'op_stash_failed' }; }
  }
  // Атомарное гашение: сначала удаляем (успешной или нет — повторный submit всегда мимо).
  takeOp(opId) {
    this._pruneOps();
    const rec = typeof opId === 'string' ? this.opRequests.get(opId) : null;
    if (rec) this.opRequests.delete(opId);
    return rec || null;
  }
  _pruneOps() {
    const now = this.now();
    for (const [id, o] of this.opRequests) if (o.expiresAt <= now) this.opRequests.delete(id);
  }
  passports() {
    try { const r = JSON.parse(fs.readFileSync(this.passportFile, 'utf8')); return Array.isArray(r) ? r : (r.passports || []); }
    catch { return []; }
  }
  findPassportByAddress(address) {
    const legacy = this.passports().find(r => r?.address === address);
    if (legacy?.revoked) return null;
    return this.identityRegistry?.findByAddress(address) || legacy || null;
  }
  loginSeqStr() {
    return { ok: false, error: 'signature_required', hint: 'Номер паспорта не является секретом. Подпишите challenge локально.' };
  }
  _prune() {
    const now = this.now();
    for (const [id, c] of this.challenges) if (c.expiresAt <= now) this.challenges.delete(id);
    for (const [id, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(id);
  }
  // challenge(address, pub=null). Паспортный путь — как раньше. Без паспорта —
  // вход владением ключом (TOFU): клиент присылает pub, нода проверяет, что
  // address == addressFromPub(pub). Подделать нельзя: подпись проверяется этим
  // же ключом, а подобрать pub под чужой адрес невозможно. Сессия key-only:
  // чтение кабинета + PIN, расходы по-прежнему только локальной подписью.
  challenge(address, pub = null) {
    try {
      if (typeof address !== 'string' || !/^AGT[0-9a-f]{40}$/.test(address)) throw new Error('invalid_address');
      if (this.security?.isBanned?.(address)) throw new Error('address_permabanned');
      const rec = this.findPassportByAddress(address);
      let keyOnly = false, usePub, rawOnly = false;
      if (rec) {
        usePub = canonicalAgentPublicKey(rec.pub || this.wallets()[address]?.pub);
        if (addressFromPub(usePub) !== address) throw new Error('address_public_key_mismatch');
      } else {
        if (pub === null || pub === undefined) throw new Error('passport_not_found');
        if (isRawAgentPubHex(pub)) {
          usePub = pub.toLowerCase();
          if (addressFromRawAgentPub(usePub) !== address) throw new Error('address_public_key_mismatch');
          rawOnly = true;
        } else {
          usePub = canonicalAgentPublicKey(pub);
          if (addressFromPub(usePub) !== address) throw new Error('address_public_key_mismatch');
        }
        keyOnly = true;
      }
      this._prune();
      if (this.challenges.size >= MAX_CHALLENGES) throw new Error('challenge_capacity');
      const meta = this.identityRegistry?.meta() || { network: 'AGENTCOIN', audience: 'agentcoin', issuerFingerprint: this.fallbackFingerprint };
      let c;
      if (rawOnly) {
        // Сырой pub вне PEM-пространства: challengeFields его бы отверг,
        // поэтому объект собираем вручную тем же каноническим порядком полей.
        // Подпись сверяется с этим же message — подмена невозможна.
        const issuedAt = this.now();
        c = { version: 1, domain: AGENT_IDENTITY_DOMAIN, action: 'login',
          network: meta.network, audience: meta.audience, issuerFingerprint: meta.issuerFingerprint,
          address, pub: usePub, handle: '', challengeId: crypto.randomBytes(16).toString('hex'),
          nonce: crypto.randomBytes(32).toString('hex'), issuedAt, expiresAt: issuedAt + 300_000 };
        c.message = AGENT_IDENTITY_DOMAIN + '\n' + JSON.stringify([
          c.version, c.action, c.network, c.issuerFingerprint, c.audience, c.address,
          c.pub, c.handle, c.challengeId, c.nonce, c.issuedAt, c.expiresAt]);
      } else {
        c = createAgentChallenge({ action: 'login', network: meta.network,
          audience: meta.audience, issuerFingerprint: meta.issuerFingerprint, address, pub: usePub }, { now: this.now() });
      }
      c.keyOnly = keyOnly;
      this.challenges.set(c.challengeId, c);
      return { ok: true, challenge: c, nonce: c.message, challengeId: c.challengeId, ttlSec: 300, keyOnly };
    } catch (e) { return { ok: false, error: e.code || e.message || 'challenge_failed' }; }
  }
  loginChallenge(address, nonce, signature, challengeId) {
    try {
      if (typeof address !== 'string' || typeof nonce !== 'string' || nonce.length > 4096 || typeof signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(signature)) throw new Error('invalid_login');
      if (this.security?.isBanned?.(address)) throw new Error('address_permabanned');
      const issued = challengeId ? this.challenges.get(challengeId) : [...this.challenges.values()].find(c => c.address === address && c.message === nonce);
      if (!issued || issued.address !== address || issued.message !== nonce) throw new Error('challenge_not_issued');
      if (this.now() >= issued.expiresAt) { this.challenges.delete(issued.challengeId); throw new Error('challenge_expired'); }
      const rec = this.findPassportByAddress(address);
      let pub, keyOnly = !!issued.keyOnly;
      if (rec) {
        pub = rec.pub || this.wallets()[address]?.pub;
        if (pub !== issued.pub) throw new Error('passport_changed');
        keyOnly = false;
      } else {
        if (!issued.keyOnly) throw new Error('passport_changed');
        pub = issued.pub;
      }
      const verifyPub = (typeof pub === 'string' && pub.startsWith('-----BEGIN PUBLIC KEY-----')) ? pub : rawAgentPubToPem(pub);
      if (!crypto.verify(null, Buffer.from(issued.message, 'utf8'), verifyPub, Buffer.from(signature, 'hex'))) throw new Error('invalid_signature');
      // Invalid public requests cannot consume another agent's valid challenge.
      this.challenges.delete(issued.challengeId);
      // Запоминаем ключ успешного входа (публичное!) для будущих op-request.
      try { if (typeof pub === 'string' && pub) this.knownPub.set(address, pub); } catch {}
      return this._session(address, 'challenge-signature', keyOnly);
    } catch (e) { return { ok: false, error: e.message || 'login_failed' }; }
  }
  countActiveSessions(address) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.address === address) n++;
    return n;
  }
  // Публичная выдача кабинет-сессии после PIN/WebAuthn: фактор входа уже проверен,
  // ключ паспорта остаётся обязательным для op-submit. Расход этим не разрешается.
  issueSession(address, via = 'pin') {
    try {
      if (!this.findPassportByAddress(address)) return { ok: false, error: 'passport_not_found' };
      if (this.security?.isBanned?.(address)) return { ok: false, error: 'address_permabanned' };
      return this._session(address, via);
    } catch (e) { return { ok: false, error: e.message || 'session_failed' }; }
  }
  _session(address, via, keyOnly = false) {
    this._prune();
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, error: 'session_capacity' };
    const cap = sessionCap();
    let rotated = false;
    if (this.countActiveSessions(address) >= cap) {
      // Ротация по AGIP-44 STAGE-1: выталкиваем старейшую СВОЮ живую сессию      // (порядок вставки Map = порядок выдачи; при равенстве expiresAt это      // детерминированный выбор). Чужие сессии не затрагиваются.
      for (const [id, s] of this.sessions) {
        if (s.address !== address) continue;
        this.sessions.delete(id);
        rotated = true;
        break;
      }
    }
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.sessions.set(token, { address, via, expiresAt, keyOnly: !!keyOnly });
    return { ok: true, token, address, expiresAt, ttlSec: SESSION_TTL_MS / 1000,
      sessionCap: cap, activeSessions: this.countActiveSessions(address), rotated };
  }
  session(address, token) {
    if (typeof token !== 'string') return null;
    const s = this.sessions.get(token);
    if (!s || s.address !== address) return null;
    if (s.expiresAt <= this.now() || this.security?.isBanned?.(address)) { this.sessions.delete(token); return null; }
    // key-only сессии (вход владением ключом / PIN без паспорта) живут без паспорта.
    if (!s.keyOnly && !this.findPassportByAddress(address)) { this.sessions.delete(token); return null; }
    return s;
  }
  logout(token) { this.sessions.delete(token); return { ok: true }; }
  // Публичный ключ адреса, запомненный при успешном входе ключом (или null).
  // Возвращает только если ключ ВНУТРИ своей схемы вяжется к адресу.
  sessionPubFor(address) {
    try {
      const saved = this.knownPub.get(address);
      if (typeof saved !== 'string' || !saved) return null;
      return bindPubToAddress(address, saved);
    } catch { return null; }
  }
  // ---- PIN-доступ (контракт user-wallet-page.html) ----
  pinStatus(address) {
    try {
      if (!this.pins) throw new Error('pin_store_unavailable');
      return this.pins.status(address);
    } catch (e) { return { ok: false, error: e.message || 'pin_status_failed' }; }
  }
  async pinSet(address, token, pin) {
    try {
      if (!this.pins) throw new Error('pin_store_unavailable');
      if (!this.session(address, token)) throw new Error('session_invalid_or_foreign');
      if (!validPin(pin)) throw new Error('pin_format');
      return await this.pins.set(address, pin);
    } catch (e) { return { ok: false, error: e.message || 'pin_save_failed' }; }
  }
  async pinLogin(address, pin) {
    try {
      if (!this.pins) throw new Error('pin_store_unavailable');
      if (this.security?.isBanned?.(address)) throw new Error('address_permabanned');
      const v = await this.pins.verify(address, pin);
      if (!v.ok) return v;
      const keyOnly = !this.findPassportByAddress(address);
      const s = this._session(address, 'pin', keyOnly);
      if (!s.ok) return s;
      return { ok: true, token: s.token, address, expiresAt: s.expiresAt, ttlSec: s.ttlSec, keyOnly };
    } catch (e) { return { ok: false, error: e.message || 'pin_login_failed' }; }
  }
  pinDisable(address, token) {
    try {
      if (!this.pins) throw new Error('pin_store_unavailable');
      if (!this.session(address, token)) throw new Error('session_invalid_or_foreign');
      return this.pins.disable(address);
    } catch (e) { return { ok: false, error: e.message || 'pin_disable_failed' }; }
  }
  state(address, via) {
    const rec = this.findPassportByAddress(address);
    const bal = this.balances()[address] || 0;
    return { ok: !!via, address, via,
      passport: rec ? { agentId: rec.agentId || null, seq: rec.seq || null,
        seqStrMasked: typeof rec.seqStr === 'string' ? '****' + rec.seqStr.slice(-4) : null,
        handle: rec.handle, tax: rec.tax, issuedAt: rec.issuedAt,
        certificate: rec.certificate || null } : null,
      wallet: { address, baoAGT: bal, baoMGNT: Math.max(0, Math.round(bal * 1e9)) },
      sessions: { active: this.countActiveSessions(address), cap: sessionCap(), ttlHours: SESSION_TTL_MS / 3600_000 },
      note: 'Ключ хранится у агента. Сессия не разрешает расходы; операции подписываются локально. Максимум одновременно активных сессий на паспорт — см. sessions.cap (перевесил старую — вытесняется). Приватные сессии других агентов недоступны.' };
  }
}
