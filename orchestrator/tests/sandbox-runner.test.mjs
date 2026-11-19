import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commandRunner, isolationGate } from '../lib/engine.mjs';
import { detectSandbox, ISOLATED_RUNNER_UNAVAILABLE } from '../lib/sandbox.mjs';

const sandbox = detectSandbox();

test('no isolation backend blocks a real agent before anything runs', () => {
  const gate = isolationGate({ simulated: false }, { available: false, code: ISOLATED_RUNNER_UNAVAILABLE, detail: 'probe' });
  assert.equal(gate.code, 'isolated_runner_unavailable');
  assert.equal(isolationGate({ simulated: true }, { available: false, detail: 'probe' }), null);
});

test(
  'the real command runner executes an allowed command inside the sandbox',
  { skip: sandbox.available ? false : `no isolation backend: ${sandbox.detail}` },
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
