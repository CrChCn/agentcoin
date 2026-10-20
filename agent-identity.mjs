// Public, portable agent identity. Agent signing keys never enter this registry.
// The issuer key attests passport records; it cannot sign agent transactions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { addressFromPub } from './core.mjs';

export const AGENT_IDENTITY_DOMAIN = 'AGT-IDENTITY-V1';
export const AGENT_PASSPORT_DOMAIN = 'AGT-PASSPORT-V1';
const MAX_TTL_MS = 5 * 60_000;
const MAX_CERT_BYTES = 4096;
const CHALLENGE_KEYS = ['version', 'domain', 'action', 'network', 'issuerFingerprint', 'audience', 'address', 'pub', 'handle', 'challengeId', 'nonce', 'issuedAt', 'expiresAt'];
const PAYLOAD_KEYS = ['version', 'network', 'agentId', 'address', 'pub', 'handle', 'issuedAt', 'issuerFingerprint'];

function fail(code) { const e = new Error(code); e.code = code; throw e; }
function object(value, code = 'invalid_object') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(code);
  return value;
}
function exactKeys(value, required, optional = []) {
  object(value);
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail('invalid_schema');
}
function text(value, name, max, pattern) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\x00-\x1f\x7f]/.test(value) || (pattern && !pattern.test(value))) fail(`invalid_${name}`);
  return value;
}
function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`invalid_${name}`);
  return value;
}
function networkName(value) { return text(value, 'network', 96, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/); }
function fingerprintValue(value) { return text(value, 'issuer_fingerprint', 71, /^sha256:[0-9a-f]{64}$/); }
function addressValue(value) { return text(value, 'address', 43, /^AGT[0-9a-f]{40}$/); }
function handleValue(value) {
  text(value, 'handle', 64, /^[\p{L}\p{N}][\p{L}\p{N}_. -]*$/u);
  if (value.normalize('NFKC').trim() !== value) fail('invalid_handle');
  return value;
}
function handleKey(value) { return handleValue(value).toLocaleLowerCase('en-US'); }
function signatureBytes(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{128}$/.test(value)) fail('invalid_signature');
  return Buffer.from(value, 'hex');
}
const clone = value => JSON.parse(JSON.stringify(value));

