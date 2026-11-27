'use strict';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createIdentity, loadIdentity, nodeIdFromPublicKeyPem, ephemeralIdentity, verifyWithPublicKey,
} from '../src/identity.mjs';
import { loadConfig, ensureLayout, dataPaths } from '../src/config.mjs';
import { tempDir, cleanupAll } from './helpers.mjs';

after(cleanupAll);

test('identity: nodeId выводится из pubkey и переживает перезагрузку', () => {
  const dir = tempDir('id');
  const id = createIdentity(dir);
  assert.match(id.nodeId, /^agt1[0-9a-f]{32}$/);
  assert.equal(nodeIdFromPublicKeyPem(id.publicKeyPem), id.nodeId);
  const again = loadIdentity(dir);
  assert.equal(again.nodeId, id.nodeId);
  assert.equal(again.publicKeyPem, id.publicKeyPem);
  const priv = path.join(dir, 'keys', 'node.key.pem');
  assert.ok(fs.existsSync(priv));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(priv).mode & 0o777, 0o600);
  }
});

test('identity: подпись проверяется, подмена данных отклоняется', () => {
  const id = ephemeralIdentity();
  const data = Buffer.from('agentnet-hello');
  const sig = id.signB64u(data);
  assert.equal(verifyWithPublicKey(id.publicKeyPem, data, sig), true);
  assert.equal(verifyWithPublicKey(id.publicKeyPem, Buffer.from('agentnet-hell0'), sig), false);
  assert.equal(verifyWithPublicKey(ephemeralIdentity().publicKeyPem, data, sig), false);
});

test('identity: приватный ключ не попадает в публичное описание', () => {
  const id = ephemeralIdentity();
  const desc = JSON.stringify(id.publicDescriptor());
  assert.ok(!desc.includes('PRIVATE KEY'));
  assert.ok(!desc.includes('privateKey'));
  assert.ok(desc.includes(id.nodeId));
});

test('config: раскладка каталогов и дефолты', () => {
  const dir = tempDir('cfg');
  ensureLayout(dir);
  const paths = dataPaths(dir);
  for (const p of [paths.chain, paths.peers, paths.logs, paths.state, paths.guard]) {
    assert.ok(fs.statSync(p).isDirectory(), p);
  }
  const cfg = loadConfig(dir);
  assert.equal(cfg.protocol, 1);
  assert.equal(cfg.sync.headersPerBatch, 200);
  assert.equal(cfg.limits.ratePerSecond, 20);
});
