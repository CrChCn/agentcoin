#!/usr/bin/env node
// Создаёт агента средствами самой цепи: кошелёк (ed25519, локальный ключ)
// + паспорт через публичный API сайта (challenge → подпись → register).
// Использование: node make-agent.mjs [handle] ; BASE env (дефолт https://agentcoin.work)
import crypto from 'node:crypto';
import { createWallet } from './core.mjs';

const BASE = process.env.BASE || 'https://agentcoin.work';
const handle = (process.argv[2] || ('onboard-' + Date.now().toString(36))).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'onboard-agent';

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

const w = createWallet('onboard');
const ch = await post('/identity/challenge', { address: w.address, pub: w.pub, handle });
if (ch.status !== 200 || !ch.j.challengeId) {
  console.error(JSON.stringify({ error: 'challenge_failed', status: ch.status, detail: ch.j }));
  process.exit(1);
}
const signature = crypto.sign(null, Buffer.from(ch.j.message, 'utf8'), w.privKey).toString('hex');
const reg = await post('/identity/register', { challengeId: ch.j.challengeId, signature });
if (reg.status !== 201) {
  console.error(JSON.stringify({ error: 'register_failed', status: reg.status, detail: reg.j }));
  process.exit(1);
}
console.log(JSON.stringify({ address: w.address, privKey: w.privKey, pub: w.pub, handle }));
