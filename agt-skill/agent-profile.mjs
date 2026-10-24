#!/usr/bin/env node
// Local agent identity vault. This module performs no network requests and never
// returns a seed/private key from its public API. CLI secrets arrive as JSON stdin.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { txDigest, verifyTransaction, unitsOfAmountBigInt, escrowReceiptDigest } from '../core.mjs';
import { createSeedWallet, recoverFromMnemonic } from '../bip39-lite.mjs';
import {
  canonicalAgentChallenge, validateAgentChallenge, canonicalAgentPublicKey,
  agentIdentityId,
} from '../agent-identity.mjs';

const scrypt = promisify(crypto.scrypt);
const VAULT_SCHEMA = 'agentcoin-agent-vault';
const PUBLIC_SCHEMA = 'agentcoin-agent-public';
const SECRET_SCHEMA = 'agentcoin-agent-secret';
const VERSION = 1;
const MAX_BYTES = 128 * 1024;
export const PROFILE_KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 32 });
export const DEFAULT_PROFILE_PATH = path.join(os.homedir(), '.agentcoin', 'identity', 'profile.json');

function fail(code) { throw new Error(code); }
function plainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function exactKeys(v, keys, code) {
  if (!plainObject(v) || Object.keys(v).sort().join('|') !== [...keys].sort().join('|')) fail(code);
}
function validPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) fail('password_must_be_12_to_1024_chars');
}
function validNetwork(network) {
  if (typeof network !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(network)) fail('invalid_network');
}
function validLabel(label) {
  if (typeof label !== 'string' || label.length > 128 || /[\u0000-\u001f\u007f]/.test(label)) fail('invalid_label');
}
function addressFromPub(pub) {
  const sha256d = x => crypto.createHash('sha256').update(crypto.createHash('sha256').update(x).digest()).digest('hex');
  const hash = sha256d(pub);
  return 'AGT' + hash.slice(0, 32) + sha256d(hash).slice(0, 8);
}
function publicIdentity(secret) {
  return { schema: PUBLIC_SCHEMA, version: VERSION, network: secret.network,
    identityId: agentIdentityId(secret.network, secret.pub, secret.address),
    address: secret.address, pub: secret.pub, label: secret.label, createdAt: secret.createdAt };
}
function validatePublic(pub) {
  exactKeys(pub, ['schema', 'version', 'network', 'identityId', 'address', 'pub', 'label', 'createdAt'], 'invalid_public_profile');
  if (pub.schema !== PUBLIC_SCHEMA || pub.version !== VERSION) fail('unsupported_public_profile');
  validNetwork(pub.network); validLabel(pub.label);
  if (!Number.isSafeInteger(pub.createdAt) || pub.createdAt < 0) fail('invalid_created_at');
  if (canonicalAgentPublicKey(pub.pub) !== pub.pub || addressFromPub(pub.pub) !== pub.address ||
      agentIdentityId(pub.network, pub.pub, pub.address) !== pub.identityId) fail('public_identity_mismatch');
}
function validateSecret(secret) {
  exactKeys(secret, ['schema', 'version', 'network', 'address', 'pub', 'privKey', 'label', 'createdAt', 'mnemonic', 'mnemonicPassphrase'], 'invalid_secret_profile');
  if (secret.schema !== SECRET_SCHEMA || secret.version !== VERSION || typeof secret.privKey !== 'string' ||
      typeof secret.mnemonic !== 'string' || typeof secret.mnemonicPassphrase !== 'string') fail('unsupported_secret_profile');
  validatePublic(publicIdentity(secret));
  const key = crypto.createPrivateKey(secret.privKey);
  if (key.asymmetricKeyType !== 'ed25519' || crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== secret.pub) fail('private_identity_mismatch');
  // Keep mnemonic recovery and the stored key inseparable, even after backup.
  const recovered = recoverFromMnemonic(secret.mnemonic, secret.label, secret.mnemonicPassphrase).wallet;
  if (recovered.address !== secret.address || recovered.pub !== secret.pub || recovered.privKey !== secret.privKey) fail('mnemonic_identity_mismatch');
}
function b64(value, length, code) {
  if (typeof value !== 'string' || value.length > MAX_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(code);
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value || (length !== null && buf.length !== length)) fail(code);
  return buf;
}
function validateEnvelope(envelope) {
  exactKeys(envelope, ['schema', 'version', 'public', 'kdf', 'cipher', 'ciphertext'], 'invalid_vault');
  if (envelope.schema !== VAULT_SCHEMA || envelope.version !== VERSION) fail('unsupported_vault');
  validatePublic(envelope.public);
  exactKeys(envelope.kdf, ['name', 'N', 'r', 'p', 'keyLength', 'salt'], 'invalid_kdf');
  // Never accept attacker-controlled work factors from a backup file.
  for (const [key, value] of Object.entries(PROFILE_KDF)) if (envelope.kdf[key] !== value) fail('unsupported_kdf');
  b64(envelope.kdf.salt, 16, 'invalid_salt');
  exactKeys(envelope.cipher, ['name', 'iv', 'tag'], 'invalid_cipher');
  if (envelope.cipher.name !== 'aes-256-gcm') fail('unsupported_cipher');
  b64(envelope.cipher.iv, 12, 'invalid_iv'); b64(envelope.cipher.tag, 16, 'invalid_tag');
  const ciphertext = b64(envelope.ciphertext, null, 'invalid_ciphertext');
  if (!ciphertext.length || ciphertext.length > MAX_BYTES / 2) fail('invalid_ciphertext');
}
function aad(envelope) {
  const p = envelope.public;
  return Buffer.from(JSON.stringify([VAULT_SCHEMA, VERSION,
    p.schema, p.version, p.network, p.identityId, p.address, p.pub, p.label, p.createdAt,
    PROFILE_KDF.name, PROFILE_KDF.N, PROFILE_KDF.r, PROFILE_KDF.p, PROFILE_KDF.keyLength,
    envelope.kdf.salt, 'aes-256-gcm', envelope.cipher.iv]), 'utf8');
}
async function deriveKey(password, salt) {
  validPassword(password);
  return scrypt(password, salt, PROFILE_KDF.keyLength, { N: PROFILE_KDF.N, r: PROFILE_KDF.r, p: PROFILE_KDF.p, maxmem: 64 * 1024 * 1024 });
}
async function encryptSecret(secret, password) {
  validateSecret(secret);
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const envelope = { schema: VAULT_SCHEMA, version: VERSION, public: publicIdentity(secret),
    kdf: { ...PROFILE_KDF, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: '' }, ciphertext: '' };
  const key = await deriveKey(password, salt);
  const clear = Buffer.from(JSON.stringify(secret), 'utf8');
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(envelope));
    envelope.ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]).toString('base64');
    envelope.cipher.tag = cipher.getAuthTag().toString('base64');
    return envelope;
  } finally { key.fill(0); clear.fill(0); }
}
async function decryptEnvelope(envelope, password) {
  validateEnvelope(envelope);
  const key = await deriveKey(password, b64(envelope.kdf.salt, 16, 'invalid_salt'));
  let clear;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, b64(envelope.cipher.iv, 12, 'invalid_iv'));
    decipher.setAAD(aad(envelope)); decipher.setAuthTag(b64(envelope.cipher.tag, 16, 'invalid_tag'));
    clear = Buffer.concat([decipher.update(b64(envelope.ciphertext, null, 'invalid_ciphertext')), decipher.final()]);
    const secret = JSON.parse(clear.toString('utf8'));
    validateSecret(secret);
    const expected = publicIdentity(secret);
    if (Object.keys(expected).some(key => expected[key] !== envelope.public[key])) fail('vault_identity_mismatch');
    return secret;
  } catch { fail('vault_unlock_failed'); }
  finally { key.fill(0); clear?.fill(0); }
}
async function privateDirectory(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(dir);
  // Reject symlinks in ancestors as well as the leaf directory. This avoids
  // silently placing a profile under a redirected identity directory.
  let ancestor = path.resolve(dir);
  for (;;) {
    const entry = await fsp.lstat(ancestor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('profile_directory_must_be_real');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077)) fail('profile_directory_must_be_0700');
}
async function atomicPrivateWrite(filePath, value) {
  const target = path.resolve(filePath), dir = path.dirname(target);
  await privateDirectory(dir);
  const temp = path.join(dir, '.agent-profile-' + crypto.randomBytes(12).toString('hex'));
  let handle;
  try {
    handle = await fsp.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync(); await handle.close(); handle = null;
    // link is atomic and refuses an existing destination (including symlinks).
    await fsp.link(temp, target);
    if (process.platform !== 'win32') {
      const dh = await fsp.open(dir, fs.constants.O_RDONLY);
      try { await dh.sync(); } finally { await dh.close(); }
    }
  } catch (error) {
    if (error?.code === 'EEXIST') fail('profile_or_backup_already_exists');
    throw error;
  } finally { await handle?.close().catch(() => {}); await fsp.unlink(temp).catch(() => {}); }
}
async function readEnvelope(filePath) {
  const target = path.resolve(filePath);
  const stat = await fsp.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('profile_must_be_regular_file');
  const h = await fsp.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await h.stat();
    if (!opened.isFile() || opened.size > MAX_BYTES || (process.platform !== 'win32' && (opened.mode & 0o077))) fail('profile_must_be_private_and_bounded');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await h.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) fail('profile_too_large');
    const envelope = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    validateEnvelope(envelope);
    return envelope;
  } finally { await h.close(); }
}

