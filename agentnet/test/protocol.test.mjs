'use strict';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openEnvelope, ReplayGuard } from '../src/envelope.mjs';
import { PeerBook } from '../src/peers.mjs';
import { AgentcoinNode } from '../src/node.mjs';
import { waitFor } from '../src/util.mjs';
import {
  cleanupAll, endpoint, makeNetworkId, sessionOf, startTestNode, tempDir,
} from './helpers.mjs';

after(cleanupAll);

test('protocol: HELLO/CHALLENGE, шифрованный канал, объявления и RTT', async () => {
  const networkId = makeNetworkId('proto');
  const a = await startTestNode({ dir: tempDir('pa'), networkId });
  const b = await startTestNode({ dir: tempDir('pb'), networkId });
  try {
    const r = await b.connect(endpoint(a));
    assert.equal(r.ok, true);
    await waitFor(() => a.authenticatedCount() === 1 && b.authenticatedCount() === 1, { timeoutMs: 5000, label: 'auth' });
    const inbound = sessionOf(a, b.id, 'inbound');
    const outbound = sessionOf(b, a.id, 'outbound');
    assert.ok(inbound, 'A видит входящую сессию');
    assert.ok(outbound, 'B видит исходящую сессию');
    assert.equal(inbound.stream.stats().encrypted, true);
    assert.equal(outbound.stream.stats().encrypted, true);
    assert.equal(inbound.pubkey, b.identity.publicKeyPem);

    await waitFor(() => a.announcements.has(b.id) && b.announcements.has(a.id), { timeoutMs: 5000, label: 'announcements' });
    assert.equal(a.announcements.get(b.id).payload.height, 0);

    b._send(outbound, 'PING', { nonce: 'n1', t: Date.now() });
    await waitFor(() => outbound.rtt !== null, { timeoutMs: 3000, label: 'pong' });
    assert.ok(outbound.rtt >= 0 && outbound.rtt < 2000);
  } finally {
    await b.stop('test'); await a.stop('test');
  }
});

test('protocol: replay, подпись, TTL и лимит размера', () => {
  const id = startIdentity();
  const env = id.announcement();
  const guard = new ReplayGuard();
  const first = openEnvelope(env, { pubkeyPem: id.identity.publicKeyPem, replay: guard });
  assert.equal(first.ok, true);
  const second = openEnvelope(env, { pubkeyPem: id.identity.publicKeyPem, replay: guard });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'replay');

  const tampered = JSON.parse(JSON.stringify(env));
  tampered.payload.height = 999999;
  const bad = openEnvelope(tampered, { pubkeyPem: id.identity.publicKeyPem });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_signature');

  const expired = JSON.parse(JSON.stringify(env));
  expired.timestamp = Date.now() - 10 * 24 * 3600 * 1000;
  expired.expiresAt = Date.now() - 1000;
  const exp = openEnvelope(expired, { pubkeyPem: id.identity.publicKeyPem });
  assert.equal(exp.ok, false);
  assert.equal(exp.reason, 'expired');

  const big = {
    protocol: 1, type: 'HELLO', messageId: 'a'.repeat(32), nodeId: id.identity.nodeId,
    timestamp: Date.now(), expiresAt: Date.now() + 1000,
    payload: { pubkey: id.identity.publicKeyPem, pad: 'x'.repeat(20000) }, signature: 'x'.repeat(64),
  };
  const large = openEnvelope(big, { pubkeyPem: id.identity.publicKeyPem });
  assert.equal(large.ok, false);
  assert.equal(large.reason, 'too_large');
});

function startIdentity() {
  const node = new AgentcoinNode({ dataDir: tempDir('pid'), config: { networkId: 'unit' }, log: () => {} });
  return { identity: node.identity, announcement: () => node.announcement() };
}

test('protocol: забаненный nodeId не проходит рукопожатие, бан переживает перезагрузку', async () => {
  const networkId = makeNetworkId('ban');
  const x = await startTestNode({ dir: tempDir('bx'), networkId });
  const y = await startTestNode({ dir: tempDir('by'), networkId });
  try {
    y.book.ban(x.id, 'unit-test-ban');
    const r = await x.connect(endpoint(y));
    assert.equal(r.ok, true);
    await waitFor(() => x.authenticatedCount() === 0 && y.authenticatedCount() === 0, { timeoutMs: 5000, label: 'banned' });
    const book = new PeerBook({ file: y.paths.peersFile }).load();
    assert.equal(book.isBanned(x.id), true);
  } finally {
    await x.stop('test'); await y.stop('test');
  }
});

test('protocol: self-connect и чужая сеть отклоняются', async () => {
  const networkId = makeNetworkId('self');
  const a = await startTestNode({ dir: tempDir('sa'), networkId });
  const other = await startTestNode({ dir: tempDir('sb'), networkId: makeNetworkId('other') });
  try {
    const self = await a.connect(endpoint(a));
    assert.equal(self.ok, false);
    assert.equal(self.reason, 'self');
    await other.connect(endpoint(a));
    await waitFor(() => a.authenticatedCount() === 0 && other.authenticatedCount() === 0, { timeoutMs: 5000, label: 'net-mismatch' });
  } finally {
    await other.stop('test'); await a.stop('test');
  }
});

test('protocol: флуд сверх rate limit закрывает сессию и начисляет штраф', async () => {
  const networkId = makeNetworkId('flood');
  const a = await startTestNode({ dir: tempDir('fa'), networkId });
  const b = await startTestNode({ dir: tempDir('fb'), networkId });
  try {
    await b.connect(endpoint(a));
    await waitFor(() => b.authenticatedCount() === 1 && a.authenticatedCount() === 1, { timeoutMs: 5000, label: 'auth' });
    const s = sessionOf(b, a.id, 'outbound');
    assert.ok(s);
    for (let i = 0; i < 400; i++) b._send(s, 'PING', { nonce: `f${i}`, t: Date.now() });
    await waitFor(() => !a.sessions.has(`${b.id}:inbound`), { timeoutMs: 8000, label: 'flood-close' });
    assert.ok(a.book.penalties.has(b.id), 'штраф начислен');
    assert.ok(a.book.penalties.get(b.id).score > 0);
  } finally {
    await b.stop('test'); await a.stop('test');
  }
});
