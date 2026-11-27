/* agentnet/truth.mjs — уровни доверия, готовность ноды и классификация форков.
   Подпись доказывает ключ, но не независимость сервера: уровень поднимается
   только по независимым наблюдениям. */
'use strict';

export const LEVELS = Object.freeze([
  'SELF_REPORTED',
  'CHALLENGE_VERIFIED',
  'PEER_OBSERVED',
  'MULTI_OBSERVED',
  'PUBLIC_REACHABLE',
  'INDEPENDENT_OPERATOR',
]);

export const LEVEL_RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));

export function levelAtLeast(level, required) {
  return (LEVEL_RANK[level] ?? -1) >= (LEVEL_RANK[required] ?? 99);
}

/**
 * Сравнение двух голов. Разная высота — НЕ форк: LAGGING/ADVANCED.
 * Форк — только разные hash на одной высоте.
 */
export function classifyHeads(a, b) {
  const ha = a && a.height;
  const hb = b && b.height;
  if (!Number.isFinite(ha) || !Number.isFinite(hb)) return 'UNKNOWN';
  if (ha !== hb) return ha < hb ? 'LAGGING' : 'ADVANCED';
  if (!a.tipHash || !b.tipHash) return 'UNKNOWN';
  return a.tipHash === b.tipHash ? 'CONSISTENT' : 'DIVERGENT';
}

export function detectForks(nodes) {
  const byHeight = new Map();
  for (const n of nodes || []) {
    if (!Number.isFinite(n.height) || !n.tipHash) continue;
    if (!byHeight.has(n.height)) byHeight.set(n.height, new Map());
    const hashes = byHeight.get(n.height);
    if (!hashes.has(n.tipHash)) hashes.set(n.tipHash, []);
    hashes.get(n.tipHash).push(n.nodeId);
  }
  const forks = [];
  for (const [height, hashes] of byHeight) {
    if (hashes.size < 2) continue;
    forks.push({
      height,
      status: 'DIVERGENT',
      branches: [...hashes.entries()].map(([hash, nodeIds]) => ({ hash, nodeIds })),
    });
  }
  return forks.sort((a, b) => b.height - a.height);
}

export function distinctObservers(observers) {
  return new Set((observers || []).map((o) => o.indexerId).filter(Boolean)).size;
}

/**
 * Уровень записи. observers: [{indexerId, challenge, headers, dialBack, observedAt}]
 * operator: {verified, operatorId, name}
 */
export function computeLevel(record) {
  const observers = record.observers || [];
  const distinct = distinctObservers(observers);
  const challenged = observers.some((o) => o.challenge === true);
  const headers = observers.some((o) => o.headers === true);
  const dialBack = observers.some((o) => o.dialBack === true);
  let level = 'SELF_REPORTED';
  if (challenged) level = 'CHALLENGE_VERIFIED';
  if (challenged && headers && observers.length >= 1) level = 'PEER_OBSERVED';
  if (levelAtLeast(level, 'PEER_OBSERVED') && distinct >= 2) level = 'MULTI_OBSERVED';
  if (levelAtLeast(level, 'MULTI_OBSERVED') && dialBack) level = 'PUBLIC_REACHABLE';
  if (levelAtLeast(level, 'PUBLIC_REACHABLE') && record.operator && record.operator.verified) {
    level = 'INDEPENDENT_OPERATOR';
  }
  return level;
}

/**
 * Готовность по правилам: подпись + genesis + свежесть + challenge +
 * минимум 2 независимых наблюдателя + совпавший общий блок.
 */
