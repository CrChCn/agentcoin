'use strict';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Discovery, compareDistance, parseSeed, xorDistance } from '../src/discovery.mjs';
import { PeerBook, normalizeEndpoint, validHost } from '../src/peers.mjs';
import { cleanupAll, tempDir } from './helpers.mjs';

after(cleanupAll);

function book(name) {
  const dir = tempDir(name);
  return new PeerBook({ dir, file: path.join(dir, 'peers.json') });
}

test('discovery: разбор seed-адресов, IPv6 и невалидные значения', () => {
  assert.deepEqual(parseSeed('127.0.0.1:9336'), { host: '127.0.0.1', port: 9336 });
  assert.deepEqual(parseSeed('node1.agentcoin.work:9336'), { host: 'node1.agentcoin.work', port: 9336 });
  assert.deepEqual(parseSeed('[::1]:9336'), { host: '::1', port: 9336 });
  assert.equal(parseSeed('127.0.0.1'), null);
  assert.equal(parseSeed('0.0.0.0:9336'), null);
  assert.equal(parseSeed('host:99999'), null);
  assert.equal(validHost('::1'), true);
  assert.equal(normalizeEndpoint('::1', 9336).port, 9336);
});

test('discovery: static/saved источники, pex и DHT-lite по XOR-расстоянию', async () => {
  const b = book('disc');
  const disc = new Discovery({ book: b, seeds: ['127.0.0.1:9336'] });

  b.add({ host: '127.0.0.1', port: 9337, source: 'saved' });
  const candidates = await disc.candidates({ limit: 8 });
  assert.ok(candidates.some((c) => c.port === 9336));
  assert.ok(candidates.some((c) => c.port === 9337));

  const added = disc.learn([{ host: '203.0.113.10', port: 9336, nodeId: 'agt1' + 'a'.repeat(32) }, { host: '', port: 1 }], 'pex');
  assert.equal(added, 1);
  assert.ok(b.known({ limit: 10 }).some((p) => p.host === '203.0.113.10'));

  const target = 'agt1' + 'a'.repeat(32);
  const far = 'agt1' + 'f'.repeat(32);
  const near = 'agt1' + 'a'.repeat(30) + 'ab';
  assert.ok(compareDistance(xorDistance(near, target), xorDistance(far, target)) < 0);
  const closest = disc.closestKnown(target, { k: 4 });
  assert.equal(closest[0].nodeId, target);
  disc.noteLookup();
  assert.equal(disc.report().dhtLookups, 1);
  assert.equal(disc.report().sources.static, 1);
});

test('discovery: баны скрывают пиров из выдачи', () => {
  const b = book('disc-ban');
  const bannedId = 'agt1' + 'b'.repeat(32);
  b.add({ host: '203.0.113.11', port: 9336, nodeId: bannedId });
  assert.equal(b.known({ limit: 10 }).length, 1);
  b.ban(bannedId, 'test');
  assert.equal(b.known({ limit: 10 }).length, 0);
  assert.equal(b.known({ limit: 10, includeBanned: true }).length, 1);
});
