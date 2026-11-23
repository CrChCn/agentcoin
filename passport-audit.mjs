// Public aggregate only. A passport records issuance; it is not proof that a
// distinct external AI agent exists. Never infer origin from a handle/address.
export function localPassportIssuanceMetadata() {
  return { version: 1, source: 'local_node', ownershipVerified: false };
}

export function mergePassportSources({ identity = [], cabinet = [] } = {}) {
  if (!Array.isArray(identity) || !Array.isArray(cabinet)) throw new TypeError('passport_sources_must_be_arrays');
  const addressOf = record => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const address = record.payload?.address ?? record.address;
    return typeof address === 'string' && address.length > 0 ? address : null;
  };
  const cabinetByAddress = new Map();
  for (const record of cabinet) {
    const address = addressOf(record);
    if (address && !cabinetByAddress.has(address)) cabinetByAddress.set(address, record);
  }
  const identityByAddress = new Map();
  for (const record of identity) {
    const address = addressOf(record);
    if (address && !identityByAddress.has(address)) identityByAddress.set(address, record);
  }
  const identityOnly = [...identityByAddress.keys()].filter(address => !cabinetByAddress.has(address));
  const cabinetOnly = [...cabinetByAddress.keys()].filter(address => !identityByAddress.has(address));
  const common = [...identityByAddress.keys()].filter(address => cabinetByAddress.has(address)).length;
  const auditRecords = [...cabinetByAddress.values()];
  for (const [address, record] of identityByAddress) {
    if (cabinetByAddress.has(address)) continue;
    auditRecords.push({ address, revoked: record?.payload?.revoked === true, issuance: record?.payload?.issuance ?? null });
  }
  return {
    count: identityByAddress.size + cabinetOnly.length,
    sources: { identity: identity.length, cabinet: cabinet.length },
    diff: { identityOnly: identityOnly.length, cabinetOnly: cabinetOnly.length, common },
    auditRecords,

  };
}

export function summarizePassports(input) {
  const records = Array.isArray(input) ? input : input?.passports;
  if (!Array.isArray(records)) throw new TypeError('passport_registry_must_be_array');
  const addresses = new Map();
  let revoked = 0, malformedRecords = 0, missingAddressRecords = 0;
  let localNodeDeclared = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      malformedRecords++;
      continue;
    }
    if (record.revoked === true) revoked++;
    // Addresses are exact identifiers: do not merge different key-derived IDs
    // through lowercasing or other speculative normalization.
    if (typeof record.address === 'string' && record.address.length > 0) {
      addresses.set(record.address, (addresses.get(record.address) || 0) + 1);
    } else missingAddressRecords++;
    const issuance = record.issuance;
    if (issuance?.version === 1 && issuance.source === 'local_node' &&
        issuance.ownershipVerified === false) localNodeDeclared++;
  }
  const repeated = [...addresses.values()].filter(n => n > 1);
  return {
    count: records.length,
    revoked,
    notRevokedRecords: records.length - revoked - malformedRecords,
    malformedRecords,
    missingAddressRecords,
    uniqueAddresses: addresses.size,
    duplicateAddresses: repeated.length,
    duplicateAddressRecords: repeated.reduce((sum, n) => sum + n - 1, 0),
    provenance: { local_service: 0, test: 0, external_verified: 0, unknown: records.length },
    issuance: { localNodeDeclared, unknown: records.length - localNodeDeclared },
    independentExternalAgents: null,
    semantics: {
      count: 'registry_records_not_verified_independent_agents',
      provenance: 'unverified_metadata_never_establishes_agent_origin',
      issuance: 'local_node_metadata_is_a_declaration_not_an_ownership_or_external_origin_proof',
      unknown: 'no_authenticated_provenance_evidence_available',
    },
  };
}