export function evaluateReadiness(record, {
  now = Date.now(),
  genesisHash = null,
  minObservers = 2,
  maxAgeMs = 180000,
  expectedHeight = null,
} = {}) {
  const reasons = [];
  const observers = record.observers || [];
  const distinct = distinctObservers(observers);

  if (record.signatureValid === false) reasons.push('signature_invalid');
  if (!record.nodeId) reasons.push('no_node_id');
  if (genesisHash && record.genesisHash && record.genesisHash !== genesisHash) reasons.push('genesis_mismatch');
  if (!record.genesisHash) reasons.push('genesis_unknown');
  const lastSeen = record.lastSeen ? Date.parse(record.lastSeen) : 0;
  if (!lastSeen || now - lastSeen > maxAgeMs) reasons.push('stale');
  if (!observers.some((o) => o.challenge === true)) reasons.push('challenge_missing');
  if (distinct < minObservers) reasons.push('observers_insufficient');
  if (!observers.some((o) => o.headers === true)) reasons.push('head_not_verified');

  // Общий блок: наблюдатели видят одинаковую голову на одной высоте.
  const heads = new Map();
  for (const o of observers) {
    if (!Number.isFinite(o.height) || !o.tipHash) continue;
    const key = `${o.height}:${o.tipHash}`;
    heads.set(key, (heads.get(key) || 0) + 1);
  }
  const agreed = [...heads.values()].some((n) => n >= minObservers);
  if (!agreed) reasons.push('common_block_missing');
  if (expectedHeight !== null && record.height !== expectedHeight) reasons.push('height_mismatch');

  return {
    ready: reasons.length === 0,
    level: computeLevel(record),
    reasons,
  };
}

/** Сводка по нескольким indexer-наблюдениям в один узел. */
export function mergeObservations(observations) {
  const byNode = new Map();
  for (const obs of observations || []) {
    if (!obs || !obs.nodeId) continue;
    if (!byNode.has(obs.nodeId)) {
      byNode.set(obs.nodeId, {
        nodeId: obs.nodeId,
        version: obs.version,
        protocol: obs.protocol,
        height: obs.height,
        tipHash: obs.tipHash,
        chainwork: obs.chainwork,
        genesisHash: obs.genesisHash,
        peers: obs.peers,
        uptimeSec: obs.uptimeSec,
        natStatus: obs.natStatus,
        endpoint: obs.endpoint || null,
        region: obs.region || null,
        operatorId: obs.operatorId || null,
        firstSeen: obs.firstSeen || obs.observedAt,
        lastSeen: obs.observedAt,
        signatureValid: obs.signatureValid !== false,
        observers: [],
      });
    }
    const rec = byNode.get(obs.nodeId);
    for (const key of ['version', 'protocol', 'height', 'tipHash', 'chainwork', 'genesisHash', 'peers', 'uptimeSec', 'natStatus', 'region', 'operatorId']) {
      if (obs[key] !== undefined && obs[key] !== null) rec[key] = obs[key];
    }
    if (obs.observedAt && (!rec.lastSeen || Date.parse(obs.observedAt) > Date.parse(rec.lastSeen))) rec.lastSeen = obs.observedAt;
    if (obs.firstSeen && (!rec.firstSeen || Date.parse(obs.firstSeen) < Date.parse(rec.firstSeen))) rec.firstSeen = obs.firstSeen;
    if (obs.endpoint) rec.endpoint = obs.endpoint;
    rec.observers.push({
      indexerId: obs.indexerId,
      observedAt: obs.observedAt,
      challenge: obs.challenge !== false,
      headers: Boolean(obs.headers),
      dialBack: Boolean(obs.dialBack),
      height: obs.height,
      tipHash: obs.tipHash,
      latencyMs: obs.latencyMs ?? null,
    });
  }
  return [...byNode.values()];
}

/** Итоговый статус: online / stale / offline по свежести и наблюдателям. */
export function classifyStatus(record, { now = Date.now(), staleAfterMs = 60000, offlineAfterMs = 180000 } = {}) {
  const last = record.lastSeen ? Date.parse(record.lastSeen) : 0;
  if (!last) return 'offline';
  const age = now - last;
  if (age > offlineAfterMs) return 'offline';
  if (age > staleAfterMs) return 'stale';
  return 'online';
}
