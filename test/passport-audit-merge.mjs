// mergePassportSources: read-only слияние identity-реестра и файла кабинета.
// Контракт redesign-ac (payload-aware, строгий): не-массивы бросают TypeError,
// дубли адресов схлопываются, diff — счётчики { identityOnly, cabinetOnly, common }.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePassportSources, summarizePassports } from '../passport-audit.mjs';

test('merge: counts, sources and diff by exact address', () => {
  const a = { address: 'AGTa', handle: 'one' };
  const b = { address: 'AGTb', handle: 'two' };
  const m = mergePassportSources({ identity: [a, b], cabinet: [b, { address: 'AGTc' }] });
  assert.equal(m.count, 3);
  assert.deepEqual(m.sources, { identity: 2, cabinet: 2 });
  assert.deepEqual(m.diff, { identityOnly: 1, cabinetOnly: 1, common: 1 });
  assert.equal(m.auditRecords.length, 3);
  const audit = summarizePassports(m.auditRecords);
  assert.equal(audit.uniqueAddresses, 3);
});

test('merge: tolerates malformed records, no case folding', () => {
  const m = mergePassportSources({ identity: [], cabinet: [{ address: 'AGTx' }, null, 42, {}] });
  assert.equal(m.count, 1);
  assert.deepEqual(m.diff, { identityOnly: 0, cabinetOnly: 1, common: 0 });
  const cased = mergePassportSources({ identity: [{ address: 'AGTAb' }], cabinet: [{ address: 'AGTab' }] });
  assert.equal(cased.count, 2, 'адреса не нормализуются регистром');
  assert.deepEqual(cased.diff, { identityOnly: 1, cabinetOnly: 1, common: 0 });
  assert.throws(() => mergePassportSources({ identity: null, cabinet: [] }), /passport_sources_must_be_arrays/);
});

test('merge: defaults to empty', () => {
  const m = mergePassportSources();
  assert.deepEqual([m.count, m.diff.common, m.auditRecords.length], [0, 0, 0]);
});
