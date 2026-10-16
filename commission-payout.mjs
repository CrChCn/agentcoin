#!/usr/bin/env node
/* commission-payout.mjs — выплата по 10 AGT агентам комиссии AGIP-7 (2026-10-16).
   Кошельки членов комиссии: data-agents/commission-2026-10-16.json (ключи не печатаются).
   Плательщик — фондовый кошелёк (faucet-казначей, AGT11a01a…): sig2 не требуется.
   Запуск: node commission-payout.mjs [адрес ноды API] */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signTransaction, txDigest } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.argv[2] || 'http://127.0.0.1:9335';
const FUND = 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a';
const WALLETS = path.join(__dirname, 'data-node-ts', 'wallets.json');
const COMM = path.join(__dirname, 'data-agents', 'commission-2026-10-16.json');

const all = JSON.parse(fs.readFileSync(WALLETS, 'utf8'));
const comm = JSON.parse(fs.readFileSync(COMM, 'utf8')).members;
if (!all[FUND]) { console.error('FAIL: фондовый кошелёк не найден'); process.exit(1); }

async function api(method, p, body = null) {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const sleep = ms => new Promise(s => setTimeout(s, ms));

function buildTx(to, amount, memo) {
  const w = all[FUND];
  const tx = { from: FUND, fromPub: w.pub, to, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
  tx.txid = txDigest(tx);
  tx.signature = signTransaction(tx, w.privKey);
  return tx;
}

async function scanFor(txid, n = 150) {
  const r = await api('GET', '/blocks?n=' + n);
  if (r.status !== 200) return null;
  for (const b of r.body.blocks || []) {
    for (const t of b.txs || []) if (t.txid === txid) return { height: b.height, tx: t };
  }
  return null;
}

const txids = [];
for (const m of comm) {
  const tx = buildTx(m.address, 10, `hire:audit-commission:AGIP-7:2026-10-16:10AGT:${m.role}`);
  const r = await api('POST', '/tx', tx);
  if (r.status !== 200 && r.status !== 201) {
    console.error(`FAIL ${m.role}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    process.exit(1);
  }
  console.log(`ok ${m.role}: ${m.address.slice(0, 14)}… ← 10 AGT, txid=${tx.txid.slice(0, 16)}…`);
  txids.push(tx.txid);
}

// верификация ончейн: ждём попадания обоих tx в блоки
for (let i = 0; i < 240; i++) {
  const hits = await Promise.all(txids.map(id => scanFor(id, 150)));
  if (hits.every(Boolean)) {
    hits.forEach((h, i) => console.log(`ончейн @${h.height}: memo=${h.tx.memo} amount=${h.tx.amount} txid=${txids[i].slice(0, 16)}…`));
    console.log('DONE');
    process.exit(0);
  }
  await sleep(5000);
}
console.error('ПРЕДУПРЕЖДЕНИЕ: payout-tx не в цепи за 20 мин: ' + txids.join(','));
process.exit(2);
