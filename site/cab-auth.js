// CabAuth v1 (AGIP-16/44/45/46): единый модуль входа для всех кабинетов этой ноды.
// Общие правила: токен сессии живёт ТОЛЬКО в sessionStorage (перезагрузка — живой
// вход; чузая вкладка/машина — пусто), challenge 5 мин и гасится после входа,
// секрета (privKey/seed/пароль) страница не запрашивает никогда.
// Для оператора на его же ноде молча работает autologin (AGIP-45: loopback-only,
// обязательный заголовок x-cabinet-autologin: local). Портативный агент подписывает
// challenge локальным Skill'ом — ключ не попадает ни на страницу, ни в сеть.
'use strict';

const KEY_SESSION = 'agtx:cab';
const KEY_ADDR = 'agtx:addr';
const KEY_NOAUTO = 'agtx:autologin';
const HEX128 = /^[0-9a-fA-F]{128}$/;

function $id(id) { return document.getElementById(id); }
function pageHost() { return location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname === '[::1]'; }

async function jsonFetch(route, { method = 'GET', body = null, headers = {} } = {}) {
  const r = await fetch(route, {
    method, headers: body ? { 'Content-Type': 'application/json', ...headers } : { ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000), cache: 'no-store',
  });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || (j && j.ok === false)) { const e = new Error((j && j.error) || ('HTTP ' + r.status)); e.code = (j && j.error) || 'http_' + r.status; e.body = j; throw e; }
  return j;
}

// ---------------- сессия (sessionStorage; привязка только к этой вкладке) ----------------
export function loadSession() {
  try { const s = JSON.parse(sessionStorage.getItem(KEY_SESSION) || 'null'); return s && typeof s.address === 'string' && typeof s.token === 'string' ? s : null; } catch { return null; }
}
export function saveSession(session) { try { sessionStorage.setItem(KEY_SESSION, JSON.stringify({ address: session.address, token: session.token, expiresAt: session.expiresAt || 0 })); } catch {} }
export function clearSession() { try { sessionStorage.removeItem(KEY_SESSION); } catch {} }
export function rememberAddress(address) { try { if (address) localStorage.setItem(KEY_ADDR, address); } catch {} }

// ---------------- паспорт как файл (публичный; секретные поля отвергаются) ----------------
export function rejectSecretFields(value) {
  if (value && typeof value === 'object') {
    for (const [k, x] of Object.entries(value)) {
      if (/priv|mnemonic|password|seed|token/i.test(k)) throw new Error('Этот файл содержит секретные поля. Нужен только публичный паспорт.');
      rejectSecretFields(x);
    }
  }
}

