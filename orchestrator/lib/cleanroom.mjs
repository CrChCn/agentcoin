#!/usr/bin/env node
/* Чистая проверка архива: распаковка в пустой каталог и запуск команд
   ровно так, как их выполнит получатель. Ничего из рабочего дерева не
   подмешивается: все пути строятся от каталога распаковки. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { extractZip, readZip } from './zip.mjs';

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const CLEAN_ENV_DROP = ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'NODE_CHANNEL_FD', 'NODE_UNIQUE_ID'];

function cleanEnv(extra = {}) {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
  for (const key of CLEAN_ENV_DROP) delete env[key];
  return env;
}

function hasBash() {
  const probe = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
  return probe.status === 0;
}

function run(command, cwd, { bash = false, timeout = 900000 } = {}) {
  const argv = bash ? ['bash', ['-lc', command]] : command.split(' ');
  const result = bash
    ? spawnSync(argv[0], argv[1], { cwd, encoding: 'utf8', timeout, env: cleanEnv(), windowsHide: true })
    : spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout, env: cleanEnv(), windowsHide: true });
  return {
    command,
    exitCode: typeof result.status === 'number' ? result.status : -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function block(title, result, extra = []) {
  const lines = [`$ ${title}`, `exit ${result.exitCode}`];
  if (result.error) lines.push(`error: ${result.error}`);
  lines.push('--- stdout ---', result.stdout.trimEnd(), '--- stderr ---', result.stderr.trimEnd(), ...extra, '');
  return lines.join('\n');
}

export function countArchiveFiles(zipBytes) {
  try {
    return readZip(zipBytes).length;
  } catch {
    return -1;
  }
}

/* Нормализация только для сравнения прогонов между сборками:
   временный каталог и длительности у каждого запуска свои. */
