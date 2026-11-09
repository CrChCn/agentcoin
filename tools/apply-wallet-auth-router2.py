#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AGIP-W2R v2: чистый патчер node.mjs — роутер /auth/* «Ядро Агента».
Только добавление: один вызов handleWalletAuth перед /wallet-роутом + одна строка цели страницы."""
import io, sys

SRC = 'tools/node.mjs.fetched'
DST = 'tools/node.mjs.patched'

BLOCK = u"""/* ==================== AGIP-W2R: /auth/* — «Ядро Агента» (новый /wallet) ====================
   Аддитивный роутер многофакторного входа: JWT (HMAC-SHA256, привязка к IP), PIN (scrypt),
   WebAuthn (Face ID/Touch ID, ES256 P-256, серверная верификация challenge/origin/rpIdHash),
   вход по файлу-паспорту (через существующую машину кабинета challenge/signature), честная
   SMS-заглушка (ключей шлюза нет), выход (revoke jti / epoch logout-all).
   Логика ядра не переписана: cabinet.challenge / cabinet.loginChallenge используются как есть. */

const WA_FILE = path.join(__dirname, 'data', 'wallet-auth.json');
const WA_TTL_MS = 12 * 3600 * 1000;           // JWT живёт 12 ч
let waStore = null;
function waLoad() {
  if (waStore) return waStore;
  try { waStore = JSON.parse(fs.readFileSync(WA_FILE, 'utf8')); }
  catch { waStore = { secret: null, pins: {}, creds: {}, webNonces: {}, revoked: { issued: {} }, epoch: {} }; }
  waStore.pins = waStore.pins || {}; waStore.creds = waStore.creds || {}; waStore.webNonces = waStore.webNonces || {};
  waStore.revoked = waStore.revoked || { issued: {} }; waStore.revoked.issued = waStore.revoked.issued || {};
  waStore.epoch = waStore.epoch || {};
  if (!waStore.secret) waStore.secret = crypto.randomBytes(48).toString('hex');
  return waStore;
}
function waPersist() { try { fs.writeFileSync(WA_FILE, JSON.stringify(waLoad(), null, 1)); } catch {} }
const waB64u = (buf) => Buffer.from(buf).toString('base64url');
const waUnb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function waIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  if (xf) return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function waJwtIssue(sub) {
  const jti = crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  const h = waB64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = waB64u(JSON.stringify({ sub, ip: null, ep: waLoad().epoch[sub] || 0, jti, iat: now, exp: now + WA_TTL_MS }));
  const pp = JSON.parse(waUnb64u(p).toString('utf8'));
  return { jti, jwt: null, make: (ip) => {
    pp.ip = ip;
    const body = waB64u(JSON.stringify(pp));
    const sig = crypto.createHmac('sha256', waLoad().secret).update(h + '.' + body).digest('base64url');
    return h + '.' + body + '.' + sig;
  }, payload: pp };
}
function waJwtVerify(tok, req) {
  if (typeof tok !== 'string' || tok.length > 4096) return { ok: false, why: 'bad_token' };
  const parts = tok.split('.');
  if (parts.length !== 3) return { ok: false, why: 'malformed' };
  const expSig = crypto.createHmac('sha256', waLoad().secret).update(parts[0] + '.' + parts[1]).digest('base64url');
  const a = Buffer.from(expSig), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, why: 'bad_signature' };
  let p; try { p = JSON.parse(waUnb64u(parts[1]).toString('utf8')); } catch { return { ok: false, why: 'bad_payload' }; }
  if (!p || typeof p.sub !== 'string' || typeof p.ip !== 'string' || typeof p.jti !== 'string') return { ok: false, why: 'bad_payload' };
  if (!p.exp || Date.now() >= p.exp) return { ok: false, why: 'expired' };
  // Отзыв — только живой: просроченная запись описывает прошлое и подчищается лениво.
  // (P0-фикс: раньше выдача сразу же помечала jti отозванным — ни одна сессия не переживала /auth/session.)
  const rj = waLoad().revoked.issued[p.jti];
  if (rj) { if (rj > Date.now()) return { ok: false, why: 'revoked' }; delete waLoad().revoked.issued[p.jti]; }
  if (waLoad().epoch[p.sub] && p.ep !== waLoad().epoch[p.sub]) return { ok: false, why: 'epoch_invalidated' };
  if (p.ip !== waIp(req)) return { ok: false, why: 'ip_changed_invalidated' }; // AC-7
  return { ok: true, p };
}
function waBearer(req) { return waAuthToken(req).tok; }
// Сессия из двух источников: Bearer (CLI/тесты/совместимость) либо HttpOnly-cookie
// agt_wa (браузер). Кука ставится ответами входа и никогда не читается из JS.
function waAuthToken(req) {
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) { const t = h.slice(7).trim(); if (t) return { tok: t, via: 'bearer' }; }
  const ck = String(req.headers.cookie || '');
  const m = ck.match(/(?:^|;\\s*)agt_wa=([^;]{1,4096})/);
  if (m) { try { const t = decodeURIComponent(m[1]).trim(); if (t) return { tok: t, via: 'cookie' }; } catch {} }
  return { tok: null, via: null };
}
// Куки-сессия требует явного JS-заголовка: обычная cross-site форма его не выставит.
// Второй рубеж — SameSite=Strict на самой куке.
function waCsrfOk(req) {
  const h = String(req.headers['x-requested-with'] || req.headers['x-csrf'] || '').toLowerCase();
  return h === 'xmlhttprequest' || h === '1';
}
function waTls(req) {
  return !!((req.socket && req.socket.encrypted) ||
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}
function waSetSessionCookie(res, jwt, req) {
  // Secure — только поверх TLS: на loopback-тестах без HTTPS кука иначе не сохранится.
  res.setHeader('Set-Cookie', 'agt_wa=' + encodeURIComponent(jwt) +
    '; Path=/; HttpOnly; SameSite=Strict' + (waTls(req) ? '; Secure' : ''));
}
function waClearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'agt_wa=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}
function waIssueAndRegister(sub, req) {
  const ip = waIp(req);
  const w = waJwtIssue(sub);
  const jwt = w.make(ip);
  // Выдача НЕ помечает jti отозванным (иначе сессия умирала бы в тот же миг).
  // Отзыв — только явный: /auth/logout (jti) или /auth/logout-all (epoch).
  return jwt;
}

/* ---- минимальный CBOR-декодер для attestationObject/authData (ES256 COSE-ключ) ---- */
function waCbor(buf, pos, end) {
  end = end == null ? buf.length : end; pos = pos || 0;
  if (pos >= end) throw new Error('cbor_eof');
  const b = buf[pos++]; const maj = b >> 5; const ago = b & 31;
  const readLen = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[pos + i]; pos += n; return v; };
  let len = ago < 24 ? ago : ago === 24 ? readLen(1) : ago === 25 ? readLen(2) : ago === 26 ? readLen(4) : ago === 27 ? readLen(8) : null;
  if (len === null) throw new Error('cbor_len');
  if (maj === 0 || maj === 1) return { v: maj === 0 ? len : -1 - len, pos };
  if (maj === 7) {
    if (ago === 20) return { v: false, pos };
    if (ago === 21) return { v: true, pos };
    if (ago === 22) return { v: null, pos };
    if (ago < 20) throw new Error('cbor_simple');
    return { v: buf.slice(pos, pos + len), pos: pos + len };
  }
  if (maj === 2 || maj === 3) return { v: buf.slice(pos, pos + len), pos: pos + len };
  if (maj === 4) { const arr = []; for (let i = 0; i < len; i++) { const it = waCbor(buf, pos, end); arr.push(it.v); pos = it.pos; } return { v: arr, pos }; }
  if (maj === 5) {
    const m = {};
    for (let i = 0; i < len; i++) { const k = waCbor(buf, pos, end); const val = waCbor(buf, k.pos, end); m[k.v] = val.v; pos = val.pos; }
    return { v: m, pos };
  }
  throw new Error('cbor_maj' + maj);
}
const WA_ALLOWED_ORIGINS = new Set(['https://agentcoin.work', 'https://www.agentcoin.work', 'https://node1.agentcoin.work', 'http://localhost:8787', 'http://127.0.0.1:8787']);
function waWebAuthnCd(clientDataB64, kind, nonceRec) {
  let cd; try { cd = JSON.parse(waUnb64u(clientDataB64).toString('utf8')); } catch { throw new Error('bad_clientDataJSON'); }
  if (cd.type !== kind) throw new Error('clientData_type_' + cd.type);
  if (!cd.challenge || waUnb64u(cd.challenge).toString('base64url') !== nonceRec.challenge) throw new Error('challenge_mismatch');
  if (!WA_ALLOWED_ORIGINS.has(String(cd.origin || ''))) throw new Error('origin_not_allowed');
  return cd;
}
function waCoseToJwk(co) {
  if (co[1] !== 2 || co[3] !== -7) throw new Error('cose_want_ES256');
  if (co[-1] !== 1) throw new Error('cose_want_P256');
  return { kty: 'EC', crv: 'P-256', x: waB64u(co[-2]), y: waB64u(co[-3]) };
}
function waAuthDataCheck(authDataBuf, expectRp, needUV) {
  if (!authDataBuf || authDataBuf.length < 37) throw new Error('authData_short');
  const rpHash = crypto.createHash('sha256').update(expectRp).digest();
  if (!authDataBuf.slice(0, 32).equals(rpHash)) throw new Error('rpIdHash_mismatch');
  const flags = authDataBuf[32];
  if (!(flags & 0x01)) throw new Error('user_present_required');
  if (needUV && !(flags & 0x04)) throw new Error('user_verified_required');
  return { flags, counter: authDataBuf.readUInt32BE(33) };
}

