import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI, ORCH, TASKS, tempRoot } from './helpers.mjs';
import * as codex from '../adapters/codex-cli.mjs';
import { buildArtifact } from '../artifacts/store.mjs';
import { scanTree } from '../lib/secrets.mjs';

/* Ключ передаётся процессу агента только через окружение. Тест подаёт
   канарейку в CODEX_API_KEY и проверяет, что она не появляется ни в одном
   сохранённом артефакте: argv, meta.json, JSONL, отчёт, промпты, ошибки. */

const FAKE = path.join(ORCH, 'tests', 'codex-cli-double.mjs');
const CANARY = 'sk-canary-9f4c1b7a2e5d8c3f6a0b';

function withCanary() {
  const previous = { key: process.env.CODEX_API_KEY, openai: process.env.OPENAI_API_KEY };
  process.env.CODEX_API_KEY = CANARY;
  delete process.env.OPENAI_API_KEY;
  return () => {
    if (previous.key === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previous.key;
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.openai;
  };
}

function workspace(label) {
  const root = tempRoot(label);
  const dir = path.join(root, 'ws');
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  return { root, dir, git };
}

function noCanary(text, where) {
  assert.equal(String(text).includes(CANARY), false, `secret leaked into ${where}`);
}

test('adapter output, argv, metadata, JSONL, prompt and error text are redacted', async () => {
  const restore = withCanary();
  try {
    const { dir } = workspace('secret-adapter');
    const transcripts = path.join(dir, 'logs', 'events.jsonl');
    const metaPath = path.join(dir, 'logs', 'meta.json');
    const promptPath = path.join(dir, 'logs', 'prompt.txt');
    const outputPath = path.join(dir, 'logs', 'result.json');

    process.env.CODEX_BIN = FAKE;
    process.env.FAKE_CODEX_MODE = 'leak-implement';
    process.env.FAKE_BASE_COMMIT = 'a'.repeat(40);
    process.env.FAKE_ITERATION = '1';

    const outcome = await codex.run({
      role: 'implementer',
      prompt: `implement the task (key must never be here)`,
      workspace: dir,
      outputPath,
      transcriptPath: transcripts,
      promptPath,
      metaPath,
      timeoutMs: 20000,
    });

    assert.ok(outcome.result, 'the double produced a structured result');
    noCanary(JSON.stringify(outcome), 'the adapter result');
    noCanary(outcome.session.argv.join(' '), 'argv');
    noCanary(fs.readFileSync(metaPath, 'utf8'), 'meta.json');
    noCanary(fs.readFileSync(transcripts, 'utf8'), 'JSONL transcript');
    noCanary(fs.readFileSync(promptPath, 'utf8'), 'prompt file');
    noCanary(fs.readFileSync(outputPath, 'utf8'), 'structured output file');
    assert.equal(outcome.result.knownLimitations.join(' ').includes('[REDACTED]'), true);

    process.env.FAKE_CODEX_MODE = 'leak-fail';
    const failed = await codex.run({
      role: 'implementer', prompt: 'x', workspace: dir,
      outputPath: path.join(dir, 'logs', 'failed.json'),
      transcriptPath: path.join(dir, 'logs', 'failed.jsonl'),
      metaPath: path.join(dir, 'logs', 'failed.meta.json'),
      timeoutMs: 20000,
    });
    assert.equal(failed.blocked.code, 'agent_failed');
    noCanary(failed.blocked.detail, 'the error message');
  } finally {
    restore();
  }
});

test('an artifact that would carry a secret is refused instead of packaged', () => {
  const restore = withCanary();
  try {
    const { root, dir } = workspace('secret-artifact');
    const artifactRoot = path.join(root, 'artifacts-root');
    fs.writeFileSync(path.join(dir, 'leak.txt'), `OPENAI_API_KEY=${CANARY}\n`);

    let caught = null;
    try {
      buildArtifact({
        root: artifactRoot,
        taskId: 'secret-task',
        iteration: 1,
        baseCommit: 'a'.repeat(40),
        resultCommit: 'b'.repeat(40),
        workspace: dir,
        changes: [{ file: 'leak.txt', status: 'modified' }],
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'buildArtifact must throw');
    assert.equal(caught.code, 'SECRET_IN_ARTIFACT');
    noCanary(caught.message, 'the artifact error message');
    assert.equal(fs.existsSync(path.join(artifactRoot, 'artifacts')), false, 'no artifact may be written');
  } finally {
    restore();
  }
});

test('a full two-agent cycle leaves no secret anywhere under the run root', () => {
  const restore = withCanary();
  try {
    const root = tempRoot('secret-cycle');
    const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args, '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_BIN: FAKE, ...env },
    });

    const init = run(['init', '--task', path.join(TASKS, 'lesson-01.json'), '--implementer', 'codex-implementer', '--reviewer', 'codex-reviewer']);
    assert.equal(init.status, 0, init.stderr);

    assert.equal(run(['step', '--task', 'lesson-01']).status, 0);
    assert.equal(run(['step', '--task', 'lesson-01'], { FAKE_CODEX_MODE: 'implement', FAKE_ROLE: 'implementer', FAKE_ITERATION: '1', FAKE_BASE_COMMIT: readBase(root) }).status, 0);

    const state = JSON.parse(fs.readFileSync(path.join(root, 'state', 'lesson-01', 'state.json'), 'utf8'));
    const meta = state.artifacts.at(-1);
    const reviewed = run(['step', '--task', 'lesson-01'], {
      FAKE_CODEX_MODE: 'review',
      FAKE_ROLE: 'reviewer',
      FAKE_ARTIFACT_SHA: meta.sha256,
      FAKE_BASE_COMMIT: state.baseCommit,
      FAKE_RESULT_COMMIT: state.result.resultCommit,
    });
    assert.equal(reviewed.status, 0, reviewed.stderr);

    const report = run(['report', '--task', 'lesson-01']);
    assert.equal(report.status, 0, report.stderr);
    noCanary(report.stdout, 'the report output');

    const hits = scanTree(root, [{ name: 'CODEX_API_KEY', value: CANARY }]);
    assert.deepEqual(hits, [], `secret found in: ${hits.map((hit) => hit.file).join(', ')}`);
  } finally {
    restore();
  }
});

function readBase(root) {
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state', 'lesson-01', 'state.json'), 'utf8'));
  return state.baseCommit;
}
