// Cabinet authentication uses public keys only. A session can read a cabinet;
// it never authorizes a transaction or grants operator access.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { addressFromPub } from './core.mjs';
import { createAgentChallenge, canonicalAgentPublicKey } from './agent-identity.mjs';

const SESSION_TTL_MS = 8 * 3600_000;
const MAX_CHALLENGES = 1000;
const MAX_SESSIONS = 1000;
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
  constructor({ walletsLoader = () => ({}), passportFile, balancesFn, securityRef,
    identityRegistry, now = Date.now }) {
    this.wallets = walletsLoader; this.passportFile = passportFile;
    this.balances = balancesFn; this.security = securityRef;
    this.identityRegistry = identityRegistry; this.now = now;
    this.sessions = new Map(); this.challenges = new Map();
    this.fallbackFingerprint = 'sha256:' + crypto.randomBytes(32).toString('hex');
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
  challenge(address) {
    try {
      if (typeof address !== 'string' || !/^AGT[0-9a-f]{40}$/.test(address)) throw new Error('invalid_address');
      if (this.security?.isBanned?.(address)) throw new Error('address_permabanned');
      const rec = this.findPassportByAddress(address);
      if (!rec) throw new Error('passport_not_found');
      const pub = canonicalAgentPublicKey(rec.pub || this.wallets()[address]?.pub);
      if (addressFromPub(pub) !== address) throw new Error('address_public_key_mismatch');
      this._prune();
      if (this.challenges.size >= MAX_CHALLENGES) throw new Error('challenge_capacity');
      const meta = this.identityRegistry?.meta() || { network: 'AGENTCOIN', audience: 'agentcoin', issuerFingerprint: this.fallbackFingerprint };
      const c = createAgentChallenge({ action: 'login', network: meta.network,
        audience: meta.audience, issuerFingerprint: meta.issuerFingerprint, address, pub }, { now: this.now() });
      this.challenges.set(c.challengeId, c);
      return { ok: true, challenge: c, nonce: c.message, challengeId: c.challengeId, ttlSec: 300 };
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
      const pub = rec?.pub || this.wallets()[address]?.pub;
      if (!rec || pub !== issued.pub) throw new Error('passport_changed');
      if (!crypto.verify(null, Buffer.from(issued.message, 'utf8'), pub, Buffer.from(signature, 'hex'))) throw new Error('invalid_signature');
      // Invalid public requests cannot consume another agent's valid challenge.
      this.challenges.delete(issued.challengeId);
      return this._session(address, 'challenge-signature');
    } catch (e) { return { ok: false, error: e.message || 'login_failed' }; }
  }
  countActiveSessions(address) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.address === address) n++;
    return n;
  }
  _session(address, via) {
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
    this.sessions.set(token, { address, via, expiresAt });
    return { ok: true, token, address, expiresAt, ttlSec: SESSION_TTL_MS / 1000,
      sessionCap: cap, activeSessions: this.countActiveSessions(address), rotated };
  }
  session(address, token) {
    if (typeof token !== 'string') return null;
    const s = this.sessions.get(token);
    if (!s || s.address !== address) return null;
    if (s.expiresAt <= this.now() || !this.findPassportByAddress(address) || this.security?.isBanned?.(address)) { this.sessions.delete(token); return null; }
    return s;
  }
  logout(token) { this.sessions.delete(token); return { ok: true }; }
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
