// Wallet acceptance test — isolated node (fresh datadir, outbound guard).
// No production port, wallet or peer is used. Treasury rows are height-gated:
// a tx from the treasury address BEFORE policy.effectiveFrom must be reported
// as single-signature valid — retroactive 2-sig is the strict-validation bug we fixed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { createProfile, signProfileChallenge } from '../agt-skill/agent-profile.mjs';
import { recoverFromMnemonic } from '../bip39-lite.mjs';
import { Blockchain } from '../core.mjs';
import { classifyTx } from '../wallet-api.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'synthetic-wallet-password-for-test';
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const aliceMnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(origin, route, payload, headers = {}) {
  const response = await fetch(origin + route, { method: payload === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: 'error', signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
async function good(origin, route, payload, status = 200, headers = {}) {
  const r = await request(origin, route, payload, headers);
  assert.equal(r.status, status, `${route}: ${JSON.stringify(r.body)}`);
  assert.notEqual(r.body.ok, false, `${route}: ${JSON.stringify(r.body)}`);
  return r.body;
}
function sign(profilePath, pwd, challenge, meta, action) {
  return signProfileChallenge({ profilePath, password: pwd, challenge, expectedAction: action,
    expectedAudience: meta.audience, expectedIssuerFingerprint: meta.issuerFingerprint, expectedNetwork: 'AGENTCOIN' });
}
async function startNode({ port, dataDir, guardPath, blockedFile }) {
  const adminToken = crypto.randomBytes(32).toString('hex');
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BIND: '127.0.0.1', AGT_ADMIN_MODE: 'token',
    AGT_ADMIN_TOKEN: adminToken, AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0',
    AGT_IDENTITY_AUDIENCE: `agt-wallet-test:${port}`, AGT_IDENTITY_ROLE: 'issuer', AGT_TEST_BLOCKED_FILE: blockedFile };
  for (const key of ['AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT', 'NODE_OPTIONS']) delete env[key];
  const child = spawn(process.execPath, ['--import', pathToFileURL(guardPath).href, String(path.join(root, 'node.mjs')), String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', c => { logs = (logs + c.toString()).slice(-32_000); });
  child.stderr.on('data', c => { logs = (logs + c.toString()).slice(-32_000); });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('test_node_exited: ' + logs);
    try { const r = await request(origin, '/identity/meta'); if (r.status === 200) { ready = true; break; } } catch {}
    await delay(50);
  }
  if (!ready) { child.kill('SIGKILL'); throw new Error('test_node_not_ready: ' + logs); }
  return { child, origin, adminToken, logs: () => logs,
    stop: async () => { if (child.exitCode !== null || child.signalCode) return;
      const ended = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await ended; } finally { clearTimeout(force); } } };
}

// ---------- unit-проверки без сети ----------
test('treasury classification is height-gated: no retroactive 2-sig', () => {
  const policy = { treasury: 'AGT' + 'a'.repeat(40), signers: ['AGT' + 'b'.repeat(40)], requires: 2, effectiveFrom: 101 };
  const tx = { from: policy.treasury, to: 'AGT' + 'c'.repeat(40), amount: 1, memo: '' };
  const before = classifyTx(tx, 100, policy);
  assert.equal(before.kind, 'treasury');
  assert.equal(before.sig.required, 1, 'до активации — ОДНА подпись');
  assert.equal(before.sig.sig2Present, null);
  assert.match(before.sig.note, /не активна/);
  const after = classifyTx(tx, 102, policy);
  assert.equal(after.sig.required, 2);
  assert.equal(after.sig.sig2Present, false);
  const plain = classifyTx({ from: 'AGT' + 'd'.repeat(40), to: policy.treasury, amount: 1 }, 102, policy);
  assert.equal(plain.kind, 'transfer', 'не-from-казны не помечается');
  const legacy = classifyTx(tx, 100, { treasury: policy.treasury, requires: 2 }); // без effectiveFrom (legacy-инъекции)
  assert.equal(legacy.sig.required, 2, 'без effectiveFrom — как раньше (всегда 2sig)');
});


test('wallet-format units + QR algebraic self-checks', async () => {
  const src = await fs.readFile(path.join(root, 'site', 'user-wallet-format-lib.js'), 'utf8');
  const sandbox = { window: {}, TextEncoder, TextDecoder, atob, console };
  sandbox.crypto = crypto; // subtle отсутствует — signed() здесь не гоняем
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const U = sandbox.window.AgentcoinWalletUnits, Q = sandbox.window.AgentcoinQR;
  assert.ok(U && Q);
  assert.deepEqual({ AGT: U.convert('1').AGT, mAGT: U.convert('1').mAGT, mGNT: U.convert('1').mGNT }, { AGT: '1', mAGT: '1000', mGNT: '1000000000' });
  assert.equal(U.toAGT('2', 'mAGT'), '0.002');
  assert.equal(U.toAGT('1500000000', 'mGNT'), '1.5');
  assert.throws(() => U.toAGT('0.0000000005', 'AGT'), /Сумма/, 'пол-магента отвергаются форматом');
  // QR: BCH(15,5) для всех масок
  for (let mask = 0; mask < 8; mask++) {
    const c15 = Q.formatBits(mask) ^ 0x5412;
    let v = c15;
    for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= 0x537 << (i - 10);
    assert.equal(v, 0, 'format BCH remainder mask' + mask);
  }
  // RS: syndrome полного кодворда = 0
  const gf = Q._gf, rs = Q._rsEnc;
  const d = []; for (let i = 0; i < 34; i++) d.push((i * 7 + 1) & 0xff);
  const C = [...d, ...rs(d, 10)];
  for (let j = 0; j < 10; j++) {
    let S = 0;
    for (let i = 0; i < C.length; i++) S ^= gf.mul(C[i], gf.EXP[(j * (C.length - 1 - i)) % 255]);
    assert.equal(S, 0, 'RS syndrome j=' + j);
  }
  const qr = Q.encode('agentcoin:AGT' + '1'.repeat(40));
  assert.notEqual(qr.modules[qr.size - 8][8], null, 'copy1 bit7 занят форматной информацией (не данные)');
  assert.equal(qr.modules[8][qr.size - 8], 1, 'тёмный модуль чёрный');
  assert.throws(() => Q.encode('x'.repeat(300)), /qr_too_long/);
});

// ---------- parsed-DOM: loginBox и cab — соседи, дефолты без сессии ----------
test('wallet page DOM: #loginBox closed BEFORE #cab opens; defaults = form visible, cabinet hidden', async () => {
  const html = await fs.readFile(path.join(root, 'site', 'user-wallet-page.html'), 'utf8');
  const openAt = (tag) => html.indexOf(tag);
  const lb = openAt('id="loginBox"'), cb = openAt('id="cab"');
  assert.ok(lb > 0 && cb > lb, 'оба раздела присутствуют и loginBox раньше cab');
  const slice = html.slice(lb, cb);
  assert.ok(slice.includes('</section>'), '#loginBox закрыт до открытия #cab (иначе скрытый loginBox прячет кабинет)');
  // DOM-инвариант !loginBox.contains(cab): между стартом loginBox и стартом cab нет вложенного <section
  assert.equal((slice.match(/<section\b/g) || []).length, 1, 'между loginBox и cab нет вложенного <section>');
  // дефолты без сессии: форма входа видима, кабинет скрыт
  const lbTag = html.slice(html.lastIndexOf('<section', lb), lb + 200);
  assert.ok(!/class="[^"]*\bhidden\b/.test(lbTag), 'loginBox по умолчанию ВИДИМ (гость видит вход)');
  const cbTag = html.slice(html.lastIndexOf('<section', cb), cb + 200);
  assert.ok(/class="[^"]*\bhidden\b/.test(cbTag), 'cab по умолчанию СКРЫТ до входа');
});