export function normalize(text, { room, codexBin } = {}) {
  let out = String(text || '');
  if (room) out = out.split(room).join('<CLEANROOM>');
  if (room) out = out.split(room.replace(/\\/g, '/')).join('<CLEANROOM>');
  if (codexBin) out = out.split(codexBin).join('<CODEX_BIN>');
  out = out.replace(/duration_ms:\s*[\d.]+/g, 'duration_ms: <ms>');
  out = out.replace(/\(\s*[\d.]+\s*ms\s*\)/g, '(<ms>)');
  out = out.replace(/time=[\d.]+ms/g, 'time=<ms>');
  out = out.replace(/\u001b\[[0-9;]*m/g, '');
  return out;
}

/* Репортер Node печатает либо `# pass N` (TAP), либо `ℹ pass N` (spec).
   Оба варианта должны читаться одинаково. */
function parseTestCounts(stdout) {
  const read = (label) => {
    const match = new RegExp(`^(?:#|\u2139)\\s*${label}\\s+(\\d+)`, 'm').exec(stdout);
    return match ? Number(match[1]) : null;
  };
  return { pass: read('pass'), fail: read('fail'), tests: read('tests') };
}

export function runCleanRoom(zipBytes, { archiveName = 'archive.zip', codexBin = null, keep = false } = {}) {
  const room = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcoin-fix1-clean-'));
  const archivePath = path.join(room, archiveName);
  fs.writeFileSync(archivePath, zipBytes);
  const bash = hasBash();
  const unpacked = path.join(room, 'unpacked');
  const blocks = [];

  const header = [
    'Agentcoin orchestrator — clean-room verification',
    `archive: ${archiveName}`,
    `files in archive: ${countArchiveFiles(zipBytes)}`,
    `extractor: ${bash ? 'unzip' : 'node (lib/zip.mjs)'}`,
    `workspace root: ${room}`,
    '',
  ].join('\n');

  let extractResult;
  if (bash) {
    extractResult = run(`unzip -q ${JSON.stringify(path.basename(archivePath))} -d unpacked`, room, { bash: true });
  } else {
    try {
      extractZip(zipBytes, unpacked);
      extractResult = { command: 'node -e extractZip(...)', exitCode: 0, stdout: '', stderr: '', error: null };
    } catch (err) {
      extractResult = { command: 'node -e extractZip(...)', exitCode: 1, stdout: '', stderr: String(err.message || err), error: null };
    }
  }
  blocks.push(block(bash ? `unzip -q ${archiveName} -d unpacked` : `extract ${archiveName} -> unpacked`, extractResult));

  const appDir = path.join(unpacked, 'orchestrator');
  if (!fs.existsSync(appDir) || !fs.existsSync(path.join(appDir, 'orchestrator.mjs'))) {
    const log = `${header}${blocks.join('\n')}FAIL: unpacked archive has no orchestrator/orchestrator.mjs\n`;
    if (!keep) fs.rmSync(room, { recursive: true, force: true });
    return {
      ok: false,
      room,
      log,
      signature: { error: 'missing_entrypoint' },
      preflightJson: null,
      tests: null,
      commands: [],
    };
  }

  const tests = run('node --test tests/*.test.mjs', appDir, { bash, timeout: 900000 });
  blocks.push(block('node --test tests/*.test.mjs', tests));

  const capabilities = run('node orchestrator.mjs capabilities', appDir, { bash });
  blocks.push(block('node orchestrator.mjs capabilities', capabilities));

  const preflightCommand = [
    'node orchestrator.mjs preflight',
    '--task fixtures/tasks/lesson-01.json',
    '--root runs/preflight-clean',
    codexBin ? `--codex-bin ${JSON.stringify(codexBin)}` : '',
  ].filter(Boolean).join(' ');
  const preflight = run(preflightCommand, appDir, { bash });
  let preflightJson = null;
  try {
    preflightJson = JSON.parse(preflight.stdout);
  } catch {
    preflightJson = null;
  }
  blocks.push(block(preflightCommand, preflight));

  const sums = bash
    ? run('sha256sum -c SHA256SUMS', appDir, { bash })
    : { command: 'sha256sum -c SHA256SUMS', exitCode: -1, stdout: '', stderr: 'sha256sum unavailable', error: null };
  blocks.push(block('sha256sum -c SHA256SUMS', sums));

  /* Два роли дают два блокера с одним кодом — это одна причина, а не две. */
  const blockerCodes = preflightJson && Array.isArray(preflightJson.blockers)
    ? [...new Set(preflightJson.blockers.map((item) => item.code))].sort()
    : ['preflight_output_unreadable'];
  const counts = parseTestCounts(tests.stdout);
  const capabilityList = (() => {
    try {
      return JSON.parse(capabilities.stdout).adapters || [];
    } catch {
      return [];
    }
  })();

  const signature = {
    files: countArchiveFiles(zipBytes),
    tests: { exitCode: tests.exitCode, ...counts },
    capabilities: { exitCode: capabilities.exitCode, adapters: capabilityList.map((a) => a.id).sort() },
    preflight: { exitCode: preflight.exitCode, blockers: blockerCodes },
    sha256sum: { exitCode: sums.exitCode },
  };

  const ok = tests.exitCode === 0
    && counts.fail === 0
    && capabilities.exitCode === 0
    && capabilityList.some((a) => a.id === 'codex-implementer')
    && capabilityList.some((a) => a.id === 'codex-reviewer')
    && preflight.exitCode === 3
    && blockerCodes.length === 1
    && blockerCodes[0] === 'agent_unauthenticated'
    && sums.exitCode === 0;

  const summary = [
    'summary:',
    `  tests: exit ${tests.exitCode}, pass ${counts.pass}, fail ${counts.fail}`,
    `  capabilities: exit ${capabilities.exitCode}, adapters ${capabilityList.map((a) => a.id).join(',')}`,
    `  preflight: exit ${preflight.exitCode}, blockers ${blockerCodes.join(',')}`,
    `  sha256sum: exit ${sums.exitCode}`,
    `  verdict: ${ok ? 'PASS' : 'FAIL'}`,
    '',
  ].join('\n');

  const rawLog = `${header}${blocks.join('\n')}${summary}`;
  const log = normalize(rawLog, { room, codexBin });

  if (!keep) fs.rmSync(room, { recursive: true, force: true });

  return {
    ok,
    room,
    log,
    signature,
    preflightJson: preflightJson
      ? JSON.parse(normalize(JSON.stringify(preflightJson), { room, codexBin }))
      : null,
    tests: {
      exitCode: tests.exitCode,
      ...counts,
      output: normalize(block('node --test tests/*.test.mjs', tests), { room, codexBin }),
    },
    commands: [
      { command: `unzip ${archiveName}`, exitCode: extractResult.exitCode },
      { command: 'node --test tests/*.test.mjs', exitCode: tests.exitCode },
      { command: 'node orchestrator.mjs capabilities', exitCode: capabilities.exitCode },
      { command: preflightCommand, exitCode: preflight.exitCode },
      { command: 'sha256sum -c SHA256SUMS', exitCode: sums.exitCode },
    ],
  };
}

export function writeEvidence(clean, orchRoot) {
  const dir = path.join(orchRoot, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package-clean-test.txt'), clean.log);
  fs.writeFileSync(path.join(dir, 'tests.txt'), `${clean.tests.output}\n`);
  fs.writeFileSync(path.join(dir, 'preflight-clean.json'), `${JSON.stringify(clean.preflightJson, null, 2)}\n`);
}
