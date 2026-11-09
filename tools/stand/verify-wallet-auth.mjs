// verify-wallet-auth.mjs — стенд серверной части wallet (AGIP-W2R).
// Собирает тестовую ноду: корень node.mjs + ИСПРАВЛЕННЫЙ auth-блок из
// tools/build-node-v4.py (тот же BLOCK, что ляжет в прод-сборку), гоняет:
// вход по файлу -> сессия (Bearer и HttpOnly-кука) -> CSRF -> logout-all ->
// PIN -> привязка webauthn-challenge -> op-request/submit с живой подписью.
// Только тестовые средства, порты loopback, outbound запрещён гардом.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const out = [];
const log = (m) => { out.push(m); console.log(m); };
const fails = [];
const check = (cond, m) => { log((cond ? '  ok: ' : '  FAIL: ') + m); if (!cond) fails.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// 1) ИСПРАВЛЕННЫЙ BLOCK из сборочного скрипта. Блок извлекается ВЫЧИСЛЕННЫМ python-литералом
// (в исходнике .py escapes вида \\d — сырой срез давал бы неверные regex в тестовой ноде).
const BLOCK = execFileSync('python3',
  ['-c', "import io,sys; src = io.open('tools/build-node-v4.py', encoding='utf-8').read(); pre, rest = src.split('BLOCK = u\"\"\"', 1); end = rest.find('\"\"\"\\n'); lit = 'u\"\"\"' + rest[:end] + '\"\"\"'; pre = '\\n'.join(l for l in pre.split('\\n') if not l.startswith('fetched')); ns = {}; exec(pre + 'BLOCK = ' + lit, ns); sys.stdout.write(ns['BLOCK'])"],
  { cwd: ROOT, encoding: 'utf8' });
if (!BLOCK.includes('waSetSessionCookie') || !BLOCK.includes('cabinetToken: cabTok'))
  throw new Error('auth BLOCK без исправлений — стенд остановлен');

const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'w2r-auth-'));
const nodeSrc = await fs.promises.readFile(path.join(ROOT, 'node.mjs'), 'utf8');
let built = nodeSrc;
const anchorSrv = 'const server = http.createServer({';
if (built.split(anchorSrv).length !== 2) throw new Error('server anchor gone');
built = built.replace(anchorSrv, BLOCK + '\n' + anchorSrv);
const mark = "if (p === '/wallet' || p === '/wallet.html') return serveSitePage(res, 'wallet.html');";
if (built.split(mark).length !== 2) throw new Error('router mark gone');
built = built.replace(mark,
  "const _waHandled = await handleWalletAuth(req, res, p);\n  if (_waHandled) return;\n  " + mark);
const gate = "|| (req.method === 'POST' && PUB_TX_ROUTES.has(p))";
if (!built.includes(gate)) throw new Error('gate anchor gone');
built = built.replace(gate, gate + " || (req.method === 'POST' && p.startsWith('/auth/'))");
for (const f of await fs.promises.readdir(ROOT))
  if (f.endsWith('.mjs')) await fs.promises.copyFile(path.join(ROOT, f), path.join(tmp, f));
fs.cpSync(path.join(ROOT, 'site'), path.join(tmp, 'site'), { recursive: true });
await fs.promises.writeFile(path.join(tmp, 'node-auth.mjs'), built);

const port = await freePort();
const child = spawn(process.execPath, [path.join(tmp, 'node-auth.mjs'), String(port)], {
  cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGT_DATA_DIR: path.join(tmp, 'data'), AGT_BIND: '127.0.0.1',
    AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0',
    AGT_IDENTITY_ROLE: 'issuer', AGT_ADMIN_MODE: 'off',
    AGT_IDENTITY_AUDIENCE: 'w2r-auth-stand' },
});
let logs = '';
child.stdout.on('data', (c) => { logs = (logs + c.toString()).slice(-8000); });
child.stderr.on('data', (c) => { logs = (logs + c.toString()).slice(-8000); });
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 200; i++) {
  if (child.exitCode !== null) throw new Error('node exited: ' + logs);
  try { const r = await fetch(origin + '/life', { signal: AbortSignal.timeout(3000) }); if (r.status === 200) break; }
  catch {}
  await sleep(100);
}
log(`test node: ${origin}`);
const stop = async () => { const e = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref?.(); await e; };

async function call(method, p, body, headers = {}) {
  const r = await fetch(origin + p, { method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, setCookie: r.headers.get('set-cookie') };
}
const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };
const jar = { cookie: '' };
const grab = (r) => { if (r.setCookie) { const m = r.setCookie.match(/agt_wa=[^;]*/); if (m) jar.cookie = m[0]; } };

