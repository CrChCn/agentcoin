// PIN-приёмка кабинета: полный цикл «паспорт → настройка → выход → PIN-вход →
// неверный PIN → замок → отключение» на изолированной ноде (свежий datadir).
// Повторяет сценарий приёмки: каждый шаг — HTTP-статус и тело ответа.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createProfile, signProfileChallenge } from '../agt-skill/agent-profile.mjs';
import { recoverFromMnemonic } from '../bip39-lite.mjs';
import { Blockchain } from '../core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'synthetic-pin-test-password';
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PIN = '48291';

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
function sign(profilePath, pwd, challenge, meta, action) {
  return signProfileChallenge({ profilePath, password: pwd, challenge, expectedAction: action,
    expectedAudience: meta.audience, expectedIssuerFingerprint: meta.issuerFingerprint, expectedNetwork: 'AGENTCOIN' });
}
async function startNode({ port, dataDir, guardPath, blockedFile }) {
  const adminToken = crypto.randomBytes(32).toString('hex');
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BIND: '127.0.0.1', AGT_ADMIN_MODE: 'token',
    AGT_ADMIN_TOKEN: adminToken, AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0',
    AGT_IDENTITY_AUDIENCE: `agt-pin-test:${port}`, AGT_IDENTITY_ROLE: 'issuer', AGT_TEST_BLOCKED_FILE: blockedFile,
    AGT_PIN_MAX_FAILS: '3', AGT_PIN_LOCK_MS: '1500' };
  for (const key of ['AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT', 'NODE_OPTIONS'] ) delete env[key];
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

