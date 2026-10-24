import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createProfile, signProfileChallenge, signProfileWalletIntent, signProfileWalletOperation } from '../../agt-skill/agent-profile.mjs';
import { amountToUnits, amountToNetworkNumber, apiBalanceToUnits, pinNode, getBalance, preflight } from '../src/agent-client.mjs';
import { prepareTransfer, checkTransfer, submitExact } from '../src/wallet-service.mjs';
import { readJson, writeJsonAtomic, withLock } from '../src/secure-store.mjs';
import { txDigest, verifyTransaction } from '../../core.mjs';
import { formatStartupFailure, outputCapture, safeText } from '../../scripts/startup-diagnostics.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const wait = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function startNode(t, temp, network = 'AGT_TESTNET') {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, admin = crypto.randomBytes(32).toString('hex');
  const dataDir = path.join(temp, 'node-data'), passportDir = path.join(temp, 'passports');
  const home = path.join(temp, 'home'), tempDir = path.join(temp, 'tmp');
  await fs.mkdir(home, { recursive: true, mode: 0o700 }); await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(passportDir, { recursive: true, mode: 0o700 });
  const bootstrapFile = path.join(temp, 'bootstrap.json'); await fs.writeFile(bootstrapFile, '{"bootstrap":[]}');
  // Do not inherit AGT_*, NODE_OPTIONS, issuer pins, origins, proxy settings or
  // operator paths from the invoking shell. Every child gets a deliberately
  // constructed test-only environment and separate chain/passport/bootstrap roots.
  const env = {
    PATH: process.env.PATH || '', HOME: home, TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    AGT_CHAIN_ID: network, AGT_BIND: '127.0.0.1', AGT_DATA_DIR: dataDir,
    AGT_PASSPORT_DATA_DIR: passportDir, AGT_BOOTSTRAP_FILE: bootstrapFile,
    AGT_AGENT_OWNER_FILE: path.join(temp, 'agent-owner.json'),
    AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: admin, AGT_SITE_SYNC: '0',
    AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0', AGT_IDENTITY_ROLE: 'issuer',
    AGT_IDENTITY_AUDIENCE: 'agent-wallet-test:' + port, AGT_REQUIRE_EXISTING_ISSUER: '0',
    AGT_AGENT_ORIGINS: 'https://wallet.example.test', NODE_ENV: 'test', TZ: 'UTC',
  };
  const child = spawn(process.execPath, [path.join(root, 'node.mjs'), String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = outputCapture(), stderr = outputCapture(); let spawnError = null;
  child.stdout.on('data', stdout.append); child.stderr.on('data', stderr.append);
  child.once('error', error => { spawnError = error; });
  t.after(async () => {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit'); child.kill('SIGTERM');
    const graceful = await Promise.race([ended.then(() => true), wait(3000).then(() => false)]);
    if (!graceful) { const forced = once(child, 'exit'); child.kill('SIGKILL'); await Promise.race([forced, wait(3000)]); }
  });
  const api = async (route, { method = 'GET', body, token = false } = {}) => {
    const r = await fetch(origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(7000),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-admin-token': admin } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null && !spawnError; i++) { try { if ((await api('/info')).status === 200) { ready = true; break; } } catch {} await wait(100); }
  if (!ready) assert.fail(formatStartupFailure({ label: 'agent-wallet test', exitCode: child.exitCode,
    signal: child.signalCode, stdout, stderr, spawnError, secrets: [admin] }));
  return { origin, api, env, getOutput: () => safeText(`stdout:\n${stdout.text}\nstderr:\n${stderr.text}`, [admin]) };
}
async function secretProfile(file, network = 'AGT_TESTNET') {
  const password = 'synthetic-only-' + crypto.randomBytes(8).toString('hex');
  const publicData = await createProfile({ profilePath: file, password, network, label: path.basename(file) });
  return { ...publicData, profilePath: file, password };
}

test('strict user amounts and numeric API balances convert exactly to mGNT', async () => {
  assert.equal(amountToUnits('0.000000015'), 15n);
  assert.equal(amountToNetworkNumber('0.000000015'), 0.000000015);
  assert.throws(() => amountToNetworkNumber('9007199.254740991'), /exact/);
  for (const bad of ['-1', 'NaN', '1e-9', '1.0000000001', '9007199.254740992', '0']) assert.throws(() => amountToUnits(bad));
  assert.equal(typeof 1e-9, 'number');
  assert.equal(String(1e-9), '1e-9', 'API balance may stringify using exponent notation');
  assert.equal(apiBalanceToUnits(0), 0n);
  assert.equal(apiBalanceToUnits(1e-9), 1n);
  assert.equal(apiBalanceToUnits(15e-9), 15n);
  assert.equal(apiBalanceToUnits(1.23456789), 1234567890n);
  assert.equal(apiBalanceToUnits(Number('9007199.25474099')), 9007199254740990n);
  for (const bad of [NaN, Infinity, -Infinity, -1, -0, 1e-10, Number('9007199.254740993'), '1e-9', null]) {
    assert.throws(() => apiBalanceToUnits(bad), undefined, `reject API balance ${JSON.stringify(bad)}`);
  }

  const originalFetch = globalThis.fetch;
  const address = 'AGT' + 'a'.repeat(40), genesisHash = 'd'.repeat(64);
  let balance = 0;
  globalThis.fetch = async input => {
    const route = new URL(String(input)).pathname;
    const body = route === '/info' ? { chainId: 'AGT_TESTNET', genesisHash } : { address, balance, unit: 'AGT' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const pin = { nodeUrl: 'https://balance.example.test', network: 'AGT_TESTNET', genesisHash };
    for (const [value, units] of [[0, '0'], [1e-9, '1'], [15e-9, '15'], [1.23456789, '1234567890'],
      [Number('9007199.25474099'), '9007199254740990']]) {
      balance = value;
      const result = await getBalance(pin, address);
      assert.equal(result.smallestUnits, units, `balance=${JSON.stringify({ type: typeof value, value: String(value) })}`);
      assert.equal(result.unit, 'AGT');
    }
    balance = Number('9007199.254740993');
    await assert.rejects(getBalance(pin, address), /api_balance_overflow/);
  } finally { globalThis.fetch = originalFetch; }
});

test('existing encrypted profile signer verifies one exact wallet operation and its profile binding', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-wallet-sign-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const p = await secretProfile(path.join(temp, 'chosen-agent.profile.json'));
  const receiver = await secretProfile(path.join(temp, 'recipient.profile.json'));
  const tx = { from: p.address, fromPub: p.pub, to: receiver.address, amount: 0.000000015, nonce: 42, ts: Math.floor(Date.now() / 1000), memo: 'цель <demo>' };
  tx.txid = txDigest(tx);
  const operation = { schema: 'agt-agent-wallet-op-v1', sourceOrigin: 'https://wallet.example.test', opId: 'a'.repeat(32),
    payload: { kind: 'send', tx, txidHex: tx.txid } };
  const result = await signProfileWalletOperation({ profilePath: p.profilePath, password: p.password, operation,
    expectedNetwork: 'AGT_TESTNET', expectedGenesisHash: 'b'.repeat(64), expectedNodeOrigin: 'https://wallet.example.test' });
  assert.equal(result.txid, tx.txid); assert.equal(result.pub, p.pub);
  assert.equal(verifyTransaction({ ...tx, signature: result.signature }), true);
  const trustedPin = { network: p.network, genesisHash: 'b'.repeat(64), nodeUrl: 'https://wallet.example.test' };
  const prepared = prepareTransfer({ pin: trustedPin, from: p.address, to: receiver.address,
    amount: '0.000000015', memo: 'точный intent' });
  await assert.rejects(signProfileWalletIntent({ profilePath: p.profilePath, password: p.password, request: prepared,
    expectedNetwork: trustedPin.network, expectedGenesisHash: trustedPin.genesisHash, expectedNodeUrl: trustedPin.nodeUrl }), /invalid_wallet_intent_request/);
  const { fee: _fee, display: _display, ...request } = prepared;
  assert.deepEqual(Object.keys(request).sort(), ['genesisHash', 'intent', 'network', 'schema']);
  const intentSigned = await signProfileWalletIntent({ profilePath: p.profilePath, password: p.password, request,
    expectedNetwork: trustedPin.network, expectedGenesisHash: trustedPin.genesisHash, expectedNodeUrl: trustedPin.nodeUrl });
  assert.equal(intentSigned.tx.to, receiver.address);
  assert.equal(verifyTransaction(intentSigned.tx), true);
  await assert.rejects(signProfileWalletIntent({ profilePath: p.profilePath, password: p.password, request,
    expectedNetwork: trustedPin.network, expectedGenesisHash: 'c'.repeat(64), expectedNodeUrl: trustedPin.nodeUrl }), /wallet_trust_pin_mismatch/);
  await assert.rejects(signProfileWalletIntent({ profilePath: p.profilePath, password: p.password, request,
    expectedNetwork: 'AGENTCOIN', expectedGenesisHash: trustedPin.genesisHash, expectedNodeUrl: trustedPin.nodeUrl }), /wallet_trust_pin_mismatch/);
  const realFetch = globalThis.fetch;
  let submitMode = 'accepted', postCount = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), route = url.pathname + url.search;
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (route === '/info') return json(200, { chainId: trustedPin.network, genesisHash: trustedPin.genesisHash });
    if (route === '/tx/preflight') return json(200, { network: trustedPin.network, verdict: 'preflight_pass',
      signature: { ok: true }, balance: { ok: true }, nonce: { ok: true }, fee: { amount: 0 } });
    if (route === '/tx') {
      postCount++;
      if (submitMode === 'timeout') throw new DOMException('synthetic timeout', 'TimeoutError');
      if (submitMode === 'reject') return json(400, { error: 'bad_signature' });
      return json(201, { accepted: true, mempool: 1, gossipped: true });
    }
    if (route === '/mempool?full=1') return json(200, { complete: true, txs: [] });
    if (route.startsWith('/txproof/')) return json(404, { error: 'tx_not_found' });
    return json(404, { error: 'route_not_found' });
  };
  try {
    const walletPin = { nodeUrl: trustedPin.nodeUrl, network: trustedPin.network, genesisHash: trustedPin.genesisHash };
    const accepted = await submitExact(walletPin, intentSigned);
    assert.equal(accepted.state, 'mempool', 'Agentcoin accepted:true contract needs no response txid');
    assert.equal(accepted.diagnostic.stage, 'accepted_response');
    submitMode = 'reject';
    const rejected = await submitExact(walletPin, intentSigned);
    assert.equal(rejected.state, 'rejected'); assert.equal(rejected.diagnostic.httpStatus, 400);
    assert.equal(rejected.diagnostic.response.error, 'bad_signature');
    submitMode = 'timeout';
    const unknown = await submitExact(walletPin, intentSigned, { timeoutMs: 25 });
    assert.equal(unknown.state, 'status_unknown'); assert.equal(unknown.diagnostic.stage, 'http_request');
    assert.equal(unknown.diagnostic.exception.name, 'TimeoutError');
    assert.equal(postCount, 3, 'one POST per explicit test invocation; timeout path did not retry');
  } finally { globalThis.fetch = realFetch; }
  await assert.rejects(signProfileWalletOperation({ profilePath: p.profilePath, password: p.password, operation,
    expectedNetwork: 'AGENTCOIN', expectedGenesisHash: 'b'.repeat(64), expectedNodeOrigin: 'https://wallet.example.test' }), /mismatch/);
  await assert.rejects(signProfileWalletOperation({ profilePath: p.profilePath, password: p.password, operation: { ...operation, payload: { ...operation.payload, txidHex: 'f'.repeat(64) } },
    expectedNetwork: 'AGT_TESTNET', expectedGenesisHash: 'b'.repeat(64), expectedNodeOrigin: 'https://wallet.example.test' }), /invalid_wallet_operation/);
  for (const [field, value] of [['amount', tx.amount + 0.000000001], ['to', 'AGT' + 'e'.repeat(40)], ['memo', tx.memo + ' altered']]) {
    const changedTx = { ...tx, [field]: value };
    const changed = { ...operation, payload: { ...operation.payload, tx: changedTx } };
    await assert.rejects(signProfileWalletOperation({ profilePath: p.profilePath, password: p.password, operation: changed,
      expectedNetwork: 'AGT_TESTNET', expectedGenesisHash: 'b'.repeat(64), expectedNodeOrigin: 'https://wallet.example.test' }),
    /wallet_profile_or_txid_mismatch/,
    `changing ${field} without changing the signed txid is rejected`);
  }
  const expired = { schema: 'agentcoin.wallet.intent.v1', network: trustedPin.network, genesisHash: trustedPin.genesisHash,
    intent: { from: p.address, to: receiver.address, amount: '0.000000015', memo: 'expired', createdAt: Math.floor(Date.now() / 1000) - 301,
      expiresAt: Math.floor(Date.now() / 1000) - 1, nonce: 43 } };
  await assert.rejects(signProfileWalletIntent({ profilePath: p.profilePath, password: p.password, request: expired,
    expectedNetwork: trustedPin.network, expectedGenesisHash: trustedPin.genesisHash, expectedNodeUrl: 'https://wallet.example.test' }), /invalid_wallet_intent/);
});

test('private journal storage is atomic, locked, mode-limited and fails closed on corruption', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-wallet-store-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'private', 'operations.json');
  await withLock(file, async () => {
    await writeJsonAtomic(file, { version: 1, entries: [{ state: 'prepared', amount: '0.1' }] });
    await assert.rejects(withLock(file, async () => {}), /busy/);
  });
  assert.equal((await readJson(file)).entries[0].amount, '0.1');
  const mode = (await fs.stat(file)).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
  await fs.writeFile(file, '{broken');
  await assert.rejects(readJson(file));
});

