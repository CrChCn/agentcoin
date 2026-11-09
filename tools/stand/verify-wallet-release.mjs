#!/usr/bin/env node
// Релизная приёмка /wallet: штатная сборка (коммитнутый tools/node.mjs.v4) напрямую
// и через HTTPS-прокси (самоподписанный cert, X-Forwarded-*).
// Сквозной сценарий тестовой сети: чистая установка -> вход паспортом -> смета
// (миноры) -> sign-op CLI -> submit -> мемпул -> блок -> идемпотентный повтор ->
// две сессии -> logout-all (wa + кабинетные токены) -> лимиты PIN/WebAuthn ->
// матрица маршрутов direct/proxy. Ошибки API — JSON.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // стенд: самоподписанный прокси-сертификат
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const results = [];
function check(ok, label, extra) {
  results.push({ ok: !!ok, label });
  console.log((ok ? '  ok: ' : '  FAIL: ') + label + (extra ? ' — ' + extra : ''));
}
function failAll(e) { console.log('WALLET-RELEASE-STAND: FAIL — ' + (e && e.stack || e)); process.exitCode = 1; }

async function freePort() {
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise((r) => s.close(r)); return p;
}
function makeJar() {
  const j = { cookie: '' };
  j.store = (res) => {
    const h = res.headers.get('set-cookie'); if (!h) return;
    const m = /agt_wa=([^;]*)/.exec(h);
    if (/Max-Age=0/i.test(h)) { j.cookie = ''; return; }
    if (m) j.cookie = 'agt_wa=' + m[1];
  };
  return j;
}
function client(origin, jar, { csrf = true } = {}) {
  const call = async (method, p, body, headers = {}) => {
    const h = { 'content-type': 'application/json', ...headers };
    if (csrf && method === 'POST') h['x-requested-with'] = 'XMLHttpRequest';
    if (jar && jar.cookie) h.cookie = jar.cookie;
    const r = await fetch(origin + p, { method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    if (jar) jstore(jar, r);
    return { status: r.status, json, text, ct: r.headers.get('content-type') || '', setCookie: r.headers.get('set-cookie') || '' };
  };
  return { call };
}
function jstore(jar, res) {
  const h = res.headers.get('set-cookie'); if (!h) return;
  const m = /agt_wa=([^;]*)/.exec(h);
  if (/Max-Age=0/i.test(h)) { jar.cookie = ''; return; }
  if (m) jar.cookie = 'agt_wa=' + m[1];
}

async function main() {
  // ---- Z0: штатная сборка из коммитнутого артефакта ----
  const v4bytes = fs.readFileSync(path.join(ROOT, 'tools', 'node.mjs.v4'));
  const v4head = execFileSync('git', ['show', 'HEAD:tools/node.mjs.v4'], { cwd: ROOT, maxBuffer: 40 * 1024 * 1024 });
  check(crypto.createHash('sha256').update(v4bytes).digest('hex') ===
    crypto.createHash('sha256').update(v4head).digest('hex'), 'Z0 сборка — коммитнутый tools/node.mjs.v4');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w2r-rel-'));
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.mjs')) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  for (const f of fs.readdirSync(path.join(ROOT, 'node-src'))) if (f.endsWith('.mjs')) fs.copyFileSync(path.join(ROOT, 'node-src', f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, 'site'), path.join(tmp, 'site'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'node.mjs.v4'), path.join(tmp, 'node.mjs'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(tmp, 'node.mjs'), String(port)], { cwd: tmp,
    env: { ...process.env, AGT_DATA_DIR: path.join(tmp, 'data'), AGT_BIND: '127.0.0.1',
      AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0', AGT_IDENTITY_ROLE: 'issuer',
      AGT_ADMIN_MODE: 'off', AGT_IDENTITY_AUDIENCE: 'release-stand' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    const ended = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const f = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    try { await ended; } finally { clearTimeout(f); }
  };
  process.on('exit', () => { try { child.kill('SIGKILL'); } catch {} });
  const origin = 'http://127.0.0.1:' + port;
  let up = false, bootLog = '';
  child.stderr.on('data', (c) => { bootLog = (bootLog + c.toString()).slice(-4000); });
  for (let i = 0; i < 150 && !up; i++) {
    if (child.exitCode !== null) throw new Error('node exited early: ' + bootLog);
    try { const r = await fetch(origin + '/life'); if (r.status === 200) up = true; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  check(up, 'Z0 нода поднялась');
  // ---- HTTPS-прокси (TLS-терминация + X-Forwarded-*) ----
  const sslDir = path.join(tmp, 'ssl'); fs.mkdirSync(sslDir);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(sslDir, 'key.pem'),
    '-out', path.join(sslDir, 'cert.pem'), '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1']);
  const proxyPort = await freePort();
  const proxySrv = https.createServer({
    key: fs.readFileSync(path.join(sslDir, 'key.pem')),
    cert: fs.readFileSync(path.join(sslDir, 'cert.pem')),
  }, (q, s) => {
    const chunks = []; q.on('data', (c) => chunks.push(c)); q.on('end', () => {
      const pr = http.request({ host: '127.0.0.1', port, path: q.url, method: q.method,
        headers: { ...q.headers, host: '127.0.0.1:' + port,
          'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' } },
        (r) => { s.writeHead(r.statusCode, r.headers); r.pipe(s); });
      pr.on('error', () => { try { s.writeHead(502); s.end('proxy_error'); } catch {} });
      pr.end(Buffer.concat(chunks));
    });
  });
  await new Promise((r) => proxySrv.listen(proxyPort, '127.0.0.1', r));
  const via = 'https://127.0.0.1:' + proxyPort;
  // ---- Z0 маршруты напрямую ----
  const jarD = makeJar(), direct = client(origin, jarD);
  const w = await direct.call('GET', '/wallet');
  const walletDisk = fs.readFileSync(path.join(ROOT, 'site', 'wallet.html'));
  check(w.status === 200 && w.ct.includes('text/html'), 'Z0 GET /wallet 200 text/html (direct)');
  check(crypto.createHash('sha256').update(w.text).digest('hex') ===
    crypto.createHash('sha256').update(walletDisk).digest('hex'), 'Z0 /wallet == релизный site/wallet.html');
  const leg = await direct.call('GET', '/user-wallet-page.html');
  check(leg.status === 200 && leg.text.includes('Кошелёк AGENTCOIN'), 'Z0 legacy /user-wallet-page.html жив');
  // ---- Z1 чистая установка + вход + восстановление по куке ----
  const apm = await import(pathToFileURL(path.join(ROOT, 'agt-skill', 'agent-profile.mjs')).href);
  const profA = path.join(tmp, 'a.json'), profB = path.join(tmp, 'b.json');
  await apm.createProfile({ profilePath: profA, password: 'release-stand-password-1', label: 'rel-a' });
  await apm.createProfile({ profilePath: profB, password: 'release-stand-password-1', label: 'rel-b' });
  const A = await apm.readPrivateKey({ profilePath: profA, password: 'release-stand-password-1' });
  const B = await apm.readPrivateKey({ profilePath: profB, password: 'release-stand-password-1' });
  check(A.address !== B.address, 'Z1 два чистых профиля');
  const ich = (await direct.call('POST', '/identity/challenge', { address: A.address, pub: A.pub, handle: 'rel-a' })).json;
  const reg = await direct.call('POST', '/identity/register', { challengeId: ich.challengeId,
    signature: crypto.sign(null, Buffer.from(ich.message, 'utf8'), A.privKey).toString('hex') });
  check(reg.status === 201, 'Z1 паспорт зарегистрирован');
  check((await direct.call('POST', '/mine', { miner: A.address })).status === 200, 'Z1 блок намайнен');
  const ch = (await direct.call('POST', '/auth/file/challenge', { address: A.address })).json;
  const login = await direct.call('POST', '/auth/file/login', { address: A.address, nonce: ch.nonce,
    challengeId: ch.challengeId,
    signature: crypto.sign(null, Buffer.from(ch.nonce, 'utf8'), A.privKey).toString('hex') });
  check(login.status === 200 && !!login.json.walletJwt && !!login.json.cabinetToken, 'Z1 вход по паспорту (JWT + кабинетный токен)');
  const jarA = makeJar(); if (login.setCookie) jstore(jarA, { headers: { get: (n) => n === 'set-cookie' ? login.setCookie : null } });
  check(!!jarA.cookie, 'Z1 HttpOnly-кука agt_wa выставлена');
  const cA = client(origin, jarA);
  const sess = await cA.call('POST', '/auth/session', {});
  check(sess.status === 200 && sess.json.ok === true, 'Z1 сессия восстанавливается по куке (перезагрузка)');
  // ---- Z2 смета и заявка в минорах ----
  const cab = login.json.cabinetToken;
  const est = await cA.call('POST', '/cabinet/wallet/estimate',
    { address: A.address, token: cab, to: B.address, amountMinor: '2500000000' });
  check(est.status === 200 && est.json.ok === true && est.json.amountMinor === '2500000000', 'Z2 смета по минорам',
    'arrival=' + (est.json && est.json.arrivalMinor));
  check(est.json.fees && est.json.fees[0] && est.json.fees[0].amount === 0 && est.json.feeMinor === '0',
    'Z2 базовая комиссия сети 0 (контракт SEND_BASE_FEE_MINOR)');
  const estLeg = await cA.call('POST', '/cabinet/wallet/estimate',
    { address: A.address, token: cab, to: B.address, amount: '2.5' });
  check(estLeg.status === 200 && estLeg.json.amountMinor === '2500000000', 'Z2 legacy amount совместим');
  const estBad = await cA.call('POST', '/cabinet/wallet/estimate',
    { address: A.address, token: cab, to: B.address, amount: '0.0000000001' });
  check(estBad.status === 400 && estBad.json.error === 'inexact_amount', 'Z2 >9 знаков — 400 inexact_amount');
  const estMin = await cA.call('POST', '/cabinet/wallet/estimate',
    { address: A.address, token: cab, to: B.address, amountMinor: '1' });
  check(estMin.status === 200 && estMin.json.amountMinor === '1', 'Z2 минимальная сумма 1 mGNT');
  const opR = await cA.call('POST', '/cabinet/op-request',
    { address: A.address, token: cab, op: { kind: 'send', to: B.address, amountMinor: '2500000000', memo: 'rel-test' } });
  check(opR.status === 200 && !!opR.json.opId && !!opR.json.payload, 'Z2 op-request вернул пакет');
  const pay = opR.json.payload;
  check(pay.amountMinor === '2500000000' && pay.feeMinor === '0' && pay.network === 'AGENTCOIN',
    'Z2 пакет несёт миноры/комиссию/сеть');
  // ---- Z3 локальная подпись через sign-op CLI ----
  const opFile = path.join(tmp, 'op.json');
  fs.writeFileSync(opFile, JSON.stringify(opR.json, null, 2));
  const sign = spawnSync(process.execPath, [path.join(ROOT, 'agt-skill', 'sign-op.mjs'),
    '--profile', profA, '--op', opFile, '--to', B.address, '--amount-minor', '2500000000',
    '--memo', 'rel-test', '--network', 'AGENTCOIN'],
    { cwd: ROOT, input: JSON.stringify({ password: 'release-stand-password-1' }), encoding: 'utf8' });
  check(sign.status === 0, 'Z3 sign-op подписал пакет');
  const sigOut = JSON.parse((sign.stdout || '').trim().split('\n').pop());
  check(sigOut.opId === opR.json.opId && /^[0-9a-f]{128}$/i.test(sigOut.signature), 'Z3 подпись валидна',
    'txid=' + String(sigOut.txid).slice(0, 16) + '…');
  check(/network : AGENTCOIN/.test(sign.stderr) && /2500000000 mGNT/.test(sign.stderr) && /from    : AGT/.test(sign.stderr),
    'Z3 CLI показал сводку (сеть/отправитель/сумма/комиссия)');
  // подмены: to / amount / memo / сеть / txid
  function signTampered(mutate, args) {
    const t = JSON.parse(JSON.stringify(opR.json));
    mutate(t.payload);
    const f = path.join(tmp, 'op-t.json'); fs.writeFileSync(f, JSON.stringify(t));
    return spawnSync(process.execPath, [path.join(ROOT, 'agt-skill', 'sign-op.mjs'),
      '--profile', profA, '--op', f, ...args], { cwd: ROOT,
      input: JSON.stringify({ password: 'release-stand-password-1' }), encoding: 'utf8' });
  }
  check(signTampered((p) => { p.tx.to = A.address; }, ['--to', A.address, '--amount-minor', '2500000000', '--memo', 'rel-test', '--network', 'AGENTCOIN']).status !== 0,
    'Z3 подмена получателя отклонена');
  check(signTampered((p) => { p.amountMinor = '2500000001'; }, ['--to', B.address, '--amount-minor', '2500000001', '--memo', 'rel-test', '--network', 'AGENTCOIN']).status !== 0,
    'Z3 подмена суммы отклонена (txid не сошёлся)');
  check(signTampered((p) => { p.tx.memo = 'evil'; }, ['--to', B.address, '--amount-minor', '2500000000', '--memo', 'rel-test', '--network', 'AGENTCOIN']).status !== 0,
    'Z3 подмена memo отклонена');
  check(signTampered((p) => { p.network = 'OTHERNET'; }, ['--to', B.address, '--amount-minor', '2500000000', '--memo', 'rel-test', '--network', 'AGENTCOIN']).status !== 0,
    'Z3 чужой network в пакете отклонён CLI');
  check(signTampered((p) => { p.txidHex = '0'.repeat(64); }, ['--to', B.address, '--amount-minor', '2500000000', '--memo', 'rel-test', '--network', 'AGENTCOIN']).status !== 0,
    'Z3 подмена txid отклонена');
  // ---- Z4 submit, мемпул, блок, идемпотентный повтор ----
  const sub = await cA.call('POST', '/cabinet/op-submit', { opId: opR.json.opId, signature: sigOut.signature });
  check(sub.status === 201 && sub.json.accepted === true && typeof sub.json.txidFull === 'string' && sub.json.txidFull.length === 64,
    'Z4 op-submit 201 + полный txidFull', 'txid=' + (sub.json && sub.json.txidFull));
  const txid = sub.json.txidFull;
  const dup = await cA.call('POST', '/cabinet/op-submit', { opId: opR.json.opId, signature: sigOut.signature });
  check(dup.status === 200 && dup.json.duplicate === true && dup.json.txidFull === txid,
    'Z4 повтор после потери ответа — тот же txid, без второго перевода');
  const hist1 = await cA.call('POST', '/cabinet/wallet/history', { address: A.address, token: cab, limit: 50 });
  const mrows = (hist1.json && hist1.json.mempoolRows) || [];
  check(mrows.some((r) => r.txid === txid), 'Z4 история видит операцию в мемпуле (тот же txid)');
  check((await direct.call('POST', '/mine', { miner: A.address })).status === 200, 'Z4 блок с операцией');
  const hist2 = await cA.call('POST', '/cabinet/wallet/history', { address: A.address, token: cab, limit: 50 });
  const crows = ((hist2.json && hist2.json.rows) || []).filter((r) => r.txid === txid);
  check(crows.length === 1 && crows[0].status === 'confirmed', 'Z4 в цепи РОВНО одна операция с этим txid');
  check(crows[0] && crows[0].amountMGNT === 2500000000, 'Z4 история: точные миноры операции', String(crows[0] && crows[0].amountMGNT));
  const balA = (await direct.call('POST', '/balance', { address: A.address })).json;
  const balB = (await direct.call('POST', '/balance', { address: B.address })).json;
  check(balB.balance === 2.5, 'Z4 получатель +2.5 ровно (комиссия 0)', 'balB=' + balB.balance);
  check(typeof balA.balance === 'number', 'Z4 баланс отправителя читается', 'balA=' + balA.balance);
  // ---- Z5 две сессии, обычный и глобальный выход ----
  const ch2 = (await direct.call('POST', '/auth/file/challenge', { address: A.address })).json;
  const login2 = await direct.call('POST', '/auth/file/login', { address: A.address, nonce: ch2.nonce,
    challengeId: ch2.challengeId,
    signature: crypto.sign(null, Buffer.from(ch2.nonce, 'utf8'), A.privKey).toString('hex') });
  const cab2 = login2.json.cabinetToken, jwt2 = login2.json.walletJwt;
  const one = await cA.call('POST', '/cabinet/logout', { address: A.address, token: cab });
  check(one.status === 200, 'Z5 обычный выход отзывает текущую кабинетную сессию');
  check((await cA.call('POST', '/cabinet/wallet/history', { address: A.address, token: cab })).status === 401,
    'Z5 отозванный кабинетный токен мёртв');
  check((await cA.call('POST', '/cabinet/wallet/history', { address: A.address, token: cab2 })).status === 200,
    'Z5 вторая сессия жива');
  const all = await direct.call('POST', '/auth/logout-all', {},
    { Authorization: 'Bearer ' + jwt2 });
  check(all.status === 200 && all.json.all_sessions_invalidated === true && Number(all.json.cabinet_revoked) >= 1,
    'Z5 «выйти везде» подтверждён + отозвал кабинетные токены', 'cabinet_revoked=' + all.json.cabinet_revoked);
  check(/Max-Age=0/i.test(all.setCookie || ''), 'Z5 ответ сбросил HttpOnly-куку (Max-Age=0)');
  const gone = await direct.call('POST', '/auth/session', {}, { Authorization: 'Bearer ' + jwt2 });
  check(gone.status === 401, 'Z5 старый Bearer мёртв (epoch)');
  check((await cA.call('POST', '/cabinet/wallet/history', { address: A.address, token: cab2 })).status === 401,
    'Z5 второй кабинетный токен отозван кросс-отзывом');
  const jarGone = makeJar(); if (jarA.cookie) jarGone.cookie = jarA.cookie;
  const cGone = client(origin, jarGone);
  check((await cGone.call('POST', '/auth/session', {})).status === 401,
    'Z5 перезагрузка с сохранившейся кукой НЕ возвращает в кабинет (кука отозвана)');
  check((await cA.call('POST', '/cabinet/logout', { address: A.address, token: cab2, all: true })).status === 401,
    'Z5 logout-all по мёртвой сессии — 401 (не 200)');
  // ---- Z6 лимиты: PIN и WebAuthn challenge ----
  let pinLocked = false;
  for (let i = 0; i < 6; i++) {
    const r = await direct.call('POST', '/auth/pin/login', { pin: '0000' });
    if (r.json && r.json.error === 'pin_locked_try_later') pinLocked = true;
  }
  check(pinLocked, 'Z6 5 неверных PIN — замок pin_locked_try_later');
  let waf429 = false;
  for (let i = 0; i < 25; i++) {
    const r = await direct.call('POST', '/auth/webauthn/challenge', { mode: 'login', address: A.address });
    if (r.status === 429) { waf429 = true; break; }
  }
  check(waf429, 'Z6 выдача WebAuthn challenge лимитирована (429)');
  // ---- Z7 HTTPS-прокси: атрибуты куки, CSRF, X-Forwarded ----
  const jarP = makeJar(), proxy = client(via, jarP);
  const chp = (await proxy.call('POST', '/auth/file/challenge', { address: A.address })).json;
  const loginP = await proxy.call('POST', '/auth/file/login', { address: A.address, nonce: chp.nonce,
    challengeId: chp.challengeId,
    signature: crypto.sign(null, Buffer.from(chp.nonce, 'utf8'), A.privKey).toString('hex') });
  check(loginP.status === 200, 'Z7 вход через HTTPS-прокси');
  const sc = loginP.setCookie || '';
  check(/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && /Secure/i.test(sc),
    'Z7 кука: HttpOnly + SameSite=Strict + Secure (x-forwarded-proto=https)', sc.slice(0, 90));
  const cabP = loginP.json.cabinetToken;
  const noCsrf = client(via, jarP, { csrf: false });
  check((await noCsrf.call('POST', '/auth/session', {})).status === 403, 'Z7 кука без CSRF-заголовка — 403');
  check((await proxy.call('POST', '/auth/session', {})).status === 200, 'Z7 кука + CSRF — 200 (сессия привязана к IP прокси)');
  // смена IP: свежий вход напрямую, та же кука через другой IP — привязка срабатывает
  const jarIP = makeJar(), cIP = client(origin, jarIP);
  const chI = (await cIP.call('POST', '/auth/file/challenge', { address: A.address })).json;
  const loginI = await cIP.call('POST', '/auth/file/login', { address: A.address, nonce: chI.nonce,
    challengeId: chI.challengeId,
    signature: crypto.sign(null, Buffer.from(chI.nonce, 'utf8'), A.privKey).toString('hex') });
  check(loginI.status === 200, 'Z7 свежий прямой вход для IP-теста');
  const cIPx = client(via, jarIP); // та же кука, но IP прокси
  const ipSwap = await cIPx.call('POST', '/auth/session', {});
  check(ipSwap.status === 401 && ipSwap.json && ipSwap.json.reason === 'ip_changed_invalidated',
    'Z7 смена IP — 401 ip_changed_invalidated', JSON.stringify(ipSwap.json).slice(0, 80));
  check((await cIP.call('POST', '/auth/session', {})).status === 200, 'Z7 свой IP — сессия жива');
  // ---- Z8 матрица маршрутов direct/proxy (у каждой стороны своя живая сессия) ----
  const jarM = makeJar(), mDirect = client(origin, jarM);
  const chm = (await mDirect.call('POST', '/auth/file/challenge', { address: A.address })).json;
  const loginM = await mDirect.call('POST', '/auth/file/login', { address: A.address, nonce: chm.nonce,
    challengeId: chm.challengeId,
    signature: crypto.sign(null, Buffer.from(chm.nonce, 'utf8'), A.privKey).toString('hex') });
  const cabM = loginM.json.cabinetToken;
  const mProxy = client(via, jarP); // jarP: живая proxy-сессия из Z7
  const matrix = [
    ['GET', '/wallet', undefined, undefined],
    ['GET', '/info', undefined, undefined],
    ['POST', '/balance', { address: A.address }, { address: A.address }],
    ['POST', '/auth/file/challenge', { address: A.address }, { address: A.address }],
    ['POST', '/auth/session', {}, {}],
    ['POST', '/auth/pin/status', {}, {}],
    ['POST', '/cabinet/state', { address: A.address, token: cabM }, { address: A.address, token: cabP }],
    ['POST', '/cabinet/wallet/history', { address: A.address, token: cabM, limit: 5 }, { address: A.address, token: cabP, limit: 5 }],
    ['POST', '/cabinet/wallet/estimate', { address: A.address, token: cabM, to: B.address, amountMinor: '1' }, { address: A.address, token: cabP, to: B.address, amountMinor: '1' }],
    ['POST', '/cabinet/wallet/history', { address: A.address, token: 'dead' }, { address: A.address, token: 'dead' }],
  ];
  console.log('  матрица (direct / proxy):');
  for (const [m, pth, bodyD, bodyP] of matrix) {
    const d = await mDirect.call(m, pth, bodyD);
    const v = await mProxy.call(m, pth, bodyP);
    console.log(`    ${m} ${pth} -> direct ${d.status} [${d.ct}] / proxy ${v.status} [${v.ct}]`);
    results.push({ ok: d.status < 500 && v.status < 500, label: 'matrix ' + m + ' ' + pth });
    if (d.status >= 400) results.push({ ok: /application\/json/.test(d.ct || ''), label: 'error-json-direct ' + m + ' ' + pth });
    if (v.status >= 400) results.push({ ok: /application\/json/.test(v.ct || ''), label: 'error-json-proxy ' + m + ' ' + pth });
  }
  await stop();
  await new Promise((r) => proxySrv.close(r));
  const bad = results.filter((r) => !r.ok);
  console.log(bad.length === 0
    ? '\nWALLET-RELEASE-STAND: OK — сквозной сценарий, миноры, идемпотентность, кросс-отзыв, лимиты, HTTPS.'
    : '\nWALLET-RELEASE-STAND: FAIL (' + bad.length + '): ' + bad.map((r) => r.label).join('; '));
  if (bad.length) process.exitCode = 1;
}
main().catch(failAll);
