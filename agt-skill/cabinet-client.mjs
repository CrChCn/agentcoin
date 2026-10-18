#!/usr/bin/env node
// Noncustodial passport/cabinet client. Only public keys, certificates and
// domain-separated challenge signatures cross the network. No payment API.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILE_PATH, inspectProfile, signProfileChallenge } from './agent-profile.mjs';
import { canonicalAgentPassport, issuerFingerprint } from '../agent-identity.mjs';

export const DEFAULT_CONFIG_PATH = path.join(path.dirname(DEFAULT_PROFILE_PATH), 'node.json');
const MAX_LOCAL = 128 * 1024, MAX_RESPONSE = 1024 * 1024;
function fail(code) { throw new Error(code); }
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function fingerprint(v) { return typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v); }
function nodeURL(value) {
  let url; try { url = new URL(value); } catch { fail('invalid_node_url'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('node_url_must_be_bare_origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('https_required_except_loopback');
  return url.origin;
}
async function privateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('private_state_directory_required');
}
async function saveState(file, value, { overwrite = true } = {}) {
  file = path.resolve(file); const dir = path.dirname(file); await privateDir(dir);
  try { const existing = await fsp.lstat(file); if (!existing.isFile() || existing.isSymbolicLink()) fail('state_must_be_regular_file'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const temp = path.join(dir, '.cabinet-client-' + crypto.randomBytes(12).toString('hex'));
  let h;
  try {
    h = await fsp.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    await h.writeFile(JSON.stringify(value, null, 2) + '\n'); await h.sync(); await h.close(); h = null;
    if (overwrite) await fsp.rename(temp, file); else await fsp.link(temp, file);
    if (process.platform !== 'win32') { const d = await fsp.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } }
  } finally { await h?.close().catch(() => {}); await fsp.unlink(temp).catch(() => {}); }
}
async function readState(file) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('state_must_be_regular_file');
  const h = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await h.stat();
    if (!opened.isFile() || opened.size > MAX_LOCAL || (process.platform !== 'win32' && (opened.mode & 0o077))) fail('private_state_file_required');
    const buf = Buffer.alloc(MAX_LOCAL + 1); const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_LOCAL) fail('state_too_large');
    return JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
  } finally { await h.close(); }
}
async function api(url, method, endpoint, payload) {
  const response = await fetch(url + endpoint, { method, redirect: 'error', credentials: 'omit',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(10000) });
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength; if (size > MAX_RESPONSE) fail('node_response_too_large'); chunks.push(Buffer.from(chunk));
  }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_node_json'); }
  if (!object(data) || !response.ok || data.ok === false || data.error) fail('node_request_rejected');
  return data;
}
function configFields(config) {
  if (!object(config) || config.version !== 1 || config.nodeUrl !== nodeURL(config.nodeUrl) ||
      typeof config.network !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(config.network) ||
      !/^[a-f0-9]{64}$/.test(config.genesisHash) || !fingerprint(config.passportIssuerFingerprint) ||
      !fingerprint(config.nodeIssuerFingerprint) || typeof config.audience !== 'string' || !config.audience || config.audience.length > 256) fail('invalid_node_config');
  return config;
}
async function probe({ nodeUrl, expectedNetwork, expectedGenesisHash, expectedIssuerFingerprint }) {
  const url = nodeURL(nodeUrl);
  if (typeof expectedNetwork !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(expectedNetwork) ||
      !/^[a-f0-9]{64}$/.test(expectedGenesisHash) || !fingerprint(expectedIssuerFingerprint)) fail('explicit_network_genesis_issuer_pins_required');
  const info = await api(url, 'GET', '/info');
  if ((info.network ?? info.chainId) !== expectedNetwork || info.genesisHash !== expectedGenesisHash) fail('node_network_or_genesis_mismatch');
  const meta = await api(url, 'GET', '/identity/meta');
  const local = issuerFingerprint(meta.issuerPub);
  if (meta.network !== expectedNetwork || meta.issuerFingerprint !== local ||
      (meta.localIssuerFingerprint !== undefined && meta.localIssuerFingerprint !== local) ||
      typeof meta.audience !== 'string' || !meta.audience || meta.audience.length > 256) fail('invalid_identity_metadata');
  if (local !== expectedIssuerFingerprint && !(Array.isArray(meta.trustedIssuers) && meta.trustedIssuers.includes(expectedIssuerFingerprint))) fail('node_does_not_trust_pinned_issuer');
  if (meta.passportIssuerFingerprint !== undefined && meta.passportIssuerFingerprint !== expectedIssuerFingerprint) fail('passport_issuer_mismatch');
  return { version: 1, nodeUrl: url, network: expectedNetwork, genesisHash: expectedGenesisHash,
    passportIssuerFingerprint: expectedIssuerFingerprint, nodeIssuerFingerprint: local,
    audience: meta.audience, enrollmentEnabled: meta.enrollmentEnabled !== false && meta.role !== 'replica' && local === expectedIssuerFingerprint };
}
async function verifiedConnection(configPath) {
  const config = configFields(await readState(configPath));
  const current = await probe({ nodeUrl: config.nodeUrl, expectedNetwork: config.network,
    expectedGenesisHash: config.genesisHash, expectedIssuerFingerprint: config.passportIssuerFingerprint });
  if (current.nodeIssuerFingerprint !== config.nodeIssuerFingerprint || current.audience !== config.audience) fail('node_identity_changed_reconnect_required');
  return current;
}
export async function connectCabinet({ configPath = DEFAULT_CONFIG_PATH, nodeUrl, expectedIssuerFingerprint, expectedNetwork, expectedGenesisHash } = {}) {
  const config = await probe({ nodeUrl, expectedIssuerFingerprint, expectedNetwork, expectedGenesisHash });
  await saveState(configPath, config);
  // A session is scoped to a node+issuer. Changing the connection never reuses it.
  await fsp.unlink(configPath + '.session.json').catch(e => { if (e.code !== 'ENOENT') throw e; });
  return { ok: true, ...config };
}

