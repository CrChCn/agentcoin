'use strict';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignedResponse } from '../src/api.mjs';
import { assertNoPrivateLeaks } from '../src/privacy.mjs';
import { createRelease } from '../src/updates.mjs';
import { createPassport } from '../src/operator.mjs';
import { ephemeralIdentity } from '../src/identity.mjs';
import { mineNext, mineMany, coinbaseTx } from '../src/mine.mjs';
import { waitFor } from '../src/util.mjs';
import {
  cleanupAll, endpoint, fetchJson, makeNetworkId, startTestIndexer,
  startTestNode, startTestPortal, tempDir,
} from './helpers.mjs';

after(cleanupAll);

test('network: 3 наблюдателя + портал, подписи, SSE, форк, обновления и отказы', async (t) => {
  const networkId = makeNetworkId('net');
  const releaseKey = ephemeralIdentity();
  const nodes = [];
  const indexers = [];
  let portal = null;
  try {
    const n1 = await startTestNode({ dir: tempDir('n1'), networkId, releaseKeys: [releaseKey.publicKeyPem] });
    mineMany(n1.chain, 3, { txs: [coinbaseTx('n1-genesis-branch')] });
    const n4 = await startTestNode({ dir: tempDir('n4'), networkId });
    mineMany(n4.chain, 3, { txs: [coinbaseTx('n4-other-branch')] });
    const n2 = await startTestNode({ dir: tempDir('n2'), networkId, seeds: [endpoint(n1)] });
    const n3 = await startTestNode({ dir: tempDir('n3'), networkId, seeds: [endpoint(n2)] });
    nodes.push(n1, n2, n3, n4);

    await n1.connect(endpoint(n4));
    await n2.connect(endpoint(n3));
    await n4.connect(endpoint(n3));
    await waitFor(() => n2.chain.height === 3 && n3.chain.height === 3, { timeoutMs: 15000, label: 'nodes sync' });
    assert.equal(n2.chain.tip.hash, n1.chain.tip.hash);
    assert.equal(n4.chain.tip.hash !== n1.chain.tip.hash, true, 'разные ветки на одной высоте');

    for (let i = 0; i < 3; i++) {
      const idx = await startTestIndexer({
        dir: tempDir(`idx${i}`),
        networkId,
        seeds: [endpoint(n1), endpoint(n2), endpoint(n3)],
      });
      indexers.push(idx);
      for (const node of [n1, n2, n3, n4]) await idx.node.connect(endpoint(node));
    }
    assert.equal(new Set(indexers.map((i) => i.id)).size, 3, 'у indexer-ов разные nodeId');

    portal = await startTestPortal({ dir: tempDir('portal'), indexers: indexers.map((i) => i.url) });
    await waitFor(() => portal.nodes.length >= 4, { timeoutMs: 30000, label: 'portal nodes' });
    await waitFor(() => portal.nodes.filter((n) => n.ready).length >= 4, { timeoutMs: 30000, label: 'portal ready' });

    const ready = portal.nodes.filter((n) => n.ready);
    assert.equal(ready.length, 4);
    for (const n of ready) {
      assert.ok(['MULTI_OBSERVED', 'PUBLIC_REACHABLE', 'INDEPENDENT_OPERATOR'].includes(n.level), n.level);
      assert.ok(n.observers.length >= 2, 'минимум два наблюдателя');
    }
    assert.ok(portal.summary().indexers.online === 3);

    // --- подписанные ответы Network API ---
    const nodesDoc = (await fetchJson(`${portal.url}/api/v1/network/nodes`)).doc;
    const verified = verifySignedResponse(nodesDoc, { expectedKind: 'nodes' });
    assert.equal(verified.ok, true);
    assert.equal(nodesDoc.sourceIndexer, portal.id);
    assert.ok(nodesDoc.signature && nodesDoc.pubkey && nodesDoc.expiresAt);
    assert.doesNotThrow(() => assertNoPrivateLeaks(nodesDoc.data));
    assert.ok(!JSON.stringify(nodesDoc.data).includes('127.0.0.1'), 'loopback не публикуется');

    const idxDoc = (await fetchJson(`${indexers[0].url}/api/v1/network/observations`)).doc;
    const idxVerified = verifySignedResponse(idxDoc, { expectedKind: 'observations', pubkeyPem: idxDoc.pubkey });
    assert.equal(idxVerified.ok, true);
    assert.equal(idxDoc.sourceIndexer, indexers[0].id);

    // --- форк на одинаковой высоте ---
    await waitFor(() => portal.forks.length >= 1, { timeoutMs: 20000, label: 'fork detected' });
    const fork = portal.forks[0];
    assert.equal(fork.height, 3);
    assert.equal(fork.branches.length, 2);
    assert.equal(portal.consensus().status, 'FORK');

    // --- форк снят: у n1 высота 4 (разные высоты — не форк) ---
    mineNext(n1.chain, { txs: [coinbaseTx('n1-resolve')] });
    n1.broadcastAnnouncement();
    await waitFor(() => portal.forks.length === 0, { timeoutMs: 20000, label: 'fork resolved' });

    // --- SSE с sequence number ---
    const ac = new AbortController();
    const sse = await fetch(`${portal.url}/api/v1/network/events`, { signal: ac.signal });
    assert.equal(sse.status, 200);
    const reader = sse.body.getReader();
    let text = '';
    const readUntil = async (pred, label) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
        if (pred(text)) return text;
      }
      throw new Error(`sse timeout: ${label}\n${text.slice(-500)}`);
    };
    await readUntil((t2) => t2.includes('event: snapshot'), 'snapshot');
    mineNext(n1.chain, { txs: [coinbaseTx('n1-sse')] });
    n1.broadcastAnnouncement();
    const streamed = await readUntil((t2) => /^id: \d+/m.test(t2) && t2.includes('event: node.'), 'event');
    ac.abort();
    assert.match(streamed, /id: \d+/);

    // --- оператор: паспорт поднял уровень ---
    const operator = ephemeralIdentity();
    const passport = createPassport(operator, { operatorId: 'op-test', name: 'Test Operator', nodeIds: [n2.id], region: 'EU' });
    const reg = portal.operators.add(passport);
    assert.equal(reg.ok, true);
    await waitFor(() => portal.nodes.find((n) => n.nodeId === n2.id)?.level === 'INDEPENDENT_OPERATOR', { timeoutMs: 15000, label: 'independent operator' });
    const ops = (await fetchJson(`${portal.url}/api/v1/network/operators`)).doc.data;
    assert.equal(ops.operators.length, 1);
    assert.equal(ops.operators[0].operatorId, 'op-test');

    // --- обновления: канарейка, несовместимость, rollback ---
    const rel = createRelease(releaseKey, { version: '1.1.0', protocol: { min: 1, max: 2 }, canaryPercent: 100, artifacts: [] });
    assert.equal(n1.updater.check(rel, { nodeId: n1.id }).action, 'apply');
    assert.equal((await n1.updater.apply(rel, { nodeId: n1.id })).ok, true);
    assert.equal(n1.version, '1.1.0');
    assert.equal((await n1.updater.rollback()).ok, true);
    assert.equal(n1.version, '1.0.0');
    const incompatible = createRelease(releaseKey, { version: '2.0.0', protocol: { min: 2, max: 2 }, canaryPercent: 100 });
    assert.equal(n1.updater.check(incompatible, { nodeId: n1.id }).action, 'reject');
    const deferred = createRelease(releaseKey, { version: '1.2.0', protocol: { min: 1, max: 2 }, canaryPercent: 0 });
    assert.equal(n1.updater.check(deferred, { nodeId: n1.id }).action, 'defer');

    // --- отказ indexer-а: сеть и готовность на двух наблюдателях ---
    await indexers[2].stop();
    await waitFor(() => portal.sources.filter((s) => s.ok).length === 2, { timeoutMs: 15000, label: 'indexer down' });
    await waitFor(() => portal.nodes.filter((n) => n.ready).length >= 4, { timeoutMs: 20000, label: 'ready with 2 observers' });

    // --- отказ сайта: сеть продолжает синхронизироваться ---
    await portal.stop();
    portal = null;
    const before = n3.chain.height;
    mineNext(n1.chain, { txs: [coinbaseTx('after-site-down')] });
    n1.broadcastAnnouncement();
    await waitFor(() => n3.chain.height > before, { timeoutMs: 15000, label: 'sync without site' });

    // --- отказ seed-ноды: знакомые пиры работают дальше ---
    await waitFor(() => n2.chain.height === n3.chain.height, { timeoutMs: 10000, label: 'n2 caught up' });
    await n1.stop('test_seed_down');
    const h2 = n3.chain.height;
    mineNext(n2.chain, { txs: [coinbaseTx('after-seed-down')] });
    n2.broadcastAnnouncement();
    await waitFor(() => n3.chain.height > h2, { timeoutMs: 15000, label: 'sync without seed' });

    // --- оператор выключил все свои серверы: независимые ноды работают ---
    await waitFor(() => n4.chain.height >= n2.chain.height - 1, { timeoutMs: 15000, label: 'n4 following' });
    const h4 = n4.chain.height;
    await n2.stop('operator_all_down');
    mineNext(n3.chain, { txs: [coinbaseTx('after-operator-down')] });
    n3.broadcastAnnouncement();
    await waitFor(() => n4.chain.height > h4, { timeoutMs: 15000, label: 'independent node continues' });
  } finally {
    if (portal) await portal.stop().catch(() => {});
    for (const idx of indexers) await idx.stop().catch(() => {});
    for (const n of nodes) await n.stop('test').catch(() => {});
  }
});
