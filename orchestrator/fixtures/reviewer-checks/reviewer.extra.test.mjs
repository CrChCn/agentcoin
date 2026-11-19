import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDiscount,
  qualifiesForFreeShipping,
  FREE_SHIPPING_THRESHOLD_CENTS,
} from '../src/pricing.mjs';

test('reviewer: shipping boundary is inclusive around the constant', () => {
  assert.equal(qualifiesForFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS), true);
  assert.equal(qualifiesForFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS - 1), false);
  assert.equal(qualifiesForFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS + 1), true);
});

test('reviewer: discount is integer, bounded and monotone', () => {
  for (const total of [0, 1, 99, 100, 999, 10000]) {
    for (const pct of [0, 1, 33, 50, 99, 100]) {
      const discounted = applyDiscount(total, pct);
      assert.ok(Number.isInteger(discounted), `integer for ${total}/${pct}`);
      assert.ok(discounted >= 0 && discounted <= total, `bounded for ${total}/${pct}`);
      if (pct === 0) assert.equal(discounted, total);
      if (pct === 100) assert.equal(discounted, 0);
    }
  }
  for (const total of [100, 999, 10000]) {
    assert.ok(applyDiscount(total, 50) >= applyDiscount(total, 60));
  }
});

test('reviewer: invalid inputs are rejected with RangeError', () => {
  for (const args of [[-1, 10], [10.5, 10], ['100', 10], [100, -1], [100, 101], [100, 10.5]]) {
    assert.throws(() => applyDiscount(...args), RangeError, `applyDiscount(${args.join(',')})`);
  }
  for (const value of [-1, 1.5, '5000']) {
    assert.throws(() => qualifiesForFreeShipping(value), RangeError, `qualifiesForFreeShipping(${value})`);
  }
});
