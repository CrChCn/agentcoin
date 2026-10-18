// Real node HTTP acceptance: two isolated data directories and synthetic agents.
// No production port, wallet, peer or credential is used.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createProfile, createEncryptedBackup, restoreProfile, signProfileChallenge,
} from '../agt-skill/agent-profile.mjs';
import { recoverFromMnemonic } from '../bip39-lite.mjs';
import { connectCabinet, enrollAgent, loginAgent, cabinetState } from '../agt-skill/cabinet-client.mjs';
import { Blockchain } from '../core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'synthetic-agent-password-for-test';
const restoredPassword = 'synthetic-restored-password-for-test';
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(origin, route, payload, headers = {}) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(origin + route, { method: payload === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: 'error', signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
async function good(origin, route, payload, status = 200) {
  const r = await request(origin, route, payload);
  assert.equal(r.status, status, `${route}: ${JSON.stringify(r.body)}`);
  assert.notEqual(r.body.ok, false, `${route}: ${JSON.stringify(r.body)}`);
  return r.body;
}
async function startNode({ port, dataDir, guardPath, blockedFile, trustFile, passportIssuer }) {
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BIND: '127.0.0.1', AGT_ADMIN_MODE: 'token',
    AGT_ADMIN_TOKEN: crypto.randomBytes(32).toString('hex'), AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0',
    AGT_IDENTITY_AUDIENCE: `agt-test-node:${port}`, AGT_IDENTITY_ROLE: trustFile ? 'replica' : 'issuer', AGT_TEST_BLOCKED_FILE: blockedFile };
  for (const key of ['AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT', 'NODE_OPTIONS']) delete env[key];
  if (trustFile) env.AGT_TRUSTED_ISSUERS_FILE = trustFile;
  if (passportIssuer) env.AGT_PASSPORT_ISSUER_FINGERPRINT = passportIssuer;
  const child = spawn(process.execPath, ['--import', guardPath, path.join(root, 'node.mjs'), String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (!ready) { child.kill('SIGKILL'); throw new Error('test_node_start_timeout: ' + logs); }
  return { origin, pid: child.pid, child, logs: () => logs,
    async stop() {
      if (child.exitCode !== null || child.signalCode) return;
      const ended = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await ended; } finally { clearTimeout(force); }
    } };
}
async function sign(profilePath, pwd, challenge, meta, action) {
  return signProfileChallenge({ profilePath, password: pwd, challenge, expectedAction: action,
    expectedAudience: meta.audience, expectedIssuerFingerprint: meta.issuerFingerprint, expectedNetwork: 'AGENTCOIN' });
}
async function login(origin, profilePath, pwd, address, meta) {
  const issued = await good(origin, '/cabinet/challenge', { address });
  assert.equal(issued.challengeId, issued.challenge.challengeId);
  assert.equal(issued.nonce, issued.challenge.message);
  const proof = await sign(profilePath, pwd, issued.challenge, meta, 'login');
  const payload = { address, mode: 'challenge', challengeId: proof.challengeId, nonce: issued.challenge.message, signature: proof.signature };
  return { payload, result: await good(origin, '/cabinet/login', payload) };
}
async function assertNoAgentKeys(dataDir, forbidden) {
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        const body = await fs.readFile(file, 'utf8');
        for (const value of forbidden) assert.equal(body.includes(value), false, `agent secret found in ${entry.name}`);
        if (entry.name === 'wallets.json') assert.deepEqual(JSON.parse(body), {}, 'agent must not appear in server wallet storage');
      }
    }
  }
  await walk(dataDir);
}