test('encrypted profile signer produces a verified Agentcoin tx and refuses mismatched pins or mutations', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-wallet-unit-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const node = await startNode(t, temp);
  const from = await secretProfile(path.join(temp, 'from.profile.json')), to = await secretProfile(path.join(temp, 'to.profile.json'));
  const info = (await node.api('/info')).body, pin = await pinNode(node.origin, 'AGT_TESTNET', info.genesisHash);
  await assert.rejects(pinNode(node.origin, 'AGENTCOIN', info.genesisHash), /mismatch/);
  const wrong = { ...pin, genesisHash: 'a'.repeat(64) }; await assert.rejects(getBalance(wrong, from.address), /mismatch/);
  const prepared = prepareTransfer({ pin, from: from.address, to: to.address, amount: '0.000000015', memo: 'синтетика & <тест>' });
  // Match CLI's on-disk request exactly: fee/display are presentation metadata,
  // while the signer accepts only the pinned network/genesis and intent.
  const { fee: _fee, display: _display, ...request } = prepared;
  await assert.rejects(signProfileWalletIntent({ profilePath: from.profilePath, password: from.password, request,
    expectedNetwork: 'AGT_TESTNET', expectedGenesisHash: 'b'.repeat(64), expectedNodeUrl: node.origin }), /pin_mismatch/);
  const signed = await signProfileWalletIntent({ profilePath: from.profilePath, password: from.password, request,
    expectedNetwork: 'AGT_TESTNET', expectedGenesisHash: pin.genesisHash, expectedNodeUrl: node.origin });
  await assert.rejects(signProfileWalletIntent({ profilePath: to.profilePath, password: to.password, request,
    expectedNetwork: 'AGT_TESTNET', expectedGenesisHash: pin.genesisHash, expectedNodeUrl: node.origin }), /profile_mismatch/);
  assert.equal(signed.tx.amount, 0.000000015);
  // Fund and verify the sender before preflight: mining after preflight cannot
  // retroactively make an underfunded snapshot pass.
  const mined = await node.api('/mine', { method: 'POST', body: { miner: from.address }, token: true });
  assert.equal(mined.status, 200, `funding block must be committed before preflight: HTTP ${mined.status}`);
  const funded = await getBalance(pin, from.address);
  assert.equal(funded.unit, 'AGT');
  assert.ok(BigInt(funded.smallestUnits) >= amountToUnits('0.000000015'),
    'sender must have at least 15 mGNT (0.000000015 AGT) before preflight');
  const checked = await checkTransfer(pin, signed);
  const reasons = [];
  if (!checked.format?.ok) reasons.push(checked.format?.error || 'format_not_ok');
  if (!checked.signature?.ok) reasons.push(checked.signature?.error || 'signature_not_ok');
  if (!checked.network_ok) reasons.push('network_not_ok');
  if (!checked.balance?.ok) reasons.push('insufficient_balance');
  if (!checked.nonce?.ok) reasons.push('nonce_conflict');
  if (checked.format?.mgnt_exact === false) reasons.push('amount_not_exact_mgnt');
  const diagnostic = {
    httpStatus: checked.httpStatus,
    reason: reasons.join(',') || checked.reason || checked.error || null,
    network: checked.network,
    readonly: checked.readonly,
    format: checked.format,
    signature: checked.signature,
    network_ok: checked.network_ok,
    balance: checked.balance,
    nonce: checked.nonce,
    fee: checked.fee,
    verdict: checked.verdict,
  };
  t.diagnostic({ event: 'anonymized POST /tx/preflight response', ...diagnostic });
  assert.equal(checked.verdict, 'preflight_pass', `anonymized POST /tx/preflight response: ${JSON.stringify(diagnostic)}`);
  assert.equal(checked.fee.amount, 0, 'current Agentcoin transfer fee is zero AGT');
  for (const altered of [ { ...signed, tx: { ...signed.tx, to: from.address } }, { ...signed, tx: { ...signed.tx, amount: 1 } },
    { ...signed, tx: { ...signed.tx, memo: 'подмена' } }, { ...signed, tx: { ...signed.tx, signature: '00'.repeat(64) } } ]) await assert.rejects(checkTransfer(pin, altered));
  const submitted = await submitExact(pin, signed);
  assert.equal(submitted.state, 'mempool', `POST /tx diagnostics: ${JSON.stringify({ stage: submitted.diagnostic?.stage,
    httpStatus: submitted.diagnostic?.httpStatus, response: submitted.diagnostic?.response, exception: submitted.diagnostic?.exception })}`);
  assert.equal(submitted.txid, signed.tx.txid);
  const pool = await node.api('/mempool?full=1');
  assert.equal(pool.status, 200);
  assert.equal(pool.body.complete, true);
  assert.ok(pool.body.txs.some(tx => tx.txid === signed.tx.txid),
    `the original full txid must be present after accepted POST; found=${pool.body.txs.some(tx => tx.txid === signed.tx.txid)}`);
  const repeated = await preflight(pin, signed.tx); assert.equal(repeated.nonce.ok, false, 'same signed request is detected as already queued');
  const block = await node.api('/mine', { method: 'POST', body: { miner: from.address }, token: true }); assert.equal(block.status, 200);
  const recipientBalance = await getBalance(pin, to.address); assert.equal(recipientBalance.smallestUnits, '15');
  assert.equal((await node.api('/txproof/' + signed.tx.txid)).status, 200);
});

