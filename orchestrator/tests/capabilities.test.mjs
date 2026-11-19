import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI, DOUBLE, MISSING_CODEX, TASKS, cli, cliWith, tempRoot, testEnv } from './helpers.mjs';
import * as freebuff from '../adapters/freebuff-cli.mjs';
import * as codex from '../adapters/codex-cli.mjs';

/* Каждый сценарий задаёт CODEX_BIN явно: отсутствующий путь или объявленный
   тестовый двойник. PATH этой машины не используется никогда. */

function withEnv(patch, fn) {
  const saved = new Map();
  for (const key of Object.keys(patch)) {
    saved.set(key, process.env[key]);
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const undef = { CODEX_API_KEY: undefined, OPENAI_API_KEY: undefined };

test('Freebuff: official surface is interactive, so it is not a programmatic interface', () => {
  const capability = freebuff.probe();
  assert.equal(capability.programmatic, false);
  assert.match(capability.evidence, /docs\.freebuff\.page/);
  assert.match(capability.reason, /интерактив|interactive|scriptable|JSON/i);
  assert.equal(freebuff.simulated, false);
});

test('Codex CLI absent: adapter is unavailable and the loop blocks with agent_unavailable', () => {
  const capability = withEnv({ CODEX_BIN: MISSING_CODEX, ...undef }, () => codex.probe());
  assert.equal(capability.available, false);
  assert.equal(capability.authenticated, false);

  const root = tempRoot('capa-missing');
  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'),
    '--implementer', 'codex-implementer', '--reviewer', 'codex-reviewer',
    '--confirm-real-agents', 'lesson-01');
  cli(root, 'step', '--task', 'lesson-01');
  const blocked = cli(root, 'step', '--task', 'lesson-01');
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.blockedCode, 'agent_unavailable');
});

test('Codex CLI present but not logged in: agent_unauthenticated, no agent is started', () => {
  const capability = withEnv({ CODEX_BIN: DOUBLE, FAKE_CODEX_LOGIN: 'not-logged-in', ...undef }, () => codex.probe());
  assert.equal(capability.available, true);
  assert.equal(capability.authenticated, false);
  assert.equal(capability.requiresHuman, 'codex login');

  const root = tempRoot('capa-unauth');
  const env = { CODEX_BIN: DOUBLE, FAKE_CODEX_LOGIN: 'not-logged-in' };
  cliWith(root, env, 'init', '--task', path.join(TASKS, 'lesson-01.json'),
    '--implementer', 'codex-implementer', '--reviewer', 'codex-reviewer',
    '--confirm-real-agents', 'lesson-01');
  cliWith(root, env, 'step', '--task', 'lesson-01');
  const blocked = cliWith(root, env, 'step', '--task', 'lesson-01');
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.blockedCode, 'agent_unauthenticated');
});

test('real adapters cannot be initialised without per-task confirmation', () => {
  const root = tempRoot('capa-arming');
  const result = spawnSync(process.execPath, [
    CLI, 'init', '--task', path.join(TASKS, 'lesson-01.json'),
    '--implementer', 'codex-implementer', '--reviewer', 'codex-reviewer', '--root', root,
  ], { encoding: 'utf8', env: testEnv() });

  assert.equal(result.status, 3, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.blockedCode, 'REAL_AGENT_NOT_ARMED');
  assert.equal(fs.existsSync(path.join(root, 'state', 'lesson-01', 'state.json')), false, 'nothing may be created');
});

test('a non-programmatic implementer results in BLOCKED, not a simulated success', () => {
  const root = tempRoot('capa-freebuff');
  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'), '--implementer', 'freebuff-cli',
    '--confirm-real-agents', 'lesson-01');
  cli(root, 'step', '--task', 'lesson-01');
  const blocked = cli(root, 'step', '--task', 'lesson-01');
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.blockedCode, 'agent_not_scriptable');
  assert.equal(blocked.artifact, null);
});