test('portable noncustodial passport: enroll → two-node login → restart → encrypted restore', { timeout: 45_000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-cabinet-e2e-'));
  const nodes = [];
  t.after(async () => { for (const n of nodes.reverse()) await n.stop(); await fs.rm(temp, { recursive: true, force: true }); });
  const portA = await freePort(); let portB = await freePort(); while (portB === portA) portB = await freePort();
  const guardPath = path.join(temp, 'no-outbound.mjs'), blockedFile = path.join(temp, 'outbound-attempts.txt');
  // Every outbound connection from a test node is unexpected. Fail before DNS or
  // a socket connect, including raw HTTP/WS paths that do not use global fetch.
  await fs.writeFile(guardPath, `import fs from 'node:fs'; import net from 'node:net';\nconst deny=()=>{fs.appendFileSync(process.env.AGT_TEST_BLOCKED_FILE,'blocked\\n');throw new Error('test_outbound_network_forbidden');};\nglobalThis.fetch=async()=>deny();\nnet.Socket.prototype.connect=function(){return deny();};\n`);
  const profilePath = path.join(temp, 'profile.json');
  const identity = await createProfile({ profilePath, password, mnemonic, label: 'synthetic-portable-agent' });
  const strangerPath = path.join(temp, 'stranger.json');
  const stranger = await createProfile({ profilePath: strangerPath, password, label: 'synthetic-stranger' });
  const agentPriv = recoverFromMnemonic(mnemonic, 'synthetic-portable-agent').wallet.privKey;
  const backup = await createEncryptedBackup({ profilePath, password });
  const dataA = path.join(temp, 'node-a'), dataB = path.join(temp, 'node-b');
  // Synthetic PoW coinbase funding needs only public addresses. Both servers
  // start from the same valid chain; no agent key is placed in their data dirs.
  const funding = new Blockchain(dataA);
  funding.mineOnce(identity.address);
  funding.mineOnce(stranger.address);
  assert.equal(funding.validate(true).ok, true);
  const expectedBalance = funding.balances()[identity.address];
  const expectedStrangerBalance = funding.balances()[stranger.address];
  assert.ok(expectedBalance > 0); assert.ok(expectedStrangerBalance > 0);
  await fs.mkdir(dataB, { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(dataA, 'chain.json'), path.join(dataB, 'chain.json'));
  let nodeA = await startNode({ port: portA, dataDir: dataA, guardPath, blockedFile }); nodes.push(nodeA);
  const metaA = await good(nodeA.origin, '/identity/meta');
  assert.equal(metaA.role, 'issuer');

  let passport;
  await t.test('public proof enrollment and one-use registration', async () => {
    const challenge = await good(nodeA.origin, '/identity/challenge', { address: identity.address, pub: identity.pub, handle: 'portable-agent' });
    const proof = await sign(profilePath, password, challenge, metaA, 'register');
    const input = { challengeId: proof.challengeId, signature: proof.signature };
    const registered = await good(nodeA.origin, '/identity/register', input, 201);
    assert.equal(registered.identity.address, identity.address);
    assert.equal(registered.identity.agentId, identity.identityId);
    passport = registered.passport;
    const replay = await request(nodeA.origin, '/identity/register', input);
    assert.equal(replay.status, 400); assert.equal(replay.body.error, 'challenge_not_issued');
  });

  const trustFile = path.join(temp, 'trusted-issuers.json');
  await fs.writeFile(trustFile, JSON.stringify([metaA.issuerPub]));
  let nodeB = await startNode({ port: portB, dataDir: dataB, guardPath, blockedFile, trustFile, passportIssuer: metaA.issuerFingerprint }); nodes.push(nodeB);
  const metaB = await good(nodeB.origin, '/identity/meta');
  assert.equal(metaB.role, 'replica'); assert.equal(metaB.enrollmentEnabled, false);
  assert.equal(metaB.passportIssuerFingerprint, metaA.issuerFingerprint);
  assert.notEqual(metaB.issuerFingerprint, metaA.issuerFingerprint);

  await t.test('public cabinet pages need no operator token, ask for no secrets, and monitor lists self', async () => {
    for (const n of [nodeA, nodeB]) {
      for (const route of ['/cabinet', '/cabinet.html']) {
        const response = await fetch(n.origin + route, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200, route);
        const html = await response.text();
        assert.match(html, /<!doctype html>/i);
        const inputs = html.match(/<input\b[^>]*>/gi) || [];
        assert.ok(inputs.length > 0);
        for (const input of inputs) {
          assert.doesNotMatch(input, /\btype\s*=\s*["']?password\b/i);
          assert.doesNotMatch(input, /\b(?:id|name)\s*=\s*["'][^"']*(?:privkey|private.?key|password|mnemonic|seed)[^"']*["']/i);
        }
      }
      const monitor = await good(n.origin, '/network/nodes');
      assert.equal(monitor.nodes.length, 1, 'isolated monitor still includes the current node');
      assert.equal(monitor.nodes[0].name, 'Эта нода');
      assert.equal(monitor.nodes[0].reachable, true);
      assert.equal(monitor.nodes[0].blocks, funding.blockCount());
      assert.equal(monitor.nodes[0].tipHash, funding.tip().hash);
    }
  });

  await t.test('invalid public JSON bodies receive bounded 4xx responses instead of hanging', async () => {
    for (const route of ['/cabinet/challenge', '/cabinet/login', '/cabinet/state', '/cabinet/logout', '/balance']) {
      const response = await fetch(nodeA.origin + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null', signal: AbortSignal.timeout(800) });
      assert.equal(response.status, 400, route);
      assert.equal((await response.json()).error, 'body_must_be_object', route);
    }
    for (const body of ['[]', '"text"', 'false', '{bad-json']) {
      const response = await fetch(nodeA.origin + '/cabinet/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(800) });
      assert.equal(response.status, 400);
    }
    assert.equal((await good(nodeA.origin, '/identity/meta')).issuerFingerprint, metaA.issuerFingerprint);
  });

  let sessionA; let sessionB;
  await t.test('same passport works on a pinned replica without copying the agent wallet', async () => {
    const blockedEnroll = await request(nodeB.origin, '/identity/challenge', { address: stranger.address, pub: stranger.pub, handle: 'stranger' });
    assert.equal(blockedEnroll.status, 403);
    await good(nodeB.origin, '/identity/import', { passport });
    sessionA = await login(nodeA.origin, profilePath, password, identity.address, metaA);
    sessionB = await login(nodeB.origin, profilePath, password, identity.address, metaB);
    for (const [n, session] of [[nodeA, sessionA], [nodeB, sessionB]]) {
      const state = await good(n.origin, '/cabinet/state', { address: identity.address, token: session.result.token });
      assert.equal(state.address, identity.address); assert.equal(state.passport.agentId, identity.identityId);
      assert.equal(state.passport.handle, 'portable-agent'); assert.equal(state.wallet.baoAGT, expectedBalance);
      assert.equal(JSON.stringify(state).includes('PRIVATE KEY'), false);
    }
  });

  await t.test('foreign key, consumed proof and cross-node replay cannot create a session', async () => {
    const replay = await request(nodeA.origin, '/cabinet/login', sessionA.payload);
    assert.equal(replay.status, 400); assert.equal(replay.body.error, 'challenge_not_issued');
    const issued = await good(nodeA.origin, '/cabinet/challenge', { address: identity.address });
    await assert.rejects(sign(strangerPath, password, issued.challenge, metaA, 'login'), /challenge_profile_mismatch/);
    // Synthetic foreign key gives a valid Ed25519 signature over the owner's
    // challenge. It must still fail against the passport's public key.
    const pair = crypto.generateKeyPairSync('ed25519');
    const foreign = { address: identity.address, mode: 'challenge', challengeId: issued.challengeId, nonce: issued.nonce, signature: crypto.sign(null, Buffer.from(issued.nonce), pair.privateKey).toString('hex') };
    assert.equal((await request(nodeA.origin, '/cabinet/login', foreign)).body.error, 'invalid_signature');
    const proof = await sign(profilePath, password, issued.challenge, metaA, 'login');
    const legitimate = { ...foreign, signature: proof.signature };
    assert.equal((await request(nodeB.origin, '/cabinet/login', legitimate)).body.error, 'challenge_not_issued');
    assert.equal((await request(nodeA.origin, '/cabinet/login', legitimate)).status, 200, 'foreign attempt must not consume the real owner challenge');
    assert.equal((await request(nodeB.origin, '/cabinet/state', { address: identity.address, token: sessionA.result.token })).status, 401);
    assert.equal((await request(nodeA.origin, '/cabinet/state', { address: stranger.address, token: sessionA.result.token })).status, 401);
    assert.equal((await request(nodeA.origin, '/cabinet/login', { address: identity.address, seqStr: '123456' })).body.error, 'signature_required');
  });

  await t.test('cabinet sessions do not grant wallet/sign/admin permissions', async () => {
    for (const n of [nodeA, nodeB]) for (const endpoint of ['/wallet/create', '/tx/sign', '/mine']) {
      const r = await request(n.origin, endpoint, { address: identity.address, token: sessionA.result.token }, { authorization: 'Bearer ' + sessionA.result.token });
      assert.equal(r.status, 403); assert.equal(r.body.error, 'admin_loopback_only');
    }
    for (const n of [nodeA, nodeB]) {
      const operator = await request(n.origin, '/operator/cabinet');
      assert.equal(operator.status, 403);
      assert.equal(operator.body.error, 'admin_loopback_only');
    }
  });

  await t.test('restart loses sessions/challenges, preserves passport and stable issuer keys', async () => {
    const staleChallenge = await good(nodeB.origin, '/cabinet/challenge', { address: identity.address });
    const staleProof = await sign(profilePath, password, staleChallenge.challenge, metaB, 'login');
    await nodeB.stop();
    nodeB = await startNode({ port: portB, dataDir: dataB, guardPath, blockedFile, trustFile, passportIssuer: metaA.issuerFingerprint }); nodes.push(nodeB);
    assert.equal((await good(nodeB.origin, '/identity/meta')).issuerFingerprint, metaB.issuerFingerprint);
    assert.equal((await request(nodeB.origin, '/cabinet/state', { address: identity.address, token: sessionB.result.token })).status, 401);
    assert.equal((await request(nodeB.origin, '/cabinet/login', { address: identity.address, mode: 'challenge', challengeId: staleProof.challengeId, nonce: staleChallenge.nonce, signature: staleProof.signature })).body.error, 'challenge_not_issued');
    sessionB = await login(nodeB.origin, profilePath, password, identity.address, metaB);
    const restartedBState = await good(nodeB.origin, '/cabinet/state', { address: identity.address, token: sessionB.result.token });
    assert.equal(restartedBState.passport.agentId, identity.identityId);
    assert.equal(restartedBState.wallet.baoAGT, expectedBalance);
    await nodeA.stop();
    nodeA = await startNode({ port: portA, dataDir: dataA, guardPath, blockedFile }); nodes.push(nodeA);
    assert.equal((await good(nodeA.origin, '/identity/meta')).issuerFingerprint, metaA.issuerFingerprint);
    const restartedA = await login(nodeA.origin, profilePath, password, identity.address, metaA);
    assert.equal(restartedA.result.ok, true);
    const restartedAState = await good(nodeA.origin, '/cabinet/state', { address: identity.address, token: restartedA.result.token });
    assert.equal(restartedAState.wallet.baoAGT, expectedBalance);
    assert.equal(restartedAState.passport.agentId, identity.identityId);
  });

  await t.test('encrypted restoration on a new local profile retains the same identity', async () => {
    const restoredPath = path.join(temp, 'restored', 'profile.json');
    const restored = await restoreProfile({ profilePath: restoredPath, password: restoredPassword, backup, backupPassword: password });
    assert.deepEqual(restored, identity);
    await fs.unlink(profilePath); // The original vault is no longer available.
    for (const [n, meta] of [[nodeA, metaA], [nodeB, metaB]]) {
      const restoredLogin = await login(n.origin, restoredPath, restoredPassword, identity.address, meta);
      const state = await good(n.origin, '/cabinet/state', { address: identity.address, token: restoredLogin.result.token });
      assert.equal(state.passport.agentId, identity.identityId); assert.equal(state.wallet.address, identity.address);
      assert.equal(state.wallet.baoAGT, expectedBalance);
    }
  });

  await t.test('actual Skill client connects, enrolls and reads the same cabinet on both nodes', async () => {
    const info = await good(nodeA.origin, '/info');
    const configA = path.join(temp, 'client', 'issuer.json');
    const configB = path.join(temp, 'client', 'replica.json');
    const pins = { expectedIssuerFingerprint: metaA.issuerFingerprint, expectedNetwork: 'AGENTCOIN', expectedGenesisHash: info.genesisHash };
    await connectCabinet({ configPath: configA, nodeUrl: nodeA.origin, ...pins });
    const enrolled = await enrollAgent({ configPath: configA, profilePath: strangerPath, password, handle: 'skill-client-agent' });
    assert.equal(enrolled.identity.address, stranger.address);
    await loginAgent({ configPath: configA, profilePath: strangerPath, password });
    const stateA = await cabinetState({ configPath: configA, profilePath: strangerPath });
    assert.equal(stateA.wallet.address, stranger.address);
    assert.equal(stateA.passport.handle, 'skill-client-agent');
    await connectCabinet({ configPath: configB, nodeUrl: nodeB.origin, ...pins });
    await assert.rejects(enrollAgent({ configPath: configB, profilePath: strangerPath, password, handle: 'invalid-replica-enrollment' }), /enrollment_requires_pinned_issuer_node/);
    await loginAgent({ configPath: configB, profilePath: strangerPath, password });
    const stateB = await cabinetState({ configPath: configB, profilePath: strangerPath });
    assert.equal(stateB.passport.agentId, stranger.identityId);
    assert.equal(stateB.wallet.address, stateA.wallet.address);
    assert.equal(stateB.wallet.baoAGT, stateA.wallet.baoAGT);
    assert.equal(stateB.wallet.baoAGT, expectedStrangerBalance);
    assert.equal(Object.hasOwn(stateB, 'token'), false);
  });

  await assertNoAgentKeys(dataA, [agentPriv, mnemonic, password, restoredPassword]);
  await assertNoAgentKeys(dataB, [agentPriv, mnemonic, password, restoredPassword]);
  await assert.rejects(fs.stat(blockedFile), { code: 'ENOENT' }, 'isolated nodes must not even attempt outbound networking');

  await t.test('public requests through a loopback proxy retain the heavy rate limit', async () => {
    let limited = false;
    for (let i = 0; i < 61; i++) {
      const response = await request(nodeA.origin, '/identity/register', {}, { 'x-forwarded-for': '198.51.100.10' });
      if (response.status === 429) { assert.equal(response.body.error, 'rate_limited'); limited = true; break; }
      assert.equal(response.status, 400);
    }
    assert.equal(limited, true, 'proxied public requests cannot inherit the direct-loopback exemption');
  });
});
