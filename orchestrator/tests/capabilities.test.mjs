import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cli, TASKS, tempRoot } from './helpers.mjs';
import * as freebuff from '../adapters/freebuff-cli.mjs';
import * as codex from '../adapters/codex-cli.mjs';

test('Freebuff: official surface is interactive, so it is not a programmatic interface', () => {
  const capability = freebuff.probe();
  assert.equal(capability.programmatic, false);
  assert.match(capability.evidence, /docs\.freebuff\.page/);
  assert.match(capability.reason, /интерактив|interactive|scriptable|JSON/i);
  assert.equal(freebuff.simulated, false);
});

test('Codex: official CLI is programmatic (codex exec)', () => {
  const capability = codex.probe();
  assert.equal(capability.programmatic, true);
  assert.match(capability.evidence, /developers\.openai\.com/);
});

test('a non-programmatic implementer results in BLOCKED, not a simulated success', () => {
  const root = tempRoot('capa-freebuff');
  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'), '--implementer', 'freebuff-cli');
  cli(root, 'step', '--task', 'lesson-01');
  const blocked = cli(root, 'step', '--task', 'lesson-01');
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.blockedCode, 'agent_not_scriptable');
  assert.equal(blocked.artifact, null);
});

test('an unavailable or unauthenticated Codex results in BLOCKED', () => {
  const root = tempRoot('capa-codex');
  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'), '--implementer', 'codex-cli');
  cli(root, 'step', '--task', 'lesson-01');
  const blocked = cli(root, 'step', '--task', 'lesson-01');
  assert.equal(blocked.state, 'BLOCKED');
  assert.ok(
    ['agent_unavailable', 'agent_unauthenticated'].includes(blocked.blockedCode),
    `unexpected code: ${blocked.blockedCode}`,
  );
  assert.match(blocked.reason, /codex|CODEX_API_KEY|codex login/i);
});
