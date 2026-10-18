#!/usr/bin/env node
/* node-grants.mjs — программа грантов внешним нодам (10 AGT/нед) с Sybil-защитой.
   Правила (AGIP-8/СЦ-6):
     1) 1 кошель = 1 активный грант (реестр data-agents/node-grants.json, gitignored);
     2) повторная выплата тому же кошелю — не раньше 7 дней (импульс дозревания);
     3) кап 200 активных грантов (бездонной казне не бываем) — до предела казны:
        бюджет = treasury (Fund) 63.8k, программы грантов составляют до 2% казны в год;
     4) каждая выплата — ончейн tx с memo `grant:<peerRef>:<weekIdx>` — прозрачна всем;
     5) форма заявки — через job-borad (escrow/open) или чат-канал, регистрируется вручную оператором.
   Запуск: node node-grants.mjs check-ledger | grant <addr> <peerRef> [неделя]
   Exit-коды: 0 ок, 1 отказ (причина в stderr). Ключи плательщика — data-node-ts/wallets.json (не печатаются). */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signTransaction, txDigest } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(__dirname, 'data-agents', 'node-grants.json');
const WALLETS = path.join(__dirname, 'data-node-ts', 'wallets.json');
const API = process.env.AGT_API || 'http://127.0.0.1:9335';
const FUND = 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a';
const AMOUNT_PER_WEEK = 10;
const CAP_ACTIVE = 200;
const WEEK_MS = 7 * 24 * 3600 * 1000;

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { grants: {} }; }
}
function saveLedger(l) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}

function checkLedger() {
  const l = loadLedger();
  const addrs = Object.keys(l.grants);
  const now = Date.now();
  const active = addrs.filter(a => now - (l.grants[a].lastPaidAt || 0) < WEEK_MS);
  console.log(`реестр: ${addrs.length} кошелей, активных грантов ${active.length}/${CAP_ACTIVE}`);
  for (const a of addrs) {
    const g = l.grants[a];
    console.log(`  ${a.slice(0, 14)}… peer=${g.peerRef} paid=${g.totalPaid} last=${g.lastPaidAt ? new Date(g.lastPaidAt).toISOString().slice(0, 10) : '-'}`);
  }
  return l;
}

async function grant(addr, peerRef) {
  const addrRe = /^AGT[0-9a-f]{40}$/;
  if (!addrRe.test(addr)) { console.error('FAIL: некорректный AGT-адрес'); process.exit(1); }
  const l = loadLedger();
  const g = l.grants[addr];
  const now = Date.now();
  if (g && now - (g.lastPaidAt || 0) < WEEK_MS - 3600e3) {
    console.error(`FAIL: кошель ${addr.slice(0, 14)}… уже получал грант ${Math.round((now - g.lastPaidAt) / 86400e3)} дн назад (норма: раз в неделю) — Sybil-защита`);
    process.exit(1);
  }
  const actives = Object.values(l.grants).filter(x => now - (x.lastPaidAt || 0) < WEEK_MS).length;
  if (actives >= CAP_ACTIVE) { console.error(`FAIL: кап активных грантов ${CAP_ACTIVE} достигнут`); process.exit(1); }

  const all = JSON.parse(fs.readFileSync(WALLETS, 'utf8'));
  const w = all[FUND];
  if (!w) { console.error('FAIL: ключ фонда не найден'); process.exit(1); }
  const tx = { from: FUND, fromPub: w.pub, to: addr, amount: AMOUNT_PER_WEEK, nonce: Date.now(), ts: Math.floor(now / 1000), memo: `grant:${peerRef || 'node'}:w${Math.floor(now / WEEK_MS)}` };
  tx.txid = txDigest(tx);
  tx.signature = signTransaction(tx, w.privKey);

  const r = await fetch(API + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tx) });
  if (r.status !== 200 && r.status !== 201) { console.error('FAIL: нода отказала: ' + r.status + ' ' + JSON.stringify(await r.json().catch(() => ({})))); process.exit(1); }
  l.grants[addr] = Object.assign(g || { peerRef: peerRef || 'node' }, { 
    peerRef: peerRef || (g?.peerRef || 'node'),
    lastPaidAt: now, lastTxid: tx.txid.slice(0, 16),
    totalPaid: (g?.totalPaid || 0) + AMOUNT_PER_WEEK,
  });
  saveLedger(l);
  console.log(`ok: выплачен грант ${AMOUNT_PER_WEEK} AGT на ${addr.slice(0, 14)}… txid=${tx.txid.slice(0, 16)}… peer=${l.grants[addr].peerRef}`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'check-ledger') checkLedger();
else if (cmd === 'grant') grant(a, b);
else {
  console.error('usage: node node-grants.mjs check-ledger | grant <addr> <peerRef>');
  process.exit(1);
}
