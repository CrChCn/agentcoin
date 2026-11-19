import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../state/store.mjs';
import { cli, runLoop, TASKS, tempRoot } from './helpers.mjs';

test('restart: journal wins over a stale snapshot and the loop continues in a new process', () => {
  const root = tempRoot('restart');
  cli(root, 'init', '--task', path.join(TASKS, 'lesson-01.json'));

  // Три отдельных процесса: checkout, implement, review (каждый шаг — рестарт).
  const afterCheckout = cli(root, 'step', '--task', 'lesson-01');
  assert.equal(afterCheckout.state, 'READY');
  const afterImplement = cli(root, 'step', '--task', 'lesson-01');
  assert.equal(afterImplement.state, 'ARTIFACT_SUBMITTED');
  assert.ok(afterImplement.baseCommit);

  const store = new Store(root);
  const before = store.load('lesson-01');
  const stateFile = store.stateFile('lesson-01');
  const stale = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  // Имитация падения между записью события и снимка: снимок откатывается назад.
  stale.state = 'CREATED';
  stale.iteration = 0;
  fs.writeFileSync(stateFile, `${JSON.stringify(stale, null, 2)}\n`);

  const recovered = store.load('lesson-01');
  assert.equal(recovered.state, before.state, 'state must be replayed from the journal');
  assert.equal(recovered.iteration, before.iteration);

  // Продолжение после «перезапуска»: новый процесс доводит цикл до конца.
  const trail = runLoop(root, 'lesson-01');
  assert.equal(trail.at(-1).state, 'ACCEPTED');
  assert.equal(trail.at(-1).iteration, 2);

  const journal = store.verifyJournal('lesson-01');
  assert.equal(journal.ok, true);
  assert.ok(journal.events.length >= 8, `expected a full trail, got ${journal.events.length}`);
  const seqs = journal.events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i), 'seq must be contiguous');
});
