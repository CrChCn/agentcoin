#!/usr/bin/env node
/* Hostile clean-room: доказательство того, что изолированный runner реально
   отказывает враждебному коду, а не просит агента вести себя хорошо.

   Стенд создаёт:
   - workspace с «вредоносным» тестом;
   - файл-канарейку вне workspace;
   - поддельные ~/.ssh/id_rsa и ~/.codex/auth.json;
   - canary-переменные окружения в процессе оркестратора.

   Каждая из 12 атак должна получить технический отказ. Дополнительно
   проверяется, что ни одно canary-значение не попало в вывод и в evidence. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectSandbox, sandboxRun, toWslPath } from '../lib/sandbox.mjs';
import { findSecrets, secretPairs } from '../lib/secrets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const CANARIES = Object.freeze({
  DATABASE_URL: 'postgres://user:canary-db-password@db.invalid/x',
  SESSION_COOKIE: 'canary-session-cookie-value',
  AUTH_HEADER: 'Bearer canary-auth-header',
  OPENAI_API_KEY: 'sk-canary-openai-key-value',
  CODEX_API_KEY: 'canary-codex-key-value',
});

export const ATTACKS = Object.freeze([
  'read-outside-workspace',
  'read-ssh-key',
  'read-codex-auth',
  'env-database-url',
  'env-session-cookie',
  'env-openai-key',
  'net-localhost',
  'net-public',
  'spawn-curl',
  'spawn-powershell',
  'spawn-shell',
  'open-docker-socket',
  'open-ssh-agent',
  'symlink-escape',
  'write-sibling',
]);

function buildFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hostile-'));
  const ws = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(ws, 'tests'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const outsideFile = path.join(outside, 'canary.txt');
  fs.writeFileSync(outsideFile, 'OUTSIDE-CANARY-VALUE\n');
  const sshKey = path.join(home, '.ssh', 'id_rsa');
  fs.writeFileSync(sshKey, 'SSH-KEY-CANARY-VALUE\n');
  const codexAuth = path.join(home, '.codex', 'auth.json');
  fs.writeFileSync(codexAuth, JSON.stringify({ token: 'CODEX-AUTH-CANARY-VALUE' }));
  const script = path.join(ws, 'offender.mjs');
  fs.copyFileSync(path.join(ROOT, 'tests', 'hostile', 'attacks.mjs'), script);
  return { base, ws, outside, home, outsideFile, sshKey, codexAuth, script };
}

export function runHostileCheck({ sandbox = detectSandbox(), log } = {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    if (log) log(line);
  };
  if (!sandbox.available) {
    say(`BLOCKED ${sandbox.code}: ${sandbox.detail}`);
    return { ok: false, code: sandbox.code, attacks: [], log: lines.join('\n') };
  }
  const uni = (p) => (sandbox.backend === 'wsl-bwrap' ? toWslPath(p) : p);
  const fixture = buildFixture();
  const configPath = path.join(fixture.ws, 'attack-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    outsideFile: uni(fixture.outsideFile),
    sshKey: uni(fixture.sshKey),
    codexAuth: uni(fixture.codexAuth),
    siblingWrite: uni(path.join(fixture.outside, 'pwn.txt')),
    sshAgentSocket: uni(path.join(fixture.home, '.ssh', 'agent.sock')),
  }, null, 2));

  const saved = {};
  for (const [name, value] of Object.entries(CANARIES)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  let result;
  try {
    result = sandboxRun({ workspace: fixture.ws, argv: ['node', 'offender.mjs'], sandbox });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const attacks = [];
  for (const line of String(result.stdout || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      attacks.push(JSON.parse(line));
    } catch {
      /* строка не от атак — игнорируем */
    }
  }
  const byName = new Map(attacks.map((item) => [item.attack, item]));
  const missing = ATTACKS.filter((name) => !byName.has(name));
  const leaked = ATTACKS.filter((name) => byName.get(name) && byName.get(name).denied !== true);
  const pairs = secretPairs({ ...process.env, ...CANARIES });
  const leaks = findSecrets(`${result.stdout}\n${result.stderr}`, pairs)
    .concat(findSecrets(lines.join('\n'), pairs))
    .concat(findSecrets('', [{ name: 'outside-canary', value: 'OUTSIDE-CANARY-VALUE' }]));

  const ok = result.exitCode === 0 && missing.length === 0 && leaked.length === 0 && leaks.length === 0;
  say(`backend: ${sandbox.backend} (${sandbox.detail})`);
  say(`workspace: ${fixture.ws}`);
  say(`attack results (${attacks.length}/${ATTACKS.length}):`);
  for (const name of ATTACKS) {
    const item = byName.get(name);
    say(`  ${item && item.denied ? 'DENIED ' : 'FAILED '} ${name.padEnd(24)} ${item ? item.detail : 'no result'}`);
  }
  if (missing.length) say(`missing results: ${missing.join(', ')}`);
  if (leaked.length) say(`attacks that succeeded: ${leaked.join(', ')}`);
  if (leaks.length) say(`canary values found in output: ${leaks.join(', ')}`);
  say(`verdict: ${ok ? 'PASS' : 'FAIL'}`);
  say(`exitCode: ${result.exitCode}`);

  fs.rmSync(fixture.base, { recursive: true, force: true });
  return { ok, attacks, missing, leaked, leaks, log: lines.join('\n'), backend: sandbox.backend };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const outcome = runHostileCheck({ log: (line) => console.log(line) });
  const evidenceDir = path.join(ROOT, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'hostile-check.txt'), `${outcome.log}\n`);
  process.exitCode = outcome.ok ? 0 : 1;
}