/** Creates a new vault, or recovers a compatible BIP39 identity if mnemonic is supplied. */
export async function createProfile({ profilePath = DEFAULT_PROFILE_PATH, password, label = 'agent', network = 'AGENTCOIN', mnemonic, mnemonicPassphrase = '' } = {}) {
  validPassword(password); validLabel(label); validNetwork(network);
  if (typeof mnemonicPassphrase !== 'string' || Buffer.byteLength(mnemonicPassphrase) > 1024) fail('invalid_mnemonic_passphrase');
  let wallet, phrase;
  if (mnemonic !== undefined) {
    if (typeof mnemonic !== 'string' || mnemonic.length > 1024) fail('invalid_mnemonic');
    phrase = mnemonic.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
    try { wallet = recoverFromMnemonic(phrase, label, mnemonicPassphrase).wallet; }
    catch { fail('invalid_mnemonic'); }
  } else {
    const generated = createSeedWallet(label); phrase = generated.mnemonic;
    // Existing BIP39 helper creates an empty-passphrase wallet initially.
    wallet = mnemonicPassphrase ? recoverFromMnemonic(phrase, label, mnemonicPassphrase).wallet : generated.wallet;
  }
  const secret = { schema: SECRET_SCHEMA, version: VERSION, network, address: wallet.address,
    pub: wallet.pub, privKey: wallet.privKey, label, createdAt: wallet.createdAt,
    mnemonic: phrase, mnemonicPassphrase };
  const envelope = await encryptSecret(secret, password);
  await atomicPrivateWrite(profilePath, envelope);
  return publicIdentity(secret);
}

