import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ORCH, 'orchestrator.mjs');
export const TASKS = path.join(ORCH, 'fixtures', 'tasks');
export const TERMINAL = new Set(['ACCEPTED', 'BLOCKED', 'FAILED', 'CANCELLED']);
export const DOUBLE = path.join(ORCH, 'tests', 'codex-cli-double.mjs');

/* Гарантированно отсутствующий путь: тест, который забыл задать CODEX_BIN,
   получает «CLI нет», а не настоящий codex из PATH. */
export const MISSING_CODEX = path.join(os.tmpdir(), 'agentcoin-orchestrator-no-codex', 'codex-not-installed.js');

/* Единое тестовое окружение: ключи удаляются, тестовый режим включён,
   бинарник по умолчанию отсутствует. */
export function testEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  /* Наследованные переключатели двойника не должны протекать в тест:
     иначе набор зависел бы от окружения, из которого его запустили. */
  for (const key of Object.keys(env)) {
    if (key.startsWith('FAKE_CODEX_') && !Object.prototype.hasOwnProperty.call(extra, key)) delete env[key];
  }
  if (!Object.prototype.hasOwnProperty.call(extra, 'CODEX_BIN')) env.CODEX_BIN = MISSING_CODEX;
  if (!Object.prototype.hasOwnProperty.call(extra, 'ORCH_TEST_ALLOW_DOUBLE')) delete env.ORCH_TEST_ALLOW_DOUBLE;
  env.ORCH_TEST_MODE = '1';
  return env;
}

export function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agt-orch-${label}-`));
}

export function cli(root, ...args) {
  const out = execFileSync(process.execPath, [CLI, ...args, '--root', root], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: testEnv(),
  });
  return JSON.parse(out);
}

export function cliRaw(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8', env: testEnv() });
}

export function cliWith(root, env, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--root', root], {
    encoding: 'utf8',
    env: testEnv(env),
  });
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

export function cliWithRaw(root, env, ...args) {
  return spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8', env: testEnv(env) });
}

export function runLoop(root, taskId, maxSteps = 20) {
  const trail = [cli(root, 'status', '--task', taskId)];
  while (!TERMINAL.has(trail.at(-1).state) && trail.length < maxSteps) {
    trail.push(cli(root, 'step', '--task', taskId));
  }
  return trail;
}
