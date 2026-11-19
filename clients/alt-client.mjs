#!/usr/bin/env node
/* Альтернативный клиент Agentcoin — независимая реализация протокола.
   Существует как доказательство, что рынок не привязан к SDK:
     - импортирует ТОЛЬКО node:crypto и node:fs (никакого кода проекта);
     - сам считает адрес из публичного ключа, канонику подписи и digest;
     - говорит с узлом по HTTP теми же полями, что описаны в /queue/auth-capabilities.

   Формат, который он обязан воспроизвести (это протокол, а не деталь SDK):
     address   = 'AGT' + sha256d(pubPem).slice(0,32) + sha256d(pubHash).slice(0,8)
     digest    = sha256(JSON.stringify({ chain:'AGENTCOIN', action, body (sorted keys),
                                         nonce: String(nonce), expiry: Number(expiry) }))
     signature = ed25519(digest bytes)

   Клиент не доверяет узлу больше, чем нужно: приватное чтение делается только
   с подписью 'read', а суммы считает по ответу, а не по своим ожиданиям. */
import crypto from 'node:crypto';
import fs from 'node:fs';

const CHAIN = 'AGENTCOIN';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const sha256dHex = (x) => {
  const once = sha256(Buffer.isBuffer(x) ? x : Buffer.from(String(x), 'utf8'));
  return sha256(once).toString('hex');
};

export function addressFromPublicKey(pem) {
  const pubHash = sha256dHex(pem);
  return 'AGT' + pubHash.slice(0, 32) + sha256dHex(pubHash).slice(0, 8);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export function actionDigest({ action, body = {}, nonce, expiry }) {
  const canon = JSON.stringify({ chain: CHAIN, action, body: sortKeys(body), nonce: String(nonce), expiry: Number(expiry) });
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

export function createAltClient({ node, walletFile }) {
  const base = String(node || '').replace(/\/+$/, '');
  const w = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
  const pubPem = w.public_key_pem || w.pub;
  const privPem = w.privateKeyPem || w.priv;
  if (!pubPem || !privPem) throw new Error('wallet_incomplete');
  const address = w.address || addressFromPublicKey(pubPem);
  if (address !== addressFromPublicKey(pubPem)) throw new Error('wallet_address_mismatch');

  let counter = 0;
  const sign = (action, body = {}) => {
    const nonce = 'alt-' + Date.now().toString(36) + '-' + (counter++).toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const expiry = Date.now() + 4 * 60_000;
    const digest = actionDigest({ action, body, nonce, expiry });
    const signature = crypto.sign(null, Buffer.from(digest, 'hex'), privPem).toString('hex');
    return { address, fromPub: pubPem, signature, action, body, nonce, expiry, chain: CHAIN };
  };

  const req = async (path, init) => {
    const r = await fetch(base + path, init);
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    return { status: r.status, ok: r.ok, data };
  };
  const get = (path) => req(path, { method: 'GET' });
  const post = (path, body) => req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const signed = (action, path, body = {}) => post(path, sign(action, body));

  return {
    address,
    endpoint: base,
    capabilities: async () => (await get('/queue/auth-capabilities')).data,
    // Ресурс: каталог, регистрация, аренда квоты, измерение, закрытие.
    listResources: async (kind) => (await get('/resources' + (kind ? '?kind=' + encodeURIComponent(kind) : ''))).data,
    getResource: async (resourceId) => (await get('/resources/' + encodeURIComponent(resourceId))).data,
    registerResource: (resource) => signed('rregister', '/resources/register', { resource }),
    lease: (resourceId, units, opts = {}) => signed('rlease', '/resources/lease', { resourceId, units, idempotencyKey: opts.idempotencyKey, leaseMs: opts.leaseMs }),
    consume: (leaseId, units, usageId) => signed('rconsume', '/resources/consume', { leaseId, units, usageId }),
    closeLease: (leaseId) => signed('rclose', '/resources/close', { leaseId }),
    // Заказ/расчёт: те же пути, что у SDK — но без SDK.
    getOrder: async (assignmentId) => (await get('/orders/' + encodeURIComponent(assignmentId))).data,
    accept: (assignmentId, verdict = 'accepted') => signed('accept', '/orders/accept', { assignmentId, verdict }),
    faucet: (amountAtomic) => post('/settlements/faucet', { address, amountAtomic }),
    getSettlement: async (assignmentId) => (await get('/settlements/' + encodeURIComponent(assignmentId))).data,
    createSettlement: (assignmentId) => signed('settle', '/settlements/create', { assignmentId }),
    sendSettlement: (assignmentId) => signed('ssend', '/settlements/send', { assignmentId }),
    confirmSettlement: (assignmentId) => signed('sconfirm', '/settlements/confirm', { assignmentId }),
    signed,
  };
}
