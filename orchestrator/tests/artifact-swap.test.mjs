import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../state/store.mjs';
import { cli, cliRaw, runLoop, TASKS, tempRoot } from './helpers.mjs';

test('artifact swap: one byte invalidates the hash and revokes acceptance', () => {
  const root = tempRoot('swap');
  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'));
  const trail = runLoop(root, 'lesson-01');
  assert.equal(trail.at(-1).state, 'ACCEPTED');

  const store = new Store(root);
  const accepted = store.load('lesson-01');
  const meta = accepted.artifacts.at(-1);
  const archive = path.join(root, meta.path);

  // Неподменённый артефакт проходит проверку.
  const clean = cliRaw(root, 'verify', '--task', 'lesson-01', '--artifact', archive);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(JSON.parse(clean.stdout).ok, true);

  // Меняем ровно один байт.
  const bytes = fs.readFileSync(archive);
  const mutated = Buffer.from(bytes);
  const offset = Math.floor(mutated.length / 2);
  mutated[offset] ^= 0xff;
  const swapped = path.join(root, 'swapped.zip');
  fs.writeFileSync(swapped, mutated);

  const check = cliRaw(root, 'verify', '--task', 'lesson-01', '--artifact', swapped);
  assert.equal(check.status, 2, check.stderr);
  const verdict = JSON.parse(check.stdout);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.revoked, true);
  assert.equal(verdict.state, 'CHANGES_REQUESTED');
  assert.notEqual(verdict.actual, verdict.expected);

  const after = store.load('lesson-01');
  assert.equal(after.state, 'CHANGES_REQUESTED');
  assert.equal(after.acceptedArtifactSha256, null);
  assert.equal(after.acceptanceRevoked.expected, meta.sha256);
  assert.equal(after.acceptanceRevoked.actual, verdict.actual);

  const journal = store.verifyJournal('lesson-01');
  assert.equal(journal.ok, true);
  assert.equal(journal.events.at(-1).action, 'revoke_acceptance');
  assert.equal(journal.events.at(-1).from, 'ACCEPTED');
});
