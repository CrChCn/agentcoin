#!/usr/bin/env node
/* Уровень 3 как машинное доказательство (Stage A fix5).

   fix4 принимал любой JSON с полями ok/adapter/threadId/attacks, поэтому
   уровень 3 подделывался вручную за минуту. Здесь доказательство:

   - подписано HMAC-SHA256 ключом, который лежит ВНЕ workspace агента
     (`~/.agentcoin/evidence-hmac.key`, создаётся при первом hostile-прогоне);
   - привязано к одноразовому nonce, выданному и учитываемому в реестре рядом
     с ключом;
   - привязано к машине (host fingerprint) и сборке (commit + SHA256 bwrap,
     Codex entrypoint, policy, proxy/broker, attack matrix, orchestrator);
   - содержит полный фиксированный список attack ID с техническим результатом
     каждой атаки и хэш-цепочку журнала инструментов.

   Preflight отклоняет: неизвестный/пропущенный/повторный attack ID, другой
   хэш кода или Codex, другой host fingerprint, просроченный nonce, запись без
   проверяемой подписи. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ORCH_ROOT } from './package.mjs';
import { toolEnv } from './envpolicy.mjs';
import { canonical, GENESIS, chainEntry, sha256Text } from './journal.mjs';

export const EVIDENCE_VERSION = 2;
export const NONCE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const EVIDENCE_SIGNATURE_ALG = 'hmac-sha256';

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
export const sha256File = (file) => {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
};

export function evidenceHome(env = process.env) {
  return env.ORCH_EVIDENCE_HOME || path.join(os.homedir(), '.agentcoin');
}

export const keyFile = (env = process.env) => path.join(evidenceHome(env), 'evidence-hmac.key');
export const nonceFile = (env = process.env) => path.join(evidenceHome(env), 'nonces.json');

export const keyIdOf = (key) => sha256(key).slice(0, 16);

/* Ключ создаётся один раз на машину и никогда не попадает в репозиторий:
   каталог лежит в домашнем каталоге пользователя, режим 0600. Если его нет и
   создание запрещено (тест/preflight), доказательство не принимается. */
export function loadKey({ create = false, env = process.env } = {}) {
  const home = evidenceHome(env);
  const file = keyFile(env);
  try {
    const raw = fs.readFileSync(file);
    const key = Buffer.from(String(raw).trim(), 'base64');
    if (key.length < 32) throw new Error('key material is too short');
    return { ok: true, key, file, keyId: keyIdOf(key) };
  } catch (err) {
    if (!create) {
      return {
        ok: false,
        code: 'EVIDENCE_KEY_UNAVAILABLE',
        detail: `no evidence signing key at ${file}; level-3 evidence cannot be verified (${err.code || err.message})`,
      };
    }
  }
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows ACL: каталог всё равно вне репозитория */
    }
    return { ok: true, key, file, keyId: keyIdOf(key), created: true };
  } catch (err) {
    return { ok: false, code: 'EVIDENCE_KEY_UNAVAILABLE', detail: `cannot create ${file}: ${err.message || err}` };
  }
}