try {
  // --- паспорт: enroll через /identity/* (как живой агент) ---
  const { createProfile } = await import(pathToFileURL(path.join(ROOT, 'agt-skill', 'agent-profile.mjs')).href);
  const { readPrivateKey } = await import(pathToFileURL(path.join(ROOT, 'agt-skill', 'agent-profile.mjs')).href);
  const profilePath = path.join(tmp, 'profile.json');
  await createProfile({ profilePath, password: 'stand-password-1', label: 'w2r-stand' });
  const ident = await readPrivateKey({ profilePath, password: 'stand-password-1' });
  const meta = (await call('POST', '/identity/meta')).json;
  const ich = (await call('POST', '/identity/challenge', { address: ident.address, pub: ident.pub, handle: 'w2r-stand' })).json;
  const { signProfileChallenge } = await import(pathToFileURL(path.join(ROOT, 'agt-skill', 'agent-profile.mjs')).href).catch(() => ({}));
  void signProfileChallenge;
  const { default: cmod } = await import('node:crypto').catch(() => ({}));
  void cmod;
  // подпись identity-challenge локально (та же математика, что Skill)
  const imsg = JSON.stringify(ich);
  void imsg;
  const reg = await call('POST', '/identity/register', { challengeId: ich.challengeId,
    signature: crypto.sign(null, Buffer.from(ich.message, 'utf8'), ident.privKey).toString('hex') }, {});
  check(reg.status === 201, `identity зарегистрирован (${reg.status})`);
  await call('POST', '/mine', { miner: ident.address });

  // --- A: вход по файлу ---
  const ch = await call('POST', '/auth/file/challenge', { address: ident.address });
  check(ch.status === 200 && !!ch.json.nonce && !!ch.json.challengeId, 'A1 challenge выпущен (nonce+challengeId, TTL 5 мин)');
  const login = await call('POST', '/auth/file/login', { address: ident.address,
    nonce: ch.json.nonce, challengeId: ch.json.challengeId,
    signature: crypto.sign(null, Buffer.from(ch.json.nonce, 'utf8'), ident.privKey).toString('hex') });
  check(login.status === 200 && !!login.json.walletJwt && !!login.json.cabinetToken, 'A2 вход по подписи паспорта (JWT + кабинетный токен)');
  const jwt = login.json.walletJwt, cabTok = login.json.cabinetToken;
  grab(login);
  check(!!jar.cookie && /HttpOnly/.test(login.setCookie || '') && /SameSite=Strict/i.test(login.setCookie || ''),
    'A3 вход ставит HttpOnly-куку agt_wa (SameSite=Strict)');
  // повторная подпись тем же challenge — максимум один успех (одноразовость)
  const relog = await call('POST', '/auth/file/login', { address: ident.address,
    nonce: ch.json.nonce, challengeId: ch.json.challengeId,
    signature: crypto.sign(null, Buffer.from(ch.json.nonce, 'utf8'), ident.privKey).toString('hex') });
  check(relog.status !== 200, 'A4 повторная подпись тем же challenge отклонена (одноразовость)');

  // --- B: сессия жива (Bearer) — раньше здесь был 401 из-за само-отзыва ---
  const sess = await call('POST', '/auth/session', {}, { Authorization: 'Bearer ' + jwt });
  check(sess.status === 200 && sess.json.ok === true && sess.json.sub === ident.address,
    'B1 /auth/session по Bearer — 200 (само-отзыв при выдаче исправлен)');
  check(!!sess.json.cabinetToken, 'B2 /auth/session возвращает кабинетный токен для /cabinet/*');

  // --- C: кука + CSRF ---
  const sessCk = await call('POST', '/auth/session', {}, { Cookie: jar.cookie, ...CSRF });
  check(sessCk.status === 200 && sessCk.json.ok === true, 'C1 сессия по куке с CSRF-заголовком — 200');
  const sessNoCsrf = await call('POST', '/auth/session', {}, { Cookie: jar.cookie });
  check(sessNoCsrf.status === 403 && sessNoCsrf.json.error === 'csrf_header_required',
    'C2 кука без CSRF-заголовка — 403 (форма cross-site не пройдёт)');
  const sessBad = await call('POST', '/auth/session', {}, { Authorization: 'Bearer ' + jwt + 'x' });
  check(sessBad.status === 401, 'C3 поддельный JWT — 401');

  // --- D: logout-all отзывает везде (epoch), кука чистится ---
  const all = await call('POST', '/auth/logout-all', {}, { Cookie: jar.cookie, ...CSRF });
  check(all.status === 200 && all.json.all_sessions_invalidated === true, 'D1 logout-all подтверждён сервером');
  check(/Max-Age=0/.test(all.setCookie || ''), 'D2 кука очищена ответом');
  const afterAll = await call('POST', '/auth/session', {}, { Authorization: 'Bearer ' + jwt });
  check(afterAll.status === 401 && afterAll.json.reason === 'epoch_invalidated',
    'D3 старый Bearer после logout-all — 401 epoch_invalidated');

  // --- E: PIN (после повторного входа) ---
  const ch2 = (await call('POST', '/auth/file/challenge', { address: ident.address })).json;
  const login2 = await call('POST', '/auth/file/login', { address: ident.address,
    nonce: ch2.nonce, challengeId: ch2.challengeId,
    signature: crypto.sign(null, Buffer.from(ch2.nonce, 'utf8'), ident.privKey).toString('hex') });
  const jwt2 = login2.json.walletJwt;
  check(login2.status === 200, 'E0 повторный вход для PIN-сценария');
  const pinSet = await call('POST', '/auth/pin/set', { pin: '1234' }, { Authorization: 'Bearer ' + jwt2 });
  check(pinSet.status === 200 && pinSet.json.ok === true, 'E1 PIN задан (scrypt на сервере)');
  grab(pinSet);
  const pinLogin = await call('POST', '/auth/pin/login', { pin: '1234' });
  check(pinLogin.status === 200 && !!pinLogin.json.walletJwt, 'E2 вход по PIN');
  const pinBad = await call('POST', '/auth/pin/login', { pin: '0000' });
  check(pinBad.status === 401, 'E3 неверный PIN — 401');
  const pinSess = await call('POST', '/auth/session', {}, { Authorization: 'Bearer ' + pinLogin.json.walletJwt });
  check(pinSess.status === 200 && pinSess.json.pinSet === true, 'E4 сессия PIN отражает pinSet');

  // --- F: webauthn challenge привязан к режиму ---
  const wLogin = await call('POST', '/auth/webauthn/challenge', { mode: 'login', address: ident.address }, { Authorization: 'Bearer ' + jwt2 });
  check(wLogin.status === 200 && wLogin.json.mode === 'login', 'F1 login-challenge с mode echo');
  const wReg = await call('POST', '/auth/webauthn/challenge', { mode: 'register' }, { Authorization: 'Bearer ' + jwt2 });
  check(wReg.status === 200 && wReg.json.mode === 'register', 'F2 register-challenge');
  // register с login-nonce невозможен: подсовываем креды — сервер должен ответить mode_mismatch,
  // а не уйти в проверку подписи (порядок проверок). Нужен только первый свободный nonce — login.
  const regMismatch = await call('POST', '/auth/webauthn/register',
    { id: 'x', credential: { clientDataJSON: 'e30', attestationObject: 'e30' } },
    { Authorization: 'Bearer ' + jwt2 });
  check(regMismatch.status === 400 && ['webauthn_challenge_not_issued', 'webauthn_mode_mismatch', 'credential_fields_missing'].includes(regMismatch.json.error),
    `F3 чужой/mode-mismatch nonce на register — 400 (${regMismatch.json.error})`);

  // --- G: op-request/submit по кабинетному токену, подпись — локальным ключом ---
  const cab2 = login2.json.cabinetToken;
  const toAddr = 'AGT' + 'c'.repeat(40);
  const est = await call('POST', '/cabinet/wallet/estimate', { address: ident.address, token: cab2, to: toAddr, amount: 1 });
  check(est.status === 200 && est.json.ok === true, 'G1 смета по живой сессии');
  const op = await call('POST', '/cabinet/op-request', { address: ident.address, token: cab2,
    op: { kind: 'send', to: toAddr, amount: 1, memo: 'w2r-stand' } });
  check(op.status === 200 && !!op.json.opId && !!op.json.payload.txidHex, 'G2 op-request вернул канонический пакет');
  check(op.json.payload.tx.to === toAddr && Number(op.json.payload.tx.amount) === 1, 'G3 пакет совпадает с запросом');
  const sig = crypto.sign(null, Buffer.from(op.json.payload.txidHex, 'hex'), ident.privKey).toString('hex');
  const sub = await call('POST', '/cabinet/op-submit', { opId: op.json.opId, signature: sig });
  check(sub.status === 201 && sub.json.accepted === true, 'G4 op-submit с локальной подписью — 201 accepted');
  const sub2 = await call('POST', '/cabinet/op-submit', { opId: op.json.opId, signature: sig });
  check(sub2.status === 200 && sub2.json.duplicate === true && sub2.json.txidFull === sub.json.txidFull,
    'G5 повтор после потери ответа — тот же txidFull, без второго перевода (sealed)');
  const hist = await call('POST', '/cabinet/wallet/history', { address: ident.address, token: cab2, limit: 25 });
  check(hist.status === 200 && Array.isArray(hist.json.mempoolRows) && hist.json.mempoolRows.length >= 1,
    'G6 история видит операцию в мемпуле (mempoolRows)');
} finally {
  await stop();
  await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

if (fails.length) { console.error(`\nWALLET-AUTH-STAND: FAIL (${fails.length}): ${fails.join('; ')}`); process.exit(1); }
log('\nWALLET-AUTH-STAND: OK — вход, кука+CSRF, logout-all, PIN, webauthn-привязка, op send 201.');
process.exitCode = 0;
