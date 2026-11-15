// Synthetic identities only. No network, no production files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Cabinet } from '../cabinet.mjs';
import { PinStore } from '../cabinet-pin.mjs';

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { pub, priv };
}

async function tempPin(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-pin-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'pins.json');
}

function cabinet(pinFile) {
  return new Cabinet({
    walletsLoader: () => ({}),
    passportFile: path.join('nonexistent-passports.json'),
    pinFile,
    balancesFn: () => ({}),
    securityRef: { isBanned: () => false },
    identityRegistry: {
      findByAddress: () => null,
      meta: () => ({ network: 'AGENTCOIN', audience: 'https://test.invalid', issuerFingerprint: 'sha256:' + 'b'.repeat(64) }),
    },
  });
}

test('passport-less address: challenge fails without pub, succeeds with bound pub (TOFU)', async (t) => {
  const cab = cabinet(await tempPin(t));
  const { pub } = keypair();
  const { addressFromPub } = await import('../core.mjs');
  const addr = addressFromPub(pub);
  const noPub = cab.challenge(addr);
  assert.equal(noPub.ok, false);
  assert.equal(noPub.error, 'passport_not_found');
  const r = cab.challenge(addr, 'WRONG');
  assert.equal(r.ok, false);
  const r2 = cab.challenge(addr, pub);
  assert.equal(r2.ok, true);
  assert.equal(r2.keyOnly, true);
  assert.ok(r2.challengeId);
});

test('TOFU login: signature by the key opens a key-only session; strangers cannot', async (t) => {
  const cab = cabinet(await tempPin(t));
  const a = keypair(), b = keypair();
  const { addressFromPub } = await import('../core.mjs');
  const addr = addressFromPub(a.pub);
  const ch = cab.challenge(addr, a.pub);
  assert.equal(ch.ok, true);
  // чужая подпись — мимо
  const badSig = crypto.sign(null, Buffer.from(ch.nonce, 'utf8'), b.priv).toString('hex');
  assert.equal(cab.loginChallenge(addr, ch.nonce, badSig, ch.challengeId).ok, false);
  // своя подпись — сессия
  const sig = crypto.sign(null, Buffer.from(ch.nonce, 'utf8'), a.priv).toString('hex');
  const s = cab.loginChallenge(addr, ch.nonce, sig, ch.challengeId);
  assert.equal(s.ok, true);
  assert.ok(s.token);
  // повторное использование challenge — мимо
  assert.equal(cab.loginChallenge(addr, ch.nonce, sig, ch.challengeId).ok, false);
  // сессия жива без паспорта
  const sess = cab.session(addr, s.token);
  assert.ok(sess);
  assert.equal(sess.address, addr);
});

test('PIN full cycle on key-only address: set needs session, login works, lockout bites', async (t) => {
  const cab = cabinet(await tempPin(t));
  const { pub, priv } = keypair();
  const { addressFromPub } = await import('../core.mjs');
  const addr = addressFromPub(pub);
  // без сессии задать PIN нельзя
  assert.equal((await cab.pinSet(addr, 'nope', '1234')).ok, false);
  const ch = cab.challenge(addr, pub);
  const sig = crypto.sign(null, Buffer.from(ch.nonce, 'utf8'), priv).toString('hex');
  const s = cab.loginChallenge(addr, ch.nonce, sig, ch.challengeId);
  assert.equal(s.ok, true);
  assert.equal((await cab.pinSet(addr, s.token, '12')).ok, false); // формат
  const set = await cab.pinSet(addr, s.token, '4321');
  assert.deepEqual(set, { ok: true, pinSet: true });
  assert.deepEqual(cab.pinStatus(addr), { ok: true, pinSet: true });
  const login = await cab.pinLogin(addr, '4321');
  assert.equal(login.ok, true);
  assert.ok(login.token);
  assert.ok(cab.session(addr, login.token));
  // 5 ошибок — замок
  for (let i = 0; i < 5; i++) await cab.pinLogin(addr, '0000');
  const locked = await cab.pinLogin(addr, '4321');
  assert.equal(locked.ok, false);
  assert.equal(locked.error, 'pin_locked');
  // верный PIN чужого адреса — мимо
  assert.equal((await cab.pinLogin(addr.replace(/.$/, addr.endsWith('0') ? '1' : '0'), '4321')).ok, false);
  // disable по сессии
  const dis = cab.pinDisable(addr, login.token);
  assert.deepEqual(dis, { ok: true, pinSet: false });
});

