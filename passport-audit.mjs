// Public aggregate only. A passport records issuance; it is not proof that a
// distinct external AI agent exists. Never infer origin from a handle/address.
export function localPassportIssuanceMetadata() {
  return { version: 1, source: 'local_node', ownershipVerified: false };
}

// Слияние двух источников паспортов для /passport/count: реестр identity-ноды и
// файл кабинета. Адреса — точные идентификаторы (без нормализации регистра).
// Read-only агрегат: count — уникальные адреса обоих источников; diff — кто где
// есть; auditRecords — конкатенация для summarizePassports.
export function mergePassportSources({ identity, cabinet } = {}) {
  const idRecs = Array.isArray(identity) ? identity : [];
  const cabRecs = Array.isArray(cabinet) ? cabinet : [];
  const addrOf = r => (r && typeof r === 'object' && typeof r.address === 'string' && r.address.length > 0 ? r.address : null);
  const idAddrs = new Set(idRecs.map(addrOf).filter(Boolean));
  const cabAddrs = new Set(cabRecs.map(addrOf).filter(Boolean));
  return {
    count: new Set([...idAddrs, ...cabAddrs]).size,
    sources: { identity: idRecs.length, cabinet: cabRecs.length },
    diff: {
      onlyIdentity: [...idAddrs].filter(a => !cabAddrs.has(a)),
      onlyCabinet: [...cabAddrs].filter(a => !idAddrs.has(a)),
      inBoth: [...idAddrs].filter(a => cabAddrs.has(a)).length,
    },
    auditRecords: [...idRecs, ...cabRecs],
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
