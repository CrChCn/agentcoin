import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { addressFromPub } from '../core.mjs';
import { resolveOperationPublicKey } from '../cabinet-public-key.mjs';
function identity() {
  const key = crypto.generateKeyPairSync('ed25519');
  const pub = key.publicKey.export({ type: 'spki', format: 'pem' });
  return { pub, address: addressFromPub(pub) };
}
const a = identity(), b = identity();
const fixture = (record, wallet = { pub: a.pub }) => ({
  findPassportByAddress: address => address === a.address ? record : null,
  wallets: () => ({ [a.address]: wallet }),
});
test('passport public key resolves without consulting local wallets', () => {
  const cabinet = fixture({ pub: a.pub });
  cabinet.wallets = () => { throw Error('must_not_load_keys'); };
  assert.equal(resolveOperationPublicKey(cabinet, a.address), a.pub);
});
test('legacy passport resolves matching local public key only', () => {
  const wallet = { pub: a.pub };
  Object.defineProperty(wallet, 'privKey', { get() { throw Error('secret_access'); } });
  assert.equal(resolveOperationPublicKey(fixture({ handle: 'legacy' }, wallet), a.address), a.pub);
});
test('absent or revoked passport cannot be bypassed by local wallet', () => {
  assert.equal(resolveOperationPublicKey(fixture(null), a.address), null);
  assert.equal(resolveOperationPublicKey(fixture({ revoked: true }), a.address), null);
});
test('legacy without local public key returns missing without creating a key', () => {
  assert.equal(resolveOperationPublicKey(fixture({}, {}), a.address), null);
});
test('mismatching passport key is rejected despite matching local wallet', () => {
  assert.throws(() => resolveOperationPublicKey(fixture({ pub: b.pub }), a.address), /address_mismatch/);
});
test('mismatching legacy local key is rejected', () => {
  assert.throws(() => resolveOperationPublicKey(fixture({}, { pub: b.pub }), a.address), /address_mismatch/);
});
test('malformed explicit passport key does not fall back to local wallet', () => {
  assert.throws(() => resolveOperationPublicKey(fixture({ pub: 'invalid' }), a.address), /pub_invalid/);
});
