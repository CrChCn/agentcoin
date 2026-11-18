#!/usr/bin/env node
// Адреса страниц: AGT + 40 hex (канон core.mjs ADDRESS_RE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normAddr, isAddr } from '../web/lib/addr.js';

const A = 'AGTc0eba9749aa3200cd314e8f4afd8eb8e8a240a65';
const H = 'c0eba9749aa3200cd314e8f4afd8eb8e8a240a65';

test('канон AGT+40hex принимается как есть', () => {
  assert.deepEqual(normAddr(A), { ok: true, address: A });
  assert.equal(isAddr(A), true);
});

test('голые 40 hex канонизируются (регистр — к нижнему)', () => {
  assert.deepEqual(normAddr(H), { ok: true, address: A });
  assert.deepEqual(normAddr(H.toUpperCase()), { ok: true, address: A });
  assert.deepEqual(normAddr('  ' + A + '  '), { ok: true, address: A });
});

test('мусор отклоняется (адрес из жалобы тоже чинился здесь)', () => {
  for (const bad of ['', 'ABC', 'AGT', 'AGTxyz', H.slice(0, 39), H + '00', '0x' + H]) {
    assert.equal(normAddr(bad).ok, false, JSON.stringify(bad));
    assert.equal(isAddr(bad), false);
  }
});
