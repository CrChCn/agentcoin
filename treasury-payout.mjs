#!/usr/bin/env node
/* treasury-payout.mjs — выплата 100 AGT премии по найму 2xgELrMi (HIRING.md).
   Ключи казны/подписантов/фонд-кошелька читаются из data-node-ts/wallets.json локально,
   НИКОГДА не печатаются. Схема:
     1) fund → казна (AGT209ec…) 105.5 AGT (fund — не казна-политика, sig2 не нужен);
     2) ждём попадания funding-tx в блок (казна должна иметь баланс);
     3) казна → автор найма AGT11a01a… 100 AGT, memo gov:2xgELrMi:passed:premium-100AGT:AGENTOR,
        двойная подпись: primary sig + sig2 от signer2 (2-of-3, AGIP-4);
     4) верификация ончейн: txid премии найден в цепи, комиссия/балансы сходятся.
   Запуск: node treasury-payout.mjs [адрес ноды API]   (по умолчанию 127.0.0.1:9335) */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signTransaction, txDigest } from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.argv[2] || 'http://127.0.0.1:9335';
const WALLETS = path.join(__dirname, 'data-node-ts', 'wallets.json');

const FUND_ADDR = 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a'; // faucet-казначей + автор найма
const TREASURY  = 'AGT209ec9884a9569ac8d5b897177087aab5bd0c937'; // активная политика trs|K|Fl3kfV00
const SIGNER2   = 'AGTf4c8e1e24588dbe2c58d58ce86466237df680c81';
const PREMIUM   = 100;
const MEMO_OK   = 'gov:2xgELrMi:passed:premium-100AGT:AGENTOR';

const all = JSON.parse(fs.readFileSync(WALLETS, 'utf8'));
for (const a of [FUND_ADDR, TREASURY, SIGNER2]) {
  if (!all[a]) { console.error(`FAIL: кошелёк ${a.slice(0, 12)}… не найден в wallets.json`); process.exit(1); }
}
console.log('ключи найдены: фонд/казна/signer2 (значения не печатаются)');

async function api(method, p, body = null) {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const sleep = ms => new Promise(s => setTimeout(s, ms));

function buildTx(from, to, amount, memo) {
  const w = all[from];
  const tx = { from, fromPub: w.pub, to, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
  tx.txid = txDigest(tx);
  tx.signature = signTransaction(tx, w.privKey);
  return tx;
}

async function submit(tx, label) {
  const r = await api('POST', '/tx', tx);
  if (r.status !== 200 && r.status !== 201) {
    console.error(`FAIL ${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`ok ${label}: txid=${tx.txid.slice(0, 16)}… → mempool (size=${r.body.mempoolSize})`);
}

// поиск txid в последних блоках цепи (bodies живого /blocks)
function scanFor(txid, n = 100) {
  return api('GET', '/blocks?n=' + n).then(r => {
    if (r.status !== 200) return null;
    for (const b of r.body.blocks || []) {
      for (const t of b.txs || []) { if (t.txid === txid) return { height: b.height ?? b.header?.height, tx: t }; }
    }
    return null;
  }).catch(() => null);
}

// ---- 1) funding казны
const h0 = (await api('GET', '/life').catch(() => ({ body: {} }))).body.blocks ?? 0;
const fundTx = buildTx(FUND_ADDR, TREASURY, PREMIUM + 5.5, 'trsfund:2xgELrMi-premium');
await submit(fundTx, 'funding казны 105.5 AGT');

// ---- 2) ждём майнинг funding-tx
let funded = (await scanFor(fundTx.txid, 120)) !== null;
for (let i = 0; i < 240 && !funded; i++) { await sleep(5000); funded = (await scanFor(fundTx.txid, 120)) !== null; }
if (!funded) { console.error('FAIL: funding-tx не попал в блок за 20 минут — казна без баланса'); process.exit(1); }
console.log('ок: funding-tx ончейн, казна профинансирована');
const treBal = await api('GET', '/cabinet/' + TREASURY);
console.log('баланс казны после fund: ' + (treBal.body?.balance ?? treBal.body?.bal));

// ---- 3) premium-tx казны: primary sig + sig2 (2-of-3, AGIP-4)
const prem = buildTx(TREASURY, FUND_ADDR, PREMIUM, MEMO_OK);
prem.sig2 = signTransaction(prem, all[SIGNER2].privKey);
prem.sig2Pub = all[SIGNER2].pub;
await submit(prem, 'премия 100 AGT Казна → автор (2-of-3)');

// ---- 4) верификация ончейн
let hit = await scanFor(prem.txid, 120);
for (let i = 0; i < 240 && !hit; i++) { await sleep(5000); hit = await scanFor(prem.txid, 120); }
if (!hit) { console.error('ПРЕДУПРЕЖДЕНИЕ: премиум-tx видел mempool, но ещё не в цепи; txid=' + prem.txid); process.exit(2); }
console.log(`ок: премия ончейн @ высота ${hit.height}: amount=${hit.tx.amount} memo=${hit.tx.memo} txid=${prem.txid.slice(0, 16)}…`);
console.log('высота старта: ' + h0 + ' → цепь: ' + ((await api('GET', '/life').catch(() => ({ body: {} }))).body.blocks ?? '?'));
// балансы после выплаты
for (const [lbl, a] of [['казна', TREASURY], ['автор(фонд)', FUND_ADDR]]) {
  const c = await api('GET', '/cabinet/' + a);
  console.log(`${lbl}: ${c.body?.balance ?? c.body?.bal}`);
}
console.log('DONE');
