import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createProfile, signProfileTransaction } from '../agt-skill/agent-profile.mjs';
import { canonicalWalletAmount, prepareWalletTransfer, signWalletTransfer, validateSignedWalletTransfer, readWalletState, broadcastWalletTransfer, runWalletCLI } from '../agt-skill/wallet-client.mjs';
import { createWallet, computeBlockHash, merkleRoot, verifyTransaction } from '../core.mjs';
const password = 'synthetic-wallet-password';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agt-wallet-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const profilePath = path.join(dir, 'profile.json'), pub = await createProfile({ profilePath, password }), to = createWallet().address;
  function block(prevHash, txs = [], nonce = 0) { const header = { version: 1, prevHash, merkleRoot: merkleRoot(txs), timestamp: 123, difficultyBits: 8, nonce, chainId: 'AGENTCOIN' }; return { header, txs, hash: computeBlockHash(header) }; }
  const genesis = block('0'.repeat(64)), tip = block(genesis.hash, [{ from: 'COINBASE', to: pub.address, amount: 50, txid: 'funding' }], 1), chain = [genesis, tip];
  const network = { network: 'AGENTCOIN', genesisHash: genesis.hash, nodeUrl: 'https://wallet.invalid' };
  const intent = await prepareWalletTransfer({ profilePath, network, recipient: to, amount: '10.000000000', nonce: 42, ts: 123, memo: 'test' });
  const requests = [];
  let mempool = { size: 0, txs: [] }, infoGenesis = network.genesisHash;
  const fetchFn = async (url, options) => {
    requests.push({ url, options }); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    const p = new URL(url).pathname;
    const data = p === '/info' ? { chainId: 'AGENTCOIN', genesisHash: infoGenesis, blocks: chain.length } : p === '/blocks' ? { blocks: chain.slice(Number(new URL(url).searchParams.get('from'))), height: chain.length } : p === '/headers' ? { headers: [{ hash: chain.at(-1).hash }] } : p === '/mempool' ? mempool : p === '/tx' ? { ok: true } : assert.fail(p);
    return new Response(JSON.stringify(data), { status: p === '/tx' ? 201 : 200 });
  };
  return { dir, profilePath, pub, to, network, intent, requests, fetchFn, setMempool: value => { mempool = value; }, wrongGenesis: () => { infoGenesis = 'f'.repeat(64); } };
}
test('offline vault signing binds exact nine-decimal intent and exports no secrets', async t => {
  const f = await fixture(t), manifest = await signWalletTransfer({ intent: f.intent, profilePath: f.profilePath, password, network: f.network });
  await assert.rejects(signWalletTransfer({ intent: f.intent, profilePath: f.profilePath, password, network: { ...f.network, genesisHash: 'f'.repeat(64) } }), /intent_network_pins/);
  assert.equal(f.intent.amount, '10'); assert.equal(verifyTransaction(manifest.tx), true);
  assert.equal(validateSignedWalletTransfer(manifest).tx.nonce, 42);
  assert.equal(JSON.stringify(manifest).includes('PRIVATE KEY'), false); assert.equal(JSON.stringify(manifest).includes(password), false); assert.equal(f.requests.length, 0);
  assert.throws(() => validateSignedWalletTransfer({ ...manifest, intent: { ...manifest.intent, amount: '11' } }), /mismatch/);
  await assert.rejects(signWalletTransfer({ intent: f.intent, profilePath: f.profilePath, password: 'wrong-wallet-password', network: f.network }), /vault_unlock_failed/);
  assert.equal(canonicalWalletAmount('0.000000001'), '0.000000001');
  for (const s of ['0.0000000001', '1e-9', '-1', '0', '9007199.254740992']) assert.throws(() => canonicalWalletAmount(s));
  const tiny = await signWalletTransfer({ intent: { ...f.intent, amount: '0.000000001' }, profilePath: f.profilePath, password, network: f.network });
  assert.equal(tiny.tx.amount, 1e-9);
});
test('vault signer requires explicit transfer domain and matching identity', async t => {
  const f = await fixture(t);
  await assert.rejects(signProfileTransaction({ profilePath: f.profilePath, password, expectedNetwork: 'AGENTCOIN', expectedAddress: f.pub.address, domain: 'login', transaction: {} }), /domain_network_address/);
  const transaction = { from: f.to, fromPub: f.pub.pub, to: f.to, amount: 10, nonce: 42, ts: 123, memo: '' };
  await assert.rejects(signProfileTransaction({ profilePath: f.profilePath, password, expectedNetwork: 'AGENTCOIN', expectedAddress: f.pub.address, domain: 'agentcoin.wallet.transfer.v1', transaction }), /profile_mismatch/);
});
test('read-only state calculates balance/history, pins genesis and labels truncated pending unknown', async t => {
  const f = await fixture(t), state = await readWalletState({ profilePath: f.profilePath, network: f.network, fetchFn: f.fetchFn, now: () => 1000 });
  assert.equal(state.balance, '50'); assert.equal(state.history.length, 1); assert.equal(state.pendingComplete, true);
  assert.equal(f.requests.some(r => r.options.method !== 'GET'), false);
  f.setMempool({ size: 1, txs: [{ txid: 'short', from: 'short', amount: 1 }] });
  assert.equal((await readWalletState({ profilePath: f.profilePath, network: f.network, fetchFn: f.fetchFn })).pending, null);
  f.wrongGenesis(); await assert.rejects(readWalletState({ profilePath: f.profilePath, network: f.network, fetchFn: f.fetchFn }), /node_network_or_genesis/);
});
test('broadcast defaults offline; explicit transfer durably records exact nonce and 201 stays submitted', async t => {
  const f = await fixture(t), manifest = await signWalletTransfer({ intent: f.intent, profilePath: f.profilePath, password, network: f.network }), journalPath = path.join(f.dir, 'payments.json');
  assert.equal((await broadcastWalletTransfer({ manifest, network: f.network })).dryRun, true); assert.equal(f.requests.length, 0);
  const r = await broadcastWalletTransfer({ manifest, network: f.network, journalPath, broadcast: true, fetchFn: f.fetchFn, now: () => 1000 });
  assert.equal(r.record.state, 'submitted'); assert.equal(r.record.transaction.nonce, 42);
  const posted = f.requests.find(r => r.options.method === 'POST'); assert.equal(new URL(posted.url).pathname, '/tx'); assert.deepEqual(JSON.parse(posted.options.body), manifest.tx);
  await assert.rejects(broadcastWalletTransfer({ manifest, network: f.network, journalPath, broadcast: true, fetchFn: f.fetchFn, now: () => 1000 }), /stale_observation/);
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 1);
});
test('nonempty abbreviated mempool refuses broadcast; CLI password comes from stdin only', async t => {
  const f = await fixture(t), manifest = await signWalletTransfer({ intent: f.intent, profilePath: f.profilePath, password, network: f.network });
  f.setMempool({ size: 1, txs: [{ txid: 'short' }] });
  await assert.rejects(broadcastWalletTransfer({ manifest, network: f.network, journalPath: path.join(f.dir, 'payments.json'), broadcast: true, fetchFn: f.fetchFn }), /full_mempool_required/);
  assert.equal(f.requests.some(r => r.options.method === 'POST'), false);
  const file = path.join(f.dir, 'intent.json'), networkFile = path.join(f.dir, 'network.json'); await fs.writeFile(file, JSON.stringify(f.intent)); await fs.writeFile(networkFile, JSON.stringify(f.network));
  assert.deepEqual(await runWalletCLI(['prepare', '--intent', file, '--profile', f.profilePath, '--network', networkFile]), f.intent);
  const signed = await runWalletCLI(['sign', '--intent', file, '--profile', f.profilePath, '--network', networkFile], { stdin: Readable.from([JSON.stringify({ password })]) });
  assert.equal(signed.tx.txid, manifest.tx.txid);
  await assert.rejects(runWalletCLI(['sign', '--password', password]), /arguments/);
});
