import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { initTask, report, step } from '../lib/engine.mjs';
import { TASKS, tempRoot } from './helpers.mjs';

const taskId = 'lesson-01';
const fixtureTask = path.join(TASKS, `${taskId}.json`);

function assertReportCopies(root, expectedState) {
  const summary = report({ root, taskId });
  // reportPath нормализован к прямым слэшам, файл — платформенный путь.
  const logReport = `logs/${taskId}/report.json`;
  assert.equal(summary.state, expectedState);
  assert.equal(summary.reportPath, logReport);

  const copy = readFileSync(path.join(root, 'report.json'));
  assert.deepEqual(copy, readFileSync(path.join(root, 'logs', taskId, 'report.json')));
  const { reportPath, ...payload } = summary;
  assert.deepEqual(JSON.parse(copy), payload);
}

test('report writes identical JSON at the run root and the existing log path', (t) => {
  const root = tempRoot('report-copy');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initTask({ root, taskFile: fixtureTask });

  assertReportCopies(root, 'CREATED');
});

test('report writes both copies for a blocked run', async (t) => {
  const root = tempRoot('report-copy-blocked');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = JSON.parse(readFileSync(fixtureTask, 'utf8'));
  task.deadline = '2000-01-01T00:00:00Z';
  const taskFile = path.join(root, 'task.json');
  writeFileSync(taskFile, JSON.stringify(task));
  initTask({ root, taskFile });
  await step({ root, taskId });

  assertReportCopies(root, 'BLOCKED');
});
