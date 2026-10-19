/** Real isolated two-node acceptance. No operator configuration, funds or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWallet, signTransaction, txDigest, computeBlockHash, hashMeetsDifficulty } from '../core.mjs';
import { stageIsolatedSource, isolatedEnvironment } from '../tools/isolated-test-node.mjs';
import { createProfile } from '../agt-skill/agent-profile.mjs';
import { prepareWalletTransfer, signWalletTransfer, broadcastWalletTransfer, readWalletState } from '../agt-skill/wallet-client.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await done; } finally { clearTimeout(timer); }
}
async function port() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agt-wallet-accept-'));
  const children = new Set();
  t.after(async () => { await Promise.all([...children].map(stop)); await fs.rm(root, { recursive: true, force: true }); });
  const source = await stageIsolatedSource(repository, path.join(root, 'source'));
  const bootstrap = path.join(root, 'bootstrap.json'); await fs.writeFile(bootstrap, '{"bootstrap":[]}');
  async function start(label, requestedPort) {
    const p = requestedPort ?? await port(), url = `http://127.0.0.1:${p}`, token = randomBytes(32).toString('hex');
    const data = path.join(root, label);
    const env = { ...isolatedEnvironment(), HOME: root, USERPROFILE: root, AGT_DATA_DIR: data, AGT_BOOTSTRAP_FILE: bootstrap, AGT_ADMIN_TOKEN: token, AGT_ADMIN_MODE: 'token', AGT_BIND: '127.0.0.1', AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' };
    const child = spawn(process.execPath, [path.join(source, 'node.mjs'), String(p)], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] }); children.add(child);
    let error = ''; child.stderr.on('data', b => error = (error + b).slice(-2000)); child.on('error', e => error += e.message);
    const api = async (method, route, body, auth = true) => {
      const response = await fetch(url + route, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json', ...(auth ? { 'x-admin-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    let ready = false;
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw Error('Fixture exited: ' + error); try { ready = (await api('GET', '/health')).status === 200; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 50)); }
    assert.ok(ready, error);
    return { child, port: p, url, api, data };
  }
  return { root, start, a: await start('A'), b: await start('B') };
}
function signed(sender, recipient, amount, nonce, changes = {}) {
  const tx = { from: sender.address, fromPub: sender.pub, to: recipient.address, amount, nonce, ts: Math.floor(Date.now() / 1000), memo: 'isolated-wallet-acceptance', ...changes };
  tx.signature = signTransaction(tx, sender.privKey); tx.txid = txDigest(tx); return tx;
}
async function mine(node, address) { for (let i = 0; i < 5; i++) { const r = await node.api('POST', '/mine', { miner: address }); if (r.status === 200) return r; assert.equal(r.status, 202, JSON.stringify(r)); } throw Error('Synthetic mining slices exhausted'); }
async function balance(node, wallet) { const r = await node.api('POST', '/balance', { address: wallet.address }); assert.equal(r.status, 200); return r.body.balance; }
async function chain(node) { const r = await node.api('GET', '/blocks?from=0'); assert.equal(r.status, 200); return r.body.blocks; }
async function sync(node) { const r = await node.api('GET', '/sync-now'); assert.equal(r.status, 200, JSON.stringify(r)); }

test('two real nodes: local signed payment, propagation, duplicate safety, histories and restart', { timeout: 60000 }, async t => {
  const f = await fixture(t), { a, b } = f;
  const sender = createWallet('synthetic-sender'), recipient = createWallet('synthetic-recipient'), miner = createWallet('synthetic-miner');
  assert.equal((await a.api('POST', '/peer/add', { peer: b.url })).status, 200);
  assert.equal((await b.api('POST', '/peer/add', { peer: a.url })).status, 200);
  await mine(a, sender.address); await sync(b);
  assert.equal(await balance(a, sender), 50); assert.equal(await balance(b, sender), 50);
  const tx = signed(sender, recipient, 10, 1001);
  assert.equal((await a.api('POST', '/tx', tx)).status, 201);
  let propagated = false;
  for (let i = 0; i < 30; i++) { const mem = (await b.api('GET', '/mempool')).body; propagated = mem.txs?.some(item => item.txid === tx.txid.slice(0, 16) && item.nonce === tx.nonce && item.amount === 10); if (propagated) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(propagated, 'transaction gossips from A to B');
  const duplicate = await a.api('POST', '/tx', tx); assert.ok([200, 400, 409].includes(duplicate.status), JSON.stringify(duplicate));
  await mine(a, miner.address); await sync(b);
  for (const node of [a, b]) {
    assert.equal(await balance(node, sender), 40); assert.equal(await balance(node, recipient), 10);
    const history = (await chain(node)).flatMap(block => block.txs).filter(item => item.txid === tx.txid);
    assert.equal(history.length, 1); assert.equal(history[0].from, sender.address); assert.equal(history[0].to, recipient.address); assert.equal(history[0].amount, 10);
  }
  assert.equal((await a.api('GET', '/operator/state', undefined, false)).status, 403);
  const invalid = signed(recipient, sender, 1, 1002); invalid.signature = '00'.repeat(64);
  assert.ok([400, 403].includes((await b.api('POST', '/tx', invalid)).status));
  assert.equal(await balance(b, recipient), 10);
  await stop(b.child);
  const restarted = await f.start('B', b.port);
  assert.equal(await balance(restarted, sender), 40); assert.equal(await balance(restarted, recipient), 10);
  assert.equal((await chain(restarted)).flatMap(block => block.txs).filter(item => item.txid === tx.txid).length, 1);
  const disk = await fs.readFile(path.join(restarted.data, 'chain.json'), 'utf8'); assert.ok(disk.includes(tx.txid));
  const replay = await restarted.api('POST', '/tx', tx);
  assert.notEqual(replay.status, 201, 'confirmed transaction must not enter mempool again');
  const returnTx = signed(recipient, sender, 3, 1003, { memo: 'isolated-return-payment' });
  assert.equal((await restarted.api('POST', '/tx', returnTx)).status, 201, 'invalid signature attempt did not ban legitimate owner');
  await mine(restarted, miner.address); await sync(a);
  for (const node of [a, restarted]) {
    assert.equal(await balance(node, sender), 43); assert.equal(await balance(node, recipient), 7);
    const history = (await chain(node)).flatMap(block => block.txs);
    assert.equal(history.filter(item => item.txid === tx.txid).length, 1);
    assert.equal(history.filter(item => item.txid === returnTx.txid).length, 1);
  }

});

test('foreign chain block is rejected by actual submission endpoint', { timeout: 30000, todo: 'Known legacy consensus gap: current /block/submit accepts foreign chainId; requires coordinated consensus repair' }, async t => {
  const { a } = await fixture(t), miner = createWallet();
  const response = await a.api('POST', '/blocktemplate', { miner: miner.address }); assert.equal(response.status, 200);
  const template = response.body;
  assert.ok(template.header && template.txs, JSON.stringify(template));
  const header = { ...template.header, chainId: 'FOREIGN-NETWORK', nonce: 0 };
  while (!hashMeetsDifficulty(computeBlockHash(header), header.difficultyBits)) { if (++header.nonce > 1000000) throw Error('Fixture PoW bound'); }
  const r = await a.api('POST', '/block/submit', { miner: miner.address, header, txs: template.txs });
  assert.notEqual(r.status, 200, JSON.stringify(r)); assert.equal((await chain(a)).length, 1);
});

test('KNOWN GAP: legacy ordinary signature does not bind chainId', () => {
  const sender = createWallet(), recipient = createWallet(), tx = signed(sender, recipient, 1, 1, { chainId: 'AGENTCOIN' });
  assert.equal(txDigest(tx), txDigest({ ...tx, chainId: 'FOREIGN-NETWORK' }));
  // Deliberately records the actual limitation; this is not a successful cross-network protection test.
});

test('encrypted local wallet signs offline and durable broadcast confirms on real temporary nodes', { timeout: 60000 }, async t => {
  const f = await fixture(t), { a, b } = f;
  await b.api('POST', '/peer/add', { peer: a.url });
  const profilePath = path.join(f.root, 'private-wallet', 'profile.json');
  const password = 'synthetic-private-wallet-password', identity = await createProfile({ profilePath, password });
  const recipient = createWallet(), miner = createWallet();
  await mine(a, identity.address);
  const info = (await a.api('GET', '/info')).body;
  const network = { network: 'AGENTCOIN', genesisHash: info.genesisHash, nodeUrl: a.url };
  const intent = await prepareWalletTransfer({ profilePath, network, recipient: recipient.address, amount: '10.000000000', nonce: 901, ts: Math.floor(Date.now() / 1000), memo: 'real-vault-payment' });
  const manifest = await signWalletTransfer({ intent, profilePath, password, network });
  assert.equal(JSON.stringify(manifest).includes(password), false); assert.equal(JSON.stringify(manifest).includes('PRIVATE KEY'), false);
  await assert.rejects(signWalletTransfer({ intent, profilePath, password: 'incorrect-private-password', network }), /vault_unlock_failed/);
  await assert.rejects(signWalletTransfer({ intent, profilePath, password, network: { ...network, genesisHash: 'f'.repeat(64) } }), /intent_network_pins/);
  const journalPath = path.join(f.root, 'private-wallet', 'payments.json');
  assert.equal((await broadcastWalletTransfer({ manifest, network, journalPath })).dryRun, true);
  const submitted = await broadcastWalletTransfer({ manifest, network, journalPath, broadcast: true });
  assert.equal(submitted.record.state, 'submitted');
  await mine(a, miner.address); await sync(b);
  const state = await readWalletState({ profilePath, network }); assert.equal(state.balance, '40');
  assert.equal(state.history.filter(item => item.tx.txid === manifest.tx.txid).length, 1);
  assert.equal(state.validation, 'linked_rpc_snapshot_not_independent_consensus_validation');
  const confirmation = await broadcastWalletTransfer({ manifest, network, journalPath, broadcast: true });
  assert.equal(confirmation.record.state, 'confirmed'); assert.equal(confirmation.broadcast, false);
  assert.equal(await balance(b, recipient), 10);
  const rawProfile = await fs.readFile(profilePath, 'utf8'); assert.equal(rawProfile.includes('PRIVATE KEY'), false); assert.equal(rawProfile.includes(password), false);
});
