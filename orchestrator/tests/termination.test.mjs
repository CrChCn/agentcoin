import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ORCH, tempRoot } from './helpers.mjs';
import * as codex from '../adapters/codex-cli.mjs';

const FAKE = path.join(ORCH, 'tests', 'codex-cli-double.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Двойник объявлен явно: без этого тестовый режим запрещает любой агент.
   Состояние входа двойника тоже фиксируется: набор не должен зависеть от
   переменных, унаследованных из окружения запуска. */
process.env.CODEX_BIN = FAKE;
process.env.ORCH_TEST_ALLOW_DOUBLE = '1';
delete process.env.FAKE_CODEX_LOGIN;

function prepare(label) {
  const root = tempRoot(label);
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  return {
    root,
    workspace,
    outputPath: path.join(root, 'out.json'),
    transcriptPath: path.join(root, 'events.jsonl'),
    metaPath: path.join(root, 'meta.json'),
  };
}

test('a process that ignores SIGTERM still ends the run: BLOCKED, never a hang', async () => {
  const ctx = prepare('term-ignore');
  process.env.CODEX_BIN = FAKE;
  process.env.FAKE_CODEX_MODE = 'ignore-sigterm';

  const started = Date.now();
  const result = await codex.execWithEvents({
    prompt: 'x',
    workspace: ctx.workspace,
    /* 1500, а не 300: под нагрузкой node-двойник может не успеть установить
       обработчик SIGTERM, и процесс умрёт от сигнала по умолчанию — тогда
       эскалации не будет вовсе, хотя политика ни при чём. */
    timeoutMs: 1500,
    graceMs: 500,
    reapMs: 2000,
    outputPath: ctx.outputPath,
    transcriptPath: ctx.transcriptPath,
    metaPath: ctx.metaPath,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true, 'timeout must be reported');
  assert.ok(elapsed < 15000, `termination took ${elapsed} ms`);
  assert.ok(fs.existsSync(ctx.metaPath), 'meta.json must be written even on a kill');

  const meta = JSON.parse(fs.readFileSync(ctx.metaPath, 'utf8'));
  assert.equal(meta.timedOut, true);
  assert.equal(meta.termination.requested, 'timeout');
  assert.ok(meta.termination.graceful, 'a graceful signal must be attempted first');
  assert.notEqual(meta.termination.phase, 'running');
  /* На Windows SIGTERM — это TerminateProcess: игнорировать его нельзя, поэтому
     эскалация проверяется отдельным тестом плана остановки. */
  if (process.platform !== 'win32') {
    assert.equal(meta.termination.escalated, true, 'SIGTERM must escalate to a forced tree kill');
  }

  process.env.FAKE_CODEX_MODE = 'ignore-sigterm';
  const blocked = await codex.run({
    role: 'implementer', prompt: 'x', workspace: ctx.workspace,
    outputPath: ctx.outputPath, transcriptPath: ctx.transcriptPath, metaPath: ctx.metaPath,
    timeoutMs: 1500, graceMs: 500, reapMs: 2000,
  });
  assert.equal(blocked.blocked.code, 'agent_timeout');
});

test('termination plan: SIGTERM, grace, forced tree kill, abandoned promises settle', async () => {
  const calls = [];
  const child = { pid: 4242, kill: () => calls.push('child.kill') };
  const sendSignal = (target, signal) => {
    calls.push(signal);
    return { ok: true, method: signal };
  };

  const plan = codex.createTermination({ child, graceMs: 40, reapMs: 40, sendSignal });
  assert.equal(plan.request('timeout'), true);
  assert.equal(plan.request('timeout'), false, 'second request must be ignored');
  assert.deepEqual(calls, ['SIGTERM']);
  assert.equal(plan.phase, 'terminating');

  await sleep(70);
  assert.deepEqual(calls, ['SIGTERM', 'SIGKILL'], 'grace must end with a forced kill');
  assert.equal(plan.snapshot().escalated, true);

  let abandoned = 0;
  const stuck = codex.createTermination({
    child, graceMs: 10, reapMs: 10, sendSignal, onAbandon: () => { abandoned += 1; },
  });
  stuck.request('timeout');
  await sleep(80);
  assert.equal(abandoned, 1, 'a promise must be released even if the process never exits');
  assert.equal(stuck.snapshot().abandoned, true);

  const withDeadline = codex.createTermination({ child, graceMs: 1000, reapMs: 1000, sendSignal });
  withDeadline.request('timeout');
  assert.equal(withDeadline.settle().phase, 'settled');
});

test('the last JSONL record is parsed even without a trailing newline', async () => {
  const ctx = prepare('term-tail');
  process.env.CODEX_BIN = FAKE;
  process.env.FAKE_CODEX_MODE = 'final-no-newline';

  const result = await codex.execWithEvents({
    prompt: 'x',
    workspace: ctx.workspace,
    timeoutMs: 10000,
    outputPath: ctx.outputPath,
    transcriptPath: ctx.transcriptPath,
    metaPath: ctx.metaPath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'fake-reviewer-final', 'thread_id from the unterminated line must be kept');
  assert.equal(result.usage.totalTokens, 18, 'usage from the unterminated line must be kept');
  assert.equal(result.rawUsage.output_tokens, 7);

  const transcript = fs.readFileSync(ctx.transcriptPath, 'utf8');
  assert.ok(transcript.includes('fake-reviewer-final'), 'final record must be written to the transcript');
  const meta = JSON.parse(fs.readFileSync(ctx.metaPath, 'utf8'));
  assert.equal(meta.threadId, 'fake-reviewer-final');
  assert.equal(meta.rawUsage.total_tokens, 18);
});