/** Public metadata is not authenticated until the vault is unlocked. */
export async function readPublicProfile(profilePath = DEFAULT_PROFILE_PATH) {
  return structuredClone((await readEnvelope(profilePath)).public);
}
export const exportPublicProfile = readPublicProfile;

export async function inspectProfile({ profilePath = DEFAULT_PROFILE_PATH, password } = {}) {
  return publicIdentity(await decryptEnvelope(await readEnvelope(profilePath), password));
}

/** Decrypt, validate, and re-encrypt with a fresh salt and IV. No plaintext export. */
export async function createEncryptedBackup({ profilePath = DEFAULT_PROFILE_PATH, password, backupPassword = password, backupPath } = {}) {
  const secret = await decryptEnvelope(await readEnvelope(profilePath), password);
  const backup = await encryptSecret(secret, backupPassword);
  if (backupPath) await atomicPrivateWrite(backupPath, backup);
  return backup;
}

export async function restoreProfile({ profilePath = DEFAULT_PROFILE_PATH, password, backup, backupPath, backupPassword = password, mnemonic, mnemonicPassphrase = '', label = 'agent', network } = {}) {
  if (mnemonic !== undefined) {
    if (backup !== undefined || backupPath !== undefined) fail('choose_backup_or_mnemonic');
    return createProfile({ profilePath, password, mnemonic, mnemonicPassphrase, label, network });
  }
  if ((backup === undefined) === (backupPath === undefined)) fail('choose_exactly_one_backup_source');
  if (backupPath !== undefined) backup = await readEnvelope(backupPath);
  const secret = await decryptEnvelope(backup, backupPassword);
  if (network !== undefined && secret.network !== network) fail('backup_network_mismatch');
  const restored = await encryptSecret(secret, password);
  await atomicPrivateWrite(profilePath, restored);
  return publicIdentity(secret);
}

