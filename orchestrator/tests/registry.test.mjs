import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateCheck } from '../service/checks.mjs';
import { planNext } from '../service/planner.mjs';
import { OpsStore } from '../service/store.mjs';
import { loadTask } from '../lib/engine.mjs';
import { initRepo } from '../lib/git.mjs';
import { canonical, sha256 } from '../lib/fsx.mjs';

/* Реестр — не проза, а исполняемые проверки. Этот тест держит два свойства:
   1) каждая запись проверяется против реального репозитория и не пропускается;
   2) ТЗ каждой записи проходит контракт задания (иначе планировщик поставил бы
      задачу, которую движок отвергнет уже после взятия из очереди).
   Третье свойство — инварианты репозитория сейчас держатся, поэтому
   планировщик честно IDLE, а не выдумывает работу. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.resolve(HERE, '..');
/* В рабочем дереве инварианты проверяются против настоящего репозитория
   (site/, node.mjs, caddy-routes.conf лежат рядом с orchestrator/).
   В распакованном архиве родительский каталог пуст — там берётся канонический
   фикстур-репозиторий: проверки исполняются, а не пропускаются. Иначе реестр
   в пакете никто и никогда не проверял бы, а clean-room падал бы на том, что
   пакет не обязан содержать чужой сайт. */
const OUTER_REPO = path.resolve(ORCH, '..');
const OUTER_REPO_IS_SOURCE = fs.existsSync(path.join(OUTER_REPO, 'site', 'ops.html'))
  && fs.existsSync(path.join(OUTER_REPO, 'node.mjs'))
  && fs.existsSync(path.join(OUTER_REPO, 'caddy-routes.conf'));
const REPO = OUTER_REPO_IS_SOURCE ? OUTER_REPO : path.join(ORCH, 'fixtures', 'repo-invariants');
const registry = JSON.parse(fs.readFileSync(path.join(ORCH, 'service', 'registry.json'), 'utf8'));
const entries = (registry.entries || []).filter((entry) => entry && entry.enabled !== false);

const outcomes = entries.map((entry) => ({ entry, outcome: evaluateCheck(entry.check, { repositoryRoot: REPO }) }));

test('реестр не пуст и каждая проверка реально исполняется', () => {
  assert.ok(entries.length >= 5, `ожидалось не меньше 5 инвариантов, найдено ${entries.length}`);
  const ids = new Set();
  for (const { entry, outcome } of outcomes) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]{2,}$/, `id записи: ${entry.id}`);
    assert.equal(ids.has(entry.id), false, `повторный id в реестре: ${entry.id}`);
    ids.add(entry.id);
    assert.equal(outcome.skipped, undefined, `${entry.id}: проверка пропущена (${outcome.detail}) — доказательства нет`);
    assert.ok(Array.isArray(outcome.evidence) && outcome.evidence.length >= 1, `${entry.id}: нет evidence`);
    assert.equal(typeof outcome.ok, 'boolean', `${entry.id}: проверка не дала ответа`);
    assert.match(outcome.signature, /^[a-f0-9]{64}$/, `${entry.id}: подпись расхождения`);
  }
});

test('ТЗ каждой записи проходит контракт задания', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-registry-'));
  try {
    for (const { entry } of outcomes) {
      const file = path.join(dir, `${entry.id}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...entry.task, taskId: `gap-${entry.id}` }));
      const task = loadTask(file);
      assert.equal(task.productionWrites, false, `${entry.id}: productionWrites зафиксирован false`);
      assert.equal(task.moneyOperations, false, `${entry.id}: moneyOperations зафиксирован false`);
      assert.equal(task.consensusChanges, false, `${entry.id}: consensusChanges зафиксирован false`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('инварианты репозитория держатся: планировщику нечего ставить', () => {
  const gaps = outcomes.filter(({ outcome }) => outcome.ok !== true)
    .map(({ entry, outcome }) => `${entry.id}: ${(outcome.evidence || []).join('; ')}`);
  assert.deepEqual(gaps, [], `доказанные расхождения (${REPO}): ${gaps.join(' | ')}`);
});

/* Иначе доказанная дыра в этом репозитории «чинилась» бы в fixture-шаблоне:
   движок берёт source из задания, а планировщик его не подставлял. */
test('задача реестра выполняется в том репозитории, где доказано расхождение', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-registry-src-'));
  try {
    const repo = path.join(dir, 'repository');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
    initRepo(repo);

    const root = dir;
    const store = new OpsStore(root);
    fs.mkdirSync(path.join(root, 'queue', 'tasks'), { recursive: true });
    const task = JSON.parse(fs.readFileSync(path.join(ORCH, 'fixtures', 'tasks', 'lesson-01.json'), 'utf8'));
    delete task.taskId;
    fs.writeFileSync(path.join(root, 'queue', 'registry.json'), JSON.stringify({
      version: 2,
      entries: [{
        id: 'demo-missing-doc', enabled: true, priority: 10, type: 'registry_gap',
        check: { kind: 'file_exists', path: 'docs/missing.md' }, task,
      }],
    }, null, 2));
    const mission = {
      mission: 'test mission', continuous: false,
      planner: { enabled: true, taskPrefix: 'gap' },
      repositoryRoot: 'repository',
      adapters: { mode: 'fixture' },
    };

    const plan = planNext(store, mission);
    assert.equal(plan.action, 'enqueued', JSON.stringify(plan));
    const planned = JSON.parse(fs.readFileSync(plan.taskFile, 'utf8'));
    assert.deepEqual(planned.source, { repo: path.resolve(repo), ref: 'HEAD' }, 'источник — тот же репозиторий, где упала проверка');
    assert.equal(planned.trigger.registryId, 'demo-missing-doc');
    loadTask(plan.taskFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('поколение инцидента меняет ключ дедупликации', () => {
  const key = (generation) => sha256(canonical({ id: 'ops-page-route', generation }));
  assert.notEqual(key(1), key(2), 'вернувшийся дефект получает новый ключ');
  assert.equal(key(2), key(2), 'ключ детерминирован для одного поколения');
});
