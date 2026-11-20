#!/usr/bin/env node
/* Hostile clean-room (Stage A fix5): проверка РЕАЛЬНОГО пути, а не стенда,
   который сам выбирает защищённую ветку.

   Фаза 1 — тестовый runner: враждебный Node-процесс запускается через
   sandboxRun (как команды задачи) и обязан получить технический отказ.

   Фаза 2 — матрица атак в ТОМ ЖЕ namespace и с ТЕМ ЖЕ планом, что у Codex:
   bwrap (masked /bin,/usr/bin, /orch/bin, credentials) → broker в отдельном
   namespace без сети и credentials. Каждая атака называет абсолютный путь
   явно (`/bin/bash`, `/bin/sh`, `/usr/bin/env`, `/usr/bin/node`) и исполняется
   harness'ом; результат берётся из кода выхода, а не из текста модели.

   Уровень 3 эта проверка не открывает: она не запускает настоящий Codex.
   Evidence уровня 3 пишет только tools/agent-hostile-check.mjs --real. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectSandbox, sandboxRun, toWslPath, ISOLATED_RUNNER_UNAVAILABLE } from '../lib/sandbox.mjs';
import { buildAgentPlan, readToolJournal } from '../lib/agentsandbox.mjs';
import { findSecrets, secretPairs } from '../lib/secrets.mjs';
import {
  ALLOW_ATTACKS, ATTACK_IDS, DENY_ATTACKS, SCRIPT_CANARY, attackSpecs, probeFiles, runAttackMatrix,
} from '../lib/attackmatrix.mjs';

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

/* Матрица фазы 2 — единый список из lib/attackmatrix.mjs. */
export const AGENT_ATTACKS = ATTACK_IDS;
export { DENY_ATTACKS, ALLOW_ATTACKS };

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
  /* fix6: внешний shell-скрипт и symlink на него внутри workspace —
     два способа заставить прокси прочитать файл до broker'а. */
  const outsideScript = path.join(outside, 'script.sh');
  fs.writeFileSync(outsideScript, `echo ${SCRIPT_CANARY}\n`);
  fs.mkdirSync(path.join(ws, 'probes'), { recursive: true });
  const symlinkScript = path.join(ws, 'probes', 'outside-link.sh');
  try {
    fs.symlinkSync(outsideScript, symlinkScript);
  } catch {
    /* Windows без права symlink: script-mode всё равно проверяется */
  }
  return { base, ws, outside, home, outsideFile, sshKey, codexAuth, script, outsideScript, symlinkScript };
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

  say('phase 1 — test runner (sandboxRun, 15 attacks):');
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

/* Фаза 2: обязательная матрица в namespace Codex + broker в отдельном
   namespace. Ни одна атака не выбирает «безопасный» путь: все они называют
   абсолютные адреса, которыми прежняя версия обходила прокси. */