/* ---- единая точка входа новых маршрутов (вызывать ДО /wallet-роутов) ---- */
async function handleWalletAuth(req, res, p) {
  const bodyJ = await body(req).catch(() => ({}));
  const J = (code, o) => { json(res, code, o); return true; };
  // Анти-CSRF для куки-сессий: Bearer-источники не затрагиваются.
  const wa = waAuthToken(req);
  if (wa.via === 'cookie' && req.method === 'POST' && !waCsrfOk(req))
    return J(403, { ok: false, error: 'csrf_header_required',
      hint: 'куки-сессия требует заголовок X-Requested-With: XMLHttpRequest' });

  if (p === '/auth/session') {
    const tok = wa.tok; if (!tok) return J(401, { ok: false, error: 'no_token' });
    const v = waJwtVerify(tok, req);
    if (!v.ok) return J(401, { ok: false, error: 'session_invalidated', reason: v.why });
    const sub = v.p.sub, S = waLoad();
    // Кабинетный токен для /cabinet/*:browser-сессия по куке восстанавливается без
    // повторного входа; клиент хранит его только в памяти и обновляет при каждой проверке.
    let cabTok = null;
    try { const cs = cabinet.issueSession(sub, 'wallet-jwt'); if (cs && cs.ok) cabTok = cs.token; } catch {}
    return J(200, { ok: true, sub, ip: waIp(req), exp: v.p.exp, cabinetToken: cabTok,
      pinSet: !!S.pins[sub], faceOn: Object.values(S.creds).some((c) => c.sub === sub), phoneSet: false });
  }
  if (p === '/auth/file/challenge') {
    const address = (bodyJ || {}).address;
    if (typeof address !== 'string' || address.length > 96) return J(400, { error: 'bad_address' });
    const r = cabinet.challenge(address); // переиспользуем машину кабинета, логика не переписана
    if (!r.ok) return J(400, { error: r.error || 'challenge_failed' });
    return J(200, { ok: true, address, nonce: r.nonce, challengeId: r.challengeId, ttlSec: r.ttlSec || 300 });
  }
  if (p === '/auth/file/login') {
    const { address, nonce, challengeId, signature } = bodyJ || {};
    const r = cabinet.loginChallenge(address, nonce, signature, challengeId);
    if (!r.ok) return J(400, { error: r.error || 'login_failed', hint: 'подпишите challenge (CLI) и повторите' });
    const waJwt = waIssueAndRegister(address, req); waSetSessionCookie(res, waJwt, req);
    return J(200, { ok: true, sub: address, walletJwt: waJwt, cabinetToken: r.token || null });
  }
  if (p === '/auth/pin/set' || p === '/auth/pin/disable') {
    const tok = wa.tok; const v = tok ? waJwtVerify(tok, req) : { ok: false };
    if (!v.ok) return J(401, { ok: false, error: 'session_required', reason: v.why });
    const sub = v.p.sub, S = waLoad();
    if (p === '/auth/pin/disable') { delete S.pins[sub]; waPersist(); return J(200, { ok: true, pinSet: false }); }
    const pin = (bodyJ || {}).pin;
    if (typeof pin !== 'string' || !/^\\d{4,6}$/.test(pin)) return J(400, { error: 'pin_must_be_4_6_digits' });
    const salt = crypto.randomBytes(16).toString('hex');
    S.pins[sub] = { salt: salt, hash: crypto.scryptSync(pin, salt, 32).toString('hex'), set: Date.now() };
    waPersist(); return J(200, { ok: true, pinSet: true });
  }
  if (p === '/auth/pin/login') {
    const pin = (bodyJ || {}).pin;
    if (typeof pin !== 'string' || !/^\\d{4,6}$/.test(pin)) return J(400, { error: 'pin_must_be_4_6_digits' });      const S = waLoad(); S.pinFails = S.pinFails || {};
      // Лимит попыток PIN (зеркало pin-auth.mjs: 5 неверных — замок 10 минут, сброс успехом).
      const fk = 'ip:' + waIp(req);
      const fe = S.pinFails[fk];
      if (fe && fe.lockedUntil > Date.now())
        return J(401, { error: 'pin_locked_try_later', hint: 'Слишком много неверных попыток. Подождите 10 минут или войдите по паспорту.' });
      let hit = null;
      for (const sub of Object.keys(S.pins)) {
      const rec = S.pins[sub];
      const cand = crypto.scryptSync(pin, rec.salt, 32);
      const a = Buffer.from(rec.hash, 'hex');
      if (a.length === cand.length && crypto.timingSafeEqual(a, cand)) { hit = sub; break; }
    }      if (!hit) {
        const fails = (fe && fe.lockedUntil > 0 && fe.lockedUntil <= Date.now() ? 0 : (fe ? fe.fails : 0)) + 1;
        if (fails >= 5) {
          S.pinFails[fk] = { fails: fails, lockedUntil: Date.now() + 10 * 60 * 1000 }; waPersist();
          return J(401, { error: 'pin_locked_try_later', hint: 'Слишком много неверных попыток. Подождите 10 минут или войдите по паспорту.' });
        }
        S.pinFails[fk] = { fails: fails, lockedUntil: 0 }; waPersist();
        return J(401, { error: 'pin_not_matched' });
      }      delete S.pinFails[fk]; waPersist();
      const waJwtPin = waIssueAndRegister(hit, req); waSetSessionCookie(res, waJwtPin, req);
    return J(200, { ok: true, sub: hit, walletJwt: waJwtPin });
  }
  if (p === '/auth/webauthn/challenge') {
    // Challenge привязан к режиму и (если известен) к адресу: nonce регистрации
    // нельзя потратить на вход и наоборот; для входа по известному адресу сервер
    // возвращает allowCredentials — клиент обязан декодировать id в бинарный вид.
    const mode = (bodyJ && bodyJ.mode === 'register') ? 'register' : 'login';
    const wsub = (bodyJ && typeof bodyJ.address === 'string' && bodyJ.address) || null;
    const ch = crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomBytes(10).toString('hex');      // Лимит выдачи challenge: не более 20 живых на адрес (защита nonce-хранилища от спама).
      { const _S = waLoad(); for (const _nk of Object.keys(_S.webNonces)) { const _r = _S.webNonces[_nk]; if (!_r || _r.exp <= Date.now() || _r.used) delete _S.webNonces[_nk]; } waPersist();
        const _live = Object.keys(_S.webNonces).filter(function (_nk) { const _r = _S.webNonces[_nk]; return _r && (wsub ? _r.sub === wsub : !_r.sub); }).length;
        if (_live >= 20) return J(429, { error: 'webauthn_challenge_rate_limited', hint: 'слишком много незавершённых challenge — завершите вход или дождитесь истечения (2 мин)' }); }
      waLoad().webNonces[id] = { challenge: ch, exp: Date.now() + 2 * 60 * 1000, used: false, mode: mode, sub: wsub };
    waPersist();
    let allow = [];
    if (mode === 'login' && wsub) {
      for (const cid of Object.keys(waLoad().creds))
        if (waLoad().creds[cid].sub === wsub) allow.push({ type: 'public-key', id: cid, transports: ['internal'] });
    }
    return J(200, { id, challenge: ch, mode: mode, allowCredentials: allow });
  }
  if (p === '/auth/webauthn/register') {
    const tok = wa.tok; const v = tok ? waJwtVerify(tok, req) : { ok: false };
    if (!v.ok) return J(401, { ok: false, error: 'session_required', reason: v.why });
    const sub = v.p.sub;
    const { id, credential } = bodyJ || {};
    if (!id || !credential || !credential.clientDataJSON || !credential.attestationObject) return J(400, { error: 'credential_fields_missing' });
    let nonce = null, nonceKey = null;
    for (const nk of Object.keys(waLoad().webNonces)) {
      const rec = waLoad().webNonces[nk];
      if (rec.exp > Date.now() && !rec.used) { nonce = rec; nonceKey = nk; break; }
    }      if (!nonce) return J(400, { error: 'webauthn_challenge_not_issued' });
      if (nonce.mode && nonce.mode !== 'register') return J(400, { error: 'webauthn_mode_mismatch' });
      nonce.used = true;
      try {
        waWebAuthnCd(credential.clientDataJSON, 'webauthn.create', nonce);
      const att = waCbor(waUnb64u(credential.attestationObject));
      const authData = att.v && att.v.authData;
      const ad = waAuthDataCheck(authData, 'agentcoin.work', false);
      const off = 37 + 16, credLen = authData.readUInt16BE(off);
      const cose = waCbor(authData, off + 2 + credLen).v;
      const jwk = waCoseToJwk(cose);
      waLoad().creds[id] = { sub: sub, jwk: jwk, counter: ad.counter, created: Date.now() };
      delete waLoad().webNonces[nonceKey];
      waPersist();
      return J(200, { ok: true, faceOn: true });
    } catch (e) {
      if (nonceKey) delete waLoad().webNonces[nonceKey];
      waPersist();
      return J(400, { error: 'webauthn_register_failed', detail: e.message });
    }
  }
  if (p === '/auth/webauthn/login') {
    const { id, credential } = bodyJ || {};
    const c = id && waLoad().creds[id];
    if (!credential || !c) return J(400, { error: 'credential_unknown' });
    let nonce = null, nonceKey = null;
    for (const nk of Object.keys(waLoad().webNonces)) {
      const rec = waLoad().webNonces[nk];
      if (rec.exp > Date.now() && !rec.used) { nonce = rec; nonceKey = nk; break; }
    }      if (!nonce) return J(400, { error: 'webauthn_challenge_not_issued' });
      if (nonce.mode && nonce.mode !== 'login') return J(400, { error: 'webauthn_mode_mismatch' });
      nonce.used = true;
      try {
        waWebAuthnCd(credential.clientDataJSON, 'webauthn.get', nonce);
      const authData = waUnb64u(credential.authenticatorData);
      const ad = waAuthDataCheck(authData, 'agentcoin.work', false);
      if (ad.counter && c.counter && ad.counter <= c.counter) throw new Error('counter_replay');
      const clientHash = crypto.createHash('sha256').update(waUnb64u(credential.clientDataJSON)).digest();
      const ok = crypto.verify('sha256', Buffer.concat([authData, clientHash]),
        crypto.createPublicKey({ key: c.jwk, format: 'jwk' }), waUnb64u(credential.signature));
      if (!ok) throw new Error('assertion_signature_invalid');
      c.counter = ad.counter;
      delete waLoad().webNonces[nonceKey];
      waPersist();
      const waJwtFace = waIssueAndRegister(c.sub, req); waSetSessionCookie(res, waJwtFace, req);
      return J(200, { ok: true, sub: c.sub, walletJwt: waJwtFace });
    } catch (e) {
      if (nonceKey) delete waLoad().webNonces[nonceKey];
      waPersist();
      return J(401, { error: 'webauthn_login_failed', detail: e.message });
    }
  }
  if (p === '/auth/webauthn/disable') {
    const tok = wa.tok; const v = tok ? waJwtVerify(tok, req) : { ok: false };
    if (!v.ok) return J(401, { ok: false, error: 'session_required' });
    let n = 0;
    for (const id of Object.keys(waLoad().creds)) if (waLoad().creds[id].sub === v.p.sub) { delete waLoad().creds[id]; n++; }
    waPersist(); return J(200, { ok: true, removed: n });
  }
  if (p === '/auth/sms/send' || p === '/auth/sms/verify') {
    // Честная заглушка: шлюз (Twilio/Textbelt) не подключён — ключей нет.
    const hint = 'SMS-вход временно недоступен: шлюз (Twilio/Textbelt) не подключён — нет ключей. Используйте Face ID, PIN или файл-сертификат.';
    return J(200, { ok: false, gateway: 'not_configured', error: 'sms_gateway_not_configured', message: hint, hint: hint });
  }
  if (p === '/auth/logout') {
    const tok = wa.tok; const v = tok ? waJwtVerify(tok, req) : { ok: false, why: 'no_token' };
    if (v.ok) { waLoad().revoked.issued[v.p.jti] = Date.now() + WA_TTL_MS; waPersist(); }
    waClearSessionCookie(res);
    return J(200, { ok: true, logged_out: true });
  }
  if (p === '/auth/logout-all') {
    const tok = wa.tok; const v = tok ? waJwtVerify(tok, req) : { ok: false, why: 'no_token' };
    let cabRev = 0;
    if (v.ok) {
      waLoad().epoch[v.p.sub] = (waLoad().epoch[v.p.sub] || 0) + 1; waPersist();
      // Кросс-отзыв: «выйти везде» гасит и кабинетные токены адреса (cabinet.revokeAll).
      try { if (typeof cabinet !== 'undefined' && cabinet && typeof cabinet.revokeAll === 'function') cabRev = cabinet.revokeAll(v.p.sub).revoked || 0; } catch {}
    }
    waClearSessionCookie(res);
    return J(200, { ok: true, all_sessions_invalidated: !!v.ok, cabinet_revoked: cabRev });
  }
  return false; // не наш маршрут
}

