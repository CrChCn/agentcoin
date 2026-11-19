import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commandRunner, isolationGate } from '../lib/engine.mjs';
import { buildAgentPlan, isolationEvidence } from '../lib/agentsandbox.mjs';
import { detectSandbox, evaluateSmoke, ISOLATED_RUNNER_UNAVAILABLE, SMOKE_CHECKS } from '../lib/sandbox.mjs';

const sandbox = detectSandbox();
const smokeTested = Boolean(sandbox.available && sandbox.levels && sandbox.levels.smokeTested === true);

const healthyChecks = () => Object.fromEntries(SMOKE_CHECKS.map((name) => [name, { ok: true, detail: 'synthetic' }]));

test('a broken backend is rejected even though bwrap is installed', () => {
  /* Именно этот случай аудитор воспроизвёл: `bwrap` есть, но не может создать
     user namespace. Наличие бинарника больше не считается работоспособностью. */
  const broken = healthyChecks();
  delete broken['net-denied'];
  const verdict = evaluateSmoke({ backend: 'bwrap', checks: broken });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, ISOLATED_RUNNER_UNAVAILABLE);
  assert.ok(verdict.failed.includes('net-denied'));

  const partial = healthyChecks();
  partial['read-outside-bwrap'] = { ok: false, detail: 'outside read succeeded' };
  assert.equal(evaluateSmoke({ backend: 'bwrap', checks: partial }).ok, false);
  assert.equal(evaluateSmoke({ backend: 'bwrap', checks: healthyChecks() }).ok, true);
});

test('no smoke-tested backend blocks a real agent before anything runs', () => {
  const unavailable = { available: false, code: ISOLATED_RUNNER_UNAVAILABLE, detail: 'probe', levels: { installed: true, smokeTested: false } };
  const gate = isolationGate({ simulated: false }, unavailable, { ok: false });
  assert.equal(gate.code, 'isolated_runner_unavailable');
  assert.equal(isolationGate({ simulated: true }, unavailable, { ok: false }), null);
});

test('a smoke-tested backend without end-to-end evidence still blocks real agents', () => {
  const sandboxOk = { available: true, backend: 'bwrap', levels: { installed: true, smokeTested: true } };
  const unproven = isolationGate({ simulated: false }, sandboxOk, { ok: false, detail: 'no evidence' });
  assert.equal(unproven.code, 'agent_isolation_unproven');
  const proven = isolationGate({ simulated: false }, sandboxOk, { ok: true });
  assert.equal(proven, null);
  assert.equal(isolationGate({ simulated: false, requiresSandbox: false }, sandboxOk, { ok: false }), null);
});

test('level-3 evidence must come from the real adapter thread', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-evidence-'));
  const missing = isolationEvidence(path.join(dir, 'none.json'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'agent_isolation_unproven');

  const fakeThread = path.join(dir, 'fake.json');
  fs.writeFileSync(fakeThread, JSON.stringify({
    ok: true, adapter: 'codex-cli', backend: 'bwrap', at: new Date().toISOString(), threadId: 'short', attacks: [{ denied: true }],
  }));
  assert.equal(isolationEvidence(fakeThread).ok, false);

  const valid = path.join(dir, 'valid.json');
  fs.writeFileSync(valid, JSON.stringify({
    ok: true, adapter: 'codex-cli', backend: 'bwrap', at: new Date().toISOString(),
    threadId: 'thread_0123456789abcdef', attacks: [{ attack: 'tool-command', denied: true }],
  }));
  assert.equal(isolationEvidence(valid).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the agent plan refuses to build without a smoke-tested backend', () => {
  const plan = buildAgentPlan({
    sandbox: { available: true, backend: 'bwrap', levels: { installed: true, smokeTested: false } },
    workspace: path.join(os.tmpdir(), 'ws'),
    logDir: path.join(os.tmpdir(), 'logs'),
    task: { commandsAllowed: [] },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, ISOLATED_RUNNER_UNAVAILABLE);
});

test(
  'the real command runner executes an allowed command inside the sandbox',
  { skip: smokeTested ? false : `no smoke-tested isolation backend: ${sandbox.detail}` },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-runner-'));
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'tests', 'ok.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert';\ntest('ok', () => assert.ok(true));\n",
    );
    const task = { commandsAllowed: ['node --test tests/ok.test.mjs'] };
    const result = commandRunner(dir, task, { sandboxRequired: true })('node --test tests/ok.test.mjs');
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(result.sandboxed, true);
    assert.equal(result.exitCode, 0, `sandboxed run failed: ${result.stderr}`);
    assert.ok(result.sandboxBackend);
  },
);