test('cabinet PIN: full accept cycle passport -> set -> logout -> PIN login -> lockout -> disable', { timeout: 90_000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-pin-e2e-'));
  const nodes = [];
  t.after(async () => { for (const n of nodes.reverse()) await n.stop(); await fs.rm(temp, { recursive: true, force: true }); });
  const port = await freePort();
  const guardPath = path.join(temp, 'no-outbound.mjs'), blockedFile = path.join(temp, 'outbound-attempts.txt');
  await fs.writeFile(guardPath, 'globalThis.fetch=async()=>{throw new Error(\'test_outbound_network_forbidden\')};');
  const dataDir = path.join(temp, 'node');
  const profilePath = path.join(temp, 'profile.json');
  const identity = await createProfile({ profilePath, password, mnemonic, label: 'pin-test-agent' });
  new Blockchain(dataDir).mineOnce(identity.address);
  const node = await startNode({ port, dataDir, guardPath, blockedFile }); nodes.push(node);
  const origin = node.origin;

  await t.test('step 1: fresh wallet has no PIN; PIN login explains passport-first', async () => {
    const st = await request(origin, '/cabinet/pin/status', { address: identity.address });
    assert.equal(st.status, 200); assert.equal(st.body.pinSet, false);
    const badAddr = await request(origin, '/cabinet/pin/status', { address: 'nope' });
    assert.equal(badAddr.status, 400); assert.equal(badAddr.body.error, 'invalid_address');
    const login = await request(origin, '/cabinet/pin/login', { address: identity.address, pin: TEST_PIN });
    assert.equal(login.status, 404); assert.equal(login.body.error, 'pin_not_set');
    assert.match(login.body.hint || '', /паспорту/, 'подсказка ведёт на паспорт и «Безопасность»');
  });

  let passportToken = null;
  await t.test('step 2: passport signature login opens the wallet', async () => {
    const meta = (await request(origin, '/identity/meta')).body;
    const ch = (await request(origin, '/identity/challenge', { address: identity.address, pub: identity.pub, handle: 'pin-agent' })).body;
    const proof = await sign(profilePath, password, ch, meta, 'register');
    const reg = await request(origin, '/identity/register', { challengeId: proof.challengeId, signature: proof.signature });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const issued = (await request(origin, '/cabinet/challenge', { address: identity.address })).body;
    const lp = await sign(profilePath, password, issued.challenge, meta, 'login');
    const login = await request(origin, '/cabinet/login', { address: identity.address, mode: 'challenge', challengeId: lp.challengeId, nonce: issued.challenge.message, signature: lp.signature });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.ok(login.body.token);
    passportToken = login.body.token;
    const state = await request(origin, '/cabinet/state', { address: identity.address, token: passportToken });
    assert.equal(state.status, 200); assert.equal(state.body.address, identity.address);
  });

  await t.test('step 3: PIN setup — server confirms, status shows enabled', async () => {
    const noSession = await request(origin, '/cabinet/pin/set', { address: identity.address, token: 'dead', pin: TEST_PIN });
    assert.equal(noSession.status, 401, 'без живой сессии PIN не ставится');
    const badFmt = await request(origin, '/cabinet/pin/set', { address: identity.address, token: passportToken, pin: '12ab' });
    assert.equal(badFmt.status, 400); assert.equal(badFmt.body.error, 'pin_must_be_4_6_digits');
    const short = await request(origin, '/cabinet/pin/set', { address: identity.address, token: passportToken, pin: '123' });
    assert.equal(short.status, 400);
    const stranger = 'AGT' + crypto.randomBytes(20).toString('hex');
    const foreign = await request(origin, '/cabinet/pin/set', { address: stranger, token: passportToken, pin: TEST_PIN });
    assert.equal(foreign.status, 401, 'чужая сессия PIN не ставит');
    const set = await request(origin, '/cabinet/pin/set', { address: identity.address, token: passportToken, pin: TEST_PIN });
    assert.equal(set.status, 200, JSON.stringify(set.body)); assert.equal(set.body.pinSet, true);
    const st = await request(origin, '/cabinet/pin/status', { address: identity.address });
    assert.equal(st.body.pinSet, true, 'сервер подтвердил: PIN включён');
  });

  await t.test('step 4: logout, then PIN login reopens the same wallet; wrong PIN rejected', async () => {
    const out = await request(origin, '/cabinet/logout', { token: passportToken });
    assert.equal(out.status, 200);
    const dead = await request(origin, '/cabinet/state', { address: identity.address, token: passportToken });
    assert.equal(dead.status, 401, 'после выхода старая сессия мертва');
    const wrong = await request(origin, '/cabinet/pin/login', { address: identity.address, pin: '00000' });
    assert.equal(wrong.status, 401); assert.equal(wrong.body.error, 'pin_invalid');
    assert.match(wrong.body.hint || '', /Неверный PIN/, 'понятное сообщение');
    const login = await request(origin, '/cabinet/pin/login', { address: identity.address, pin: TEST_PIN });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.ok(login.body.token); assert.equal(login.body.address, identity.address);
    const state = await request(origin, '/cabinet/state', { address: identity.address, token: login.body.token });
    assert.equal(state.status, 200); assert.equal(state.body.address, identity.address);
    assert.equal(state.body.via, 'pin');
    await request(origin, '/cabinet/logout', { token: login.body.token });
  });

  await t.test('lockout: 3rd wrong attempt locks, correct PIN waits, then works', async () => {
    const w2 = await request(origin, '/cabinet/pin/login', { address: identity.address, pin: '00001' });
    assert.equal(w2.status, 401); assert.equal(w2.body.attemptsLeft, 2);
    const w3 = await request(origin, '/cabinet/pin/login', { address: identity.address, pin: '00002' });
    assert.equal(w3.status, 401); assert.equal(w3.body.attemptsLeft, 1);
    const w4 = await request(origin, '/cabinet/pin/login', { address: identity.address, pin: '00003' });
    assert.equal(w4.status, 429); assert.equal(w4.body.error, 'pin_locked_try_later');
    const goodLocked = await request(origin, '/cabinet/pin/login', { address: identity.address, pin: TEST_PIN });
    assert.equal(goodLocked.status, 429, 'верный PIN под замком не пускает');
    await delay(1800);
    const good = await request(origin, '/cabinet/pin/login', { address: identity.address, pin: TEST_PIN });
    assert.equal(good.status, 200, 'после паузы верный PIN снова пускает');
    await request(origin, '/cabinet/logout', { token: good.body.token });
  });

  await t.test('step 5: disable PIN — old PIN rejected, passport login alive', async () => {
    const issued = (await request(origin, '/cabinet/challenge', { address: identity.address })).body;
    const meta = (await request(origin, '/identity/meta')).body;
    const lp = await sign(profilePath, password, issued.challenge, meta, 'login');
    const login = (await request(origin, '/cabinet/login', { address: identity.address, mode: 'challenge', challengeId: lp.challengeId, nonce: issued.challenge.message, signature: lp.signature })).body;
    const dis = await request(origin, '/cabinet/pin/disable', { address: identity.address, token: login.token });
    assert.equal(dis.status, 200); assert.equal(dis.body.pinSet, false);
    const st = await request(origin, '/cabinet/pin/status', { address: identity.address });
    assert.equal(st.body.pinSet, false);
    await request(origin, '/cabinet/logout', { token: login.token });
    const oldPin = await request(origin, '/cabinet/pin/login', { address: identity.address, pin: TEST_PIN });
    assert.equal(oldPin.status, 404); assert.equal(oldPin.body.error, 'pin_not_set', 'старый PIN больше не пускает');
    const issued2 = (await request(origin, '/cabinet/challenge', { address: identity.address })).body;
    const lp2 = await sign(profilePath, password, issued2.challenge, meta, 'login');
    const relogin = await request(origin, '/cabinet/login', { address: identity.address, mode: 'challenge', challengeId: lp2.challengeId, nonce: issued2.challenge.message, signature: lp2.signature });
    assert.equal(relogin.status, 200, 'вход по паспорту доступен после отключения PIN');
  });

  await t.test('persistence: PIN store is a server file, survives restart', async () => {
    const set = await request(origin, '/cabinet/pin/set', { address: identity.address,
      token: (await (async () => {
        const meta = (await request(origin, '/identity/meta')).body;
        const issued = (await request(origin, '/cabinet/challenge', { address: identity.address })).body;
        const lp = await sign(profilePath, password, issued.challenge, meta, 'login');
        const l = (await request(origin, '/cabinet/login', { address: identity.address, mode: 'challenge', challengeId: lp.challengeId, nonce: issued.challenge.message, signature: lp.signature })).body;
        return l.token;
      })()), pin: TEST_PIN });
    assert.equal(set.status, 200);
    await nodes[0].stop(); nodes.pop();
    const port2 = await freePort();
    const node2 = await startNode({ port: port2, dataDir, guardPath, blockedFile }); nodes.push(node2);
    const st = await request(node2.origin, '/cabinet/pin/status', { address: identity.address });
    assert.equal(st.body.pinSet, true, 'PIN пережил рестарт ноды');
  });
});