function readLedger(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(nonceFile(env), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLedger(entries, env) {
  const file = nonceFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/* Одноразовый nonce: выдаётся перед hostile-прогоном, живёт ограниченное
   время, привязывается к хэшу конкретного evidence и не может быть
   использован вторым файлом. */
export function issueNonce({ env = process.env, ttlMs = NONCE_TTL_MS, now = Date.now() } = {}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const ledger = readLedger(env);
  ledger.push({ nonce, issuedAt, expiresAt, evidenceSha256: null });
  try {
    writeLedger(ledger, env);
  } catch (err) {
    return { ok: false, code: 'EVIDENCE_NONCE_STORE_UNAVAILABLE', detail: `cannot record nonce in ${nonceFile(env)}: ${err.message || err}` };
  }
  return { ok: true, nonce, issuedAt, expiresAt };
}

export function consumeNonce(nonce, evidenceSha256, { env = process.env, now = Date.now() } = {}) {
  if (typeof nonce !== 'string' || nonce.length < 16) {
    return { ok: false, code: 'nonce_missing', detail: 'evidence has no valid nonce' };
  }
  const ledger = readLedger(env);
  const entry = ledger.find((item) => item && item.nonce === nonce);
  if (!entry) {
    return { ok: false, code: 'nonce_not_issued', detail: `nonce ${nonce.slice(0, 12)}… was not issued on this machine` };
  }
  if (Date.parse(entry.expiresAt) < now) {
    return { ok: false, code: 'nonce_expired', detail: `nonce ${nonce.slice(0, 12)}… expired at ${entry.expiresAt}` };
  }
  if (entry.evidenceSha256 && entry.evidenceSha256 !== evidenceSha256) {
    return { ok: false, code: 'nonce_reused', detail: `nonce ${nonce.slice(0, 12)}… was already bound to another evidence file` };
  }
  if (!entry.evidenceSha256) {
    entry.evidenceSha256 = evidenceSha256;
    entry.usedAt = new Date(now).toISOString();
    try {
      writeLedger(ledger, env);
    } catch {
      /* Реестр недоступен на запись: доказательство всё равно не принимаем,
         потому что одноразовость перестаёт быть проверяемой. */
      return { ok: false, code: 'nonce_store_unwritable', detail: `cannot mark nonce ${nonce.slice(0, 12)}… as used` };
    }
  }
  return { ok: true, entry };
}

/* ---------- привязка к машине и сборке ---------- */

export function hostFingerprint() {
  const cpu = (os.cpus() || [])[0];
  return sha256Text(canonical({
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    machine: typeof os.machine === 'function' ? os.machine() : null,
    cpu: cpu ? cpu.model : null,
    memory: os.totalmem(),
  }));
}

export function hostInfo() {
  return {
    fingerprint: hostFingerprint(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
  };
}

function backendRun(backend, args, timeout = 20000) {
  const command = backend === 'wsl-bwrap' ? 'wsl.exe' : args[0];
  const commandArgs = backend === 'wsl-bwrap' ? ['-e', ...args] : args.slice(1);
  return spawnSync(command, commandArgs, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: toolEnv(),
    shell: false,
    windowsHide: true,
  });
}

export function bwrapFingerprint(backend = process.platform === 'win32' ? 'wsl-bwrap' : 'bwrap') {
  if (backend !== 'wsl-bwrap' && backend !== 'bwrap') {
    return { available: false, version: null, sha256: null };
  }
  const script = 'p=$(command -v bwrap) || exit 9; "$p" --version; sha256sum "$p"';
  const result = backend === 'wsl-bwrap'
    ? backendRun('wsl-bwrap', ['bash', '-lc', script])
    : spawnSync('bash', ['-lc', script], { encoding: 'utf8', timeout: 20000, env: toolEnv(), windowsHide: true });
  if (result.status !== 0) return { available: false, version: null, sha256: null };
  const lines = String(result.stdout || '').trim().split('\n');
  const version = (lines[0] || '').trim() || null;
  const match = /^([a-f0-9]{64})\s+/.exec((lines[1] || '').trim());
  return { available: Boolean(version && match), version, sha256: match ? match[1] : null };
}

function findOnPath(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: toolEnv(),
    shell: false,
  });
  return result.status === 0 ? (String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || null) : null;
}

function jsEntrypointOf(shim) {
  if (!shim) return null;
  const dir = path.dirname(shim);
  const candidates = [
    path.join(dir, '..', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(dir, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export function codexEntrypoint(env = process.env) {
  const raw = env.CODEX_BIN || 'codex';
  if (/\.(mjs|cjs|js)$/i.test(raw)) return path.resolve(raw);
  const found = findOnPath(raw);
  if (!found) return null;
  if (/\.(cmd|bat)$/i.test(found)) return jsEntrypointOf(found) || found;
  return found;
}

export function codexFingerprint(env = process.env) {
  const entry = codexEntrypoint(env);
  if (!entry || !fs.existsSync(entry)) return { available: false, sha256: null, version: null };
  let version = null;
  const args = /\.(mjs|cjs|js)$/i.test(entry) ? [entry, '--version'] : ['--version'];
  const result = spawnSync(process.execPath && !/\.(mjs|cjs|js)$/i.test(entry) ? entry : process.execPath, args, {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: toolEnv(),
    shell: false,
  });
  if (result.status === 0) version = String(result.stdout || '').split('\n')[0].trim() || null;
  return { available: true, sha256: sha256File(entry), version };
}

export function gitFingerprint(root = ORCH_ROOT) {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 8000, env: toolEnv() });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 8000, env: toolEnv() });
  const dirtyFiles = status.status === 0
    ? String(status.stdout || '').split('\n').filter((line) => line.trim()).length
    : null;
  return {
    commit: commit.status === 0 ? String(commit.stdout || '').trim() : null,
    dirty: dirtyFiles === null ? null : dirtyFiles > 0,
    dirtyFiles,
  };
}

export function fileFingerprint(root = ORCH_ROOT) {
  const rel = (file) => path.join(root, file);
  return {
    policy: sha256File(rel('lib/toolpolicy.mjs')),
    broker: sha256File(rel('tools/tool-broker.mjs')),
    proxy: sha256File(rel('tools/tool-proxy.mjs')),
    sandbox: sha256File(rel('lib/sandbox.mjs')),
    agentsandbox: sha256File(rel('lib/agentsandbox.mjs')),
    matrix: sha256File(rel('lib/attackmatrix.mjs')),
    evidence: sha256File(rel('lib/evidence.mjs')),
    orchestrator: sha256File(rel('orchestrator.mjs')),
  };
}

export function currentBuildFingerprint({ backend = null, root = ORCH_ROOT, env = process.env } = {}) {
  return {
    ...gitFingerprint(root),
    bwrap: bwrapFingerprint(backend || undefined),
    codex: codexFingerprint(env),
    files: fileFingerprint(root),
  };
}

/* ---------- подпись ---------- */

export function payloadOf(evidence) {
  const { signature, ...rest } = evidence || {};
  return rest;
}

export function payloadDigest(evidence) {
  return sha256Text(canonical(payloadOf(evidence)));
}

export function signEvidence(evidence, { key } = {}) {
  if (!key) return { ok: false, code: 'EVIDENCE_KEY_UNAVAILABLE', detail: 'no signing key' };
  const mac = crypto.createHmac('sha256', key).update(canonical(payloadOf(evidence))).digest('hex');
  return { ok: true, evidence: { ...evidence, signature: { alg: EVIDENCE_SIGNATURE_ALG, keyId: keyIdOf(key), mac } } };
}

export function verifySignature(evidence, { key } = {}) {
  if (!key) return { ok: false, code: 'signature_missing_key', detail: 'no verification key' };
  const signature = evidence && evidence.signature;
  if (!signature || signature.alg !== EVIDENCE_SIGNATURE_ALG || typeof signature.mac !== 'string' || signature.mac.length !== 64) {
    return { ok: false, code: 'signature_missing', detail: 'evidence has no verifiable HMAC signature' };
  }
  if (signature.keyId !== keyIdOf(key)) {
    return { ok: false, code: 'signature_unknown_key', detail: `evidence was signed with key ${signature.keyId}, current key is ${keyIdOf(key)}` };
  }
  const expected = crypto.createHmac('sha256', key).update(canonical(payloadOf(evidence))).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.mac, 'hex'))) {
    return { ok: false, code: 'signature_invalid', detail: 'HMAC does not match the evidence payload' };
  }
  return { ok: true };
}

