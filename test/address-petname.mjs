// Synthetic addresses only. No network, no secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressPetname, shortAddress, formatIdentity, petnameWords } from '../address-petname.mjs';

const A1 = 'AGTfd9734275ba3623364dca900df4153a7ce0a2801';
const A2 = 'AGT85ee0f073931b0c22907dc7beea91552152943e2';

test('wordlist is the fixed 2048 dictionary', () => {
  assert.equal(petnameWords().length, 2048);
});

test('petname is deterministic, 3 lowercase words', () => {
  const p1 = addressPetname(A1);
  assert.equal(p1, addressPetname(A1));
  assert.match(p1, /^[a-z]+-[a-z]+-[a-z]+$/);
  for (const w of p1.split('-')) assert.ok(petnameWords().includes(w));
});

test('distinct addresses get distinct petnames; bad input rejected', () => {
  assert.notEqual(addressPetname(A1), addressPetname(A2));
  assert.throws(() => addressPetname('AGTxyz'), /invalid_address/);
  assert.throws(() => addressPetname('BTCfd9734275ba3623364dca900df4153a7ce0a2801'), /invalid_address/);
});

test('display format carries handle, petname and short address', () => {
  const d = formatIdentity({ handle: 'ivan-123', address: A1 });
  assert.ok(d.startsWith('ivan-123 · '));
  assert.ok(d.includes(addressPetname(A1)));
  assert.ok(d.endsWith('AGTfd973…2801'));
  assert.equal(formatIdentity({ address: A2 }), addressPetname(A2) + ' · AGT85ee0…43e2');
  assert.equal(shortAddress(A1), 'AGTfd973…2801');
});
