// Доказательство владения ключом для внешнего агента.
//
// Агент просит у ноды одноразовый вызов (challenge), подписывает его своим
// ed25519-ключом и присылает подпись. Нода проверяет, что ключ действительно
// хешируется в адрес записи (PEM-схема паспорта или raw-схема create-wallet),
// и сохраняет факт проверки. Приватный ключ не покидает агента, в реестр не
// попадает и по сети не ходит.
//
// Что это доказывает: контроль над ключом на момент подписи. Чего не
// доказывает: что за ключом стоит независимый оператор, а не тот же, кто
// завёл запись. Поэтому счётчик называется verifiedExternal, а не
// independentAgents.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  bindPubToAddress, isRawAgentPubHex, rawAgentPubToPem, addressFromRawAgentPub,
} from './agent-identity.mjs';

export const OWNERSHIP_DOMAIN = 'AGT-OWNERSHIP-V1';
export const MAX_OWNERSHIP_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 1000;
const MAX_PROOFS = 100_000;

function fail(code) { const e = new Error(code); e.code = code; throw e; }
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_object');
  return value;
}
function addressValue(value) {
  if (typeof value !== 'string' || !/^AGT[0-9a-f]{40}$/.test(value)) fail('invalid_address');
  return value;
}
function signatureHex(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{128}$/.test(value)) fail('invalid_signature');
  return value.toLowerCase();
}
function nodeValue(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail('invalid_node');
  return value;
}

// Проверка внутри схемы адреса: PEM↔PEM-адрес, raw hex↔raw-адрес. Смешивать
// схемы нельзя — один ключ даёт в них разные адреса.
export function ownershipScheme(address, pub) {
  addressValue(address);
  if (typeof pub !== 'string' || pub.length < 1 || pub.length > 512) fail('invalid_public_key');
  if (isRawAgentPubHex(pub)) {
    const hex = pub.toLowerCase();
    if (addressFromRawAgentPub(hex) !== address) fail('address_public_key_mismatch');
    return { scheme: 'raw-ed25519', pub: hex, pem: rawAgentPubToPem(hex) };
  }
  const canonical = bindPubToAddress(address, pub);
  if (!canonical) fail('address_public_key_mismatch');
  return { scheme: 'spki-ed25519', pub: canonical, pem: canonical };
}

export function canonicalOwnershipMessage(challenge) {
  const c = object(challenge);
  if (c.version !== 1 || c.domain !== OWNERSHIP_DOMAIN) fail('unsupported_ownership_version');
  addressValue(c.address);
  if (typeof c.pub !== 'string' || c.pub.length > 512) fail('invalid_public_key');
  if (typeof c.challengeId !== 'string' || !/^[0-9a-f]{32}$/.test(c.challengeId)) fail('invalid_challenge_id');
  if (typeof c.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(c.nonce)) fail('invalid_nonce');
  if (!Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt)) fail('invalid_ttl');
  nodeValue(c.node);
  return OWNERSHIP_DOMAIN + '\n' + JSON.stringify([
    c.version, c.address, c.pub, c.challengeId, c.nonce, c.issuedAt, c.expiresAt, c.node,
  ]);
}

export function createOwnershipChallenge({ address, pub, node }, { now = Date.now(), ttlMs = MAX_OWNERSHIP_TTL_MS } = {}) {
  addressValue(address);
  nodeValue(node);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_OWNERSHIP_TTL_MS) fail('invalid_challenge_ttl');
  const key = ownershipScheme(address, pub);
  const c = {
    version: 1, domain: OWNERSHIP_DOMAIN, address, pub: key.pub, scheme: key.scheme,
    challengeId: crypto.randomBytes(16).toString('hex'),
    nonce: crypto.randomBytes(32).toString('hex'),
    issuedAt: now, expiresAt: now + ttlMs, node,
  };
  return { ...c, message: canonicalOwnershipMessage(c) };
}

export function verifyOwnershipSignature(challenge, signature, { now = Date.now() } = {}) {
  const c = object(challenge);
  if (!Number.isSafeInteger(now)) fail('invalid_clock');
  if (now >= c.expiresAt) fail('challenge_expired');
  if (c.issuedAt > now + 30_000) fail('challenge_from_future');
  const key = ownershipScheme(c.address, c.pub);
  const message = Buffer.from(canonicalOwnershipMessage(c), 'utf8');
  if (!crypto.verify(null, message, crypto.createPublicKey(key.pem), Buffer.from(signatureHex(signature), 'hex'))) fail('invalid_signature');
  return { ok: true, address: c.address, pub: key.pub, scheme: key.scheme, challengeId: c.challengeId };
}

export class OwnershipProofStore {
  constructor({ file, now = Date.now } = {}) {
    if (typeof file !== 'string' || !file) fail('ownership_file_required');
    if (typeof now !== 'function') fail('invalid_clock');
    this.file = file; this.now = now;
    this._proofs = new Map(); this._challenges = new Map();
    if (fs.existsSync(file)) {
      let stored;
      try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('invalid_ownership_store'); }
      if (!stored || stored.version !== 1 || !Array.isArray(stored.proofs) || stored.proofs.length > MAX_PROOFS) fail('invalid_ownership_store');
      for (const p of stored.proofs) {
        if (!p || typeof p.address !== 'string' || typeof p.pub !== 'string' || !Number.isSafeInteger(p.verifiedAt) || p.verifiedAt < 0) fail('invalid_ownership_store');
        if (!bindPubToAddress(p.address, p.pub)) fail('invalid_ownership_store');
        this._proofs.set(p.address, {
          address: p.address, pub: p.pub, verifiedAt: p.verifiedAt,
          challengeId: typeof p.challengeId === 'string' ? p.challengeId : null,
        });
      }
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, proofs: [...this._proofs.values()] }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }

  issue({ address, pub, node, ttlMs }) {
    const now = this.now();
    for (const [id, c] of this._challenges) if (c.expiresAt <= now) this._challenges.delete(id);
    if (this._challenges.size >= MAX_CHALLENGES) fail('challenge_capacity');
    if ([...this._challenges.values()].filter(c => c.address === address).length >= 3) fail('address_challenge_capacity');
    const c = createOwnershipChallenge({ address, pub, node }, ttlMs ? { now, ttlMs } : { now });
    this._challenges.set(c.challengeId, c);
    return c;
  }

  prove({ challengeId, signature }) {
    if (typeof challengeId !== 'string' || !/^[0-9a-f]{32}$/.test(challengeId)) fail('invalid_challenge_id');
    const c = this._challenges.get(challengeId);
    if (!c) fail('challenge_not_issued');
    this._challenges.delete(challengeId); // одноразовый, даже при неудачной подписи
    const checked = verifyOwnershipSignature(c, signature, { now: this.now() });
    const proof = { address: c.address, pub: c.pub, verifiedAt: this.now(), challengeId: c.challengeId };
    this._proofs.set(c.address, proof);
    this._save();
    return { ok: true, ...proof, scheme: checked.scheme };
  }

  proofOf(address) { return this._proofs.get(address) || null; }
  verified(address) { return this._proofs.has(address); }
  verifiedCount(addresses) {
    let n = 0;
    for (const a of addresses) if (this._proofs.has(a)) n++;
    return n;
  }
}