/* Журнал: единая функция цепочки для broker и проверяющего. */
export function chainJournal(entries) {
  let prev = GENESIS;
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const { hash, prev: _ignored, ...base } = entry || {};
    const chained = chainEntry(base, prev);
    prev = chained.hash;
    return chained;
  });
}

/* ---------- утечки из auth.json ---------- */

export const MIN_SECRET_VALUE_LENGTH = 16;

/* Значения читаются из временной копии auth.json и остаются в памяти: в
   evidence попадают только их SHA256. Токен не должен оказаться ни в журнале,
   ни в evidence, ни в выводе проверки. */
export function authSecrets(file) {
  const values = [];
  const hashes = [];
  const walk = (value, prefix) => {
    if (typeof value === 'string') {
      if (value.length >= MIN_SECRET_VALUE_LENGTH) {
        values.push(value);
        hashes.push({ name: prefix || 'auth.json#value', sha256: sha256Text(value) });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${prefix}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) walk(item, prefix ? `${prefix}.${name}` : name);
    }
  };
  try {
    walk(JSON.parse(fs.readFileSync(file, 'utf8')), '');
  } catch {
    return { ok: false, code: 'AUTH_COPY_UNREADABLE', values, hashes };
  }
  return { ok: true, values, hashes };
}

/* Возвращает только имена/хэши найденных утечек, никогда — сами значения. */
export function findSecretLeaks(text, secrets) {
  const source = String(text || '');
  const found = [];
  for (const item of secrets || []) {
    if (item.value && source.includes(item.value)) found.push({ name: item.name, sha256: sha256Text(item.value) });
  }
  return found;
}
