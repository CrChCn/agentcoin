import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

import { CLI, ORCH, TASKS, tempRoot, testEnv } from './helpers.mjs';
import { buildAgentPlan, discardCodexHome, NODE_IN_SANDBOX, prepareCodexHome } from '../lib/agentsandbox.mjs';
import { backendFileExists, detectSandbox, toBackendPath } from '../lib/sandbox.mjs';
import { maskNonCode } from '../lib/package.mjs';

/* Регрессии fix7d. Первые две группы закрывают шесть интеграционных находок
   реального прогона, третья — доверенный коммит движка вместо git-команды
   агента. */

const FAKE = path.join(ORCH, 'tests', 'codex-cli-double.mjs');
const DOUBLE_ENV = { CODEX_BIN: FAKE, ORCH_TEST_ALLOW_DOUBLE: '1' };

const codeOf = (rel) => maskNonCode(fs.readFileSync(path.join(ORCH, rel), 'utf8'));

test('the real harness asks Codex for a non-git fixture and disables its bash snapshot', () => {
  const harness = codeOf('tools/agent-hostile-check.mjs');
  assert.match(harness, /'--skip-git-repo-check'/);
  assert.match(harness, /'features\.shell_snapshot=false'/);
  assert.match(harness, /'sandbox_workspace_write\.network_access=true'/);

  const adapter = codeOf('adapters/codex-cli.mjs');
  assert.match(adapter, /'features\.shell_snapshot=false'/);
  assert.match(adapter, /'sandbox_workspace_write\.network_access=true'/);
  assert.match(adapter, /launch\.wrap\(\[bin\.cmd, \.\.\.argv\]/);
});

const sandbox = detectSandbox();
const usable = sandbox.available === true && sandbox.levels && sandbox.levels.smokeTested === true;

test(
  'the agent plan mounts contracts, outbox, the Codex scope and provider TLS files',
  { skip: usable ? false : `no smoke-tested sandbox: ${sandbox.detail}` },
  () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fix7d-plan-'));
    const ws = path.join(base, 'ws');
    const outbox = path.join(base, 'outbox');
    const credentials = path.join(base, 'credentials');
    const pkgBin = path.join(base, 'node_modules', '@openai', 'codex', 'bin');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(credentials, { recursive: true });
    fs.mkdirSync(pkgBin, { recursive: true });
    const entry = path.join(pkgBin, 'codex.js');
    fs.writeFileSync(entry, '// fake codex entry\n');

    const plan = buildAgentPlan({
      sandbox,
      workspace: ws,
      logDir: path.join(base, 'log'),
      credentialsDir: credentials,
      codexEntry: entry,
      rwDir: outbox,
      task: { commandsAllowed: [] },
    });
    assert.equal(plan.ok, true, plan.detail);

    const args = plan.wrap([process.execPath, entry, 'exec', '-'], { agent: true }).args.join(' ');
    const unix = (value) => toBackendPath(value, sandbox.backend);
    const contracts = unix(path.join(ORCH, 'contracts'));
    assert.ok(args.includes(`--ro-bind ${contracts} ${contracts}`), 'contracts must be mounted read-only');
    assert.ok(args.includes(`--bind ${unix(outbox)} ${unix(outbox)}`), 'outbox must be mounted read-write');
    const scope = unix(path.join(base, 'node_modules', '@openai'));
    assert.ok(args.includes(`--ro-bind ${scope} ${scope}`), 'the @openai scope must be mounted read-only');

    /* Адаптер обязан передать интерпретатор: иначе bwrap делает execvp на
       codex.js и получает ENOENT. */
    assert.ok(
      args.includes(`${NODE_IN_SANDBOX} ${unix(entry)}`),
      'a JS entrypoint must run under the sandbox node interpreter',
    );

    if (backendFileExists(sandbox.backend, '/etc/resolv.conf')) {
      assert.ok(args.includes('--ro-bind /etc/resolv.conf /etc/resolv.conf'), 'resolver config must be visible to the provider channel');
    }

    plan.cleanup();
    fs.rmSync(base, { recursive: true, force: true });
  },
);

test('a rotated auth.json is returned to the canonical codex home before cleanup', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fix7d-auth-'));
  const auth = path.join(source, 'auth.json');
  fs.writeFileSync(auth, '{"refresh":"old"}\n');
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(auth, old, old);

  const prepared = prepareCodexHome({ source });
  assert.equal(prepared.ok, true, prepared.detail);
  fs.writeFileSync(path.join(prepared.dir, 'auth.json'), '{"refresh":"rotated"}\n');
  const removed = discardCodexHome(prepared.dir);
  assert.equal(removed.ok, true, removed.detail);
  assert.equal(fs.existsSync(prepared.dir), false);
  assert.equal(fs.readFileSync(auth, 'utf8'), '{"refresh":"rotated"}\n');

  fs.rmSync(source, { recursive: true, force: true });
});

function runCli(root, env, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--root', root], {
    encoding: 'utf8',
    env: testEnv(env),
  });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('the orchestrator makes the commit itself when the agent leaves the tree uncommitted', () => {
  const root = tempRoot('trusted-commit');
  runCli(root, DOUBLE_ENV, 'init', '--task', path.join(TASKS, 'lesson-01.json'),
    '--implementer', 'codex-implementer', '--reviewer', 'codex-reviewer',
    '--confirm-real-agents', 'lesson-01');
  const ready = runCli(root, DOUBLE_ENV, 'step', '--task', 'lesson-01');
  assert.equal(ready.state, 'READY');

  const submitted = runCli(root, {
    ...DOUBLE_ENV,
    FAKE_CODEX_MODE: 'no-commit',
    FAKE_ROLE: 'implementer',
    FAKE_ITERATION: '1',
    FAKE_BASE_COMMIT: ready.baseCommit,
  }, 'step', '--task', 'lesson-01');
  assert.equal(submitted.state, 'ARTIFACT_SUBMITTED');

  const state = JSON.parse(fs.readFileSync(path.join(root, 'state', 'lesson-01', 'state.json'), 'utf8'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.join(root, 'workspaces', 'lesson-01', 'implementer'),
    encoding: 'utf8',
  }).trim();

  assert.match(state.result.resultCommit, /^[a-f0-9]{40}$/);
  assert.notEqual(state.result.resultCommit, state.baseCommit, 'the engine must create a real commit');
  assert.equal(state.result.resultCommit, head, 'the declared placeholder is replaced by the real HEAD');
  assert.equal(state.artifacts.at(-1).resultCommit, head);
});