/** Sign only a validated identity challenge, never a transaction or arbitrary text. */
export async function signProfileChallenge({ profilePath = DEFAULT_PROFILE_PATH, password, challenge,
  expectedAction, expectedAudience, expectedIssuerFingerprint, expectedNetwork, now = Date.now() } = {}) {
  if (!['register', 'login'].includes(expectedAction)) fail('expected_action_required');
  if (typeof expectedAudience !== 'string' || !expectedAudience || typeof expectedIssuerFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expectedIssuerFingerprint)) fail('expected_issuer_and_audience_required');
  const secret = await decryptEnvelope(await readEnvelope(profilePath), password);
  if (expectedNetwork !== undefined && expectedNetwork !== secret.network) fail('profile_network_mismatch');
  validateAgentChallenge(challenge, { network: secret.network, audience: expectedAudience,
    issuerFingerprint: expectedIssuerFingerprint, action: expectedAction, now });
  if (challenge.address !== secret.address || challenge.pub !== secret.pub) fail('challenge_profile_mismatch');
  const message = canonicalAgentChallenge(challenge);
  if (typeof challenge.message !== 'string' || challenge.message !== message) fail('challenge_message_mismatch');
  const signature = crypto.sign(null, Buffer.from(message, 'utf8'), secret.privKey).toString('hex');
  return { challengeId: challenge.challengeId, address: secret.address, pub: secret.pub, signature };
}

