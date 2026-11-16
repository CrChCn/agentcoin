#!/usr/bin/env node
// Найм внешних агентов: полный круг escrowopen → claim → work → payout.
// Ключи — свежие одноразовые, только в os.tmpdir(), в репо и логи не пишутся.
// Env: HI_DIR (состояние), HI_AMOUNT, HI_TASK (текст задачи), HI_WORK (текст артефакта;
//   если пуст — живой курс BTC/USD), HI_FRESH_WORKER=1 (новый воркер),
//   HI_STOP_AFTER_WORK=1 (пауза перед payout для ручной приёмки),
//   HI_PAYOUT_ONLY=1 (только payout+fee+verify по сохранённому состоянию).
//   node tools/hire-first-external.mjs [nodeUrl]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addressFromPub, signTransaction, txDigest, sha256d, escrowReceiptDigest, ESCROW_PREFIX } from '../core.mjs';

const NODE = process.argv[2] || 'https://agentcoin.work';
const DIR = path.join(os.tmpdir(), process.env.HI_DIR || 'agt-first-hire');
const KF = path.join(DIR, 'keys.json');
const FEE_ADDR = 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a';
const AMOUNT = Number(process.env.HI_AMOUNT || 0.4);
const FEE = Math.round(AMOUNT * 0.025 * 10000) / 10000;
const SEED = 0.05;
const TASK_TEXT = process.env.HI_TASK || 'ext-job-1: живой курс BTC/USD (CoinGecko) + sha256-артефакт в цепь';
const WORK_TEXT = process.env.HI_WORK || '';

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
    k = { employer: freshKey('employer-ext'), worker: freshKey('worker-ext') };
    saveKeys(k);
    log('ключи созданы (только tmpdir)');
  }
  if (process.env.HI_FRESH_WORKER === '1' && !k.freshDone) {
    k.worker = freshKey('worker-ext-2');
    k.freshDone = true;
    saveKeys(k);
    log('воркер заменён на свежего (второй найм — новый исполнитель)');
  }
  const E = k.employer, W = k.worker;
  log(`employer=${E.address} worker=${W.address}`);

  const bal = async a => (await api('/balance', { address: a })).body.balance ?? 0;

  if (process.env.HI_PAYOUT_ONLY === '1') {
    if (!k.run) die('нет сохранённого состояния для payout');
    const { escId, taskHash } = k.run;
    const W2 = W;
    const digest = escrowReceiptDigest(escId, taskHash, W2.address, AMOUNT);
    const workerReceipt = crypto.sign(null, Buffer.from(digest, 'hex'), W2.priv).toString('hex');
    const pay = await api('/escrow/payout', { escId, employerPrivKey: E.priv, workerReceiptSig: workerReceipt, workerPub: W2.pub });
    if (pay.status !== 201 && !pay.body.payoutPrepared) die('payout: ' + pay.status + ' ' + JSON.stringify(pay.body));
    log(`payout в мемпуле: txid=${pay.body.txid} (ждём блок)`);
    await sendNow(E, FEE_ADDR, FEE, `escfee:${escId}`);
    log(`комиссия казне ${FEE} отправлена`);
    const fin = await waitMined(async () => {
      const st = await api('/escrow/state?fresh=1');
      return (st.body.escrows || []).find(x => x.escId === escId && (x.status === 'paid' || x.status === 'partial'));
    }, 60);
    console.log(JSON.stringify({ ok: Boolean(fin && fin.status === 'paid'), escId, escrow: fin ? { status: fin.status, paidOut: fin.paidOut } : null, balances: { worker: await bal(W2.address), employer: await bal(E.address) } }, null, 1));
    if (!fin || fin.status !== 'paid') die('не оплачено');
    log('КРУГ ЗАМКНУТ');
    return;
  }

  let bE = await bal(E.address);
  const bW = await bal(W.address);
  log(`балансы: employer=${bE} worker=${bW}`);
  if (bE < AMOUNT + FEE + (bW < 0.01 ? SEED : 0) + 0.01) {
    console.log(JSON.stringify({ needFunding: true, employer: E.address, need: AMOUNT + FEE + SEED + 0.01 }, null, 1));
    die('нужно пополнить employer (см. needFunding выше)');
  }
  if (bW < 0.01) {
    await sendNow(E, W.address, SEED, 'seed:gas-external');
    log(`газ воркеру: ${SEED} (ждём блок)`);
    await waitMined(async () => (await bal(W.address)) >= 0.01);
  }

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

  const digest = escrowReceiptDigest(escId, taskHash, W.address, AMOUNT);
  const workerReceipt = crypto.sign(null, Buffer.from(digest, 'hex'), W.priv).toString('hex');
  log('квитанция работника подписана локально');

  let artifact, artifactHash;
  if (WORK_TEXT) {
    artifact = WORK_TEXT.slice(0, 90);
    artifactHash = sha256d(artifact);
  } else {
    const cg = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { headers: { 'user-agent': 'AGT-external-worker/1' }, signal: AbortSignal.timeout(15000) });
    if (!cg.ok) die('CoinGecko HTTP ' + cg.status);
    const price = (await cg.json()).bitcoin.usd;
    artifact = `BTCUSD=${price}@` + new Date().toISOString();
    artifactHash = sha256d(artifact);
  }
  await sendNow(W, E.address, 0.001, ('job-artifact:' + artifactHash.slice(0, 32) + ' ' + artifact).slice(0, 120));
  log(`артефакт опубликован: ${artifact} hash=${artifactHash.slice(0, 16)}`);
  k.run = { escId, taskHash, artifact, artifactHash };
  saveKeys(k);

  if (process.env.HI_STOP_AFTER_WORK === '1') {
    console.log(JSON.stringify({ paused: true, escId, taskHash, artifact, note: 'приёмка вручную → затем HI_PAYOUT_ONLY=1' }, null, 1));
    log('ПАУЗА: работа сдана, payout после ручной приёмки');
    return;
  }

  const pay = await api('/escrow/payout', { escId, employerPrivKey: E.priv, workerReceiptSig: workerReceipt, workerPub: W.pub });
  if (pay.status !== 201 && !pay.body.payoutPrepared) die('payout: ' + pay.status + ' ' + JSON.stringify(pay.body));
  log(`payout в мемпуле: txid=${pay.body.txid} (ждём блок)`);
  await sendNow(E, FEE_ADDR, FEE, `escfee:${escId}`);
  log(`комиссия казне ${FEE} отправлена`);
  const fin = await waitMined(async () => {
    const st = await api('/escrow/state?fresh=1');
    return (st.body.escrows || []).find(x => x.escId === escId && (x.status === 'paid' || x.status === 'partial'));
  }, 60);
  console.log(JSON.stringify({
    ok: Boolean(fin && fin.status === 'paid'), escId, amount: AMOUNT, artifact,
    escrow: fin ? { status: fin.status, paidOut: fin.paidOut } : null,
    balances: { worker: await bal(W.address), employer: await bal(E.address) },
  }, null, 1));
  if (!fin || fin.status !== 'paid') die('не оплачено');
  log('КРУГ ЗАМКНУТ');
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
