#!/usr/bin/env node
// Первый найм внешнего агента (2026-11-16): полный круг escrowopen → claim → work → payout.
// Ключи — свежие одноразовые, только в os.tmpdir(), в репо и логи не пишутся.
// Финансирование: один перевод пользователя на employer (~1 AGT); дальше всё само:
// employer сеет газ воркеру, открывает эскроу 0.4, платит комиссию казне.
//   node tools/hire-first-external.mjs [nodeUrl]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addressFromPub, signTransaction, txDigest, sha256d, escrowReceiptDigest, ESCROW_PREFIX } from '../core.mjs';

const NODE = process.argv[2] || 'https://agentcoin.work';
const DIR = path.join(os.tmpdir(), 'agt-first-hire');
const KF = path.join(DIR, 'keys.json');
const FEE_ADDR = 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a';
const AMOUNT = 0.4, FEE = 0.01, SEED = 0.05;
const TASK_TEXT = 'ext-job-1: живой курс BTC/USD (CoinGecko) + sha256-артефакт в цепь';

const log = m => console.log('•', m);
const die = m => { console.error('FAIL:', m); process.exit(1); };
const api = (p, body) => fetch(NODE + p, {
  method: body ? 'POST' : 'GET',
  headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(20000),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freshKey(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  return { label, address: addressFromPub(pub), pub, priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
function loadKeys() {
  try { return JSON.parse(fs.readFileSync(KF, 'utf8')); } catch { return null; }
}
function saveKeys(k) { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(KF, JSON.stringify(k), { mode: 0o600 }); }

async function waitMined(check, tries = 40) {
  for (let i = 0; i < tries; i++) { const r = await check(); if (r) return r; await sleep(15000); }
  return null;
}
async function sendNow(K, to, amount, memo) {
  const tx = {
    from: K.address, fromPub: K.pub, to, amount,
    nonce: Date.now() * 1000 + Math.floor(Math.random() * 999), ts: Math.floor(Date.now() / 1000), memo,
  };
  tx.signature = signTransaction(tx, K.priv);
  const r = await api('/tx', tx);
  if (!(r.body.accepted || r.body.ok || r.status === 201)) die('tx rejected: ' + r.status + ' ' + JSON.stringify(r.body));
  return txDigest(tx);
}

async function main() {
  let k = loadKeys();
  if (!k) {
    k = { employer: freshKey('employer-first-ext'), worker: freshKey('worker-first-ext') };
    saveKeys(k);
    log('ключи созданы (только tmpdir)');
  }
  const E = k.employer, W = k.worker;
  log(`employer=${E.address} worker=${W.address}`);

  const bal = async a => (await api('/balance', { address: a })).body.balance ?? 0;
  let bE = await bal(E.address), bW = await bal(W.address);
  log(`балансы: employer=${bE} worker=${bW}`);
  // 0) ждём финансирование от пользователя (1 перевод ~1 AGT на employer)
  if (bE < AMOUNT + FEE + SEED + 0.01) {
    console.log(JSON.stringify({ needFunding: true, employer: E.address, worker: W.address, need: AMOUNT + FEE + SEED + 0.01 }, null, 1));
    die('ждём один перевод пользователя на employer (см. needFunding выше)');
  }
  // 1) employer сеет газ воркеру
  if (bW < 0.01) {
    await sendNow(E, W.address, SEED, 'seed:gas-first-external');
    log(`газ воркеру: ${SEED} (ждём блок)`);
    await waitMined(async () => (await bal(W.address)) >= 0.01);
  }

  // 2) escrow open (подпись работодателя — локально)
  const taskHash = sha256d(TASK_TEXT).slice(0, 32);
  const escId = crypto.randomBytes(10).toString('hex');
  const deadlineTs = Math.floor(Date.now() / 1000) + 48 * 3600;
  await sendNow(E, ESCROW_PREFIX + escId, AMOUNT, `escrow:${escId}:${taskHash}:${deadlineTs}:${W.address}`);
  log(`эскроу открыт: escId=${escId} (ждём блок)`);
  const opened = await waitMined(async () => {
    const st = await api('/escrow/state?fresh=1');
    return (st.body.escrows || []).find(x => x.escId === escId && x.status === 'open');
  });
  if (!opened) die('escrow не появился в цепи');
  log(`в цепи: open ${opened.openedAmount} AGT`);

  // 3) claim: квитанция работника — локальная подпись (ключ не в сети)
  const digest = escrowReceiptDigest(escId, taskHash, W.address, AMOUNT);
  const workerReceipt = crypto.sign(null, Buffer.from(digest, 'hex'), W.priv).toString('hex');
  log('квитанция работника подписана локально');

  // 4) work: реальный курс + артефакт в цепь
  const cg = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    { headers: { 'user-agent': 'AGT-external-worker/1' }, signal: AbortSignal.timeout(15000) });
  if (!cg.ok) die('CoinGecko HTTP ' + cg.status);
  const price = (await cg.json()).bitcoin.usd;
  const artifact = `BTCUSD=${price}@` + new Date().toISOString();
  const artifactHash = sha256d(artifact);
  await sendNow(W, E.address, 0.001, ('job-artifact:' + artifactHash.slice(0, 32) + ' BTCUSD=' + price).slice(0, 120));
  log(`артефакт опубликован: BTC/USD=${price} hash=${artifactHash.slice(0, 16)}`);

  // 5) payout через контрактный эндпоинт (ключ одноразовый, сумма мизерная)
  const pay = await api('/escrow/payout', { escId, employerPrivKey: E.priv, workerReceiptSig: workerReceipt, workerPub: W.pub });
  if (pay.status !== 201 && !pay.body.payoutPrepared) die('payout: ' + pay.status + ' ' + JSON.stringify(pay.body));
  log(`payout в мемпуле: txid=${pay.body.txid} (ждём блок)`);

  // 6) комиссия казне 2.5% — вручную (у работодателя нет node-кошелька, эндпоинт её пропустит)
  await sendNow(E, FEE_ADDR, FEE, `escfee:${escId}`);
  log('комиссия казне 0.01 отправлена');

  // 7) верификация
  const fin = await waitMined(async () => {
    const st = await api('/escrow/state?fresh=1');
    return (st.body.escrows || []).find(x => x.escId === escId && (x.status === 'paid' || x.status === 'partial'));
  }, 60);
  const balW = await bal(W.address), balE = await bal(E.address);
  console.log(JSON.stringify({
    ok: Boolean(fin && fin.status === 'paid'),
    escId, taskHash: taskHash.slice(0, 16), amount: AMOUNT, artifact: `BTC/USD=${price}`,
    escrow: fin ? { status: fin.status, paidOut: fin.paidOut } : null,
    balances: { worker: balW, employer: balE },
  }, null, 1));
  if (!fin || fin.status !== 'paid') die('не оплачено');
  log('КРУГ ЗАМКНУТ: первый внешний нанят и оплачен ончейн');
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
