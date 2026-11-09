// mergePassportSources: read-only слияние identity-реестра и файла кабинета.
// Чистые unit-проверки без ноды (починяет c5f519c: /passport/count ссылался на
// несуществующий экспорт и метод list).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePassportSources, summarizePassports } from '../passport-audit.mjs';

test('merge: counts, sources and diff by exact address', () => {
  const a = { address: 'AGTa', handle: 'one' };
  const b = { address: 'AGTb', handle: 'two' };
  const m = mergePassportSources({ identity: [a, b], cabinet: [b, { address: 'AGTc' }] });
  assert.equal(m.count, 3);
  assert.deepEqual(m.sources, { identity: 2, cabinet: 2 });
  assert.deepEqual(m.diff.onlyIdentity, ['AGTa']);
  assert.deepEqual(m.diff.onlyCabinet, ['AGTc']);
  assert.equal(m.diff.inBoth, 1);
  assert.equal(m.auditRecords.length, 4);
  const audit = summarizePassports(m.auditRecords);
  assert.equal(audit.uniqueAddresses, 3);
  assert.equal(audit.duplicateAddresses, 1, 'AGTb в обоих источниках — дубль виден в аудите');
});

test('merge: tolerates missing/foreign shapes, no case folding', () => {
  const m = mergePassportSources({ identity: null, cabinet: [{ address: 'AGTx' }, null, 42, {}] });
  assert.equal(m.count, 1);
  assert.deepEqual(m.diff.onlyCabinet, ['AGTx']);
  const cased = mergePassportSources({ identity: [{ address: 'AGTAb' }], cabinet: [{ address: 'AGTab' }] });
  assert.equal(cased.count, 2, 'адреса не нормализуются регистром');
  assert.equal(cased.diff.inBoth, 0);
});

test('merge: defaults to empty', () => {
  const m = mergePassportSources();
  assert.deepEqual([m.count, m.diff.inBoth, m.auditRecords.length], [0, 0, 0]);
});
