#!/usr/bin/env node
/* Матрица окружений: один и тот же архив, одни и те же тесты, четыре разных
   состояния Codex. Результат обязан совпасть — unit-тесты не должны зависеть
   от того, установлен ли настоящий CLI и выполнен ли вход.
   Настоящий агент не запускается: в тестовом процессе адаптеры отказывают. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runCleanRoom } from '../lib/cleanroom.mjs';

const args = process.argv.slice(2);
const archive = args.find((arg) => !arg.startsWith('--'));
if (!archive) {
  console.error('usage: node tools/environment-matrix.mjs <archive.zip> [--codex-bin <path>] [--json]');
  process.exit(64);
}

const codexIndex = args.indexOf('--codex-bin');
const realCodex = codexIndex >= 0 ? path.resolve(args[codexIndex + 1]) : (process.env.CLEAN_CODEX_BIN || null);
const double = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'codex-cli-double.mjs');
const missing = path.join(os.tmpdir(), 'agentcoin-orchestrator-no-codex', 'definitely-not-installed.js');

const bytes = fs.readFileSync(path.resolve(archive));
const name = path.basename(archive);

const variants = [
  {
    label: 'codex-absent',
    env: { CODEX_BIN: missing, CODEX_API_KEY: null, OPENAI_API_KEY: null },
  },
  {
    label: 'codex-present-not-logged-in',
    env: { CODEX_BIN: double, FAKE_CODEX_LOGIN: 'not-logged-in', CODEX_API_KEY: null, OPENAI_API_KEY: null },
  },
  {
    /* Метка описывает только то, что известно точно: путь к установленному
       бинарнику. Состояние входа видно в колонке blockers (agent_unauthenticated
       против agent_unavailable) — утверждать «authorized» без проверки нельзя. */
    label: realCodex ? 'codex-installed-real-binary' : 'codex-present (test double; no real CLI here)',
    env: { CODEX_BIN: realCodex || double, CLEAN_CODEX_BIN: realCodex || null, CODEX_API_KEY: null, OPENAI_API_KEY: null },
  },
  {
    label: 'api-keys-present',
    env: { CODEX_BIN: realCodex || missing, CODEX_API_KEY: `sk-canary-${crypto.randomBytes(8).toString('hex')}`, OPENAI_API_KEY: `sk-canary-${crypto.randomBytes(8).toString('hex')}` },
  },
];

const results = [];
for (const variant of variants) {
  const clean = runCleanRoom(bytes, {
    archiveName: name,
    codexBin: variant.env.CODEX_BIN,
    env: variant.env,
    requirePreflightBlocker: false,
    label: variant.label,
  });
  results.push({ label: variant.label, clean });
  process.stderr.write(`variant ${variant.label}: tests exit ${clean.signature.tests.exitCode}, pass ${clean.signature.tests.pass}, fail ${clean.signature.tests.fail}\n`);
}

const counts = results.map((entry) => `${entry.clean.signature.tests.pass}/${entry.clean.signature.tests.fail}/${entry.clean.signature.tests.exitCode}`);
const identical = counts.every((value) => value === counts[0]);
const allPassed = results.every((entry) => entry.clean.testsOk);

const table = [
  'Environment matrix — node --test tests/*.test.mjs',
  `archive: ${name} (${bytes.length} bytes, sha256 ${crypto.createHash('sha256').update(bytes).digest('hex')})`,
  'real agent calls: none (test mode disables the real adapter)',
  '',
  'auth state of the real CLI is shown by the blockers column; nothing is started',
  '',
  'variant | pass | fail | exit | preflight | blockers',
  ...results.map((entry) => [
    entry.label,
    entry.clean.signature.tests.pass,
    entry.clean.signature.tests.fail,
    entry.clean.signature.tests.exitCode,
    entry.clean.signature.preflight.exitCode,
    entry.clean.signature.preflight.blockers.join(','),
  ].join(' | ')),
  '',
  `identical outcomes: ${identical ? 'yes' : 'NO'}`,
  `all suites passed: ${allPassed ? 'yes' : 'NO'}`,
  `verdict: ${identical && allPassed ? 'PASS' : 'FAIL'}`,
  '',
].join('\n');

if (args.includes('--json')) {
  console.log(JSON.stringify({
    ok: identical && allPassed,
    variants: results.map((entry) => ({ label: entry.label, signature: entry.clean.signature })),
  }, null, 2));
} else {
  process.stdout.write(table);
}

process.exitCode = identical && allPassed ? 0 : 1;
