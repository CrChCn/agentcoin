import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWallet } from '../core.mjs';
import {
  AgentIdentityRegistry, agentIdentityId, canonicalAgentChallenge,
  canonicalAgentPassport, createAgentChallenge, issuerFingerprint, validateAgentChallenge,
  isRawAgentPubHex, rawAgentPubToPem, addressFromRawAgentPub, bindPubToAddress,
} from '../agent-identity.mjs';
import { pubFromPriv, addressFromPubHex } from '../site/js/agt-tx.mjs';

const epoch = 1_800_000_000_000;
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-identity-'));
  const registry = new AgentIdentityRegistry({ dataDir: dir, now: () => epoch, ...options });
  return { dir, registry, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function signedRegistration(registry, wallet, handle = 'worker-one') {
  const c = registry.challengeRegistration({ address: wallet.address, pub: wallet.pub, handle });
  assert.equal(c.ok, true, JSON.stringify(c));
  return { c, input: { challengeId: c.challengeId, signature: crypto.sign(null, Buffer.from(c.message, 'utf8'), wallet.privKey).toString('hex') } };
}
function register(registry, wallet, handle) {
  const { input } = signedRegistration(registry, wallet, handle);
  const result = registry.register(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test('possession proof issues a signed passport without storing the agent secret', () => {
  const f = fixture();
  try {
    const w = createWallet('synthetic-agent');
    const { c, input } = signedRegistration(f.registry, w, 'Королер');
    assert.equal(c.action, 'register');
    assert.equal(c.message.startsWith('AGT-IDENTITY-V1\n'), true);
    const result = f.registry.register(input);
    assert.equal(result.ok, true);
    assert.equal(result.identity.address, w.address);
    assert.equal(result.identity.pub, w.pub);
    assert.equal(result.identity.agentId, agentIdentityId('AGENTCOIN', w.pub, w.address));
    assert.equal(f.registry.verifyPassport(result.passport).ok, true);
    assert.equal(f.registry.register(input).error, 'challenge_not_issued');
    const publicDisk = fs.readFileSync(path.join(f.dir, 'agent-identities.json'), 'utf8');
    const publicResponses = JSON.stringify([f.registry.meta(), result, f.registry.findByAddress(w.address)]);
    assert.equal(publicDisk.includes(w.privKey), false);
    assert.equal(publicResponses.includes('PRIVATE KEY'), false);
    const issuer = JSON.parse(fs.readFileSync(path.join(f.dir, 'identity-issuer.json'), 'utf8'));
    assert.notEqual(issuer.pub, w.pub);
    assert.notEqual(issuer.privKey, w.privKey);
    assert.equal(publicDisk.includes('PRIVATE KEY'), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.dir, 'identity-issuer.json')).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test('another agent cannot prove ownership, and a failed proof is consumed', () => {
  const f = fixture();
  try {
    const owner = createWallet(); const stranger = createWallet();
    assert.equal(f.registry.challengeRegistration({ address: owner.address, pub: stranger.pub, handle: 'owner' }).error, 'address_public_key_mismatch');
    const { c, input } = signedRegistration(f.registry, owner, 'owner');
    const wrong = crypto.sign(null, Buffer.from(c.message), stranger.privKey).toString('hex');
    assert.equal(f.registry.register({ ...input, signature: wrong }).error, 'invalid_signature');
    assert.equal(f.registry.register(input).error, 'challenge_not_issued');
    assert.equal(f.registry.findByAddress(owner.address), null);
    const fresh = signedRegistration(f.registry, owner, 'owner');
    const altered = { ...fresh.c, handle: 'stolen' };
    const alteredSig = crypto.sign(null, Buffer.from(canonicalAgentChallenge(altered)), owner.privKey).toString('hex');
    assert.equal(f.registry.register({ ...fresh.input, signature: alteredSig }).error, 'invalid_signature');
  } finally { f.close(); }
});

test('network, action, issuer and audience are in the signed domain; invalid actions fail closed', () => {
  const f = fixture();
  try {
    const w = createWallet(); const { c } = signedRegistration(f.registry, w);
    assert.equal(validateAgentChallenge(c, { network: 'AGENTCOIN', audience: 'agentcoin', issuerFingerprint: f.registry.meta().issuerFingerprint, action: 'register', now: epoch }).address, w.address);
    for (const [field, value] of [['network', 'OTHER'], ['audience', 'evil.example'], ['action', 'login'], ['issuerFingerprint', 'sha256:' + '0'.repeat(64)]]) {
      assert.throws(() => validateAgentChallenge(c, { [field]: value, now: epoch }), { code: `challenge_${field}_mismatch` });
    }
    assert.throws(() => validateAgentChallenge({ ...c, message: c.message + '\n' }, { now: epoch }), { code: 'challenge_message_mismatch' });
    assert.throws(() => canonicalAgentChallenge({ ...c, action: 'transfer' }), { code: 'unsupported_identity_action' });
    assert.throws(() => canonicalAgentChallenge({ ...c, privKey: w.privKey }), { code: 'invalid_schema' });
    assert.throws(() => canonicalAgentChallenge({ ...c, pub: w.privKey }), { code: 'invalid_public_key' });
    assert.throws(() => canonicalAgentChallenge({ ...c, version: '1' }), { code: 'unsupported_identity_version' });
    const login = createAgentChallenge({ ...c, action: 'login', handle: '' }, { now: epoch });
    assert.notEqual(login.message, c.message);
    assert.equal(validateAgentChallenge(login, { now: epoch, action: 'login' }).handle, '');
  } finally { f.close(); }
});

test('expiry, per-address/global bounds and restart eliminate outstanding proofs', () => {
  let now = epoch;
  const f = fixture({ now: () => now, maxChallenges: 2, challengeTtlMs: 1000 });
  try {
    const a = createWallet(); const b = createWallet(); const c = createWallet();
    const proof = signedRegistration(f.registry, a, 'a');
    signedRegistration(f.registry, b, 'b');
    assert.equal(f.registry.challengeRegistration({ address: c.address, pub: c.pub, handle: 'c' }).error, 'challenge_capacity');
    now += 1000;
    assert.equal(f.registry.register(proof.input).error, 'challenge_expired');
    assert.equal(f.registry.register(proof.input).error, 'challenge_not_issued');
    const newProof = signedRegistration(f.registry, c, 'c');
    const restarted = new AgentIdentityRegistry({ dataDir: f.dir, now: () => now });
    assert.equal(restarted.register(newProof.input).error, 'challenge_not_issued');
    const small = fixture({ maxChallenges: 10 });
    try {
      for (let i = 0; i < 3; i++) signedRegistration(small.registry, a, 'a');
      assert.equal(small.registry.challengeRegistration({ address: a.address, pub: a.pub, handle: 'a' }).error, 'address_challenge_capacity');
    } finally { small.close(); }
  } finally { f.close(); }
});

test('portable passport is accepted only with an explicitly pinned issuer key', () => {
  const home = fixture(); const stranger = fixture(); let child;
  try {
    const w = createWallet(); const result = register(home.registry, w, 'portable-agent');
    assert.equal(stranger.registry.importPassport(result.passport).error, 'untrusted_passport_issuer');
    child = fixture({ trustedIssuers: [home.registry.meta().issuerPub] });
    const imported = child.registry.importPassport(JSON.parse(JSON.stringify(result.passport)));
    assert.equal(imported.ok, true);
    assert.equal(imported.identity.agentId, result.identity.agentId);
    assert.equal(imported.identity.address, result.identity.address);
    assert.equal(child.registry.importPassport(result.passport).existing, true);
    const restarted = new AgentIdentityRegistry({ dataDir: child.dir, trustedIssuers: [home.registry.meta().issuerPub], now: () => epoch });
    assert.deepEqual(restarted.findByAddress(w.address).certificate, result.passport);
    assert.equal(restarted.meta().issuerFingerprint, child.registry.meta().issuerFingerprint);
    assert.throws(() => new AgentIdentityRegistry({ dataDir: child.dir, now: () => epoch }), /untrusted_passport_issuer/);
    const wrongNet = fixture({ network: 'OTHER', trustedIssuers: [home.registry.meta().issuerPub] });
    try { assert.equal(wrongNet.registry.importPassport(result.passport).error, 'passport_network_mismatch'); } finally { wrongNet.close(); }
  } finally { home.close(); stranger.close(); child?.close(); }
});

test('self-signed and tampered certificates cannot impersonate a trusted issuer', () => {
  const home = fixture(); const receiver = fixture({ trustedIssuers: [home.registry.meta().issuerPub] });
  try {
    const w = createWallet(); const attacker = createWallet();
    const legitimate = register(home.registry, w, 'honest');
    const changed = structuredClone(legitimate.passport); changed.payload.handle = 'attacker';
    assert.equal(receiver.registry.importPassport(changed).error, 'invalid_passport_signature');
    const forged = structuredClone(legitimate.passport);
    forged.issuerPub = attacker.pub; forged.payload.issuerFingerprint = issuerFingerprint(attacker.pub);
    forged.signature = crypto.sign(null, Buffer.from(canonicalAgentPassport(forged.payload)), attacker.privKey).toString('hex');
    assert.equal(receiver.registry.importPassport(forged).error, 'untrusted_passport_issuer');
    forged.payload.issuerFingerprint = home.registry.meta().issuerFingerprint;
    assert.equal(receiver.registry.importPassport(forged).error, 'issuer_fingerprint_mismatch');
    assert.equal(receiver.registry.findByAddress(w.address), null);
  } finally { home.close(); receiver.close(); }
});

test('registry survives restart, preserves uniqueness, and returns detached public objects', () => {
  const f = fixture();
  try {
    const a = createWallet(); const b = createWallet();
    const result = register(f.registry, a, 'Agent-one');
    const beforeMeta = f.registry.meta();
    const restarted = new AgentIdentityRegistry({ dataDir: f.dir, now: () => epoch });
    assert.equal(restarted.meta().issuerFingerprint, beforeMeta.issuerFingerprint);
    assert.equal(restarted.findByAddress(a.address).handle, 'Agent-one');
    assert.equal(restarted.challengeRegistration({ address: b.address, pub: b.pub, handle: 'agent-one' }).error, 'handle_unavailable');
    const publicRec = restarted.findByAddress(a.address); publicRec.certificate.payload.handle = 'changed';
    assert.equal(restarted.findByAddress(a.address).handle, 'Agent-one');
    result.passport.payload.handle = 'modified-by-caller';
    assert.equal(f.registry.findByAddress(a.address).handle, 'Agent-one');
    assert.equal(fs.readdirSync(f.dir).some(name => name.endsWith('.tmp')), false);
    // Invalid existing data is a startup error, never a silent empty registry.
    fs.writeFileSync(path.join(f.dir, 'agent-identities.json'), '{broken');
    assert.throws(() => new AgentIdentityRegistry({ dataDir: f.dir, now: () => epoch }));
  } finally { f.close(); }
});

test('raw key support: browser scheme address matches agt-tx, differs from PEM scheme', () => {
  // Фиксированный синтетический вектор (нулевой баланс, только для тестов).
  const priv = 'bcba52b43442c9edfb5b0e94146a38d10f03751cb0bce55ceef42aa9f94b97cb';
  const raw = pubFromPriv(priv);
  assert.equal(isRawAgentPubHex(raw), true);
  assert.equal(isRawAgentPubHex(raw.toUpperCase()), true);
  assert.equal(addressFromRawAgentPub(raw), addressFromPubHex(raw));
  assert.equal(addressFromRawAgentPub(raw), 'AGT0f2a987fe04ad033cf18a9aff5d633ec523e536e');
  // Случайный ключ: сошлось с браузерной формулой, разошлось с паспортной.
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw2 = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('hex');
  assert.equal(addressFromRawAgentPub(raw2), addressFromPubHex(raw2));
  const pem = rawAgentPubToPem(raw2);
  assert.ok(pem.startsWith('-----BEGIN PUBLIC KEY-----'));
  // Мусор отвергается кодом invalid_public_key, а не молча.
  for (const bad of [null, '', 'zz', '00'.repeat(31), '00'.repeat(33), pem]) {
    assert.equal(isRawAgentPubHex(bad), false);
    assert.throws(() => addressFromRawAgentPub(bad), /invalid_public_key/);
    assert.throws(() => rawAgentPubToPem(bad), /invalid_public_key/);
  }
});

test('bindPubToAddress: binds within scheme, rejects cross-scheme and garbage', () => {
  const priv = 'bcba52b43442c9edfb5b0e94146a38d10f03751cb0bce55ceef42aa9f94b97cb';
  const raw = pubFromPriv(priv);
  const pem = rawAgentPubToPem(raw);
  const addrRaw = addressFromRawAgentPub(raw);
  // сырой к сырому адресу; PEM к PEM-адресу проверяется путём canonicalAgentPublicKey
  assert.equal(bindPubToAddress(addrRaw, raw), raw);
  assert.equal(bindPubToAddress(addrRaw, raw.toUpperCase()), raw);
  // чужой адрес, мусор, кросс-схема — null
  assert.equal(bindPubToAddress('AGT' + '00'.repeat(20), raw), null);
  assert.equal(bindPubToAddress(addrRaw, 'zz'), null);
  assert.equal(bindPubToAddress(addrRaw, null), null);
  assert.equal(bindPubToAddress(addrRaw, pem), null); // PEM не вяжется к raw-адресу
  assert.equal(bindPubToAddress('not-an-address', raw), null);
});

test('raw key round-trip: rebuilt PEM verifies signatures of the same key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('hex');
  const msg = Buffer.from('AGT-IDENTITY-V1\nprobe', 'utf8');
  const sig = crypto.sign(null, msg, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.equal(crypto.verify(null, msg, rawAgentPubToPem(raw), sig), true);
  assert.equal(crypto.verify(null, Buffer.from('other', 'utf8'), rawAgentPubToPem(raw), sig), false);
});

test('malformed and oversized requests do not create passports', () => {
  const f = fixture();
  try {
    const w = createWallet();
    for (const bad of [null, [], {}, { address: w.address, pub: w.pub, handle: '<script>' }, { address: w.address, pub: w.pub, handle: 'x'.repeat(65) }, { address: w.address, pub: w.pub, handle: 'agent', privKey: w.privKey }]) {
      assert.equal(f.registry.challengeRegistration(bad).ok, false);
    }
    const p = signedRegistration(f.registry, w);
    assert.equal(f.registry.register({ ...p.input, signature: '00' }).error, 'invalid_signature');
    assert.equal(f.registry.register(p.input).error, 'challenge_not_issued');
    assert.equal(fs.existsSync(path.join(f.dir, 'agent-identities.json')), false);
    assert.equal(f.registry.importPassport({ payload: 'x'.repeat(5000), issuerPub: w.pub, signature: '0'.repeat(128) }).ok, false);
  } finally { f.close(); }
});

test('challenge validation tolerates keyOnly flag and raw-hex pub (TOFU/key-login)', () => {
  const w = createWallet();
  const base = createAgentChallenge({ action: 'login', network: 'AGENTCOIN', audience: 'a',
    issuerFingerprint: issuerFingerprint(w.pub), address: w.address, pub: w.pub }, { now: epoch });
  const opts = { now: epoch, network: 'AGENTCOIN' };
  assert.equal(validateAgentChallenge({ ...base }, opts).address, w.address);
  assert.equal(validateAgentChallenge({ ...base, keyOnly: true }, opts).address, w.address);
  assert.equal(validateAgentChallenge({ ...base, keyOnly: false }, opts).address, w.address);
  assert.throws(() => validateAgentChallenge({ ...base, keyOnly: 'yes' }, opts), /invalid_challenge_status/);
  // сырой hex-ключ: привязка внутри браузерной схемы
  const raw = pubFromPriv('bcba52b43442c9edfb5b0e94146a38d10f03751cb0bce55ceef42aa9f94b97cb');
  const addrRaw = addressFromPubHex(raw);
  const rawBase = { ...base, address: addrRaw, pub: raw, keyOnly: true };
  rawBase.message = canonicalAgentChallenge(rawBase);
  assert.equal(validateAgentChallenge(rawBase, opts).address, addrRaw);
  // кросс-схема отвергается (message собираем вручную — канонизатор закрыт на mismatch)
  const bad = { ...rawBase, address: w.address };
  bad.message = 'AGT-IDENTITY-V1\n' + JSON.stringify([1, 'login', 'AGENTCOIN',
    base.issuerFingerprint, 'a', w.address, raw, '', base.challengeId, base.nonce, base.issuedAt, base.expiresAt]);
  assert.throws(() => validateAgentChallenge(bad, opts), /address_public_key_mismatch/);
});