/** Sign one exact, explicitly reviewed Agentcoin v1 transfer in the existing encrypted profile. */
export async function signProfileWalletIntent({ profilePath = DEFAULT_PROFILE_PATH, password, request,
  expectedNetwork, expectedGenesisHash, expectedNodeUrl, now = Date.now() } = {}) {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype ||
      Object.keys(request).sort().join('|') !== 'genesisHash|intent|network|schema' ||
      request.schema !== 'agentcoin.wallet.intent.v1') fail('invalid_wallet_intent_request');
  if (typeof expectedNetwork !== 'string' || !/^[a-f0-9]{64}$/.test(expectedGenesisHash || '') ||
      !/^https:\/\//.test(expectedNodeUrl || '') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(expectedNodeUrl || '')) fail('wallet_trust_pin_mismatch');
  if (request.network !== expectedNetwork || request.genesisHash !== expectedGenesisHash) fail('wallet_trust_pin_mismatch');
  const intent = request.intent;
  if (!intent || Object.getPrototypeOf(intent) !== Object.prototype ||
      Object.keys(intent).sort().join('|') !== 'amount|createdAt|expiresAt|from|memo|nonce|to' ||
      !/^AGT[0-9a-f]{40}$/.test(intent.from || '') || !/^AGT[0-9a-f]{40}$/.test(intent.to || '') ||
      typeof intent.amount !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(intent.amount) ||
      !Number.isSafeInteger(intent.createdAt) || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= Math.floor(now / 1000) ||
      intent.expiresAt <= intent.createdAt || intent.expiresAt - intent.createdAt > 300 || !Number.isSafeInteger(intent.nonce) ||
      typeof intent.memo !== 'string' || Buffer.byteLength(intent.memo, 'utf8') > 512 || /[\u0000-\u001f\u007f]/.test(intent.memo)) fail('invalid_wallet_intent');
  const [whole, fraction = ''] = intent.amount.split('.');
  const units = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  if (units < 1n || units > BigInt(Number.MAX_SAFE_INTEGER)) fail('wallet_amount_out_of_range');
  try { if (unitsOfAmountBigInt(Number(intent.amount)) !== units) fail('wallet_amount_not_exact_in_network_format'); }
  catch { fail('wallet_amount_not_exact_in_network_format'); }
  const secret = await decryptEnvelope(await readEnvelope(profilePath), password);
  if (secret.network !== expectedNetwork || intent.from !== secret.address) fail('wallet_profile_mismatch');
  const tx = { from: intent.from, fromPub: secret.pub, to: intent.to, amount: Number(intent.amount),
    nonce: intent.nonce, ts: intent.createdAt, memo: intent.memo };
  tx.txid = txDigest(tx);
  tx.signature = crypto.sign(null, Buffer.from(tx.txid, 'hex'), secret.privKey).toString('hex');
  if (addressFromPub(tx.fromPub) !== tx.from || !verifyTransaction(tx)) fail('wallet_signature_self_check_failed');
  return { schema: 'agentcoin.wallet.signed.v1', network: expectedNetwork, genesisHash: expectedGenesisHash,
    intent: structuredClone(intent), tx };
}