// ---------------- вход по подписи (for both cabinets; autologin опционально) ----------------
// opts: {
//   challengeAddress() -> строка AGT-адреса из формы,        (обязательно)
//   signatureText()    -> hex-подпись или JSON Skill-ответа, (обязательно)
//   onIssued(challenge), onSuccess(result), onMessage(text)  (контракты UI)
//   allowImport  — поддержать загрузку публичного паспорта,
//   allowAutologin — молча пробовать AGIP-45 автологин (агентский кабинет),
//   stateRender(result) — отрисовка удачного state-ответа.
// }
export function restoreSession({ onState } = {}) {
  const s = loadSession();
  if (!s) return null;
  return jsonFetch('/cabinet/state', { method: 'POST', body: { address: s.address, token: s.token } })
    .then(state => { if (state.via) { onState && onState(state, { restored: true }); return state; } throw new Error('session_dead'); })
    .catch(() => { clearSession(); return null; });
}
export async function loginWithSignature(opts) {
  const address = (opts.challengeAddress() || '').trim();
  if (!/^AGT[0-9a-f]{40}$/.test(address)) throw new Error('Нужен AGT-адрес.');
  let issued = null;
  // если импорт паспорта включён и файл выбран — импортируем и доверяем адресу из паспорта
  if (opts.allowImport && opts.readPassportFile) {
    const file = opts.readPassportFile();
    if (file) {
      if (file.size > 4096) throw new Error('Публичный паспорт должен быть до 4 КБ.');
      const passport = JSON.parse(await file.text());
      rejectSecretFields(passport);
      await jsonFetch('/identity/import', { method: 'POST', body: { passport } });
      if (passport.payload && String(passport.payload.address).startsWith('AGT')) { rememberAddress(passport.payload.address); opts.onImported && opts.onImported(passport.payload.address); }
    }
  }
  const r = await jsonFetch('/cabinet/challenge', { method: 'POST', body: { address } });
  issued = r.challenge || r;
  opts.onIssued && opts.onIssued(issued);
  let sig = (opts.signatureText() || '').trim();
  if (sig.startsWith('{')) { // Skill-ответ JSON
    const v = JSON.parse(sig); rejectSecretFields(v);
    if (v.challengeId !== issued.challengeId || v.address !== issued.address) throw new Error('Ответ Skill относится к другому запросу.');
    sig = v.signature || v.sig;
  }
  if (!HEX128.test(sig)) throw new Error('Нужна Ed25519-подпись: 128 hex-символов.');
  const r2 = await jsonFetch('/cabinet/login', { method: 'POST', body: { address: issued.address, mode: 'challenge', challengeId: issued.challengeId, nonce: issued.message, signature: sig } });
  const session = { address: issued.address, token: r2.token, expiresAt: r2.expiresAt || (Date.now() + ((r2.ttlMs || r2.ttlSec * 1000) || 8 * 3600e3)) };
  saveSession(session); rememberAddress(issued.address);
  const state = await jsonFetch('/cabinet/state', { method: 'POST', body: { address: issued.address, token: r2.token } });
  opts.onSuccess && opts.onSuccess({ session, state });
  return state;
}

// ---------------- AGIP-45: молчаливый автологин оператора на его ноде ----------------
export async function tryAutologin({ preferAddress = null, onState, onMessage } = {}) {
  if (!pageHost()) return null;
  if (localStorage.getItem(KEY_NOAUTO) === 'off') return null;
  // 1) уже есть живая сессия этой вкладки -> тихо восстановим
  try {
    const state = await restoreSession({ onState });
    if (state && state.via) return state;
  } catch {}
  // 2) нет сессии -> требуем от ноды автологин (админ-плоскость, только loopback)
  try {
    const r = await jsonFetch('/cabinet/autologin', { method: 'POST', body: { address: preferAddress || (localStorage.getItem(KEY_ADDR) || undefined) }, headers: { 'x-cabinet-autologin': 'local' } });
    if (!r || r.ok !== true) return null; // старая нода без маршрута -> обычный вход, тишина
    saveSession({ address: r.address, token: r.token, expiresAt: r.expiresAt });
    rememberAddress(r.address);
    const state = await jsonFetch('/cabinet/state', { method: 'POST', body: { address: r.address, token: r.token } });
    onState && onState(state, { via: 'autologin' });
    onMessage && onMessage('Вход выполнен автоматически (автологин этой ноды). Сессия — 8 часов; выход кнопкой «Выйти».');
    return state;
  } catch { /* нет автологина (чужая машина/нет ключа/старая нода) — обычный вход, тишина */ }
  return null;
}
export function disableAutologin() {
  localStorage.setItem(KEY_NOAUTO, 'off');
  clearSession();
  const s = loadSession();
  if (s) { try { jsonFetch('/cabinet/logout', { method: 'POST', body: { token: s.token } }).catch(() => {}); } catch {} }
}
export function logout() {
  const s = loadSession();
  if (s) { try { jsonFetch('/cabinet/logout', { method: 'POST', body: { token: s.token } }).catch(() => {}); } catch {} }
  clearSession();
}
export function isAutologinDisabled() { return localStorage.getItem(KEY_NOAUTO) === 'off'; }
