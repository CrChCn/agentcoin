/* agentnet/identity.mjs — ed25519-идентичность ноды.
   nodeId = "agt1" + sha256(SPKI DER pubkey)[0..32]. Ключ не покидает каталог ноды:
   приватный файл 0600, экспорт через API запрещён на уровне модуля. */
'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, sha256hex, writeJsonAtomic } from './util.mjs';

export const NODE_ID_PREFIX = 'agt1';
export const PRIVATE_KEY_FILE = 'node.key.pem';
export const PUBLIC_KEY_FILE = 'node.pub.pem';

export function nodeIdFromPublicKeyPem(pem) {
  const key = crypto.createPublicKey(pem);
  const der = key.export({ type: 'spki', format: 'der' });
  return NODE_ID_PREFIX + sha256hex(der).slice(0, 32);
}

export function validateNodeId(id) {
  return typeof id === 'string' && /^agt1[0-9a-f]{32}$/.test(id);
}

export function verifyWithPublicKey(pem, data, signatureB64u) {
  try {
    const key = crypto.createPublicKey(pem);
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(String(signatureB64u), 'base64url'));
  } catch {
    return false;
  }
}

export class Identity {
  constructor({ dir, nodeId, publicKeyPem, privateKey, publicKey, createdAt = null }) {
    this.dir = dir;
    this.nodeId = nodeId;
    this.publicKeyPem = publicKeyPem;
    this.privateKey = privateKey; // KeyObject; НЕ сериализуется наружу
    this.publicKey = publicKey;
    this.createdAt = createdAt;
  }

  sign(buf) {
    return crypto.sign(null, Buffer.from(buf), this.privateKey);
  }

  signB64u(buf) {
    return this.sign(buf).toString('base64url');
  }

  verify(buf, sigB64u) {
    return verifyWithPublicKey(this.publicKeyPem, buf, sigB64u);
  }

  /** Публичное описание — без приватного материала. */
  publicDescriptor() {
    return { nodeId: this.nodeId, publicKey: this.publicKeyPem, createdAt: this.createdAt };
  }
}

function readKeyFiles(keysDir) {
  const privPem = fs.readFileSync(path.join(keysDir, PRIVATE_KEY_FILE), 'utf8');
  const pubPem = fs.readFileSync(path.join(keysDir, PUBLIC_KEY_FILE), 'utf8');
  return { privPem, pubPem };
}

export function loadIdentity(dir) {
  const keysDir = path.join(dir, 'keys');
  const { privPem, pubPem } = readKeyFiles(keysDir);
  const privateKey = crypto.createPrivateKey(privPem);
  const publicKey = crypto.createPublicKey(pubPem);
  const nodeId = nodeIdFromPublicKeyPem(pubPem);
  const meta = readJson(path.join(keysDir, 'identity.json'), {}) || {};
  return new Identity({ dir, nodeId, publicKeyPem: pubPem, privateKey, publicKey, createdAt: meta.createdAt || null });
}

export function createIdentity(dir, { force = false } = {}) {
  const keysDir = ensureDir(path.join(dir, 'keys'), 0o700);
  const privFile = path.join(keysDir, PRIVATE_KEY_FILE);
  const pubFile = path.join(keysDir, PUBLIC_KEY_FILE);
  if (!force && fs.existsSync(privFile)) return loadIdentity(dir);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(privFile, privPem, { mode: 0o600 });
  try { fs.chmodSync(privFile, 0o600); } catch { /* windows */ }
  fs.writeFileSync(pubFile, pubPem, { mode: 0o644 });
  const createdAt = new Date().toISOString();
  writeJsonAtomic(path.join(keysDir, 'identity.json'), { createdAt, algorithm: 'ed25519' }, 0o600);
  return new Identity({ dir, nodeId: nodeIdFromPublicKeyPem(pubPem), publicKeyPem: pubPem, privateKey, publicKey, createdAt });
}

export function loadOrCreateIdentity(dir) {
  ensureDir(dir, 0o700);
  try { return loadIdentity(dir); } catch { return createIdentity(dir); }
}

/** Временная (in-memory) идентичность — для тестов, индексеров и CLI-утилит. */
export function ephemeralIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return new Identity({
    dir: null,
    nodeId: nodeIdFromPublicKeyPem(publicKeyPem),
    publicKeyPem,
    privateKey,
    publicKey,
    createdAt: new Date().toISOString(),
  });
}
