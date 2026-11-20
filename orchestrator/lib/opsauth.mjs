#!/usr/bin/env node
/* Операторская подпись STOP/resume: Ed25519, а не общий HMAC.

   Почему так: HMAC-ключ пришлось бы держать и сервису, и оператору, а значит
   скомпрометированный оркестратор смог бы сам снять STOP и подписать resume.
   Здесь у сервиса только публичный ключ (state/operator.pub, 0644): он умеет
   проверять события, но не создавать их. Приватный ключ лежит у root
   (по умолчанию /etc/agentcoin/operator.key, 0600) и читается только
   операторской командой service/operator.mjs. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonical, ensureDir, sha256 } from './fsx.mjs';

export const OPERATOR_ALG = 'ed25519';

const fail = (code, message) => Object.assign(new Error(message), { code });

export function keyIdOf(publicKeyPem) {
  return sha256(publicKeyPem).slice(0, 16);
}

export function defaultPrivateKeyPath() {
  return process.env.OPS_OPERATOR_KEY || '/etc/agentcoin/operator.key';
}

export function defaultPublicKeyPath(root) {
  return process.env.OPS_OPERATOR_PUB || path.join(path.resolve(root), 'state', 'operator.pub');
}

/* Создание пары. Приватный ключ — 0600 и только root; публичный — 0644,
   его читает сервис. Существующий ключ не перезаписывается. */
export function initOperatorKey({ privateKeyPath = defaultPrivateKeyPath(), publicKeyPath } = {}) {
  if (!publicKeyPath) throw fail('OPERATOR_PUB_PATH_REQUIRED', 'publicKeyPath is required');
  if (fs.existsSync(privateKeyPath)) {
    const publicKeyPem = fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, 'utf8') : null;
    return { created: false, privateKeyPath, publicKeyPath, keyId: publicKeyPem ? keyIdOf(publicKeyPem) : null };
  }
  ensureDir(path.dirname(privateKeyPath));
  ensureDir(path.dirname(publicKeyPath));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' });
  fs.writeFileSync(privateKeyPath, privatePem, { mode: 0o600 });
  fs.chmodSync(privateKeyPath, 0o600);
  fs.writeFileSync(publicKeyPath, publicPem, { mode: 0o644 });
  fs.chmodSync(publicKeyPath, 0o644);
  return { created: true, privateKeyPath, publicKeyPath, keyId: keyIdOf(publicPem) };
}

/* Приватный ключ обязан быть закрыт от группы и остальных. Иначе любой
   процесс сервиса смог бы подписывать resume, и разделение теряет смысл. */
export function loadOperatorPrivateKey(privateKeyPath = defaultPrivateKeyPath()) {
  if (!fs.existsSync(privateKeyPath)) {
    throw fail('OPERATOR_KEY_MISSING', `operator key not found: ${privateKeyPath}; run "operator.mjs init-key" as root`);
  }
  const stat = fs.statSync(privateKeyPath);
  /* На Windows POSIX-биты режима не отражают ACL: проверка прав и владельца
     имеет смысл только на POSIX, где и работает ops-host. */
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw fail('OPERATOR_KEY_UNSAFE', `${privateKeyPath} is readable by group/others (mode ${(stat.mode & 0o777).toString(8)}); chmod 600`);
  }
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0 && stat.uid !== process.getuid()) {
    throw fail('OPERATOR_KEY_UNSAFE', `${privateKeyPath} is owned by uid ${stat.uid}, not by the calling user`);
  }
  const key = crypto.createPrivateKey(fs.readFileSync(privateKeyPath));
  const publicPem = crypto.createPublicKey(key).export({ format: 'pem', type: 'spki' });
  return { key, keyId: keyIdOf(publicPem), path: privateKeyPath };
}

export function loadOperatorPublicKey(publicKeyPath) {
  if (!fs.existsSync(publicKeyPath)) return null;
  try {
    return crypto.createPublicKey(fs.readFileSync(publicKeyPath));
  } catch {
    return null;
  }
}

export function publicKeyId(publicKey) {
  return keyIdOf(publicKey.export({ format: 'pem', type: 'spki' }));
}

/* Тело события подписывается целиком, включая alg и keyId: подмена ключа или
   алгоритма ломает подпись. */
export function signEntry(entry, { key, keyId }) {
  const body = { ...entry, alg: OPERATOR_ALG, keyId };
  delete body.sig;
  const sig = crypto.sign(null, Buffer.from(canonical(body)), key).toString('base64');
  return { ...body, sig };
}

export function verifyEntry(entry, publicKey) {
  if (!entry || !entry.sig || entry.alg !== OPERATOR_ALG || !publicKey) return false;
  if (entry.keyId && entry.keyId !== publicKeyId(publicKey)) return false;
  const { sig, ...body } = entry;
  try {
    return crypto.verify(null, Buffer.from(canonical(body)), publicKey, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}
