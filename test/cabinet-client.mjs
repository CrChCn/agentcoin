// Client integration over loopback, synthetic identities and isolated registries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentIdentityRegistry, createAgentChallenge } from '../agent-identity.mjs';
import { createProfile } from '../agt-skill/agent-profile.mjs';
import { connectCabinet, enrollAgent, loginAgent, cabinetState, verifyClientPassport } from '../agt-skill/cabinet-client.mjs';
import { createWallet, verifyTransaction } from '../core.mjs';

const password = 'synthetic-client-password';
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const genesisHash = 'a'.repeat(64), network = 'AGENTCOIN';
const cli = fileURLToPath(new URL('../agt-skill/cabinet-client.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../', import.meta.url));
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-cabinet-client-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
async function serve(t, registry, { operatorPin = registry.meta().issuerFingerprint, replica = false, infoOverride, metaOverride } = {}) {
  const calls = [], challenges = new Map(), sessions = new Map();
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body = {}; try { if (raw) body = JSON.parse(raw); } catch { /* rejected below */ }
    calls.push({ path: req.url, method: req.method, body, headers: req.headers });
    let result = { ok: false, error: 'not_found' };
    if (req.url === '/info') result = { chainId: network, genesisHash, ...infoOverride };
    if (req.url === '/identity/meta') result = { ...registry.meta(), role: replica ? 'replica' : 'issuer',
      localIssuerFingerprint: registry.meta().issuerFingerprint, passportIssuerFingerprint: operatorPin, enrollmentEnabled: !replica, ...metaOverride };
    if (req.url === '/identity/challenge') result = registry.challengeRegistration(body);
    if (req.url === '/identity/register') result = registry.register(body);
    if (req.url === '/identity/import') result = registry.importPassport(body.passport);
    if (req.url === '/cabinet/challenge') {
      const identity = registry.findByAddress(body.address);
      if (identity) {
        const meta = registry.meta();
        const challenge = createAgentChallenge({ action: 'login', network, audience: meta.audience,
          issuerFingerprint: meta.issuerFingerprint, address: body.address, pub: identity.pub, handle: '' });
        challenges.set(challenge.challengeId, challenge);
        result = { ok: true, challenge, nonce: challenge.message, challengeId: challenge.challengeId };
      }
    }
    if (req.url === '/cabinet/login') {
      const challenge = challenges.get(body.challengeId); challenges.delete(body.challengeId);
      if (challenge && challenge.action === 'login' && body.address === challenge.address && body.nonce === challenge.message &&
          body.mode === 'challenge' && crypto.verify(null, Buffer.from(challenge.message), challenge.pub, Buffer.from(body.signature, 'hex'))) {
        const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, body.address);
        result = { ok: true, token, ttlHours: 8 };
      }
    }
    if (req.url === '/cabinet/state' && sessions.has(body.token) && sessions.get(body.token) === body.address) {
      result = { ok: true, wallet: { address: sessions.get(body.token), baoAGT: 0 }, token: body.token, echo: body.token };
    }
    if (req.url === '/tx' && verifyTransaction(body)) result = { ok: true, mempool: 1 };
    res.writeHead(result.ok === false ? 400 : req.url === '/tx' ? 201 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, calls, sessions };
}
function pins(server, registry, configPath) { return { configPath, nodeUrl: server.url, expectedNetwork: network,
  expectedGenesisHash: genesisHash, expectedIssuerFingerprint: registry.meta().issuerFingerprint }; }
