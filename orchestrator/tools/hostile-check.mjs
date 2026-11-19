#!/usr/bin/env node
/* Hostile clean-room (Stage A fix4): доказательство того, что изолирован
   РЕАЛЬНЫЙ путь агента, а не только вспомогательный runner.

   Фаза 1 — тестовый runner: враждебный Node-процесс запускается через
   sandboxRun (как команды задачи) и обязан получить технический отказ.

   Фаза 2 — цепочка агента: тот же sandbox-план, что и у настоящего Codex
   (bwrap → worker → /orch/bin/bash как tool proxy), с подставным worker'ом.
   Проверяются оба канала: сам worker (fs/env) и инструменты модели (tool
   proxy: нет сети, нет /run/credentials, нет записи вне workspace).

   Если backend не прошёл smoke-run, проверка не притворяется зелёной:
   возвращается ISOLATED_RUNNER_UNAVAILABLE и код выхода 3. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectSandbox, sandboxRun, toWslPath, ISOLATED_RUNNER_UNAVAILABLE } from '../lib/sandbox.mjs';
import { buildAgentPlan, readToolJournal } from '../lib/agentsandbox.mjs';
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

export const AGENT_ATTACKS = Object.freeze([
  'worker-read-outside',
  'worker-read-ssh-key',
  'worker-env-secret',
  'worker-write-sibling',
  'tool-read-outside',
  'tool-read-ssh-key',
  'tool-read-codex-auth',
  'tool-env-secret',
  'tool-curl',
  'tool-write-sibling',
  'tool-net-public',
  'tool-net-localhost',
  'tool-read-workspace',
  'tool-ls',
]);

const AGENT_ALLOWED = new Set(['tool-read-workspace', 'tool-ls']);

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

function withCanaries(fn) {
  const saved = {};
  for (const [name, value] of Object.entries(CANARIES)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function parseJsonLines(stdout) {
  const items = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      /* не результат атаки */
    }
  }
  return items;
}

/* Фаза 1: тестовый runner (как команда задачи). */
function runnerPhase(sandbox, say) {
  const fixture = buildFixture();
  const uni = (p) => (sandbox.backend === 'wsl-bwrap' ? toWslPath(p) : p);
  const configPath = path.join(fixture.ws, 'attack-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    outsideFile: uni(fixture.outsideFile),
    sshKey: uni(fixture.sshKey),
    codexAuth: uni(fixture.codexAuth),
    siblingWrite: uni(path.join(fixture.outside, 'pwn.txt')),
    sshAgentSocket: uni(path.join(fixture.home, '.ssh', 'agent.sock')),
  }, null, 2));

  const result = withCanaries(() => sandboxRun({ workspace: fixture.ws, argv: ['node', 'offender.mjs'], sandbox }));
  const attacks = parseJsonLines(result.stdout);
  const byName = new Map(attacks.map((item) => [item.attack, item]));
  const missing = ATTACKS.filter((name) => !byName.has(name));
  const leaked = ATTACKS.filter((name) => byName.get(name) && byName.get(name).denied !== true);
  const ok = result.exitCode === 0 && missing.length === 0 && leaked.length === 0;

  say('phase 1 — test runner (sandboxRun, 12 attacks):');
  for (const name of ATTACKS) {
    const item = byName.get(name);
    say(`  ${item && item.denied ? 'DENIED ' : 'FAILED '} ${name.padEnd(24)} ${item ? item.detail : 'no result'}`);
  }
  if (missing.length) say(`  missing results: ${missing.join(', ')}`);
  if (leaked.length) say(`  attacks that succeeded: ${leaked.join(', ')}`);
  say(`  exitCode: ${result.exitCode}`);
  fs.rmSync(fixture.base, { recursive: true, force: true });
  return { ok, attacks, missing, leaked };
}

