import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePassports, localPassportIssuanceMetadata } from '../passport-audit.mjs';

test('legacy records stay unknown; aggregate exposes neither credentials nor identifiers', () => {
  const records = [
    { address: 'AGT_PRIVATE_ADDRESS', seqStr: 'SECRET_SEQ', privKey: 'SECRET_KEY', handle: 'SECRET_HANDLE' },
    { address: 'AGT_PRIVATE_ADDRESS', revoked: true },
    { address: 'agt_private_address', revoked: 'true' },
  ];
  const before = JSON.stringify(records);
  const result = summarizePassports(records);
  assert.equal(result.count, 3);
  assert.equal(result.revoked, 1);
  assert.equal(result.notRevokedRecords, 2);
  assert.equal(result.uniqueAddresses, 2);
  assert.equal(result.duplicateAddresses, 1);
  assert.equal(result.duplicateAddressRecords, 1);
  assert.equal(result.provenance.unknown, 3);
  assert.equal(result.independentExternalAgents, null);
  assert.equal(JSON.stringify(records), before);
  for (const secret of ['AGT_PRIVATE_ADDRESS', 'SECRET_SEQ', 'SECRET_KEY', 'SECRET_HANDLE']) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('self-declared provenance and proof-looking fields do not establish external identity', () => {
  const records = ['external_verified', 'test', 'local_service', 'anything'].map(provenance => ({
    address: provenance, provenance, ownershipVerified: true,
    proof: { verified: true }, issuance: { version: 1, source: 'external_verified', ownershipVerified: true },
  }));
  assert.deepEqual(summarizePassports(records).provenance,
    { local_service: 0, test: 0, external_verified: 0, unknown: 4 });
});

test('future local issuance metadata is separately counted without inventing origin', () => {
  const first = localPassportIssuanceMetadata();
  first.source = 'tampered';
  const result = summarizePassports({ passports: [
    { address: 'a', issuance: localPassportIssuanceMetadata() },
    { address: 'b', issuance: { version: 1, source: 'local_node', ownershipVerified: true } },
    { address: 'c', issuance: { version: 2, source: 'local_node', ownershipVerified: false } },
    { address: 'd' },
  ] });
  assert.deepEqual(result.issuance, { localNodeDeclared: 1, unknown: 3 });
  assert.equal(result.provenance.unknown, 4);
  assert.equal(result.independentExternalAgents, null);
});

test('malformed records are visible and registry corruption is never silently zero', () => {
  const result = summarizePassports([null, 'secret', [], {}, { revoked: true }]);
  assert.equal(result.count, 5);
  assert.equal(result.malformedRecords, 3);
  assert.equal(result.missingAddressRecords, 2);
  assert.equal(result.revoked, 1);
  assert.equal(result.notRevokedRecords, 1);
  assert.throws(() => summarizePassports({}), /passport_registry_must_be_array/);
  assert.throws(() => summarizePassports(null), /passport_registry_must_be_array/);
  assert.equal(summarizePassports([]).count, 0);
});