function child(file, args, input) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [file, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; process.stdout.on('data', b => { stdout += b; }); process.stderr.on('data', b => { stderr += b; });
    process.on('error', reject); process.on('close', status => resolve({ status, stdout, stderr }));
    process.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

test('connect/enroll/login/state: only public identity and proofs reach the node', async t => {
  const dir = await temp(t), profilePath = path.join(dir, 'profile.json'), configPath = path.join(dir, 'node.json');
  const identity = await createProfile({ profilePath, password, mnemonic });
  const registry = new AgentIdentityRegistry({ dataDir: path.join(dir, 'issuer') });
  const server = await serve(t, registry);
  await connectCabinet(pins(server, registry, configPath));
  const enrolled = await enrollAgent({ configPath, profilePath, password, handle: 'synthetic-agent' });
  assert.equal(enrolled.passport.payload.address, identity.address);
  const logged = await loginAgent({ configPath, profilePath, password });
  assert.equal(logged.address, identity.address); assert.equal(Object.hasOwn(logged, 'token'), false);
  const session = JSON.parse(await fs.readFile(configPath + '.session.json', 'utf8'));
  const state = await cabinetState({ configPath, profilePath });
  assert.equal(state.wallet.address, identity.address); assert.equal(JSON.stringify(state).includes(session.token), false);
  assert.equal(Object.hasOwn(state, 'token'), false);
  const transmitted = JSON.stringify(server.calls);
  for (const secret of [password, mnemonic, 'PRIVATE KEY', 'privKey', 'mnemonic']) assert.equal(transmitted.includes(secret), false);
  assert.equal(server.calls.some(call => ['/wallet/create', '/wallet/recover', '/tx/sign', '/join'].includes(call.path)), false);
  if (process.platform !== 'win32') for (const file of [configPath, profilePath + '.passport.json', configPath + '.session.json']) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('the same encrypted profile/passport moves to a replica with its own login issuer', async t => {
  const dir = await temp(t), profilePath = path.join(dir, 'profile.json'), configPath = path.join(dir, 'node.json');
  const identity = await createProfile({ profilePath, password, mnemonic });
  const profileBefore = await fs.readFile(profilePath, 'utf8');
  const registryA = new AgentIdentityRegistry({ dataDir: path.join(dir, 'A') });
  const serverA = await serve(t, registryA);
  await connectCabinet(pins(serverA, registryA, configPath));
  await enrollAgent({ configPath, profilePath, password, handle: 'synthetic-agent' });
  await loginAgent({ configPath, profilePath, password });
  const registryB = new AgentIdentityRegistry({ dataDir: path.join(dir, 'B'), trustedIssuers: [registryA.meta().issuerPub] });
  const serverB = await serve(t, registryB, { operatorPin: registryA.meta().issuerFingerprint, replica: true });
  assert.notEqual(registryA.meta().issuerFingerprint, registryB.meta().issuerFingerprint);
  await connectCabinet({ ...pins(serverB, registryA, configPath) });
  await assert.rejects(fs.stat(configPath + '.session.json'), { code: 'ENOENT' });
  await assert.rejects(enrollAgent({ configPath, profilePath, password, handle: 'another' }), /enrollment_requires/);
  await loginAgent({ configPath, profilePath, password });
  assert.equal((await cabinetState({ configPath, profilePath })).wallet.address, identity.address);
  assert.equal(registryB.findByAddress(identity.address).issuerFingerprint, registryA.meta().issuerFingerprint);
  assert.equal(await fs.readFile(profilePath, 'utf8'), profileBefore, 'switching URL does not rewrite or replace keys');
  assert.equal(serverB.calls.some(call => call.path === '/identity/register'), false);
});

test('network/genesis/issuer pins, certificate tampering and wrong-profile sessions fail closed', async t => {
  const dir = await temp(t), profilePath = path.join(dir, 'profile.json'), configPath = path.join(dir, 'node.json');
  const identity = await createProfile({ profilePath, password, mnemonic });
  const registry = new AgentIdentityRegistry({ dataDir: path.join(dir, 'issuer') });
  const server = await serve(t, registry); const good = pins(server, registry, configPath);
  for (const bad of [ { expectedGenesisHash: 'b'.repeat(64) }, { expectedNetwork: 'OTHER' }, { expectedIssuerFingerprint: 'sha256:' + 'f'.repeat(64) },
    { nodeUrl: 'http://example.invalid' }, { expectedIssuerFingerprint: undefined } ]) await assert.rejects(connectCabinet({ ...good, ...bad }));
  await assert.rejects(fs.stat(configPath), { code: 'ENOENT' });
  await connectCabinet(good);
  const originalConfig = await fs.readFile(configPath, 'utf8');
  await assert.rejects(connectCabinet({ ...good, expectedGenesisHash: 'b'.repeat(64) }));
  assert.equal(await fs.readFile(configPath, 'utf8'), originalConfig);
  const enrolled = await enrollAgent({ configPath, profilePath, password, handle: 'synthetic-agent' });
  const changed = structuredClone(enrolled.passport); changed.payload.handle = 'tampered-agent';
  assert.throws(() => verifyClientPassport(changed, { expectedNetwork: network, expectedIssuerFingerprint: good.expectedIssuerFingerprint, identity }), /signature_invalid/);
  await loginAgent({ configPath, profilePath, password });
  const otherPath = path.join(dir, 'other.json'); await createProfile({ profilePath: otherPath, password });
  await assert.rejects(cabinetState({ configPath, profilePath: otherPath }), /wrong_node/);
});

test('CLI emits no session token; legacy create/join cannot request node wallet keys', async t => {
  const dir = await temp(t), profilePath = path.join(dir, 'profile.json'), configPath = path.join(dir, 'node.json');
  await createProfile({ profilePath, password, mnemonic });
  const registry = new AgentIdentityRegistry({ dataDir: path.join(dir, 'issuer') }); const server = await serve(t, registry);
  const connected = await child(cli, ['connect', configPath], pins(server, registry, configPath)); assert.equal(connected.status, 0, connected.stderr);
  const enrolled = await child(cli, ['enroll', configPath, profilePath], { password, handle: 'synthetic-agent' }); assert.equal(enrolled.status, 0, enrolled.stderr);
  const logged = await child(cli, ['login', configPath, profilePath], { password }); assert.equal(logged.status, 0, logged.stderr);
  const state = await child(cli, ['state', configPath, profilePath]); assert.equal(state.status, 0, state.stderr);
  const token = JSON.parse(await fs.readFile(configPath + '.session.json', 'utf8')).token;
  for (const result of [connected, enrolled, logged, state]) for (const secret of [token, password, mnemonic, 'PRIVATE KEY']) assert.equal((result.stdout + result.stderr).includes(secret), false);

  // Copy only the legacy CLI into an isolated synthetic state directory. Import
  // the real vault module by absolute file URL; no repository wallet is touched.
  const legacyPath = path.join(dir, 'legacy.mjs');
  const legacySource = (await fs.readFile(path.join(repo, 'agt-skill', 'agt.mjs'), 'utf8'))
    .replace("'./agent-profile.mjs'", JSON.stringify(pathToFileURL(path.join(repo, 'agt-skill', 'agent-profile.mjs')).href));
  await fs.writeFile(legacyPath, legacySource);
  const stateDir = path.join(dir, '.state'); await fs.mkdir(stateDir, { mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'node.json'), JSON.stringify({ base: server.url }));
  const before = server.calls.length;
  const disabled = await child(legacyPath, ['join', 'synthetic']); assert.equal(disabled.status, 1); assert.match(disabled.stderr, /join_disabled/);
  const created = await child(legacyPath, ['create', path.join(dir, 'new-profile.json')], { password }); assert.equal(created.status, 0, created.stderr);
  assert.equal(server.calls.length, before, 'new profile and disabled join perform zero network calls');
  // Signature-only synthetic submission into a test HTTP verifier, not a chain.
  const wallet = createWallet('synthetic-legacy');
  await fs.writeFile(path.join(stateDir, 'wallets-local.json'), JSON.stringify({ wallets: { [wallet.address]: wallet } }));
  const sent = await child(legacyPath, ['send', wallet.address, wallet.address, '0.001', 'synthetic-no-chain']);
  assert.equal(sent.status, 0, sent.stderr); assert.match(sent.stderr, /legacy_plaintext_wallet/);
  const txCall = server.calls.find(call => call.path === '/tx'); assert.ok(txCall); assert.equal(verifyTransaction(txCall.body), true);
  assert.equal(JSON.stringify(server.calls).includes(wallet.privKey), false);
  assert.equal(server.calls.some(call => call.path === '/tx/sign'), false);
});