export function verifyClientPassport(passport, { expectedNetwork, expectedIssuerFingerprint, identity, now = Date.now() }) {
  if (!object(passport) || Object.keys(passport).sort().join('|') !== ['issuerPub', 'payload', 'signature'].sort().join('|') ||
      Buffer.byteLength(JSON.stringify(passport)) > 4096 || !/^[a-f0-9]{128}$/i.test(passport.signature)) fail('invalid_passport');
  const message = canonicalAgentPassport(passport.payload);
  const fp = issuerFingerprint(passport.issuerPub), payload = passport.payload;
  if (payload.network !== expectedNetwork || fp !== expectedIssuerFingerprint || payload.issuerFingerprint !== fp || payload.issuedAt > now + 30000) fail('passport_not_pinned');
  if (!identity || payload.address !== identity.address || payload.pub !== identity.pub || payload.agentId !== identity.identityId) fail('passport_profile_mismatch');
  if (!crypto.verify(null, Buffer.from(message), passport.issuerPub, Buffer.from(passport.signature, 'hex'))) fail('passport_signature_invalid');
  return structuredClone(passport);
}
function signerOptions(config, profilePath, password, challenge, expectedAction) {
  return { profilePath, password, challenge, expectedAction, expectedAudience: config.audience,
    expectedIssuerFingerprint: config.nodeIssuerFingerprint, expectedNetwork: config.network };
}
export async function enrollAgent({ configPath = DEFAULT_CONFIG_PATH, profilePath = DEFAULT_PROFILE_PATH, password, handle } = {}) {
  const config = await verifiedConnection(configPath);
  if (!config.enrollmentEnabled) fail('enrollment_requires_pinned_issuer_node');
  const identity = await inspectProfile({ profilePath, password });
  if (identity.network !== config.network) fail('profile_network_mismatch');
  const challenge = await api(config.nodeUrl, 'POST', '/identity/challenge', { address: identity.address, pub: identity.pub, handle });
  if (challenge.handle !== handle) fail('registration_handle_mismatch');
  const signed = await signProfileChallenge(signerOptions(config, profilePath, password, challenge, 'register'));
  const result = await api(config.nodeUrl, 'POST', '/identity/register', { challengeId: signed.challengeId, signature: signed.signature });
  const passport = verifyClientPassport(result.passport, { expectedNetwork: config.network, expectedIssuerFingerprint: config.passportIssuerFingerprint, identity });
  const passportPath = profilePath + '.passport.json';
  await saveState(passportPath, passport, { overwrite: false });
  return { ok: true, identity, passport, passportSaved: true };
}
export async function loginAgent({ configPath = DEFAULT_CONFIG_PATH, profilePath = DEFAULT_PROFILE_PATH, password, passportPath = profilePath + '.passport.json' } = {}) {
  const config = await verifiedConnection(configPath);
  const identity = await inspectProfile({ profilePath, password });
  if (identity.network !== config.network) fail('profile_network_mismatch');
  const passport = verifyClientPassport(await readState(passportPath), { expectedNetwork: config.network, expectedIssuerFingerprint: config.passportIssuerFingerprint, identity });
  await api(config.nodeUrl, 'POST', '/identity/import', { passport });
  const challengeResponse = await api(config.nodeUrl, 'POST', '/cabinet/challenge', { address: identity.address });
  const challenge = challengeResponse.challenge ?? challengeResponse;
  const signed = await signProfileChallenge(signerOptions(config, profilePath, password, challenge, 'login'));
  const result = await api(config.nodeUrl, 'POST', '/cabinet/login', { address: identity.address, mode: 'challenge',
    challengeId: signed.challengeId, nonce: challenge.message, signature: signed.signature });
  const ttlMs = result.ttlSec !== undefined ? result.ttlSec * 1000 : result.ttlHours !== undefined ? result.ttlHours * 3600000 : null;
  const expiresAt = result.expiresAt ?? (ttlMs === null ? NaN : Date.now() + ttlMs);
  if (typeof result.token !== 'string' || result.token.length < 32 || result.token.length > 1024 || /[\u0000-\u001f\u007f]/.test(result.token) ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 24 * 3600000) fail('invalid_session_response');
  await saveState(configPath + '.session.json', { version: 1, nodeUrl: config.nodeUrl, nodeIssuerFingerprint: config.nodeIssuerFingerprint,
    address: identity.address, token: result.token, expiresAt });
  return { ok: true, address: identity.address, sessionSaved: true, expiresAt };
}
export async function cabinetState({ configPath = DEFAULT_CONFIG_PATH, profilePath = DEFAULT_PROFILE_PATH } = {}) {
  const config = await verifiedConnection(configPath), session = await readState(configPath + '.session.json');
  // readPublicProfile is metadata only; compare against the locally bound session,
  // not an arbitrary address supplied over the network.
  const { readPublicProfile } = await import('./agent-profile.mjs');
  const identity = await readPublicProfile(profilePath);
  if (!object(session) || session.version !== 1 || session.nodeUrl !== config.nodeUrl ||
      session.nodeIssuerFingerprint !== config.nodeIssuerFingerprint || session.address !== identity.address ||
      !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now()) fail('session_missing_expired_or_wrong_node');
  const result = await api(config.nodeUrl, 'POST', '/cabinet/state', { address: identity.address, token: session.token });
  if (result.wallet?.address !== identity.address) fail('cabinet_state_address_mismatch');
  // Tokens belong only in the private local session file, including against an
  // unexpected server accidentally echoing a token in a response.
  return redactSessionSecrets(result, session.token);
}
function redactSessionSecrets(value, token) {
  if (typeof value === 'string') return value.includes(token) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(v => redactSessionSecrets(v, token));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(token|sessionToken|privKey|mnemonic|password)$/i.test(key)).map(([key, v]) => [key, redactSessionSecrets(v, token)]));
  return value;
}
async function stdinJSON() {
  if (process.stdin.isTTY) fail('provide_secret_json_on_stdin');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_LOCAL) fail('stdin_too_large'); chunks.push(chunk); }
  let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_stdin_json'); }
  if (!object(input)) fail('stdin_json_object_required'); return input;
}
export async function runCabinetCLI(args = process.argv.slice(2)) {
  const [command, configPath = DEFAULT_CONFIG_PATH, profilePath = DEFAULT_PROFILE_PATH, ...extra] = args;
  if (extra.length || !['connect', 'enroll', 'login', 'state'].includes(command)) fail('usage_cabinet_client_connect_enroll_login_state_config_profile');
  let result;
  if (command === 'state') result = await cabinetState({ configPath, profilePath });
  else {
    const input = await stdinJSON();
    if (command === 'connect') result = await connectCabinet({ ...input, configPath });
    if (command === 'enroll') result = await enrollAgent({ configPath, profilePath, password: input.password, handle: input.handle });
    if (command === 'login') result = await loginAgent({ configPath, profilePath, password: input.password, ...(input.passportPath ? { passportPath: input.passportPath } : {}) });
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCabinetCLI().catch(error => {
    const code = /^[a-z][a-z0-9_]{1,100}$/.test(error?.message || '') ? error.message : 'cabinet_client_operation_failed';
    process.stderr.write(code + '\n'); process.exitCode = 1;
  });
}