test('same AGT-IDENTITY-V1 profile signs one cabinet op bound to pinned origin/network/genesis', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-wallet-cabinet-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const node = await startNode(t, temp, 'AGENTCOIN');
  const profile = await secretProfile(path.join(temp, 'agent.profile.json'), 'AGENTCOIN');
  const meta = (await node.api('/identity/meta')).body;
  const regChallenge = (await node.api('/identity/challenge', { method: 'POST', body: { address: profile.address, pub: profile.pub, handle: 'wallet-agent' } })).body;
  const regProof = await signProfileChallenge({ profilePath: profile.profilePath, password: profile.password, challenge: regChallenge,
    expectedAction: 'register', expectedAudience: meta.audience, expectedIssuerFingerprint: meta.issuerFingerprint, expectedNetwork: meta.network });
  assert.equal((await node.api('/identity/register', { method: 'POST', body: { challengeId: regProof.challengeId, signature: regProof.signature } })).status, 201);
  const issued = (await node.api('/cabinet/challenge', { method: 'POST', body: { address: profile.address } })).body;
  const proof = await signProfileChallenge({ profilePath: profile.profilePath, password: profile.password, challenge: issued.challenge,
    expectedAction: 'login', expectedAudience: meta.audience, expectedIssuerFingerprint: meta.issuerFingerprint, expectedNetwork: meta.network });
  const login = await node.api('/cabinet/login', { method: 'POST', body: { address: profile.address, mode: 'challenge', challengeId: proof.challengeId, nonce: issued.nonce, signature: proof.signature } });
  assert.equal(login.status, 200);
  const to = await secretProfile(path.join(temp, 'recipient.profile.json'));
  const guest = await node.api('/cabinet/op-request', { method: 'POST', body: { address: profile.address, op: { kind: 'send', to: to.address, amount: 0.000000015 } } });
  assert.equal(guest.status, 401);
  const funded = await node.api('/mine', { method: 'POST', body: { miner: profile.address }, token: true }); assert.equal(funded.status, 200);
  const req = await node.api('/cabinet/op-request', { method: 'POST', body: { address: profile.address, token: login.body.token,
    op: { kind: 'send', to: to.address, amount: 0.000000015, memo: 'browser-path-test' } } });
  assert.equal(req.status, 200);
  const info = (await node.api('/info')).body;
  const operation = { schema: 'agt-agent-wallet-op-v1', sourceOrigin: node.origin, opId: req.body.opId, payload: req.body.payload };
  const trusted = { version: 1, nodeUrl: node.origin, network: info.chainId, genesisHash: info.genesisHash };
  const signed = await signProfileWalletOperation({ profilePath: profile.profilePath, password: profile.password, operation,
    expectedNetwork: trusted.network, expectedGenesisHash: trusted.genesisHash, expectedNodeOrigin: trusted.nodeUrl });
  assert.equal(signed.pub, profile.pub);
  const changedOriginOnly = { ...operation, sourceOrigin: 'http://127.0.0.1:1' };
  assert.deepEqual({ ...changedOriginOnly, sourceOrigin: operation.sourceOrigin }, operation,
    'origin negative case changes no operation fields other than sourceOrigin');
  await assert.rejects(signProfileWalletOperation({ profilePath: profile.profilePath, password: profile.password, operation: changedOriginOnly,
    expectedNetwork: trusted.network, expectedGenesisHash: trusted.genesisHash, expectedNodeOrigin: trusted.nodeUrl }), /origin_mismatch/);
  const malformed = { ...operation, payload: { ...operation.payload, unexpected: true } };
  await assert.rejects(signProfileWalletOperation({ profilePath: profile.profilePath, password: profile.password, operation: malformed,
    expectedNetwork: trusted.network, expectedGenesisHash: trusted.genesisHash, expectedNodeOrigin: trusted.nodeUrl }), /invalid_wallet_operation/);
  const signedTamper = { ...signed, txid: 'f'.repeat(64) }; assert.notEqual(signedTamper.txid, req.body.payload.txidHex);
  const accepted = await node.api('/cabinet/op-submit', { method: 'POST', body: { opId: req.body.opId, signature: signed.signature } });
  assert.equal(accepted.status, 201); assert.equal(accepted.body.txid, signed.txid.slice(0, 16));
  assert.match(node.getOutput(), /agip-46/, 'isolated node must report the exercised agip-46 operation');
});

