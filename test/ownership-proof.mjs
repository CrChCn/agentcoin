import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addressFromPub, addressFromRawPub } from '../core.mjs';
import {
  createOwnershipChallenge, canonicalOwnershipMessage, verifyOwnershipSignature,
  OwnershipProofStore, MAX_OWNERSHIP_TTL_MS,
} from '../ownership-proof.mjs';

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  return { pub, rawPub, address: addressFromPub(pub), rawAddress: addressFromRawPub(rawPub), privateKey };
}

const sign = (message, privateKey) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');

test('PEM-схема: вызов ноды + подпись агента проходят проверку', () => {
  const k = keypair();
  const c = createOwnershipChallenge({ address: k.address, pub: k.pub, node: 'sha256:' + 'a'.repeat(64) });
  assert.equal(c.message, canonicalOwnershipMessage(c));
  const r = verifyOwnershipSignature(c, sign(c.message, k.privateKey));
  assert.equal(r.address, k.address);
  assert.equal(r.scheme, 'spki-ed25519');
});

test('raw-схема create-wallet: отдельный адрес, та же проверка', () => {
  const k = keypair();
  const c = createOwnershipChallenge({ address: k.rawAddress, pub: k.rawPub, node: 'node-1' });
  const r = verifyOwnershipSignature(c, sign(c.message, k.privateKey));
  assert.equal(r.scheme, 'raw-ed25519');
  assert.equal(r.address, k.rawAddress);
  assert.notEqual(k.address, k.rawAddress);
});

test('чужой ключ, чужая подпись и просрочка отклоняются', () => {
  const k = keypair(), other = keypair();
  assert.throws(() => createOwnershipChallenge({ address: k.address, pub: other.pub, node: 'n' }), /address_public_key_mismatch/);
  const c = createOwnershipChallenge({ address: k.address, pub: k.pub, node: 'n' });
  assert.throws(() => verifyOwnershipSignature(c, sign(c.message, other.privateKey)), /invalid_signature/);
  assert.throws(() => verifyOwnershipSignature(c, sign('другое сообщение', k.privateKey)), /invalid_signature/);
  assert.throws(() => verifyOwnershipSignature(c, 'zz'), /invalid_signature/);
  assert.throws(() => verifyOwnershipSignature(c, sign(c.message, k.privateKey), { now: c.expiresAt }), /challenge_expired/);
  assert.throws(() => createOwnershipChallenge({ address: k.address, pub: k.pub, node: 'n' }, { ttlMs: MAX_OWNERSHIP_TTL_MS + 1 }), /invalid_challenge_ttl/);
});

test('store: подпись сохраняется, вызов одноразовый, запись перечитывается после рестарта', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-ownership-'));
  const file = path.join(dir, 'ownership.json');
  try {
    const k = keypair();
    const store = new OwnershipProofStore({ file });
    const c = store.issue({ address: k.address, pub: k.pub, node: 'sha256:' + 'b'.repeat(64) });
    const proof = store.prove({ challengeId: c.challengeId, signature: sign(c.message, k.privateKey) });
    assert.equal(proof.ok, true);
    assert.equal(store.verified(k.address), true);
    assert.equal(store.verifiedCount([k.address, 'AGT' + '0'.repeat(40)]), 1);
    assert.throws(() => store.prove({ challengeId: c.challengeId, signature: sign(c.message, k.privateKey) }), /challenge_not_issued/);

    const reloaded = new OwnershipProofStore({ file });
    assert.equal(reloaded.verified(k.address), true);
    assert.equal(reloaded.proofOf(k.address).pub, k.pub);
    assert.equal(reloaded.verified('AGT' + '0'.repeat(40)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store: битый файл и подмена ключа не принимаются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-ownership-'));
  try {
    const file = path.join(dir, 'ownership.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, proofs: [{ address: 'AGT' + '1'.repeat(40), pub: '-----BEGIN PUBLIC KEY-----\nnope\n', verifiedAt: 1 }] }));
    assert.throws(() => new OwnershipProofStore({ file }), /invalid_ownership_store/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
