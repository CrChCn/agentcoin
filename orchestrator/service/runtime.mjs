#!/usr/bin/env node
/* Pinned runtime для настоящих агентов (C3-gate), часть C2-раскладки.

   /tmp не является установкой: после перезагрузки его может не быть. Поэтому
   Codex живёт в /opt/agentcoin-ops/runtime/codex-<version>/ с манифестом
   SHA256, принадлежит root, не доступен на запись группе и остальным и не
   обновляется сам. Проверка не запускает агента: только файлы, права, хеши и,
   если задан бинарь, точную версию. */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readJson, sha256File } from '../lib/fsx.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });

/* Разрешённые места установки: pinned runtime обязан быть вне /tmp и вне
   домашних каталогов, иначе «постоянная установка» снова окажется временной. */
export function isPermanentRoot(dir) {
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(resolved)) return false;
  if (resolved === '/tmp' || resolved.startsWith('/tmp/')) return false;
  if (/^\/(home|root)(\/|$)/.test(resolved)) return false;
  const tmp = path.resolve(os.tmpdir());
  if (resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`)) return false;
  return true;
}

export function manifestPathOf(pin) {
  return path.join(path.resolve(pin.root), pin.manifest || 'manifest.json');
}

/* pin: {version, root, manifest?, bin?} из mission.runtime.codex */
export function verifyRuntime(pin, { expectVersion = null, runBin = true } = {}) {
  const result = {
    pinned: Boolean(pin && pin.version && pin.root),
    version: pin && pin.version ? String(pin.version) : null,
    root: pin && pin.root ? path.resolve(pin.root) : null,
    permanentPath: pin && pin.root ? isPermanentRoot(pin.root) : false,
    manifest: null, files: 0, hashesOk: false, ownershipOk: false, modeOk: false,
    autoUpdate: pin ? pin.autoUpdate === true : false,
    binaryVersion: null, ok: false, detail: '',
  };
  if (!result.pinned) {
    result.detail = 'no pinned runtime configured (mission.runtime.codex)';
    return result;
  }
  if (!result.permanentPath) {
    result.detail = `runtime root is temporary or user-owned: ${result.root}`;
    return result;
  }
  const manifestFile = manifestPathOf(pin);
  const manifest = readJson(manifestFile, null);
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) {
    result.detail = `runtime manifest is missing or empty: ${manifestFile}`;
    return result;
  }
  result.manifest = manifestFile;
  result.files = manifest.files.length;
  if (String(manifest.version) !== String(pin.version)) {
    result.detail = `manifest version ${manifest.version} does not match pinned ${pin.version}`;
    return result;
  }

  let hashesOk = true;
  let ownershipOk = true;
  let modeOk = true;
  /* Владелец и POSIX-биты проверяются только на POSIX: на Windows mode не
     отражает ACL, а ops-host всё равно Linux. */
  const posix = process.platform !== 'win32';
  /* Владельца можно проверить только от root: непривилегированная проверка
     честно помечает ownership как непроверенный, а не выдаёт его за ok. */
  const canCheckOwnership = posix && typeof process.getuid === 'function' && process.getuid() === 0;
  result.ownershipChecked = canCheckOwnership;
  for (const entry of manifest.files) {
    const file = path.join(path.resolve(pin.root), entry.path);
    if (!fs.existsSync(file)) { hashesOk = false; result.detail = `missing runtime file: ${entry.path}`; break; }
    if (sha256File(file) !== entry.sha256) { hashesOk = false; result.detail = `hash mismatch: ${entry.path}`; break; }
    const stat = fs.statSync(file);
    if (posix && (stat.mode & 0o022) !== 0) modeOk = false;
    if (canCheckOwnership && stat.uid !== 0) ownershipOk = false;
  }
  result.hashesOk = hashesOk;
  result.modeOk = modeOk;
  result.ownershipOk = ownershipOk;

  if (runBin && pin.bin && fs.existsSync(pin.bin)) {
    try {
      const out = execFileSync(pin.bin, ['--version'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, CODEX_HOME: pin.home || path.join(path.resolve(pin.root), 'home') } });
      result.binaryVersion = String(out).trim().split('\n')[0].slice(0, 120);
      if (!result.binaryVersion.includes(String(pin.version))) {
        result.detail = `binary reports "${result.binaryVersion}", expected ${pin.version}`;
        return result;
      }
    } catch (err) {
      result.detail = `binary check failed: ${err.code || err.message}`;
      return result;
    }
  } else if (pin.bin) {
    result.detail = `pinned binary not found: ${pin.bin}`;
    return result;
  }

  if (!hashesOk || !modeOk || !ownershipOk) {
    if (!result.detail) result.detail = 'runtime files are writable or not owned by root';
    return result;
  }
  if (!result.autoUpdate) {
    /* Автообновление запрещено политикой: version остаётся той, что в манифесте. */
    result.detail = canCheckOwnership
      ? 'pinned, root-owned, hash-verified, auto-update disabled'
      : 'pinned, hash-verified, auto-update disabled; ownership not verified (run as root)';
  }
  result.ok = true;
  if (!result.detail) result.detail = 'pinned runtime verified';
  return result;
}

export function runtimeOf(mission) {
  return (mission && mission.runtime && mission.runtime.codex) || null;
}

export function assertRuntimeForRealAgents(mission) {
  const pin = runtimeOf(mission);
  const verdict = verifyRuntime(pin);
  if (!verdict.ok) {
    throw fail('RUNTIME_NOT_PINNED', `real agents require a pinned runtime: ${verdict.detail}`);
  }
  return verdict;
}
