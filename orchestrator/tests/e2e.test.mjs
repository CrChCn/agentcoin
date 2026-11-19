import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../state/store.mjs';
import { cli, runLoop, TASKS, tempRoot } from './helpers.mjs';

test('two-agent loop: defect -> findings -> fix -> ACCEPTED, all hashes journaled', () => {
  const root = tempRoot('e2e');
  const init = cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'));
  assert.equal(init.state, 'CREATED');

  const trail = runLoop(root, 'lesson-01');
  const final = trail.at(-1);
  assert.equal(final.state, 'ACCEPTED', `trail: ${trail.map((t) => `${t.state}@${t.iteration}`).join(' -> ')}`);
  assert.equal(final.iteration, 2);

  const store = new Store(root);
  const state = store.load('lesson-01');
  const journal = store.verifyJournal('lesson-01');
  assert.equal(journal.ok, true, JSON.stringify(journal.errors));

  const reviews = journal.events
    .filter((e) => e.action === 'submit_review' && e.payload?.patch?.review)
    .map((e) => e.payload.patch.review.verdict);
  assert.deepEqual(reviews, ['CHANGES_REQUESTED', 'ACCEPTED']);

  const firstFindings = journal.events.find((e) => e.payload?.patch?.findings?.length)?.payload.patch.findings;
  assert.equal(firstFindings[0].code, 'ACCEPTANCE_TEST_FAILED');
  assert.match(firstFindings[0].evidence, /shipping|AC-5/i);

  assert.equal(state.artifacts.length, 2, 'one artifact per iteration');
  const artifact = state.artifacts.at(-1);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  const journaledHashes = journal.events.flatMap((e) => (e.payload?.patch?.artifacts || []).map((a) => a.sha256));
  for (const entry of state.artifacts) {
    assert.ok(journaledHashes.includes(entry.sha256), `artifact hash ${entry.artifactId} must be in the journal`);
  }
  assert.notEqual(state.artifacts[0].sha256, state.artifacts[1].sha256, 'fix must produce a new artifact');

  assert.deepEqual(state.result.changedFiles, ['src/pricing.mjs', 'tests/implementer.test.mjs']);
  assert.equal(state.simulatedReview, true);
  assert.equal(state.review.reviewer, 'fixture-reviewer');

  const accepted = journal.events.find((e) => e.to === 'ACCEPTED');
  assert.equal(accepted.payload.patch.acceptedArtifactSha256, artifact.sha256);
  assert.ok(journal.events.every((e) => e.from !== e.to || e.from === 'NONE'), 'no self transitions');
  assert.ok(state.artifacts.every((a) => a.resultCommit && a.baseCommit));
});
