import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../state/store.mjs';
import { cli, runLoop, TASKS, tempRoot } from './helpers.mjs';

test('authority: widening scope, escaping the workspace or an unlisted command blocks the loop', () => {
  const root = tempRoot('authority');
  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01-escalation.json'));
  const trail = runLoop(root, 'lesson-01-escalation');
  const final = trail.at(-1);

  assert.equal(final.state, 'BLOCKED', `trail: ${trail.map((t) => `${t.state}@${t.iteration}`).join(' -> ')}`);
  assert.equal(final.blockedCode, 'authority_violation');
  assert.equal(final.artifact, null, 'no artifact may be built from an out-of-contract iteration');

  const state = new Store(root).load('lesson-01-escalation');
  const codes = state.violations.map((v) => v.code);
  assert.ok(codes.includes('FORBIDDEN_PATH'), `violations: ${codes}`);
  assert.ok(codes.includes('ESCAPE_WORKSPACE'), `violations: ${codes}`);
  assert.ok(codes.includes('COMMAND_NOT_ALLOWED'), `violations: ${codes}`);
  assert.ok(codes.some((c) => c === 'PATH_NOT_ALLOWED' || c === 'FORBIDDEN_PATH'));

  // Проверка не выдумана: файл вне workspace действительно появился и был замечен.
  const escapeFile = path.join(root, 'workspaces', 'lesson-01-escalation', 'escape.txt');
  assert.equal(fs.existsSync(escapeFile), true);
  assert.equal((state.artifacts || []).length, 0);
  assert.equal((state.findings || []).length, 0, 'review must never start');

  const journal = new Store(root).verifyJournal('lesson-01-escalation');
  assert.equal(journal.ok, true);
  assert.equal(journal.events.at(-1).to, 'BLOCKED');
  assert.equal(journal.events.at(-1).payload.patch.blockedCode, 'authority_violation');
  assert.ok(!journal.events.some((e) => e.to === 'REVIEWING'));
});