test('HTTP accept followed by timeout yields unknown and never retries the signed tx', async t => {
  const genesisHash = 'c'.repeat(64); let posts = 0, mode = 'timeout';
  const server = http.createServer(async (req, res) => {
    if (req.url === '/info') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ chainId: 'AGT_TESTNET', genesisHash })); return; }
    if (req.url === '/tx/preflight') { for await (const _ of req) {} res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ network: 'AGT_TESTNET', verdict: 'preflight_pass', signature: { ok: true }, balance: { ok: true }, nonce: { ok: true }, fee: { amount: 0 } })); return; }
    if (req.url === '/tx') {
      posts++; for await (const _ of req) {}
      if (mode === 'timeout') { setTimeout(() => { if (!res.destroyed) { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ accepted: true, mempool: 1, gossipped: true })); } }, 250); return; }
      if (mode === 'accepted') { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ accepted: true, mempool: 1, gossipped: true })); return; }
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad_signature' })); return;
    }
    res.writeHead(404); res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const pin = { nodeUrl: `http://127.0.0.1:${server.address().port}`, network: 'AGT_TESTNET', genesisHash };
  const signed = { tx: { txid: '1234567890abcdef' + '0'.repeat(48) } };
  const result = await submitExact(pin, signed, { timeoutMs: 40 });
  assert.equal(result.state, 'status_unknown');
  assert.equal(result.diagnostic.stage, 'http_request');
  assert.equal(result.diagnostic.exception.name, 'TimeoutError');
  assert.equal(posts, 1, 'timeout causes no automatic retry/new nonce');
  mode = 'accepted';
  const accepted = await submitExact(pin, signed);
  assert.equal(accepted.state, 'mempool', `accepted contract response: ${JSON.stringify(accepted.diagnostic)}`);
  assert.equal(accepted.diagnostic.stage, 'accepted_response');
  mode = 'reject';
  const rejected = await submitExact(pin, signed);
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.diagnostic.httpStatus, 400);
  assert.equal(rejected.diagnostic.response.error, 'bad_signature');
  assert.equal(posts, 3);
});
