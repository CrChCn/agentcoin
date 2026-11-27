'use strict';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { signResponse, verifySignedResponse } from '../src/api.mjs';
import { ephemeralIdentity } from '../src/identity.mjs';
import { createPassport, verifyPassport, OperatorRegistry } from '../src/operator.mjs';
import { createRelease, verifyRelease } from '../src/updates.mjs';
import { cleanupAll, tempDir } from './helpers.mjs';

after(cleanupAll);

test('api: подпись ответа, подмена data/kind/срока отклоняется', () => {
  const id = ephemeralIdentity();
  const doc = signResponse(id, 'nodes', { nodes: [{ nodeId: 'agt1' + '0'.repeat(32) }] });
  assert.equal(verifySignedResponse(doc, { expectedKind: 'nodes' }).ok, true);

  const tampered = JSON.parse(JSON.stringify(doc));
  tampered.data.nodes[0].nodeId = 'agt1' + 'f'.repeat(32);
  const bad = verifySignedResponse(tampered, { expectedKind: 'nodes' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_signature');

  assert.equal(verifySignedResponse(doc, { expectedKind: 'summary' }).reason, 'kind_mismatch');
  assert.equal(verifySignedResponse({ ...doc, data: { stale: true } }, { now: Date.now() + 60000 }).reason, 'expired');
  const other = ephemeralIdentity();
  assert.equal(verifySignedResponse(doc, { pubkeyPem: other.publicKeyPem }).reason, 'unexpected_indexer_key');
});

test('operator: паспорт подписан, лимит регистраций и подмена отклоняются', () => {
  const op = ephemeralIdentity();
  const nodes = Array.from({ length: 6 }, (_, i) => 'agt1' + String(i).repeat(32).slice(0, 32));
  const tooMany = createPassport(op, { operatorId: 'op-big', nodeIds: nodes });
  const rej = verifyPassport(tooMany, { maxNodesPerOperator: 5 });
  assert.equal(rej.ok, false);
  assert.equal(rej.reason, 'registration_limit_exceeded');

  const passport = createPassport(op, { operatorId: 'op-1', name: 'Op One', nodeIds: nodes.slice(0, 2), region: 'EU' });
  assert.equal(verifyPassport(passport).ok, true);
  const tampered = JSON.parse(JSON.stringify(passport));
  tampered.nodeIds.push('agt1' + '9'.repeat(32));
  assert.equal(verifyPassport(tampered).reason, 'bad_signature');
  const forged = JSON.parse(JSON.stringify(passport));
  forged.operatorId = 'op-evil';
  assert.equal(verifyPassport(forged).reason, 'bad_signature');

  const reg = new OperatorRegistry({ file: path.join(tempDir('ops'), 'operators.json') });
  assert.equal(reg.add(passport).ok, true);
  assert.equal(reg.verifyNode(nodes[0]).operatorId, 'op-1');
  assert.equal(reg.verifyNode('agt1' + '7'.repeat(32)), null);
  assert.equal(reg.list().length, 1);
});

test('updates: чужой ключ и просроченный релиз не принимаются', () => {
  const key = ephemeralIdentity();
  const other = ephemeralIdentity();
  const rel = createRelease(key, { version: '1.0.1', protocol: { min: 1, max: 1 }, canaryPercent: 100 });
  assert.equal(verifyRelease(rel, { releaseKeys: [key.publicKeyPem] }).ok, true);
  assert.equal(verifyRelease(rel, { releaseKeys: [other.publicKeyPem] }).reason, 'untrusted_release_key');
  assert.equal(verifyRelease(rel, { releaseKeys: [] }).reason, 'no_trusted_release_keys');
  const expired = { ...rel, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(verifyRelease(expired, { releaseKeys: [key.publicKeyPem] }).reason, 'expired');
});