async function agentPhase(sandbox, say) {
  const fixture = buildFixture();
  const uni = (p) => (sandbox.backend === 'wsl-bwrap' ? toWslPath(p) : p);
  fs.writeFileSync(path.join(fixture.ws, 'allowed.txt'), 'ALLOWED-WORKSPACE-READ\n');
  for (const [rel, source] of probeFiles()) {
    const file = path.join(fixture.ws, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }

  const credentials = path.join(fixture.base, 'credentials', 'codex');
  fs.mkdirSync(credentials, { recursive: true });
  fs.writeFileSync(path.join(credentials, 'auth.json'), JSON.stringify({ token: 'CODEX-AUTH-CANARY-VALUE' }));

  const logDir = path.join(fixture.base, 'tool-log');
  const plan = buildAgentPlan({
    sandbox,
    workspace: fixture.ws,
    logDir,
    credentialsDir: credentials,
    task: { commandsAllowed: [] },
  });
  if (!plan.ok) {
    say(`phase 2 — attack matrix: BLOCKED ${plan.code}: ${plan.detail}`);
    fs.rmSync(fixture.base, { recursive: true, force: true });
    return { ok: false, blocked: plan };
  }

  /* Временное состояние (включая копию auth.json) удаляется при любом
     исходе: успех, BLOCKED, исключение. */
  try {
    const started = await plan.startBroker();
    if (!started.ok) {
      say(`phase 2 — attack matrix: BLOCKED ${started.code}: ${started.detail}`);
      return { ok: false, blocked: started };
    }

    const specs = attackSpecs({
      outside: uni(fixture.outsideFile),
      sshKey: uni(fixture.sshKey),
      authJson: '/run/credentials/codex/auth.json',
      outsideScript: '../outside-script.sh',
      symlinkScript: './probes/outside-link.sh',
    });
    const run = (spec) => {
      const launch = plan.wrap(spec.argv);
      if (!launch.ok) return { exitCode: 126, stderr: `policy: ${launch.code}: ${launch.detail}` };
      const result = withCanaries(() => spawnSync(launch.cmd, launch.args, {
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: launch.env,
        cwd: fixture.ws,
        maxBuffer: 16 * 1024 * 1024,
      }));
      return {
        exitCode: typeof result.status === 'number' ? result.status : -1,
        stdout: result.stdout || '',
        stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
        signal: result.signal || null,
      };
    };

    const matrix = runAttackMatrix({ specs, run, capture: true });
    await plan.flushBroker();
    const journal = [...plan.brokerEntries];
    const journalDenied = journal.filter((entry) => entry.allow === false);
    const matrixText = Object.values(matrix.outputs).map((item) => `${item.stdout}\n${item.stderr}`).join('\n');
    const canaryLeaked = matrixText.includes(SCRIPT_CANARY)
      || journal.map((entry) => String(entry.command || '')).join('\n').includes(SCRIPT_CANARY);
    const ok = matrix.ok && journal.length > 0 && journalDenied.length > 0 && !canaryLeaked;

    say(`phase 2 — attack matrix in the Codex namespace + broker (${AGENT_ATTACKS.length} attacks):`);
    for (const item of matrix.results) {
      const good = item.expect === 'allow' ? item.ok : item.denied;
      const label = item.expect === 'allow' ? (good ? 'ALLOWED' : 'FAILED ') : (good ? 'DENIED ' : 'FAILED ');
      say(`  ${label} ${item.id.padEnd(26)} exit=${item.technical.exitCode} code=${item.technical.code || 'none'} ${item.technical.detail}`);
    }
    if (matrix.failures.length) say(`  failures: ${matrix.failures.join('; ')}`);
    if (canaryLeaked) say('  the outside script canary appeared in an answer or in the journal');
    say(`  broker journal: ${journal.length} calls, ${journalDenied.length} denied`);
    if (!journalDenied.length) say('  the broker recorded no denials: policy was not enforced');

    await plan.drainBroker();
    return { ok, results: matrix.results, failures: matrix.failures, journal, journalDenied };
  } finally {
    plan.cleanup();
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
}

/* Имена временных каталогов не должны попадать в доказательство: иначе файл
   меняется от запуска к запуску и SHA256SUMS архива перестаёт сходиться. */
export function normalizeEvidence(text) {
  return String(text)
    .replace(/[^\s"]*orch-hostile-[A-Za-z0-9]+/g, '<fixture>')
    .replace(/[^\s"]*orch-ipc\.[A-Za-z0-9]+/g, '<ipc>');
}

export async function runHostileCheck({ sandbox = detectSandbox(), log, agentPhaseEnabled = true } = {}) {
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
  const agent = agentPhaseEnabled ? await agentPhase(sandbox, say) : { ok: true, results: [] };

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
    attacks: [...runner.attacks, ...(agent.results || [])],
    runner,
    agent,
    leaks,
    log: normalizeEvidence(lines.join('\n')),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const outcome = await runHostileCheck({ log: (line) => console.log(line) });
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