export function canonicalAgentPublicKey(pub) {
  if (typeof pub !== 'string' || pub.length > 512 || !pub.startsWith('-----BEGIN PUBLIC KEY-----\n')) fail('invalid_public_key');
  let key;
  try { key = crypto.createPublicKey(pub); } catch { fail('invalid_public_key'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('invalid_public_key');
  const canonical = key.export({ type: 'spki', format: 'pem' });
  if (canonical !== pub) fail('noncanonical_public_key');
  return canonical;
}

export function issuerFingerprint(pub) {
  const canonical = canonicalAgentPublicKey(pub);
  const der = crypto.createPublicKey(canonical).export({ type: 'spki', format: 'der' });
  return 'sha256:' + crypto.createHash('sha256').update(der).digest('hex');
}

export function agentIdentityId(network, pub, address = addressFromPub(pub)) {
  networkName(network); canonicalAgentPublicKey(pub); addressValue(address);
  if (addressFromPub(pub) !== address) fail('address_public_key_mismatch');
  return 'agt-agent:' + crypto.createHash('sha256').update(JSON.stringify([network, address, pub])).digest('hex');
}

function challengeFields(c) {
  exactKeys(c, CHALLENGE_KEYS, ['ok', 'message']);
  if (c.version !== 1 || c.domain !== AGENT_IDENTITY_DOMAIN) fail('unsupported_identity_version');
  if (!['register', 'login'].includes(c.action)) fail('unsupported_identity_action');
  if (Object.hasOwn(c, 'ok') && c.ok !== true) fail('invalid_challenge_status');
  networkName(c.network); fingerprintValue(c.issuerFingerprint);
  text(c.audience, 'audience', 256); addressValue(c.address); canonicalAgentPublicKey(c.pub);
  if (addressFromPub(c.pub) !== c.address) fail('address_public_key_mismatch');
  if (c.action === 'register') handleValue(c.handle);
  else if (c.handle !== '') fail('invalid_login_handle');
  text(c.challengeId, 'challenge_id', 32, /^[0-9a-f]{32}$/);
  text(c.nonce, 'nonce', 64, /^[0-9a-f]{64}$/);
  timestamp(c.issuedAt, 'issued_at'); timestamp(c.expiresAt, 'expires_at');
  if (c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > MAX_TTL_MS) fail('invalid_challenge_ttl');
  return Object.fromEntries(CHALLENGE_KEYS.map(k => [k, c[k]]));
}

export function canonicalAgentChallenge(challenge) {
  const c = challengeFields(challenge);
  return AGENT_IDENTITY_DOMAIN + '\n' + JSON.stringify([
    c.version, c.action, c.network, c.issuerFingerprint, c.audience, c.address,
    c.pub, c.handle, c.challengeId, c.nonce, c.issuedAt, c.expiresAt,
  ]);
}

export function validateAgentChallenge(challenge, expected = {}) {
  const c = challengeFields(challenge);
  const now = expected.now ?? Date.now(); timestamp(now, 'now');
  if (now >= c.expiresAt) fail('challenge_expired');
  if (c.issuedAt > now + 30_000) fail('challenge_from_future');
  for (const k of ['network', 'audience', 'issuerFingerprint', 'action', 'address', 'pub']) {
    if (Object.hasOwn(expected, k) && expected[k] !== c[k]) fail(`challenge_${k}_mismatch`);
  }
  if (Object.hasOwn(challenge, 'message') && challenge.message !== canonicalAgentChallenge(c)) fail('challenge_message_mismatch');
  return c;
}

export function createAgentChallenge(fields, { now = Date.now(), ttlMs = MAX_TTL_MS } = {}) {
  object(fields); timestamp(now, 'now');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) fail('invalid_challenge_ttl');
  const c = {
    version: 1, domain: AGENT_IDENTITY_DOMAIN, action: fields.action,
    network: fields.network, issuerFingerprint: fields.issuerFingerprint,
    audience: fields.audience, address: fields.address, pub: fields.pub,
    handle: fields.handle ?? '', challengeId: crypto.randomBytes(16).toString('hex'),
    nonce: crypto.randomBytes(32).toString('hex'), issuedAt: now, expiresAt: now + ttlMs,
  };
  return { ...c, message: canonicalAgentChallenge(c) };
}

export function canonicalAgentPassport(payload) {
  exactKeys(payload, PAYLOAD_KEYS);
  if (payload.version !== 1) fail('unsupported_passport_version');
  networkName(payload.network); addressValue(payload.address); canonicalAgentPublicKey(payload.pub);
  handleValue(payload.handle); timestamp(payload.issuedAt, 'issued_at'); fingerprintValue(payload.issuerFingerprint);
  if (payload.agentId !== agentIdentityId(payload.network, payload.pub, payload.address)) fail('invalid_agent_id');
  return AGENT_PASSPORT_DOMAIN + '\n' + JSON.stringify(PAYLOAD_KEYS.map(k => payload[k]));
}

function atomicWrite(file, value, mode = 0o600) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    // Directory fsync is available on Unix; unsupported on Windows.
    if (process.platform !== 'win32') { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function boundedRead(file, maxBytes) {
  if (fs.statSync(file).size > maxBytes) fail('identity_file_too_large');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadIssuer(file) {
  if (!fs.existsSync(file)) {
    const pair = crypto.generateKeyPairSync('ed25519');
    const value = { version: 1, pub: pair.publicKey.export({ type: 'spki', format: 'pem' }), privKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      // Link publishes a complete file exclusively; concurrent first startups cannot rotate the issuer.
      try { fs.linkSync(temp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  const value = boundedRead(file, 4096);
  // Ротация издателя добавляет шахматные метаданные createdAt/rotatedFrom — они допустимы,
  // но ничего иного сверх ключа издателя не признaётся (fail-closed).
  const metaKeys = new Set(['createdAt', 'rotatedFrom']);
  const keys = Object.keys(value);
  const missing = ['version', 'pub', 'privKey'].filter(k => !keys.includes(k));
  if (missing.length || keys.some(k => ![...metaKeys, 'version', 'pub', 'privKey'].includes(k))) fail('invalid_issuer_key_file');
  if (value.createdAt !== undefined && (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0)) fail('invalid_issuer_key_file');
  if (value.rotatedFrom !== undefined && value.rotatedFrom !== null && (typeof value.rotatedFrom !== 'string' || value.rotatedFrom.length > 80)) fail('invalid_issuer_key_file');
  if (value.version !== 1 || typeof value.privKey !== 'string' || value.privKey.length > 1024) fail('invalid_issuer_key_file');
  canonicalAgentPublicKey(value.pub);
  let key;
  try { key = crypto.createPrivateKey(value.privKey); } catch { fail('invalid_issuer_key_file'); }
  if (key.asymmetricKeyType !== 'ed25519' || crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== value.pub) fail('issuer_key_mismatch');
  fs.chmodSync(file, 0o600);
  return value;
}

function publicIdentity(cert) { return { ...clone(cert.payload), certificate: clone(cert) }; }
function resultError(e) { return { ok: false, error: e.code || 'identity_operation_failed' }; }

export class AgentIdentityRegistry {
  constructor({ dataDir, network = 'AGENTCOIN', audience = 'agentcoin', trustedIssuers = [], now = Date.now, challengeTtlMs = MAX_TTL_MS, maxChallenges = 1000, maxPassports = 100_000 } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) fail('identity_data_dir_required');
    this.network = networkName(network); this.audience = text(audience, 'audience', 256);
    if (typeof now !== 'function') fail('invalid_clock');
    if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 1000 || challengeTtlMs > MAX_TTL_MS) fail('invalid_challenge_ttl');
    if (!Number.isSafeInteger(maxChallenges) || maxChallenges < 1 || maxChallenges > 10_000 || !Number.isSafeInteger(maxPassports) || maxPassports < 1 || maxPassports > 100_000) fail('invalid_identity_capacity');
    this.now = now; this.challengeTtlMs = challengeTtlMs; this.maxChallenges = maxChallenges; this.maxPassports = maxPassports;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, 'agent-identities.json');
    this._issuer = loadIssuer(path.join(dataDir, 'identity-issuer.json'));
    this._issuerFingerprint = issuerFingerprint(this._issuer.pub);
    if (!Array.isArray(trustedIssuers) || trustedIssuers.length > 100) fail('invalid_trusted_issuers');
    this._trusted = new Map([[this._issuerFingerprint, this._issuer.pub]]);
    for (const pub of trustedIssuers) this._trusted.set(issuerFingerprint(pub), pub);
    this._challenges = new Map(); this._records = new Map(); this._handles = new Map();
    if (fs.existsSync(this.file)) {
      const stored = boundedRead(this.file, Math.max(4096, maxPassports * MAX_CERT_BYTES));
      exactKeys(stored, ['version', 'network', 'passports']);
      if (stored.version !== 1 || stored.network !== this.network || !Array.isArray(stored.passports) || stored.passports.length > maxPassports) fail('invalid_identity_registry');
      for (const cert of stored.passports) {
        const checked = this.verifyPassport(cert);
        if (!checked.ok) fail('invalid_stored_passport_' + checked.error);
        const p = checked.passport.payload;
        if (this._records.has(p.address) || this._handles.has(handleKey(p.handle))) fail('duplicate_stored_identity');
        this._records.set(p.address, checked.passport); this._handles.set(handleKey(p.handle), p.address);
      }
    }
  }

  meta() {
    return { ok: true, version: 1, domain: AGENT_IDENTITY_DOMAIN, network: this.network, audience: this.audience, issuerFingerprint: this._issuerFingerprint, issuerPub: this._issuer.pub, trustedIssuers: [...this._trusted.keys()], challengeTtlMs: this.challengeTtlMs };
  }

  _pruneChallenges() {
    const now = this.now();
    for (const [id, c] of this._challenges) if (c.expiresAt <= now) this._challenges.delete(id);
  }

  challengeRegistration(input) {
    try {
      exactKeys(input, ['address', 'pub', 'handle']);
      const { address, pub, handle } = input;
      addressValue(address); canonicalAgentPublicKey(pub); handleValue(handle);
      if (addressFromPub(pub) !== address) fail('address_public_key_mismatch');
      if (this._records.has(address)) fail('identity_already_registered');
      if (this._handles.has(handleKey(handle))) fail('handle_unavailable');
      this._pruneChallenges();
      if (this._challenges.size >= this.maxChallenges) fail('challenge_capacity');
      if ([...this._challenges.values()].filter(c => c.address === address).length >= 3) fail('address_challenge_capacity');
      const c = createAgentChallenge({ action: 'register', network: this.network, issuerFingerprint: this._issuerFingerprint, audience: this.audience, address, pub, handle }, { now: this.now(), ttlMs: this.challengeTtlMs });
      this._challenges.set(c.challengeId, c);
      return { ok: true, ...clone(c) };
    } catch (e) { return resultError(e); }
  }

  register(input) {
    try {
      exactKeys(input, ['challengeId', 'signature']);
      if (typeof input.challengeId !== 'string' || !/^[0-9a-f]{32}$/.test(input.challengeId)) fail('invalid_challenge_id');
      const c = this._challenges.get(input.challengeId);
      if (!c) fail('challenge_not_issued');
      this._challenges.delete(input.challengeId); // Consume before verification, including failed proofs.
      validateAgentChallenge(c, { now: this.now(), network: this.network, audience: this.audience, issuerFingerprint: this._issuerFingerprint, action: 'register' });
      if (!crypto.verify(null, Buffer.from(c.message, 'utf8'), c.pub, signatureBytes(input.signature))) fail('invalid_signature');
      const payload = { version: 1, network: this.network, agentId: agentIdentityId(this.network, c.pub, c.address), address: c.address, pub: c.pub, handle: c.handle, issuedAt: this.now(), issuerFingerprint: this._issuerFingerprint };
      const cert = { payload, issuerPub: this._issuer.pub, signature: crypto.sign(null, Buffer.from(canonicalAgentPassport(payload), 'utf8'), this._issuer.privKey).toString('hex') };
      return this._store(cert);
    } catch (e) { return resultError(e); }
  }

  verifyPassport(cert) {
    try {
      exactKeys(cert, ['payload', 'issuerPub', 'signature']);
      if (Buffer.byteLength(JSON.stringify(cert), 'utf8') > MAX_CERT_BYTES) fail('passport_too_large');
      const message = canonicalAgentPassport(cert.payload);
      if (cert.payload.network !== this.network) fail('passport_network_mismatch');
      if (cert.payload.issuedAt > this.now() + 30_000) fail('passport_from_future');
      const fp = issuerFingerprint(cert.issuerPub);
      if (fp !== cert.payload.issuerFingerprint) fail('issuer_fingerprint_mismatch');
      if (this._trusted.get(fp) !== cert.issuerPub) fail('untrusted_passport_issuer');
      if (!crypto.verify(null, Buffer.from(message, 'utf8'), cert.issuerPub, signatureBytes(cert.signature))) fail('invalid_passport_signature');
      const passport = clone(cert);
      return { ok: true, passport, identity: publicIdentity(passport) };
    } catch (e) { return resultError(e); }
  }

  _store(cert) {
    const p = cert.payload; const previous = this._records.get(p.address);
    if (previous) {
      if (JSON.stringify(previous) === JSON.stringify(cert)) return { ok: true, passport: clone(previous), identity: publicIdentity(previous), existing: true };
      fail('identity_conflict'); // Import cannot silently rename/reissue an existing identity.
    }
    if (this._handles.has(handleKey(p.handle))) fail('handle_unavailable');
    if (this._records.size >= this.maxPassports) fail('passport_capacity');
    const next = [...this._records.values(), cert];
    atomicWrite(this.file, { version: 1, network: this.network, passports: next });
    this._records.set(p.address, clone(cert)); this._handles.set(handleKey(p.handle), p.address);
    return { ok: true, passport: clone(cert), identity: publicIdentity(cert) };
  }

  importPassport(cert) {
    const checked = this.verifyPassport(cert);
    if (!checked.ok) return checked;
    try { return this._store(checked.passport); } catch (e) { return resultError(e); }
  }

  findByAddress(address) {
    const cert = typeof address === 'string' ? this._records.get(address) : null;
    return cert ? publicIdentity(cert) : null;
  }
}
