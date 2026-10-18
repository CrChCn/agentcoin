// AGIP-45 — приёмка автоматического входа оператора в кабинет (/cabinet/autologin).
// Одноразовая нода из текущего дерева: изолированный data-dir, случайные порты,
// никаких рабочих кошельков/данных. Проверяет: loopback-позитив, ротацию сессий,
// анти-CSRF-заголовок, proxy-заголовки (туннель) → 403, token-режим → 403,
// чужой адрес без локального ключа → 403, и что /cabinet отдаёт авто-welcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import * as core from '../core.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
const ROOT = path.resolve(HERE, '..'); // тест лежит в <root>/test
const NODE = path.join(ROOT, 'node.mjs');

const delay = ms => new Promise(r => setTimeout(r, ms));
async function jfetch(origin, route, { method = 'GET', body = null, headers = {} } = {}) {
  const res = await fetch(origin + route, {
    method, signal: AbortSignal.timeout(8000), cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json', ...headers } : { ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let b = null; try { b = await res.json(); } catch {}
  return { status: res.status, body: b };
}
const freePort = () => new Promise(res => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
});

async function startNode({ tokenMode = false, wallets = {} } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-auto-'));
  fs.writeFileSync(path.join(dataDir, 'wallets.json'), JSON.stringify(wallets, null, 2));
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BIND: '127.0.0.1', AGT_SITE_SYNC: '0',
    AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0', AGT_IDENTITY_AUDIENCE: `agt-auto:${port}`,
    AGT_IDENTITY_ROLE: 'issuer' };
  if (tokenMode) env.AGT_ADMIN_MODE = 'token';
  const child = spawn(process.execPath, [NODE, String(port)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', c => { logs = (logs + c).slice(-20000); });
  child.stderr.on('data', c => { logs = (logs + c).slice(-20000); });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('test_node_exited early, logs:\n' + logs);
    try { const r = await jfetch(origin, '/identity/meta'); if (r.status === 200) return { child, origin, dataDir, logs: () => logs }; } catch {}
    await delay(60);
  }
  child.kill('SIGKILL');
  throw new Error('test_node_start_timeout, logs:\n' + logs);
}
async function stopNode(n) {
  if (!n.child || n.child.exitCode !== null) return;
  const ended = new Promise(r => n.child.once('exit', r));
  n.child.kill('SIGTERM');
  const force = setTimeout(() => n.child.kill('SIGKILL'), 3000);
  try { await ended; } finally { clearTimeout(force); }
  fs.rmSync(n.dataDir, { recursive: true, force: true });
}

test('AGIP-45 autologin: loopback-позитив, ротация, CSRF-негатив, proxy→403, чужой адрес→403 + авто-welcome на странице', async () => {
  // локальный кошелёк с ключом на одноразовой ноде
  const w1 = core.createWallet('auto-op');
  const n = await startNode({ wallets: { [w1.address]: { label: 'auto-op', pub: w1.pub, privKey: w1.privKey, createdAt: Date.now() } } });
  try {
    // регистрируем паспорт публичным путём: POST /identity/challenge + /identity/register
    const ch = await jfetch(n.origin, '/identity/challenge', { method: 'POST', body: { address: w1.address, pub: w1.pub, handle: 'auto-op' } });
    assert.equal(ch.status, 200, 'challenge issue: ' + JSON.stringify(ch.body));
    // ответ плоский: challengeId и message прямо в теле
    const sig = crypto.sign(null, Buffer.from(ch.body.message, 'utf8'), crypto.createPrivateKey(w1.privKey)).toString('hex');
    const reg = await jfetch(n.origin, '/identity/register', { method: 'POST', body: { challengeId: ch.body.challengeId, signature: sig } });
    assert.equal(reg.status, 201, 'register: ' + JSON.stringify(reg.body));

    // 1) позитивный авто-вход с loopback (обязательный anti-CSRF заголовок)
    const r1 = await jfetch(n.origin, '/cabinet/autologin', { method: 'POST', headers: { 'x-cabinet-autologin': 'local' }, body: {} });
    assert.equal(r1.status, 200, 'autologin positive: ' + JSON.stringify(r1.body));
    assert.equal(r1.body.ok, true, 'r1 body ok');
    assert.equal(r1.body.address, w1.address, 'autologin выбрал локальный кошелёк');
    assert.equal(r1.body.via, 'autologin', 'r1 via');
    assert.ok(r1.body.passport && r1.body.passport.handle === 'auto-op', 'passport присутствует в авто-ответе');

    // 2) state по выданному токену
    const st = await jfetch(n.origin, '/cabinet/state', { method: 'POST', body: { address: r1.body.address, token: r1.body.token } });
    assert.equal(st.status, 200, 'state ok: ' + JSON.stringify(st.body));
    assert.ok(st.body.wallet && st.body.wallet.baoAGT >= 0, 'state balance');

    // 3) повторный авто-вход: новая сессия ok (ротация поджмёт лишние при переполнении)
    const r2 = await jfetch(n.origin, '/cabinet/autologin', { method: 'POST', headers: { 'x-cabinet-autologin': 'local' }, body: {} });
    assert.equal(r2.status, 200, 'второй автологин ок: ' + JSON.stringify(r2.body));
    assert.notEqual(r2.body.token, r1.body.token, 'второй вход выдаёт новый токен');

    // 4) анти-CSRF: без обязательного заголовка → 400
    const r3 = await jfetch(n.origin, '/cabinet/autologin', { method: 'POST', body: {} });
    assert.equal(r3.status, 400, 'csrf missing → 400');
    assert.equal(r3.body.error, 'autologin_csrf_header_required', 'csrf body');

    // 5) proxy-заголовки (туннель/не loopback semantics) → барьер 403
    const r4 = await jfetch(n.origin, '/cabinet/autologin', { method: 'POST', headers: { 'x-cabinet-autologin': 'local', 'x-forwarded-for': '203.0.113.9' }, body: {} });
    assert.equal(r4.status, 403, 'proxy → 403');
    assert.equal(r4.body.error, 'admin_loopback_only', 'proxy reason');

    // 6) чужой адрес (нет ключа в wallets.json) → 403 честный, без бана
    const alien = core.createWallet('alien');
    const r5 = await jfetch(n.origin, '/cabinet/autologin', { method: 'POST', headers: { 'x-cabinet-autologin': 'local' }, body: { address: alien.address } });
    assert.equal(r5.status, 403, 'чужой адрес → 403: ' + JSON.stringify(r5.body));
    assert.equal(['autologin_no_local_key', 'passport_not_found'].includes(r5.body.error), true, 'чужой адрес reason: ' + r5.body.error);

    // 7) страница /cabinet содержит авто-welcome
    const page = await fetch(n.origin + '/cabinet', { signal: AbortSignal.timeout(8000) });
    const pageText = await page.text();
    assert.equal(pageText.includes('/cabinet/autologin'), true, 'cabinet.html содержит авто-вход');
    assert.equal(pageText.includes('не входить автоматически'), true, 'кнопка выключения автологина есть');
  } finally { await stopNode(n); }
});

test('AGIP-45 token-нода: авто-вход без x-admin-token → 403 admin_loopback_only (админ-плоскость не публична)', async () => {
  const w = core.createWallet('tok-op');
  const n = await startNode({ tokenMode: true, wallets: { [w.address]: { label: 'tok-op', pub: w.pub, privKey: w.privKey, createdAt: Date.now() } } });
  try {
    const r = await jfetch(n.origin, '/cabinet/autologin', { method: 'POST', headers: { 'x-cabinet-autologin': 'local' }, body: {} });
    assert.equal(r.status, 403, 'автологин на token-ноде закрыт админ-барьером без токена: ' + JSON.stringify(r.body));
    assert.equal(r.body.error, 'admin_loopback_only', 'barrier body');
  } finally { await stopNode(n); }
});
