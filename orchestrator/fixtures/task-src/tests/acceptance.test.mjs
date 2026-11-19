import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDiscount,
  qualifiesForFreeShipping,
  FREE_SHIPPING_THRESHOLD_CENTS,
} from '../src/pricing.mjs';

test('AC-1: 10% discount on 10000 cents is 9000', () => {
  assert.equal(applyDiscount(10000, 10), 9000);
});

test('AC-2: 33% discount on 999 cents rounds to 669', () => {
  assert.equal(applyDiscount(999, 33), 669);
});

test('AC-3: 0% and 100% boundaries', () => {
  assert.equal(applyDiscount(1234, 0), 1234);
  assert.equal(applyDiscount(1234, 100), 0);
});

test('AC-4: invalid inputs throw RangeError', () => {
  assert.throws(() => applyDiscount(-1, 10), RangeError);
  assert.throws(() => applyDiscount(1.5, 10), RangeError);
  assert.throws(() => applyDiscount(100, 101), RangeError);
  assert.throws(() => applyDiscount(100, 10.5), RangeError);
});

test('AC-5: free shipping starts exactly at the threshold (inclusive)', () => {
  assert.equal(qualifiesForFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS - 1), false);
  assert.equal(qualifiesForFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS), true);
  assert.equal(qualifiesForFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS + 1), true);
});