/** Sign the current cabinet op-request payload (AGIP-46) without trusting its node pins. */
export async function signProfileWalletOperation({ profilePath = DEFAULT_PROFILE_PATH, password, operation,
  expectedNetwork, expectedGenesisHash, expectedNodeOrigin } = {}) {
  if (typeof expectedNetwork !== 'string' || !/^[a-f0-9]{64}$/.test(expectedGenesisHash || '') ||
      typeof expectedNodeOrigin !== 'string') fail('wallet_trust_pin_mismatch');
  let origin; try { origin = new URL(expectedNodeOrigin).origin; } catch { fail('wallet_trust_pin_mismatch'); }
  if (origin !== expectedNodeOrigin || !/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)) fail('wallet_trust_pin_mismatch');
  if (!operation || Object.getPrototypeOf(operation) !== Object.prototype || Object.keys(operation).sort().join('|') !== 'opId|payload|schema|sourceOrigin' || operation.schema !== 'agt-agent-wallet-op-v1' ||
      typeof operation.sourceOrigin !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operation.opId || '') ||
      !operation.payload || Object.getPrototypeOf(operation.payload) !== Object.prototype) fail('invalid_wallet_operation');
  let sourceOrigin; try { sourceOrigin = new URL(operation.sourceOrigin).origin; } catch { fail('invalid_wallet_operation'); }
  if (sourceOrigin !== operation.sourceOrigin || !/^https:\/\//.test(sourceOrigin) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(sourceOrigin)) fail('invalid_wallet_operation');
  if (sourceOrigin !== origin) fail('origin_mismatch');
  const p = operation.payload;
  if (p.kind === 'job-claim') {
    if (Object.keys(p).sort().join('|') !== 'address|amount|digestHex|employer|escId|kind|taskHash|worker' ||
        !/^AGT[0-9a-f]{40}$/.test(p.address || '') || !/^AGT[0-9a-f]{40}$/.test(p.worker || '') ||
        !/^AGT[0-9a-f]{40}$/.test(p.employer || '') || typeof p.escId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.escId) ||
        typeof p.taskHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.taskHash) || typeof p.digestHex !== 'string' || !/^[a-f0-9]{64}$/.test(p.digestHex) ||
        typeof p.amount !== 'number' || !Number.isFinite(p.amount) || p.amount <= 0 || p.address !== p.worker ||
        escrowReceiptDigest(p.escId, p.taskHash, p.worker, p.amount) !== p.digestHex) fail('invalid_wallet_operation');
    const secret = await decryptEnvelope(await readEnvelope(profilePath), password);
    if (secret.network !== expectedNetwork || p.worker !== secret.address) fail('wallet_profile_or_digest_mismatch');
    const signature = crypto.sign(null, Buffer.from(p.digestHex, 'hex'), secret.privKey).toString('hex');
    if (!crypto.verify(null, Buffer.from(p.digestHex, 'hex'), secret.pub, Buffer.from(signature, 'hex'))) fail('wallet_signature_self_check_failed');
    return { schema: 'agt-agent-wallet-signed-op-v1', opId: operation.opId, digestHex: p.digestHex, signature, pub: secret.pub,
      network: expectedNetwork, genesisHash: expectedGenesisHash, sourceOrigin: origin };
  }

  const hasRef = Object.keys(p).sort().join('|') === 'kind|ref|tx|txidHex';
  if (!['send', 'order'].includes(p.kind) || (!hasRef && Object.keys(p).sort().join('|') !== 'kind|tx|txidHex') ||
      !p.tx || Object.getPrototypeOf(p.tx) !== Object.prototype || Object.keys(p.tx).sort().join('|') !== 'amount|from|fromPub|memo|nonce|to|ts|txid' ||
      p.txidHex !== p.tx.txid) fail('invalid_wallet_operation');
  const tx = p.tx;
  if (typeof tx.from !== 'string' || typeof tx.to !== 'string' || !/^AGT[0-9a-f]{40}$/.test(tx.from) ||
      !/^AGT[0-9a-f]{40}$/.test(tx.to) || typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) ||
      !Number.isSafeInteger(tx.nonce) || !Number.isSafeInteger(tx.ts) || typeof tx.memo !== 'string' ||
      Buffer.byteLength(tx.memo, 'utf8') > 512 || /[\u0000-\u001f\u007f]/.test(tx.memo) ||
      tx.ts > Math.floor(Date.now() / 1000) + 30 || Math.floor(Date.now() / 1000) - tx.ts > 300) fail('invalid_wallet_operation');
  if (p.kind === 'send') {
    if (hasRef || tx.to === tx.from) fail('invalid_wallet_operation');
  } else {
    const match = /^dxe\|O\|([bs])\|([^|\r\n]{1,40})\|((?:0\.\d+|[1-9]\d*(?:\.\d+)?))\|((?:0\.\d+|[1-9]\d*(?:\.\d+)?))\|([A-Za-z0-9]{8})$/.exec(tx.memo);
    if (!hasRef || !match || !match[2].startsWith('mbc20:') || !Number.isFinite(Number(match[3])) || Number(match[3]) <= 0 ||
        !Number.isFinite(Number(match[4])) || Number(match[4]) <= 0 || String(Number(match[3])) !== match[3] || String(Number(match[4])) !== match[4] ||
        tx.to !== tx.from || tx.amount !== 0.001 || p.ref !== match[5]) fail('invalid_wallet_operation');
  }
  const secret = await decryptEnvelope(await readEnvelope(profilePath), password);
  if (secret.network !== expectedNetwork || tx.from !== secret.address || tx.fromPub !== secret.pub || tx.txid !== txDigest(tx)) fail('wallet_profile_or_txid_mismatch');
  // Parse the public site's amount through the same exact 1e-9-unit conversion as consensus.
  unitsOfAmountBigInt(tx.amount);
  const signature = crypto.sign(null, Buffer.from(tx.txid, 'hex'), secret.privKey).toString('hex');
  if (!crypto.verify(null, Buffer.from(tx.txid, 'hex'), secret.pub, Buffer.from(signature, 'hex'))) fail('wallet_signature_self_check_failed');
  return { schema: 'agt-agent-wallet-signed-op-v1', opId: operation.opId, txid: tx.txid, signature, pub: secret.pub,
    network: expectedNetwork, genesisHash: expectedGenesisHash, sourceOrigin: origin };
}

