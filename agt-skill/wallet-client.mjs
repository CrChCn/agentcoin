#!/usr/bin/env node
/** AGT-only local wallet. Offline signing; public read transport; explicit durable broadcast. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readPublicProfile, signProfileTransaction, DEFAULT_PROFILE_PATH } from './agent-profile.mjs';
import { PaymentIntentJournal } from '../payment-intent.mjs';
import { paymentOrigin } from '../tools/payment-intents.mjs';
import { txDigest, verifyTransaction, computeBlockHash, merkleRoot } from '../core.mjs';
const fail = message => { throw Error('wallet_' + message); };
const hash = text => createHash('sha256').update(text).digest('hex');
function keys(obj, list) { if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).sort().join() !== list.sort().join()) fail('fields'); }
export function canonicalWalletAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(value)) fail('decimal_amount');
  const [i, f = ''] = value.split('.'); const units = BigInt(i) * 1000000000n + BigInt(f.padEnd(9, '0'));
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) fail('amount_range');
  const out = i + (f.replace(/0+$/, '') ? '.' + f.replace(/0+$/, '') : '');
  if (BigInt(Number(out).toFixed(9).replace('.', '')) !== units) fail('amount_not_representable');
  return out;
}
function networkPins(network) {
  if (network?.network !== 'AGENTCOIN' || !/^[a-f0-9]{64}$/.test(network.genesisHash)) fail('network_pins_required');
  return { ...network, nodeUrl: paymentOrigin(network.nodeUrl) };
}
export function validateWalletIntent(intent) {
  keys(intent, ['schema', 'network', 'genesisHash', 'from', 'to', 'amount', 'memo', 'createdAt', 'nonce']);
  if (intent.schema !== 'agentcoin.wallet.intent.v1' || intent.network !== 'AGENTCOIN' || !/^[a-f0-9]{64}$/.test(intent.genesisHash) || !/^AGT[a-f0-9]{40}$/.test(intent.from) || !/^AGT[a-f0-9]{40}$/.test(intent.to) || canonicalWalletAmount(intent.amount) !== intent.amount || typeof intent.memo !== 'string' || Buffer.byteLength(intent.memo) > 512 || /[\u0000-\u001f\u007f]/.test(intent.memo) || !Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0 || !Number.isSafeInteger(intent.nonce) || intent.nonce < 0) fail('intent');
  return structuredClone(intent);
}
export async function prepareWalletTransfer({ profilePath = DEFAULT_PROFILE_PATH, network, recipient, amount, nonce, ts, memo = '' }) {
  const pins = networkPins(network), pub = await readPublicProfile(profilePath);
  if (pub.network !== pins.network) fail('profile_network');
  return validateWalletIntent({ schema: 'agentcoin.wallet.intent.v1', network: pins.network, genesisHash: pins.genesisHash, from: pub.address, to: recipient, amount: canonicalWalletAmount(amount), memo, createdAt: ts, nonce });
}
export async function signWalletTransfer({ intent, profilePath = DEFAULT_PROFILE_PATH, password, network }) {
  intent = validateWalletIntent(intent); const pins = networkPins(network); if (intent.network !== pins.network || intent.genesisHash !== pins.genesisHash) fail('intent_network_pins'); const pub = await readPublicProfile(profilePath);
  const tx = await signProfileTransaction({ profilePath, password, expectedNetwork: intent.network, expectedAddress: intent.from, domain: 'agentcoin.wallet.transfer.v1', transaction: { from: intent.from, fromPub: pub.pub, to: intent.to, amount: Number(intent.amount), nonce: intent.nonce, ts: intent.createdAt, memo: intent.memo } });
  return { schema: 'agentcoin.wallet.signed.v1', network: intent.network, genesisHash: intent.genesisHash, intent, tx };
}
export function validateSignedWalletTransfer(manifest) {
  keys(manifest, ['schema', 'network', 'genesisHash', 'intent', 'tx']);
  const i = validateWalletIntent(manifest.intent), tx = manifest.tx;
  keys(tx, ['from', 'fromPub', 'to', 'amount', 'nonce', 'ts', 'memo', 'txid', 'signature']);
  if (manifest.schema !== 'agentcoin.wallet.signed.v1' || manifest.network !== i.network || manifest.genesisHash !== i.genesisHash || tx.from !== i.from || tx.to !== i.to || tx.amount !== Number(i.amount) || tx.nonce !== i.nonce || tx.ts !== i.createdAt || tx.memo !== i.memo || tx.txid !== txDigest(tx) || !verifyTransaction(tx)) fail('signed_intent_mismatch');
  return structuredClone(manifest);
}
async function api(pins, endpoint, { fetchFn = fetch, method = 'GET', body, maxBytes = 16 * 1024 * 1024 } = {}) {
  const response = await fetchFn(pins.nodeUrl + endpoint, { method, redirect: 'error', credentials: 'omit', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
  if (![200, 201].includes(response.status)) fail('http_' + response.status);
  // Standard fetch streaming ensures an untrusted RPC cannot allocate unbounded JSON.
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) { size += chunk.byteLength; if (size > maxBytes) { await response.body.cancel?.().catch(() => {}); fail('response_limit'); } chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('response_json'); }
}
async function info(pins, deps) { const data = await api(pins, '/info', deps); if ((data.chainId ?? data.network) !== pins.network || data.genesisHash !== pins.genesisHash || !Number.isSafeInteger(data.blocks) || data.blocks < 1) fail('node_network_or_genesis'); return data; }
function unitsOf(n) { if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || Number(n.toFixed(9)) !== n) fail('chain_amount'); return BigInt(n.toFixed(9).replace('.', '')); }
function unitsText(n) { const sign = n < 0n ? '-' : ''; n = n < 0n ? -n : n; const f = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, ''); return sign + (n / 1000000000n) + (f ? '.' + f : ''); }
export async function readWalletState({ profilePath = DEFAULT_PROFILE_PATH, address, network, fetchFn = fetch, now = Date.now, maxBlocks = 100000 }) {
  const pins = networkPins(network), deps = { fetchFn }, identity = address ? null : await readPublicProfile(profilePath);
  address = address || identity.address; if (!/^AGT[a-f0-9]{40}$/.test(address) || (identity && identity.network !== pins.network)) fail('address_or_profile_network');
  const start = await info(pins, deps); if (start.blocks > maxBlocks) fail('snapshot_limit');
  const chain = []; let bytes = 0;
  while (chain.length < start.blocks) {
    const page = await api(pins, '/blocks?from=' + chain.length + '&limit=100', { ...deps, maxBytes: 128 * 1024 * 1024 });
    if (!Array.isArray(page.blocks) || !page.blocks.length) fail('incomplete_chain');
    const remaining = start.blocks - chain.length;
    for (const b of page.blocks.slice(0, remaining)) {
      bytes += Buffer.byteLength(JSON.stringify(b)); if (bytes > 128 * 1024 * 1024) fail('snapshot_limit');
      if (b.hash !== computeBlockHash(b.header) || b.header.merkleRoot !== merkleRoot(b.txs) || (chain.length ? b.header.prevHash !== chain.at(-1).hash : b.hash !== pins.genesisHash)) fail('chain_anchor');
      chain.push(b);
    }
  }
  const mempool = await api(pins, '/mempool?full=1', { ...deps, maxBytes: 2 * 1024 * 1024 }), end = await info(pins, deps);
  const tipCheck = await api(pins, '/headers?from=' + (chain.length - 1) + '&limit=1', deps);
  if (end.blocks !== start.blocks || tipCheck.headers?.[0]?.hash !== chain.at(-1).hash) fail('snapshot_changed_retry');
  let balance = 0n; const history = [];
  for (let h = 0; h < chain.length; h++) for (const tx of chain[h].txs) {
    if (tx.from === address || tx.to === address) { const units = unitsOf(tx.amount); if (tx.from === address) balance -= units; if (tx.to === address) balance += units; history.push({ blockHeight: h, blockHash: chain[h].hash, tx: structuredClone(tx) }); }
  }
  let fullMempool = false;
  if (mempool.version === 1) {
    if (!Number.isSafeInteger(mempool.size) || mempool.size < 0 || typeof mempool.complete !== 'boolean' || !Array.isArray(mempool.txs) || (mempool.total !== undefined && mempool.total !== mempool.size) || mempool.tipHash !== chain.at(-1).hash || mempool.height !== chain.length - 1) fail('mempool_contract_or_anchor');
    if (mempool.complete === true) {
      if (mempool.size !== mempool.txs.length || mempool.txs.length > 1000) fail('mempool_incomplete');
      const seen = new Set();
      for (const tx of mempool.txs) {
        keys(tx, ['from', 'fromPub', 'to', 'amount', 'nonce', 'ts', 'memo', 'txid', 'signature']);
        if (!/^AGT[a-f0-9]{40}$/.test(tx.from) || !/^AGT[a-f0-9]{40}$/.test(tx.to) || typeof tx.memo !== 'string' || Buffer.byteLength(tx.memo) > 512 || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || !Number.isSafeInteger(tx.ts) || tx.ts < 0 || unitsOf(tx.amount) <= 0n || tx.txid !== txDigest(tx) || !verifyTransaction(tx) || seen.has(tx.txid)) fail('mempool_transaction');
        seen.add(tx.txid);
      }
      fullMempool = true;
    } else if (mempool.txs.length !== 0) fail('mempool_partial_contract');
  } else {
    if (mempool.version !== undefined) fail('mempool_unsupported_version');
    // Older nodes ignore full=1. Only an explicitly empty legacy queue can be complete.
    fullMempool = mempool.size === 0 && Array.isArray(mempool.txs) && mempool.txs.length === 0;
  }
  return { address, balance: unitsText(balance), unit: 'AGT', fee: '0', feeNote: 'Current ordinary-transfer protocol has no fee field; no Bitcoin-style fee estimate.', history, pending: fullMempool ? mempool.txs.filter(t => t.from === address || t.to === address) : null, pendingComplete: fullMempool, validation: 'linked_rpc_snapshot_not_independent_consensus_validation', observation: { complete: fullMempool, observedAt: now(), anchor: { genesisHash: pins.genesisHash, tipHash: chain.at(-1).hash, height: chain.length - 1 }, chain, mempool: fullMempool ? mempool.txs : [] } };
}
export async function broadcastWalletTransfer({ manifest, network, journalPath, broadcast = false, fetchFn = fetch, now = Date.now }) {
  const signed = validateSignedWalletTransfer(manifest), pins = networkPins(network);
  if (signed.network !== pins.network || signed.genesisHash !== pins.genesisHash) fail('manifest_network');
  if (broadcast !== true) return { dryRun: true, txid: signed.tx.txid, manifest: signed };
  if (!path.isAbsolute(journalPath || '')) fail('journal_absolute_required');
  const serialized = JSON.stringify(Object.fromEntries(Object.entries(signed.intent).sort(([a], [b]) => a.localeCompare(b)))), taskRef = 'wallet:' + pins.genesisHash + ':' + signed.tx.from + ':' + signed.tx.nonce;
  const journal = new PaymentIntentJournal({ file: journalPath, genesisHash: pins.genesisHash, now });
  await journal.prepare({ taskRef, sender: signed.tx.from, recipient: signed.tx.to, amount: signed.intent.amount, evidence: { accepted: true, ref: taskRef, sha256: hash(serialized) } }, signed.tx);
  const state = await readWalletState({ address: signed.tx.from, network: pins, fetchFn, now });
  if (!state.pendingComplete) fail('full_mempool_required');
  const record = await journal.reconcile(taskRef, state.observation);
  if (record.state === 'confirmed' || record.state === 'submitted') return { record, broadcast: false };
  return journal.submit(taskRef, async tx => { await api(pins, '/tx', { fetchFn, method: 'POST', body: tx }); return { confirmation: false }; }, { dryRun: false });
}
export async function runWalletCLI(args, { stdin = process.stdin, fetchFn = fetch } = {}) {
  const [command, ...flags] = args, o = {};
  for (let n = 0; n < flags.length; n++) { const flag = flags[n]; if (!/^--(intent|signed|profile|network|journal|broadcast)$/.test(flag) || flag in o) fail('arguments'); o[flag] = flag === '--broadcast' ? true : flags[++n]; if (!o[flag]) fail('arguments'); }
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  if (command === 'sign') {
    let text = ''; for await (const chunk of stdin) { text += chunk; if (Buffer.byteLength(text) > 4096) fail('stdin_limit'); }
    let input; try { input = JSON.parse(text); } catch { fail('secret_json_stdin'); }
    keys(input, ['password']);
    return signWalletTransfer({ intent: await read(o['--intent']), profilePath: o['--profile'], password: input.password, network: await read(o['--network']) });
  }
  const network = await read(o['--network']);
  if (command === 'prepare') {
    const intent = validateWalletIntent(await read(o['--intent']));
    const prepared = await prepareWalletTransfer({ profilePath: o['--profile'], network, recipient: intent.to, amount: intent.amount, nonce: intent.nonce, ts: intent.createdAt, memo: intent.memo });
    if (prepared.from !== intent.from || prepared.genesisHash !== intent.genesisHash) fail('intent_profile_or_network');
    return prepared;
  }
  if (command === 'state') return readWalletState({ profilePath: o['--profile'], network, fetchFn });
  if (command === 'broadcast') return broadcastWalletTransfer({ manifest: await read(o['--signed']), network, journalPath: o['--journal'], broadcast: o['--broadcast'], fetchFn });
  fail('usage_prepare_sign_state_broadcast');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runWalletCLI(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
