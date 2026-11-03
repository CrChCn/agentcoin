#!/usr/bin/env node
// Внешний агент-работник (модель «ключ живёт у агента»): паспорт через публичные
// маршруты ноды, вход в кабинет, заявка на джоб (job-claim) и публикация артефакта.
// Приватный ключ создаётся ЛОКАЛЬНО и хранится вне репо (os.tmpdir()); ноде
// отправляются только pubkey и подписи — как настоящему внешнему агенту.
//
//   node tools/real-job-worker.mjs init [url]                — ключи + паспорт + вход в кабинет
//   node tools/real-job-worker.mjs whoami [url]              — показать адрес/паспорт/баланс
//   node tools/real-job-worker.mjs claim <escId> <taskHash> [url]  — дождаться эскроу и получить квитанцию
//   node tools/real-job-worker.mjs work [url]                — реальная работа: живой курс BTC/USD + sha256-артефакт
//   node tools/real-job-worker.mjs send <to> <amount> <memo> [url]  — публичная подпись и tx через кабинет
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { addressFromPub } from '../core.mjs';

const URL_DIR = path.join(os.tmpdir(), 'agt-external-worker');
const KEY_FILE = path.join(URL_DIR, 'worker-keys.json');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = process.argv.slice(2);
const [cmd = '', a1 = '', a2 = '', a3 = ''] = ALL.filter(x => !/^https?:\/\//.test(x));
const NODE = ALL.find(x => /^https?:\/\//.test(x)) || 'http://127.0.0.1:9335';

const api = (p, body = null, method = '') => fetch(NODE + p, {
  method: method || (body ? 'POST' : 'GET'),
  headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
  signal: AbortSignal.timeout(15000),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const die = m => { console.error('FAIL:', m); process.exit(1); };
const loadKeys = () => JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
const saveKeys = k => { fs.mkdirSync(URL_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(KEY_FILE, JSON.stringify(k, null, 2), { mode: 0o600 }); };
const signHex = (msg, privKey) => crypto.sign(null, Buffer.from(msg, 'utf8'), privKey).toString('hex');
const ensureKeys = () => {
  try { return loadKeys(); }
  catch {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    const k = { address: addressFromPub(pub), pub, privKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), handle: 'ext-' + crypto.randomBytes(3).toString('hex'), createdAt: Date.now() };
    saveKeys(k); return k;
  }
};

init();
async function init() {
  if (cmd === 'init') {
    const k = ensureKeys();
    const meta = await api('/identity/meta');
    if (!meta.body.ok) die('/identity/meta: ' + JSON.stringify(meta.body));
    const net = meta.body.network, aud = meta.body.audience, fp = meta.body.issuerFingerprint;
    if (!meta.body.enrollmentEnabled) die('enrollment disabled on this node');
    const ch = await api('/identity/challenge', { address: k.address, pub: k.pub, handle: k.handle });
    if (!ch.body.ok) die('challenge: ' + JSON.stringify(ch.body));
    // пины gensis/issuer/сети (как cabinet-client): подмена ноды отвергается
    if (ch.body.issuerFingerprint !== fp) die('issuer fingerprint pin mismatch');
    const sig = signHex(ch.body.message, k.privKey);
    const reg = await api('/identity/register', { challengeId: ch.body.challengeId, signature: sig });
    if (!reg.body.ok) die('register: ' + JSON.stringify(reg.body));
    console.log('OK паспорт зарегистрирован:', k.address, '|', k.handle);
    await login(k);
    return;
  }
  if (cmd === 'whoami') {
    const k = ensureKeys();
    const b = await api('/balance', { address: k.address });
    console.log(JSON.stringify({ address: k.address, handle: k.handle, pubSha: crypto.createHash('sha256').update(k.pub).digest('hex').slice(0, 12), balance: b.body.balance ?? b.body }, null, 1));
    return;
  }
  if (cmd === 'claim') {
    const k = ensureKeys();
    const escId = a1, taskHash = a2;
    const s = await login(k);
    const oc = await api('/cabinet/op-request', { address: k.address, token: s, op: { kind: 'job-claim', escId, taskHash: taskHash } });
    if (oc.body.ok) {
      const sig = crypto.sign(null, Buffer.from(oc.body.payload.digestHex, 'hex'), k.privKey).toString('hex');
      const sub = await api('/cabinet/op-submit', { opId: oc.body.opId, signature: sig });
      if (!sub.body.ok) die('op-submit: ' + JSON.stringify(sub.body));
      const receipt = { escId: sub.body.escId, taskHash: sub.body.taskHash, worker: sub.body.worker, amount: sub.body.amount, receiptSig: sub.body.receiptSig, workerPub: sub.body.workerPub, via: 'cabinet-job-claim' };
      saveKeys({ ...k, receipt });
      console.log('OK claim-квитанция (кабинет AGIP-46):');
      console.log(JSON.stringify(receipt, null, 1));
      return;
    }
    // фолбэк для нод ДО AGIP-46 (живые ноды ещё на старом коде): legacy-маршрут /escrow/claim
    console.log('cabinet job-claim недоступен (' + JSON.stringify(oc.body) + ') → legacy /escrow/claim');
    const c = await api('/escrow/claim', { escId, taskHash, workerAddress: k.address, workerPrivKey: k.privKey });
    if (!c.body.escId) die('escrow/claim: ' + JSON.stringify(c.body));
    const receipt = { escId: c.body.escId, taskHash: c.body.taskHash, worker: c.body.worker, amount: c.body.amount, receiptSig: c.body.receiptSig, workerPub: c.body.workerPub, via: 'legacy-escrow-claim' };
    saveKeys({ ...k, receipt });
    console.log('OK claim-квитанция (legacy-маршрут):');
    console.log(JSON.stringify(receipt, null, 1));
    return;
  }
  if (cmd === 'work') {
    const k = ensureKeys();
    // РЕАЛЬНАЯ работа: живой публичный курс BTC/USD (CoinGecko, без ключей)
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { headers: { 'user-agent': 'AGT-external-worker/1' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) die('CoinGecko HTTP ' + res.status);
    const price = (await res.json()).bitcoin.usd;
    const strait = 'BTC/USD=' + price + '@' + new Date().toISOString();
    const artifactHash = crypto.createHash('sha256').update(strait, 'utf8').digest('hex');
    console.log('REALLY-DONE артефакт:', strait);
    console.log('artifactHash:', artifactHash);
    // публикация артефакта в цепь: полностью локальная подпись tx → публичный POST /tx
    // (ключ ноде не отправляется; AGIP-46 op-request на живой ноде появляется после её рестарта)
    const memo = ('job-artifact:' + artifactHash.slice(0, 32) + ' BTCUSD=' + price).slice(0, 120);
    const bal = await api('/balance', { address: k.address });
    const balNum = Number(bal.body.balance ?? 0);
    if (!(balNum >= 0.001)) die('нет газа на артефакт: получи faucet-каплю (нужно 0.001 AGT)');
    const { txDigest, signTransaction } = await import('../core.mjs');
    const to = process.env.AGT_EMPLOYER_FALLBACK || 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a';
    const tx = { from: k.address, fromPub: k.pub, to, amount: 0.001, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
    tx.signature = signTransaction(tx, k.privKey);
    const post = await api('/tx', tx);
    if (post.status !== 201 && !(post.body && post.body.ok)) die('POST /tx: ' + post.status + ' ' + JSON.stringify(post.body));
    const artifactTxid = txDigest(tx);
    saveKeys({ ...k, artifactHash, artifact: strait, artifactTxid: artifactTxid.slice(0, 16) });
    console.log('OK артефакт опубликован в цепь: txid=' + artifactTxid.slice(0, 16) + ' (нужен 1 блок)');
    return;
  }
  if (cmd === 'send') {
    const k = ensureKeys();
    const { txDigest, signTransaction } = await import('../core.mjs');
    const tx = { from: k.address, fromPub: k.pub, to: a1, amount: Number(a2), nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: a3 };
    tx.signature = signTransaction(tx, k.privKey);
    const post = await api('/tx', tx);
    if (post.status !== 201 && !(post.body && post.body.ok)) die('POST /tx: ' + post.status + ' ' + JSON.stringify(post.body));
    console.log('OK txid=' + txDigest(tx).slice(0, 16) + ' mempool=' + post.body.mempool);
    return;
  }
  die('unknown command');
}

async function login(k) {
  const c = await api('/cabinet/challenge', { address: k.address });
  if (!c.body.ok) die('cabinet/challenge: ' + JSON.stringify(c.body));
  const nonce = c.body.nonce || c.body.challenge?.message;
  const sig = signHex(nonce, k.privKey);
  const l = await api('/cabinet/login', { address: k.address, mode: 'challenge', nonce, signature: sig, challengeId: c.body.challengeId });
  if (!l.body.ok) die('cabinet/login: ' + JSON.stringify(l.body));
  return l.body.token;
}
