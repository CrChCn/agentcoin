'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHeads, computeLevel, detectForks, evaluateReadiness, mergeObservations,
} from '../src/truth.mjs';
import { publicNode, publicEndpoint, findPrivateLeaks, assertNoPrivateLeaks } from '../src/privacy.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function observers(n = 2, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    indexerId: `agt1${String(i + 1).padStart(32, '0')}`,
    observedAt: iso(now),
    challenge: true,
    headers: true,
    dialBack: true,
    height: 100,
    tipHash: HASH_A,
    ...extra,
  }));
}

test('truth: разные высоты — не форк, разные hash на одной высоте — форк', () => {
  assert.equal(classifyHeads({ height: 10, tipHash: HASH_A }, { height: 11, tipHash: HASH_B }), 'LAGGING');
  assert.equal(classifyHeads({ height: 11, tipHash: HASH_A }, { height: 10, tipHash: HASH_B }), 'ADVANCED');
  assert.equal(classifyHeads({ height: 10, tipHash: HASH_A }, { height: 10, tipHash: HASH_A }), 'CONSISTENT');
  assert.equal(classifyHeads({ height: 10, tipHash: HASH_A }, { height: 10, tipHash: HASH_B }), 'DIVERGENT');
  assert.equal(classifyHeads({ height: 10 }, { height: 10 }), 'UNKNOWN');

  const forks = detectForks([
    { nodeId: 'n1', height: 10, tipHash: HASH_A },
    { nodeId: 'n2', height: 10, tipHash: HASH_B },
    { nodeId: 'n3', height: 9, tipHash: HASH_B },
  ]);
  assert.equal(forks.length, 1);
  assert.equal(forks[0].height, 10);
  assert.equal(forks[0].branches.length, 2);
});

test('truth: уровни растут только по независимым наблюдениям', () => {
  const base = { nodeId: 'agt1' + '0'.repeat(32), observers: [] };
  assert.equal(computeLevel(base), 'SELF_REPORTED');
  assert.equal(computeLevel({ ...base, observers: observers(1, { headers: false, dialBack: false }) }), 'CHALLENGE_VERIFIED');
  assert.equal(computeLevel({ ...base, observers: observers(1, { dialBack: false }) }), 'PEER_OBSERVED');
  assert.equal(computeLevel({ ...base, observers: observers(2, { dialBack: false }) }), 'MULTI_OBSERVED');
  assert.equal(computeLevel({ ...base, observers: observers(2), operator: { verified: true, operatorId: 'op' } }), 'INDEPENDENT_OPERATOR');
});

test('truth: готовность требует подписи, свежести, challenge, 2 наблюдателей и общего блока', () => {
  const rec = {
    nodeId: 'agt1' + '0'.repeat(32),
    genesisHash: 'g'.repeat(64),
    lastSeen: iso(now),
    signatureValid: true,
    height: 100,
    tipHash: HASH_A,
    observers: observers(2),
  };
  const ok = evaluateReadiness(rec, { now, genesisHash: 'g'.repeat(64) });
  assert.equal(ok.ready, true);
  assert.ok(['MULTI_OBSERVED', 'PUBLIC_REACHABLE', 'INDEPENDENT_OPERATOR'].includes(ok.level));

  const stale = evaluateReadiness({ ...rec, lastSeen: iso(now - 10 * 60000) }, { now, genesisHash: 'g'.repeat(64) });
  assert.equal(stale.ready, false);
  assert.ok(stale.reasons.includes('stale'));

  const one = evaluateReadiness({ ...rec, observers: observers(1) }, { now, genesisHash: 'g'.repeat(64) });
  assert.equal(one.ready, false);
  assert.ok(one.reasons.includes('observers_insufficient'));

  const noChallenge = evaluateReadiness({ ...rec, observers: observers(2, { challenge: false }) }, { now, genesisHash: 'g'.repeat(64) });
  assert.ok(noChallenge.reasons.includes('challenge_missing'));

  const wrongGenesis = evaluateReadiness(rec, { now, genesisHash: 'x'.repeat(64) });
  assert.ok(wrongGenesis.reasons.includes('genesis_mismatch'));

  const noCommon = evaluateReadiness({
    ...rec,
    observers: [observers(1)[0], { ...observers(1)[0], indexerId: 'other', tipHash: HASH_B }],
  }, { now, genesisHash: 'g'.repeat(64) });
  assert.ok(noCommon.reasons.includes('common_block_missing'));
  assert.equal(noCommon.ready, false);
});

test('truth: mergeObservations сохраняет всех наблюдателей', () => {
  const merged = mergeObservations([
    { nodeId: 'agt1' + '1'.repeat(32), indexerId: 'i1', height: 5, tipHash: HASH_A, observedAt: iso(now), challenge: true, headers: true },
    { nodeId: 'agt1' + '1'.repeat(32), indexerId: 'i2', height: 5, tipHash: HASH_A, observedAt: iso(now), challenge: true, headers: true },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].observers.length, 2);
  assert.equal(new Set(merged[0].observers.map((o) => o.indexerId)).size, 2);
});

test('privacy: приватные endpoint-ы и адреса не публикуются', () => {
  assert.equal(publicEndpoint({ host: '127.0.0.1', port: 9336 }), null);
  assert.equal(publicEndpoint({ host: '192.168.1.10', port: 9336 }), null);
  assert.equal(publicEndpoint({ host: '100.64.1.2', port: 9336 }), null);
  assert.deepEqual(publicEndpoint({ host: 'node1.agentcoin.work', port: 9336 }), { host: 'node1.agentcoin.work', port: 9336 });
  const node = publicNode({
    nodeId: 'agt1' + '0'.repeat(32),
    status: 'online',
    level: 'MULTI_OBSERVED',
    height: 1,
    tipHash: HASH_A,
    lastSeen: iso(now),
    endpoint: { host: '10.0.0.5', port: 9336 },
    privateKey: 'secret',
    hostname: 'mark-desktop',
    observers: observers(2),
  });
  assert.equal(node.endpoint, null);
  assert.equal(node.privateKey, undefined);
  assert.equal(node.hostname, undefined);
  assert.deepEqual(assertNoPrivateLeaks(node), true);
  assert.equal(findPrivateLeaks({ note: 'http://127.0.0.1:9336' }).length, 1);
});