/* ==================== конец AGIP-W2R ==================== */
"""

src = io.open(SRC, encoding='utf-8', newline='').read()

marker = "  if (p === '/wallet' || p === '/wallet.html') return serveSitePage(res, 'user-wallet-page.html');"
assert marker in src, u'маркер /wallet-роута не найден'
assert 'AGIP-W2R: /auth/' not in src, u'патч уже применён'

inject = u"  const _waHandled = await handleWalletAuth(req, res, p);\n  if (_waHandled) return;\n\n" + BLOCK + "\n" + marker
out = src.replace(marker, inject, 1)

wmark2 = "if (p === '/wallet' || p === '/wallet.html') return serveSitePage(res, 'user-wallet-page.html');"
assert out.count(wmark2) == 1, out.count(wmark2)
out = out.replace(wmark2, "if (p === '/wallet' || p === '/wallet.html') return serveSitePage(res, 'wallet.html');\n  if (p === '/user-wallet-page.html') return serveSitePage(res, 'user-wallet-page.html');", 1)

# AGIP-W2R: /auth/* — публичная POST-поверхность нового кошелька (админ-гейт остаётся нетронутым
# для остальных админ-роутов: просто добавляем префикс к проверки белого списка)
gate = "PUB_REQUEST_RE.test(p) || (req.method === 'POST' && PUB_TX_ROUTES.has(p))"
gateNew = "PUB_REQUEST_RE.test(p) || (req.method === 'POST' && PUB_TX_ROUTES.has(p)) || (req.method === 'POST' && p.startsWith('/auth/'))"
assert out.count(gate) == 1
out = out.replace(gate, gateNew, 1)
assert "handleWalletAuth(obj)" not in out
assert out.count('handleWalletAuth') >= 2
assert out.count("AGIP-W2R: /auth/") == 1

io.open(DST, 'w', encoding='utf-8', newline='').write(out)
print('patched OK ->', DST, 'size', len(out))