/** Sign only a DXE cancellation self-transfer with the pinned local node and explicit ref. */
export async function signProfileDxeCancellation({ profilePath = DEFAULT_PROFILE_PATH, password, tx,
  expectedNetwork, expectedGenesisHash, expectedNodeOrigin, now = Date.now() } = {}) {
  let origin; try { origin = new URL(expectedNodeOrigin).origin; } catch { fail('wallet_trust_pin_mismatch'); }
  if (typeof expectedNetwork !== 'string' || !/^[a-f0-9]{64}$/.test(expectedGenesisHash || '') || origin !== expectedNodeOrigin ||
      !/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)) fail('wallet_trust_pin_mismatch');
  if (!tx || Object.getPrototypeOf(tx) !== Object.prototype || Object.keys(tx).sort().join('|') !== 'amount|from|fromPub|memo|nonce|to|ts|txid' ||
      !/^AGT[0-9a-f]{40}$/.test(tx.from || '') || tx.to !== tx.from || tx.amount !== 0.001 ||
      !/^dxe\|C\|[A-Za-z0-9]{8}$/.test(tx.memo || '') || !Number.isSafeInteger(tx.nonce) || !Number.isSafeInteger(tx.ts) ||
      tx.ts > Math.floor(now / 1000) + 30 || Math.floor(now / 1000) - tx.ts > 300 || tx.txid !== txDigest(tx)) fail('invalid_dxe_cancellation');
  const secret = await decryptEnvelope(await readEnvelope(profilePath), password);
  if (secret.network !== expectedNetwork || tx.from !== secret.address || tx.fromPub !== secret.pub) fail('wallet_profile_or_txid_mismatch');
  const signature = crypto.sign(null, Buffer.from(tx.txid, 'hex'), secret.privKey).toString('hex');
  const signedTx = { ...tx, signature };
  if (!verifyTransaction(signedTx)) fail('wallet_signature_self_check_failed');
  return signedTx;
}

async function stdinJSON() {
  if (process.stdin.isTTY) fail('provide_secret_json_on_stdin');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_BYTES) fail('stdin_too_large'); chunks.push(chunk); }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!plainObject(input)) fail('stdin_json_object_required');
    return input;
  } catch { fail('invalid_stdin_json'); }
}
export async function runProfileCLI(args = process.argv.slice(2)) {
  const [command, profilePath = DEFAULT_PROFILE_PATH, extraPath, ...rest] = args;
  if (rest.length || !['create', 'info', 'public', 'backup', 'restore', 'sign-challenge'].includes(command) ||
      (extraPath && !['backup', 'restore'].includes(command))) fail('usage_agent_profile_command_profile_path_optional_backup_path');
  let result;
  if (command === 'public') result = await exportPublicProfile(profilePath);
  else {
    const input = await stdinJSON();
    if (command === 'create') result = await createProfile({ ...input, profilePath });
    if (command === 'info') result = await inspectProfile({ profilePath, password: input.password });
    if (command === 'backup') {
      if (!extraPath) fail('backup_path_required');
      await createEncryptedBackup({ profilePath, password: input.password, backupPassword: input.backupPassword ?? input.password, backupPath: extraPath });
      result = { ok: true, backupSaved: true, public: await readPublicProfile(profilePath) };
    }
    if (command === 'restore') result = await restoreProfile({ ...input, profilePath, ...(extraPath ? { backupPath: extraPath } : {}) });
    // The CLI always uses the local clock; stdin must not extend expiration.
    if (command === 'sign-challenge') result = await signProfileChallenge({ ...input, profilePath, now: Date.now() });
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProfileCLI().catch(error => {
    // Do not echo filesystem error paths, parser data, mnemonic words or crypto internals.
    const code = /^[a-z][a-z0-9_]{1,100}$/.test(error?.message || '') ? error.message : 'agent_profile_operation_failed';
    process.stderr.write(code + '\n'); process.exitCode = 1;
  });
}
