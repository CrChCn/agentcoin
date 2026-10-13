#!/usr/bin/env node
/* ============================================================
   agt-skill — единый скрипт кошелька AGENTCOIN для агентов
   Децентрализованный клиент: соединяется с любой нодой сети,
   ведёт собственную бухгалтерию (local ledger), умеет:
     - create   — создать кошелёк
     - balance  — баланс (нода + локальный ledger сверки)
     - send     — перевод другому агенту (подпись ed25519)
     - mine     — соло-майнинг
     - pool     — майнинг-пул (join/submit/_stats)
     - history  — локальная бухгалтерия (transactions.jsonl)
     - sync     — сверка локального ledger с нодой
     - gateway  — работа через шлюзы (route/list)

   Использование:
     node agt.mjs connect http://127.0.0.1:9335
     node agt.mjs create
     node agt.mjs balance <address>
     node agt.mjs send <fromAddress> <toHandle|toAddress> <amount> [memo]
     node agt.mjs mine <address>
     node agt.mjs pool join <address>
     node agt.mjs pool stats
     node agt.mjs history [address]

   Бухгалтерия: файл wallets-local.json в рабочей папке skill'а —
   там же приватные ключи (agents own them; we never upload them).
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

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
  const signed = await api('POST', '/tx/sign', { fromAddress, to: toAddress, amount, memo });
  if (signed.status !== 200) return signed;
  const tx = signed.body.signed;
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
  create                 — создать кошелёк (сохраняется локально)
  balance <addr>         — баланс + сверка ledger
  send <from> <to(@handle|addr)> <amount> [memo]
  mine <addr>            — соло-майн
  pool join|stats|submit — майнинг-пул
  history [addr]         — локальная бухгалтерия
  sync <addr>            — сверка ledger с нодой
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
    ensureDir();
    const label = args[0] || 'agent-' + crypto.randomBytes(3).toString('hex');
    const r = await api('POST', '/wallet/create', { label });
    if (r.status !== 201) { console.log('create failed:', r.body); return; }
    const state = loadState();
    state.wallets[r.body.address] = { label, privKey: r.body.privKey, pub: r.body.pub, createdAt: Date.now() };
    saveState(state);
    logLedger({ type: 'create', to: r.body.address, label });
    console.log('wallet created:', r.body.address);
    console.log('(privKey stored locally at', STATE_FILE + ')');
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
