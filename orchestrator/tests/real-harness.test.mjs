import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI, ORCH, TASKS, tempRoot, testEnv } from './helpers.mjs';
import * as codex from '../adapters/codex-cli.mjs';

/* Проводка реальных адаптеров проверяется процессным двойником CLI.
   Это НЕ доказательство реального цикла: настоящий прогон требует codex login.
   Двойник нужен, чтобы доказать: два разных процесса дают два thread_id,
   usage и JSONL пишутся, а невалидный вывод не превращается в успех. */

const FAKE = path.join(ORCH, 'tests', 'codex-cli-double.mjs');
const DOUBLE_ENV = { CODEX_BIN: FAKE, ORCH_TEST_ALLOW_DOUBLE: '1' };

function stepWith(root, taskId, env) {
  const result = spawnSync(process.execPath, [CLI, 'step', '--task', taskId, '--root', root], {
    encoding: 'utf8',
    env: testEnv({ ...DOUBLE_ENV, ...env }),
  });
  if (result.status !== 0) throw new Error(`step failed: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function initReal(root) {
  const result = spawnSync(process.execPath, [
    CLI, 'init', '--task', path.join(TASKS, 'lesson-01.json'),
    '--implementer', 'codex-implementer', '--reviewer', 'codex-reviewer',
    '--confirm-real-agents', 'lesson-01', '--root', root,
  ], { encoding: 'utf8', env: testEnv(DOUBLE_ENV) });
  if (result.status !== 0) throw new Error(`init failed: ${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('two real adapter processes: distinct thread_id, JSONL, usage, ACCEPTED', () => {
  const root = tempRoot('harness-accept');
  initReal(root);
  const checked = stepWith(root, 'lesson-01', {});
  assert.equal(checked.state, 'READY');

  const implemented = stepWith(root, 'lesson-01', {
    FAKE_CODEX_MODE: 'implement', FAKE_ROLE: 'implementer', FAKE_ITERATION: '1',
    FAKE_BASE_COMMIT: checked.baseCommit,
  });
  assert.equal(implemented.state, 'ARTIFACT_SUBMITTED');

  const stateFile = path.join(root, 'state', 'lesson-01', 'state.json');
  const snapshot = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const meta = snapshot.artifacts.at(-1);

  const reviewed = stepWith(root, 'lesson-01', {
    FAKE_CODEX_MODE: 'review', FAKE_ROLE: 'reviewer',
    FAKE_ARTIFACT_SHA: meta.sha256,
    FAKE_BASE_COMMIT: snapshot.baseCommit,
    FAKE_RESULT_COMMIT: snapshot.result.resultCommit,
  });
  assert.equal(reviewed.state, 'ACCEPTED');

  const finalState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const implementerThreads = finalState.sessions.implementer.map((s) => s.threadId);
  const reviewerThreads = finalState.sessions.reviewer.map((s) => s.threadId);
  assert.equal(implementerThreads.length, 1);
  assert.equal(reviewerThreads.length, 1);
  assert.notEqual(implementerThreads[0], reviewerThreads[0], 'roles must run in different threads');
  assert.equal(finalState.usage.totalTokens, 3000);
  assert.ok(finalState.runtimeMs.implementer > 0 && finalState.runtimeMs.reviewer > 0);

  for (const session of [...finalState.sessions.implementer, ...finalState.sessions.reviewer]) {
    const transcript = path.join(root, session.transcript);
    assert.ok(fs.existsSync(transcript), `missing JSONL ${session.transcript}`);
    const first = JSON.parse(fs.readFileSync(transcript, 'utf8').split('\n')[0]);
    assert.equal(first.type, 'thread.started');
    assert.equal(first.thread_id, session.threadId);
  }
  assert.equal(finalState.simulatedReview, false);
});

test('reviewer ACCEPTED with a failing executed check is downgraded, not accepted', () => {
  const root = tempRoot('harness-downgrade');
  initReal(root);
  const checked = stepWith(root, 'lesson-01', {});
  stepWith(root, 'lesson-01', {
    FAKE_CODEX_MODE: 'implement', FAKE_ROLE: 'implementer', FAKE_ITERATION: '1',
    FAKE_BASE_COMMIT: checked.baseCommit,
  });

  const stateFile = path.join(root, 'state', 'lesson-01', 'state.json');
  const snapshot = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const meta = snapshot.artifacts.at(-1);
  const reviewed = stepWith(root, 'lesson-01', {
    FAKE_CODEX_MODE: 'review', FAKE_ROLE: 'reviewer', FAKE_CHECK_OK: '0',
    FAKE_ARTIFACT_SHA: meta.sha256,
    FAKE_BASE_COMMIT: snapshot.baseCommit,
    FAKE_RESULT_COMMIT: snapshot.result.resultCommit,
  });
  assert.equal(reviewed.state, 'CHANGES_REQUESTED');
  const finalState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(finalState.reviewDowngraded, true);
  assert.equal(finalState.review.verdict, 'CHANGES_REQUESTED');
});

test('adapter failures are BLOCKED, never a successful result', async () => {
  const root = tempRoot('harness-failures');
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace);
  process.env.CODEX_BIN = FAKE;
  process.env.ORCH_TEST_ALLOW_DOUBLE = '1';
  delete process.env.FAKE_CODEX_LOGIN;

  const base = {
    role: 'implementer', prompt: 'x', workspace,
    outputPath: path.join(root, 'out.json'),
    transcriptPath: path.join(root, 'events.jsonl'),
    metaPath: path.join(root, 'meta.json'),
    timeoutMs: 5000,
  };

  process.env.FAKE_CODEX_MODE = 'invalid-json';
  const invalid = await codex.run({ ...base });
  assert.equal(invalid.blocked.code, 'agent_contract_invalid');

  process.env.FAKE_CODEX_MODE = 'missing-commit';
  const missing = await codex.run({ ...base });
  assert.equal(missing.blocked.code, 'agent_contract_missing_commit');

  process.env.FAKE_CODEX_MODE = 'sleep';
  const timedOut = await codex.run({ ...base, timeoutMs: 300 });
  assert.equal(timedOut.blocked.code, 'agent_timeout');
});
