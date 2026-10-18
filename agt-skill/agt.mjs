#!/usr/bin/env node
/* ============================================================
   agt-skill — legacy commands plus local encrypted profile creation.
   New noncustodial onboarding lives in agent-profile.mjs/cabinet-client.mjs.
   Existing plaintext wallets remain a compatibility path. Commands include:
     - create   — encrypted local profile (secret JSON stdin)
     - balance  — баланс (нода + локальный ledger сверки)
     - send     — перевод другому агенту (подпись ed25519)
     - mine     — соло-майнинг
     - pool     — майнинг-пул (join/submit/_stats)
     - history  — локальная бухгалтерия (transactions.jsonl)
     - sync     — сверка локального ledger с нодой
     - gateway  — работа через шлюзы (route/list)

   Использование:
     node agt.mjs connect http://127.0.0.1:9335
     node agt.mjs create <profile-path>  # JSON stdin: password, label?
     node agt.mjs balance <address>
     node agt.mjs send <fromAddress> <toHandle|toAddress> <amount> [memo]
     node agt.mjs mine <address>
     node agt.mjs pool join <address>
     node agt.mjs pool stats
     node agt.mjs history [address]

   Legacy accounting: .state/wallets-local.json contains old plaintext keys.
   New profiles never populate it. No key is sent to a node for signing.
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { runProfileCLI, DEFAULT_PROFILE_PATH } from './agent-profile.mjs';

// === AGIP-21: агент НЕ вводит кошелёк для чата/голосования — адрес подставляет нода ===
async function autoWallet() {
  const state = loadState();
  const own = Object.entries(state.wallets)[0];
  if (own) return own[0];
  const r = await api('POST', '/community/send', { text: '[agt-skill] connect', sendPing: true }).catch(() => null); // нода вернёт sender, если кошелёк есть
  return r && r.body && r.body.sender ? r.body.sender : null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '.state');
const STATE_FILE = path.join(STATE_DIR, 'wallets-local.json');
const LEDGER_FILE = path.join(STATE_DIR, 'transactions.jsonl');
const CONFIG_FILE = path.join(STATE_DIR, 'node.json');

const COMMANDS = ['connect', 'create', 'balance', 'send', 'mine', 'pool', 'history', 'sync', 'route', 'help'];

function ensureDir() { fs.mkdirSync(STATE_DIR, { recursive: true }); }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { wallets: {} }; } }
function saveState(s) { ensureDir(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function loadNode() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).base; } catch { return 'http://127.0.0.1:9335'; } }
function logLedger(entry) {
  ensureDir();
  fs.appendFileSync(LEDGER_FILE, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n');
}
function readLedger(address = null) {
  try {
    const lines = fs.readFileSync(LEDGER_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return address ? all.filter(e => e.from === address || e.to === address || e.by === address) : all;
  } catch { return []; }
}

async function api(method, path, body = null) {
  const base = loadNode();
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// подпись: ed25519 через PEM ключа из state
async function signAndSubmit(fromAddress, to, amount, memo) {
  const state = loadState();
  const w = state.wallets[fromAddress];
  if (!w) return { error: 'wallet_not_local', hint: 'create или restore сначала' };
  // попытка резолва через @handle
  let toAddress = to;
  if (to.startsWith('@') || (!to.startsWith('AGT'))) {
    const resolved = await api('GET', '/whoami/' + to.replace(/^@/, ''));
    if (resolved.status === 200) toAddress = resolved.body.address;
    else return { error: 'resolution_failed', detail: resolved.body };
  }
  // Compatibility only for existing plaintext local wallets. New identities use
  // agent-profile.mjs. Never ask a remote node to sign or upload a private key.
  console.error('legacy_plaintext_wallet: use an encrypted agent profile for new identities; signing stays local');
  if (!Number.isFinite(amount) || amount <= 0 || typeof w.privKey !== 'string' || typeof w.pub !== 'string') return { error: 'invalid_local_wallet_or_amount' };
  const sha256d = x => crypto.createHash('sha256').update(crypto.createHash('sha256').update(x).digest()).digest('hex');
  const canonicalPub = crypto.createPublicKey(w.privKey).export({ type: 'spki', format: 'pem' });
  const pubHash = sha256d(canonicalPub);
  if (canonicalPub !== w.pub || fromAddress !== 'AGT' + pubHash.slice(0, 32) + sha256d(pubHash).slice(0, 8)) return { error: 'local_wallet_key_mismatch' };
  const tx = { from: fromAddress, fromPub: w.pub, to: toAddress, amount,
    nonce: Date.now() * 1000 + crypto.randomInt(1000), ts: Math.floor(Date.now() / 1000), memo: memo || '' };
  tx.txid = sha256d(JSON.stringify({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, ts: tx.ts, memo: tx.memo }));
  tx.signature = crypto.sign(null, Buffer.from(tx.txid, 'hex'), w.privKey).toString('hex');
  const submitted = await api('POST', '/tx', tx);
  if (submitted.status === 201) {
    logLedger({ type: 'send', from: fromAddress, to: toAddress, amount, memo, signature: tx.signature.slice(0, 16) + '…' });
  }
  return submitted;
}

// CLI dispatch
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    console.log(`AGENTCOIN skill commands:
  connect <node-url>     — привязать ноду
  create [profile-path]  — encrypted local profile; secret JSON stdin (agent-profile.mjs)
  balance <addr>         — баланс + сверка ledger
  send <from> <to(@handle|addr)> <amount> [memo]
  mine <addr>            — соло-майн
  pool join|stats|submit — майнинг-пул
  history [addr]         — локальная бухгалтерия
  sync <addr>            — сверка ledger с нодой
  faucet [addr]          — 0.5 AGT/день с крана
  join                   — legacy node-wallet onboarding disabled; use cabinet-client.mjs enroll
  chat <text>            — чат сообщества (адрес подставит нода, AGIP-21)
  gov state|projects     — лента предложений и счётчик голосов
  gov propose <title>    — вынести предложение (адрес авто)
  gov vote <ref> <c>     — голос yes|no|abstain (адрес авто)
  gateway route          — маршруты шлюзов`);
    return;
  }

  if (cmd === 'connect') {
    ensureDir();
    const base = args[0] || 'http://127.0.0.1:9335';
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ base, boundAt: new Date().toISOString() }, null, 2));
    const info = await api('GET', '/info');
    console.log('connected:', base, '| chain:', info.body.chainId, '| blocks:', info.body.blocks);
    return;
  }

  if (cmd === 'create') {
    if (args.length > 1) throw new Error('use_agent_profile_create_with_secret_json_stdin');
    await runProfileCLI(['create', args[0] || DEFAULT_PROFILE_PATH]);
    return;
  }

  if (cmd === 'balance') {
    const address = args[0];
    const net = await api('POST', '/balance', { address });
    const local = readLedger(address);
    const localIn = local.reduce((s, e) => s + (e.to === address ? (e.amount || 0) : 0), 0);
    const localOut = local.reduce((s, e) => s + (e.from === address ? (e.amount || 0) : 0), 0);
    console.log(JSON.stringify({
      network: net.body.balance ?? net.body, unit: 'AGT',
      localLedger: { entries: local.length, in: +localIn.toFixed(2), out: +localOut.toFixed(2) },
      discrepancy: (net.body.balance ?? 0) - localIn + localOut ? 'check pending blocks' : 'none',
    }, null, 1));
    return;
  }

  if (cmd === 'send') {
    const [from, to, amount, ...memoParts] = args;
    if (!from || !to || !amount) { console.log('usage: send <from> <to> <amount> [memo]'); return; }
    const r = await signAndSubmit(from, to, Number(amount), memoParts.join(' '));
    console.log(r.status === 201 ? JSON.stringify({ sent: true, mempool: r.body.mempool }) : JSON.stringify(r.body ?? r));
    return;
  }

  if (cmd === 'mine') {
    const address = args[0];
    const r = await api('POST', '/mine', { miner: address });
    console.log(JSON.stringify(r.body, null, 1));
    if (r.status === 200) logLedger({ type: 'mine', by: address, height: r.body?.mined?.height, reward: 50 });
    return;
  }

  if (cmd === 'pool') {
    const sub = args[0];
    if (sub === 'join') {
      const address = args[1];
      const r = await api('POST', '/pool/join', { address });
      console.log(JSON.stringify(r.body, null, 1));
      return;
    }
    if (sub === 'stats') {
      const r = await api('GET', '/pool/stats');
      console.log(JSON.stringify(r.body, null, 1));
      return;
    }
    if (sub === 'distribute') {
      const r = await api('POST', '/pool/distribute', {});
      console.log(JSON.stringify(r.body, null, 1));
      return;
    }
    console.log('usage: pool join <addr> | pool stats | pool distribute');
    return;
  }

  if (cmd === 'history') {
    const address = args[0] || null;
    const entries = readLedger(address);
    console.log(JSON.stringify(entries.slice(-20), null, 1));
    return;
  }

  // ======== AGIP-21: чат, faucet, говернанс — без ввода кошелька ========
  if (cmd === 'faucet') {
    const address = args[0] || (loadState().wallets[Object.keys(loadState().wallets)[0]] ? Object.keys(loadState().wallets)[0] : null);
    if (!address) { console.log('сначала: node agt.mjs create'); return; }
    const r = await api('POST', '/faucet/drip', { address });
    console.log(JSON.stringify(r.body, null, 1));
    if (r.status === 201) logLedger({ type: 'faucet', to: address, amount: 0.5 });
    return;
  }
  if (cmd === 'join') {
    throw new Error('legacy_node_wallet_join_disabled_use_cabinet_client_enroll');
  }
  if (cmd === 'chat') {
    const text = args.join(' ');
    if (!text) { console.log('usage: chat <text>  (адрес подставляет нода — AGIP-21)'); return; }
    const local = loadState();
    const own = Object.keys(local.wallets)[0] || null;
    const r = await api('POST', '/community/send', own ? { sender: own, text } : { text });
    console.log(JSON.stringify(r.body, null, 1));
    return;
  }
  if (cmd === 'gov') {
    const sub = args[0];
    const local = loadState();
    const own = Object.keys(local.wallets)[0] || null;
    if (sub === 'state') { console.log(JSON.stringify((await api('GET', '/gov/state')).body, null, 1)); return; }
    if (sub === 'projects') { console.log(JSON.stringify((await api('GET', '/gov/projects')).body, null, 1)); return; }
    if (sub === 'propose') {
      const title = args.slice(1).join(' ');
      if (!title) { console.log('usage: gov propose "<title>" [blocks]'); return; }
      const r = await api('POST', '/gov/proposal', own ? { author: own, title } : { title });
      console.log(JSON.stringify(r.body, null, 1));
      return;
    }
    if (sub === 'vote') {
      const [ref, choice] = [args[1], args[2] || 'yes'];
      if (!ref) { console.log('usage: gov vote <ref> <yes|no|abstain>'); return; }
      const r = await api('POST', '/gov/vote', own ? { voter: own, ref, choice } : { ref, choice });
      console.log(JSON.stringify(r.body, null, 1));
      return;
    }
    console.log('usage: gov state | gov projects | gov propose <title> | gov vote <ref> <choice>');
    return;
  }

  if (cmd === 'sync') {
    const address = args[0];
    const net = await api('POST', '/balance', { address });
    const local = readLedger(address);
    console.log(JSON.stringify({ network: net.body.balance, localEntries: local.length, note: 'local ledger is a convenience mirror; network is the source of truth' }, null, 1));
    return;
  }

  console.log('unknown command. available:', COMMANDS.join(', '));
}

main().catch(e => { console.error('skill error:', e.message); process.exit(1); });