// ---------- HTTP-акцептанс на изолированной ноде ----------
test('wallet page, session-scoped history, estimate and signed op flow', { timeout: 60_000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-wallet-e2e-'));
  const nodes = [];
  t.after(async () => { for (const n of nodes.reverse()) await n.stop(); await fs.rm(temp, { recursive: true, force: true }); });
  const port = await freePort();
  const guardPath = path.join(temp, 'no-outbound.mjs'), blockedFile = path.join(temp, 'outbound-attempts.txt');
  await fs.writeFile(guardPath, `import fs from 'node:fs';\nconst deny=()=>{fs.appendFileSync(process.env.AGT_TEST_BLOCKED_FILE,'blocked\\n');throw new Error('test_outbound_network_forbidden');};\nglobalThis.fetch=async()=>deny();\n`);
  const dataDir = path.join(temp, 'node');
  // фандинг героя завершонной затравкой: монета на адрес из профиль creator
  const profilePath = path.join(temp, 'profile.json');
  const identity = await createProfile({ profilePath, password, mnemonic, label: 'synthetic-wallet-agent' });
  const aliceAddr = recoverFromMnemonic(aliceMnemonic, 'wallet-alice').wallet.address;
  const funding = new Blockchain(dataDir);
  funding.mineOnce(identity.address);
  funding.mineOnce(aliceAddr);
  assert.equal(funding.validate(true).ok, true);
  const node = await startNode({ port, dataDir, guardPath, blockedFile }); nodes.push(node);
  const origin = node.origin;

  await t.test('wallet page and format module are served publicly', async () => {
    const page = await fetch(origin + '/wallet', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const marker of ['Кошелёк AGENTCOIN', 'Алисы', 'Бобу', 'effectiveFrom', '/cabinet/op-request', '/cabinet/wallet/history']) {
      assert.ok(html.includes(marker), 'маркер: ' + marker);
    }
    assert.ok(!/<input[^>]*type=["']?password/i.test(html), 'страница не запрашивает пароль');
    const fmt = await fetch(origin + '/wallet-format.js', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(fmt.status, 200);
    assert.match(await fmt.text(), /AgentcoinWalletFormat/);
  });

  let token = null;
  await t.test('login via passport signature', async () => {
    const meta = await good(origin, '/identity/meta');
    const challenge = await good(origin, '/identity/challenge', { address: identity.address, pub: identity.pub, handle: 'wallet-agent' });
    const proof = await sign(profilePath, password, challenge, meta, 'register');
    const reg = await good(origin, '/identity/register', { challengeId: proof.challengeId, signature: proof.signature }, 201);
    assert.equal(reg.identity.address, identity.address);
    const issued = await good(origin, '/cabinet/challenge', { address: identity.address });
    const lp = await sign(profilePath, password, issued.challenge, meta, 'login');
    const login = await good(origin, '/cabinet/login', { address: identity.address, mode: 'challenge', challengeId: lp.challengeId, nonce: issued.challenge.message, signature: lp.signature });
    token = login.token;
    assert.ok(token);
  });

  await t.test('estimate: direct route is honest (network fee = 0), units exact', async () => {
    const alice = recoverFromMnemonic(aliceMnemonic, 'wallet-alice').wallet.address;
    const est = await good(origin, '/cabinet/wallet/estimate', { address: identity.address, token, to: alice, route: 'direct', amount: '2.5' });
    assert.equal(est.fees[0].type, 'network');
    assert.equal(est.fees[0].amount, 0);
    assert.equal(est.arrival, 2.5);
  assert.equal(est.units.mGNT, '2500000000');
  assert.equal(String(est.units.mAGT), '2500');
    assert.equal(est.sufficient, true);
    const self = await request(origin, '/cabinet/wallet/estimate', { address: identity.address, token, to: identity.address, amount: '1' });
    assert.equal(self.status, 400); assert.equal(self.body.error, 'self_send');
    const bad = await request(origin, '/cabinet/wallet/estimate', { address: identity.address, token, to: alice, amount: '0.0000000005' });
    assert.equal(bad.status, 400); assert.equal(bad.body.error, 'invalid_amount', 'пол-магента отвергаются');
    const gw = await good(origin, '/cabinet/wallet/estimate', { address: identity.address, token, to: alice, route: 'gateway', amount: '1' });
    assert.equal(gw.route, 'gateway'); assert.equal(gw.unavailable, 'no_forward_gw');
    const rndToken = crypto.randomBytes(64).toString('hex');
    const foreign = await request(origin, '/cabinet/wallet/history', { address: identity.address, token: rndToken });
    assert.equal(foreign.status, 401);
    const foreignEst = await request(origin, '/cabinet/wallet/estimate', { address: identity.address, token: rndToken, to: alice, amount: '1' });
    assert.equal(foreignEst.status, 401);
  });

  await t.test('send flow: op-request → local signature → op-submit → mempool → block → history', async () => {
    const alice = recoverFromMnemonic(aliceMnemonic, 'wallet-alice').wallet.address;
    const before = await good(origin, '/cabinet/wallet/history', { address: identity.address, token, limit: 50 });
    const baseRows = (before.rows || []).length;
    const op = await good(origin, '/cabinet/op-request', { address: identity.address, token, op: { kind: 'send', to: alice, amount: 1, memo: 'wallet-test' } });
    assert.equal(op.payload.kind, 'send');
    assert.ok(/^[a-f0-9]{64}$/.test(op.payload.tx.txidHex || op.payload.tx.txid || ''));
    // локальная подпись txid privKey-профиля: recoverFromMnemonic с тем же сидом даёт
    // ровно тот ключ, что createProfile положил в зашифрованный профиль (без pool).
    const agentPriv = recoverFromMnemonic(mnemonic, 'key-recovery-for-test').wallet.privKey;
    const txid = op.payload.tx.txidHex || op.payload.tx.txid;
    const signature = crypto.sign(null, Buffer.from(txid, 'hex'), agentPriv).toString('hex');
    const submitted = await good(origin, '/cabinet/op-submit', { opId: op.opId, signature }, 201);
    assert.equal(submitted.accepted, true);
    // неподтверждённо — в истории (мемпул)
    const h1 = await good(origin, '/cabinet/wallet/history', { address: identity.address, token, limit: 50 });
    const memoRow = (h1.mempoolRows || []).find(r => r.memo === 'wallet-test');
    assert.ok(memoRow, 'Мемпул-строка видна владельцу сессии');
    assert.equal(memoRow.status, 'mempool');
    // музейные опции: майним блок и проверяем алерты
    const mine = await good(origin, '/mine', { miner: identity.address }, 200, { 'x-admin-token': node.adminToken });
    assert.ok(mine.mined && mine.mined.height > 0, 'блок смайнен: ' + JSON.stringify(mine.mined || mine));
    await delay(300);
    const h2 = await good(origin, '/cabinet/wallet/history', { address: identity.address, token, limit: 50 });
    const confirmed = (h2.rows || []).find(r => r.memo === 'wallet-test');
    assert.ok(confirmed, 'перевод подтвердлен блоком');
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmations >= 1);
    assert.equal(confirmed.kind, 'transfer');
    assert.ok((h2.rows || []).length >= baseRows + 1);
    // пагинация с beforeHeight возвращает согласованные заказы
    if (h2.nextBeforeHeight !== null) {
      const page2 = await good(origin, '/cabinet/wallet/history', { address: identity.address, token, limit: 2, beforeHeight: h2.nextBeforeHeight });
      for (const row of (page2.rows || [])) assert.ok(row.height < h2.nextBeforeHeight, 'страница строго ниже курсора');
    }
    // только собственные tx и только при живой сессии
    const full = await good(origin, '/cabinet/wallet/history', { address: identity.address, token, limit: 200 });
    for (const row of full.rows) {
      assert.ok(row.from === identity.address || row.to === identity.address, 'только собственные tx');
      if (row.from === 'COINBASE') assert.equal(row.kind, 'mining');
    }
    assert.ok(full.rows.some(r => r.kind === 'mining'), 'свои coinbase видны как майнинг');
    const stranger = recoverFromMnemonic(aliceMnemonic, 'wallet-alice').wallet.address;
    const sreq = await request(origin, '/cabinet/wallet/history', { address: stranger, token: crypto.randomBytes(64).toString('hex') });
    assert.equal(sreq.status, 401);
  });
});
