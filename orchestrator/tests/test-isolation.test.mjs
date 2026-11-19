import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DOUBLE, tempRoot } from './helpers.mjs';
import * as codex from '../adapters/codex-cli.mjs';

/* Под тестом (NODE_TEST_CONTEXT) адаптер обязан отказать до запуска процесса,
   даже если CODEX_BIN существует, а вход выполнен. Доказательство — файл,
   который настоящий CLI создал бы при запуске. */

function recorder(dir) {
  const marker = path.join(dir, 'agent-was-launched.txt');
  const script = path.join(dir, 'codex-recorder.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'launched\\n');\nprocess.stdout.write('recorder 1.0.0\\n');\nprocess.exit(0);\n`);
  return { marker, script };
}

async function attempt(workspace) {
  return codex.run({
    role: 'implementer',
    prompt: 'x',
    workspace,
    outputPath: path.join(workspace, 'out.json'),
    timeoutMs: 5000,
  });
}

function withEnv(patch, fn) {
  const saved = new Map();
  for (const key of Object.keys(patch)) {
    saved.set(key, process.env[key]);
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of saved.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('a real CLI that records its launch is never executed under node --test', async () => {
  const dir = tempRoot('isolation-recorder');
  const { marker, script } = recorder(dir);

  await withEnv({ CODEX_BIN: script, ORCH_TEST_ALLOW_DOUBLE: undefined, CODEX_API_KEY: 'sk-canary-live-key-value' }, async () => {
    const outcome = await attempt(dir);
    assert.equal(outcome.blocked.code, 'REAL_AGENT_DISABLED_IN_TEST');
    assert.equal(fs.existsSync(marker), false, 'the external CLI must not be spawned');
  });
});

test('an installed and authorised Codex is still refused in a test process', async () => {
  const dir = tempRoot('isolation-real');
  const realBinary = process.env.CLEAN_CODEX_BIN || null;
  if (!realBinary) {
    /* В чистой распаковке без Codex проверяется отсутствующий путь. */
    await withEnv({ CODEX_BIN: path.join(dir, 'no-such-codex.js'), ORCH_TEST_ALLOW_DOUBLE: undefined }, async () => {
      const outcome = await attempt(dir);
      assert.equal(outcome.blocked.code, 'REAL_AGENT_DISABLED_IN_TEST');
    });
    return;
  }
  await withEnv({ CODEX_BIN: realBinary, ORCH_TEST_ALLOW_DOUBLE: undefined }, async () => {
    const outcome = await attempt(dir);
    assert.equal(outcome.blocked.code, 'REAL_AGENT_DISABLED_IN_TEST');
  });
});

test('the declared test double runs only with an explicit opt-in', async () => {
  const dir = tempRoot('isolation-double');
  await withEnv({ CODEX_BIN: DOUBLE, ORCH_TEST_ALLOW_DOUBLE: undefined }, async () => {
    const blocked = await attempt(dir);
    assert.equal(blocked.blocked.code, 'REAL_AGENT_DISABLED_IN_TEST');
  });

  await withEnv({
    CODEX_BIN: DOUBLE, ORCH_TEST_ALLOW_DOUBLE: '1', FAKE_CODEX_MODE: 'final-no-newline', FAKE_CODEX_LOGIN: undefined,
  }, async () => {
    const allowed = await attempt(dir);
    assert.equal(allowed.blocked, undefined);
    assert.equal(allowed.session.id, 'fake-reviewer-final');
  });
});

test('ORCH_TEST_MODE alone is enough to disable real agents', async () => {
  const dir = tempRoot('isolation-mode');
  const { marker, script } = recorder(dir);
  await withEnv({ CODEX_BIN: script, NODE_TEST_CONTEXT: undefined, ORCH_TEST_MODE: '1', ORCH_TEST_ALLOW_DOUBLE: undefined }, async () => {
    const outcome = await attempt(dir);
    assert.equal(outcome.blocked.code, 'REAL_AGENT_DISABLED_IN_TEST');
    assert.equal(fs.existsSync(marker), false);
  });
});