/* Фаза 2: цепочка агента внутри того же плана, что и настоящий Codex. */
function agentPhase(sandbox, say) {
  const fixture = buildFixture();
  const uni = (p) => (sandbox.backend === 'wsl-bwrap' ? toWslPath(p) : p);
  fs.copyFileSync(path.join(ROOT, 'tests', 'hostile', 'agent-standin.mjs'), path.join(fixture.ws, 'agent-standin.mjs'));
  fs.writeFileSync(path.join(fixture.ws, 'allowed.txt'), 'ALLOWED-WORKSPACE-VALUE\n');

  const credentials = path.join(fixture.base, 'credentials', 'codex');
  fs.mkdirSync(credentials, { recursive: true });
  fs.writeFileSync(path.join(credentials, 'auth.json'), JSON.stringify({ token: 'CODEX-AUTH-CANARY-VALUE' }));

  const configPath = path.join(fixture.ws, 'agent-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    outsideFile: uni(fixture.outsideFile),
    sshKey: uni(fixture.sshKey),
    codexAuth: '/run/credentials/codex/auth.json',
    siblingWrite: uni(path.join(fixture.outside, 'pwn.txt')),
  }, null, 2));

  const logDir = path.join(fixture.base, 'tool-log');
  const plan = buildAgentPlan({
    sandbox,
    workspace: fixture.ws,
    logDir,
    credentialsDir: credentials,
    task: { commandsAllowed: [] },
  });
  if (!plan.ok) {
    say(`phase 2 — agent chain: BLOCKED ${plan.code}: ${plan.detail}`);
    fs.rmSync(fixture.base, { recursive: true, force: true });
    return { ok: false, blocked: plan };
  }
  const launch = plan.wrap(['node', 'agent-standin.mjs']);
  if (!launch.ok) {
    say(`phase 2 — agent chain: BLOCKED ${launch.code}: ${launch.detail}`);
    fs.rmSync(fixture.base, { recursive: true, force: true });
    return { ok: false, blocked: launch };
  }

  const result = withCanaries(() => spawnSync(launch.cmd, launch.args, {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: launch.env,
    maxBuffer: 16 * 1024 * 1024,
  }));
  const attacks = parseJsonLines(result.stdout);
  const byName = new Map(attacks.map((item) => [item.attack, item]));
  const missing = AGENT_ATTACKS.filter((name) => !byName.has(name));
  const wrong = AGENT_ATTACKS.filter((name) => {
    const item = byName.get(name);
    if (!item) return false;
    return AGENT_ALLOWED.has(name) ? item.denied !== false : item.denied !== true;
  });
  const journal = readToolJournal(path.join(logDir, 'tool-calls.jsonl'));
  const journalDenied = journal.filter((entry) => entry.allow === false);
  const ok = result.status === 0 && missing.length === 0 && wrong.length === 0 && journalDenied.length > 0;

  say('phase 2 — agent chain (bwrap → worker → tool proxy, 14 attacks):');
  for (const name of AGENT_ATTACKS) {
    const item = byName.get(name);
    const good = item && (AGENT_ALLOWED.has(name) ? item.denied === false : item.denied === true);
    const label = good ? (AGENT_ALLOWED.has(name) ? 'ALLOWED' : 'DENIED ') : 'FAILED ';
    say(`  ${label} ${name.padEnd(24)} ${item ? item.detail : 'no result'}`);
  }
  if (missing.length) say(`  missing results: ${missing.join(', ')}`);
  if (wrong.length) say(`  unexpected outcomes: ${wrong.join(', ')}`);
  say(`  tool proxy journal: ${journal.length} calls, ${journalDenied.length} denied`);
  if (!journalDenied.length) say('  the tool proxy recorded no denials: policy was not enforced');
  say(`  exitCode: ${result.status}`);
  const stderr = String(result.stderr || '').trim();
  if (stderr) say(`  stderr: ${stderr.slice(0, 400)}`);

  fs.rmSync(fixture.base, { recursive: true, force: true });
  return { ok, attacks, missing, wrong, journal, journalDenied };
}

/* Имена временных каталогов не должны попадать в доказательство: иначе файл
   меняется от запуска к запуску и SHA256SUMS архива перестаёт сходиться. */
export function normalizeEvidence(text) {
  return String(text).replace(/[^\s"]*orch-hostile-[A-Za-z0-9]+/g, '<fixture>');
}

export function runHostileCheck({ sandbox = detectSandbox(), log, agentPhaseEnabled = true } = {}) {
  const lines = [];
  const say = (line) => {
    lines.push(line);
    if (log) log(line);
  };
  if (!sandbox.available || !sandbox.levels || sandbox.levels.smokeTested !== true) {
    say(`BLOCKED ${ISOLATED_RUNNER_UNAVAILABLE}: ${sandbox.detail || 'no isolation backend'}`);
    say('verdict: BLOCKED');
    return { ok: false, code: ISOLATED_RUNNER_UNAVAILABLE, exitCode: 3, attacks: [], log: lines.join('\n') };
  }
  const runner = runnerPhase(sandbox, say);
  const agent = agentPhaseEnabled ? agentPhase(sandbox, say) : { ok: true, attacks: [] };

  const pairs = secretPairs({ ...process.env, ...CANARIES });
  const leaks = findSecrets(lines.join('\n'), pairs);
  const ok = runner.ok && agent.ok && leaks.length === 0;

  say(`backend: ${sandbox.backend} (${sandbox.detail})`);
  say(`levels: installed=${sandbox.levels.installed} smokeTested=${sandbox.levels.smokeTested} adapterEndToEnd=${sandbox.levels.adapterEndToEnd}`);
  if (leaks.length) say(`canary values found in output: ${leaks.join(', ')}`);
  say(`verdict: ${ok ? 'PASS' : 'FAIL'}`);
  say('note: level 3 (real Codex thread) is proved only by tools/agent-hostile-check.mjs --real');
  return {
    ok,
    code: ok ? null : 'HOSTILE_CHECK_FAILED',
    exitCode: ok ? 0 : 1,
    backend: sandbox.backend,
    attacks: [...runner.attacks, ...(agent.attacks || [])],
    runner,
    agent,
    leaks,
    log: normalizeEvidence(lines.join('\n')),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const outcome = runHostileCheck({ log: (line) => console.log(line) });
  /* По умолчанию доказательство печатается, но не пишется: распакованный архив
     можно проверять, не меняя его файлов (SHA256SUMS остаётся верным).
     Флаг нужен только сборщику архива. */
  if (process.argv.includes('--write-evidence')) {
    const evidenceDir = path.join(ROOT, 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'hostile-check.txt'), `${outcome.log}\n`);
  }
  process.exitCode = outcome.exitCode;
}