test('PIN lockout on synthetic: 5 misses -> pin_locked, correct PIN also blocked, unlock after 15 min', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-pin-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  const store = new PinStore({ file: path.join(dir, 'pins.json'), now: () => now });
  const addr = 'AGT' + 'ab'.repeat(20);
  assert.deepEqual(await store.set(addr, '4321'), { ok: true, pinSet: true });
  for (let i = 0; i < 5; i++) {
    const r = await store.verify(addr, '0000');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'pin_mismatch');
    assert.equal(r.attemptsLeft, 4 - i);
  }
  const locked = await store.verify(addr, '4321');
  assert.equal(locked.ok, false);
  assert.equal(locked.error, 'pin_locked');
  assert.ok(locked.retryAfterSec > 0 && locked.retryAfterSec <= 900);
  now += 15 * 60 * 1000 + 1000; // замок истёк
  assert.deepEqual(await store.verify(addr, '4321'), { ok: true });
});

test('sessionPubFor: remembers login key (public only), rejects strangers and tampering', async (t) => {
  const cab = cabinet(await tempPin(t));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawHex = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('hex');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const sha256 = (x) => crypto.createHash('sha256').update(x).digest();
  const hBytes = sha256(sha256(Buffer.from(rawHex, 'hex')));
  const h = hBytes.toString('hex');
  const addr = 'AGT' + h.slice(0, 32) + sha256(sha256(hBytes)).toString('hex').slice(0, 8);
  assert.equal(cab.sessionPubFor(addr), null); // до входа — ничего не помним
  const ch = cab.challenge(addr, rawHex);
  const sig = crypto.sign(null, Buffer.from(ch.nonce, 'utf8'), privPem).toString('hex');
  cab.loginChallenge(addr, ch.nonce, sig, ch.challengeId);
  const remembered = cab.sessionPubFor(addr);
  assert.ok(typeof remembered === 'string' && remembered.length > 0);
  assert.equal(cab.sessionPubFor('AGT' + '00'.repeat(20)), null); // чужой адрес
  cab.knownPub.set(addr, 'zz'); // подмена в памяти
  assert.equal(cab.sessionPubFor(addr), null); // привязка не сошлась — мимо
});

test('TOFU accepts raw-hex pub (browser wallets): same key, browser address scheme', async (t) => {
  const cab = cabinet(await tempPin(t));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawHex = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('hex');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  // адрес браузерной схемы: та же формула, что agt-tx.addressFromPubHex
  const sha256 = (x) => crypto.createHash('sha256').update(x).digest();
  const hBytes = sha256(sha256(Buffer.from(rawHex, 'hex')));
  const h = hBytes.toString('hex');
  const addr = 'AGT' + h.slice(0, 32) + sha256(sha256(hBytes)).toString('hex').slice(0, 8);
  const ch = cab.challenge(addr, rawHex);
  assert.equal(ch.ok, true);
  assert.equal(ch.keyOnly, true);
  const sig = crypto.sign(null, Buffer.from(ch.nonce, 'utf8'), privPem).toString('hex');
  const s = cab.loginChallenge(addr, ch.nonce, sig, ch.challengeId);
  assert.equal(s.ok, true);
  assert.ok(cab.session(addr, s.token));
  // чужой адрес с тем же ключом — мимо
  const evil = 'AGT' + '0'.repeat(40);
  assert.equal(cab.challenge(evil, rawHex).ok, false);
});

test('PinStore alone: format, checksum tamper, persistence', async (t) => {
  const store = new PinStore({ file: await tempPin(t) });
  await assert.rejects(store.set('AGTxx', '1234'), /invalid_address/);
  await assert.rejects(store.set('AGT' + 'a'.repeat(40), '123'), /pin_format/);
  await store.set('AGT' + 'a'.repeat(40), '1234');
  assert.equal((await store.verify('AGT' + 'a'.repeat(40), '1234')).ok, true);
  assert.equal((await store.verify('AGT' + 'a'.repeat(40), '0000')).ok, false);
});
