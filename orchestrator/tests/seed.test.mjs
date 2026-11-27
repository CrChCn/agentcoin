/* Семя: сервис о нём докладывает, владелец — регулирует.
   Проверяется не только форма отчёта, но и граница: файл, который сервис
   может переписать, обязан быть назван проблемой, а не «ок». */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectSeed } from '../service/seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPSD = path.join(HERE, '..', 'service', 'opsd.mjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-seed-'));
  const repository = path.join(root, 'repository');
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'docs', 'present.md'), 'инвариант держится\n');
  fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
  const missionFile = path.join(root, 'queue', 'mission.json');
  const mission = { version: 2, mission: 'test mission', planner: { enabled: true }, repositoryRoot: 'repository' };
  fs.writeFileSync(missionFile, JSON.stringify(mission, null, 2));
  return { root, repository, missionFile, mission, registryFile: path.join(root, 'queue', 'registry.json') };
}

const entry = (id, check, extra = {}) => ({
  id,
  enabled: true,
  priority: 10,
  type: 'registry_gap',
  check,
  task: { title: `fix ${id}`, objective: 'доказательство', scope: { allowedPaths: ['docs'] } },
  ...extra,
});

const inspect = (box, extra = {}) => inspectSeed({
  missionFile: box.missionFile,
  mission: box.mission,
  registryFile: box.registryFile,
  repositoryRoot: box.repository,
  ...extra,
});

test('пустое семя — штатный IDLE, а не проблема', () => {
  const box = sandbox();
  const report = inspect(box);
  assert.equal(report.registry.present, false);
  assert.equal(report.state, 'empty');
  assert.deepEqual(report.problems, []);
  assert.match(report.hint, /IDLE/);
});

test('падающая проверка — gap, проходящая — closed', () => {
  const box = sandbox();
  fs.writeFileSync(box.registryFile, JSON.stringify({
    version: 2,
    entries: [
      entry('missing', { kind: 'file_exists', path: 'docs/absent.md' }),
      entry('present', { kind: 'file_exists', path: 'docs/present.md' }),
    ],
  }));
  const report = inspect(box);
  assert.equal(report.state, 'gap');
  assert.equal(report.registry.entries, 2);
  assert.equal(report.registry.enabled, 2);
  const byId = Object.fromEntries(report.entries.map((item) => [item.id, item]));
  assert.equal(byId.missing.status, 'gap');
  assert.equal(byId.present.status, 'closed');
  assert.ok(byId.missing.evidence.length > 0);
  assert.deepEqual(report.problems, []);
});

test('containment не даёт доказательства: запись skipped, а не gap', () => {
  const box = sandbox();
  fs.writeFileSync(box.registryFile, JSON.stringify({
    version: 2,
    entries: [entry('escape', { kind: 'file_exists', path: '../outside.md' })],
  }));
  const report = inspect(box);
  assert.equal(report.entries[0].status, 'skipped');
  /* Отсутствие доказательства — не «инвариант держится». */
  assert.equal(report.state, 'unknown');
  assert.match(report.hint, /не дали доказательства/);
  assert.deepEqual(report.problems, []);
});

test('нет repositoryRoot — unknown, а не closed', () => {
  const box = sandbox();
  fs.writeFileSync(box.registryFile, JSON.stringify({
    version: 2,
    entries: [entry('present', { kind: 'file_exists', path: 'docs/present.md' })],
  }));
  const report = inspect(box, { repositoryRoot: path.join(box.root, 'no-such-repo') });
  assert.equal(report.repositoryRoot.present, false);
  assert.equal(report.entries[0].status, 'skipped');
  assert.equal(report.state, 'unknown');
  assert.equal(report.registry.statuses.skipped, 1);
  assert.equal(report.registry.statuses.closed, 0);
});

test('неизвестная проверка, дубль id и битый JSON — invalid', () => {
  const unknown = sandbox();
  fs.writeFileSync(unknown.registryFile, JSON.stringify({
    version: 2,
    entries: [entry('weird', { kind: 'file_smells', path: 'docs/present.md' })],
  }));
  const unknownReport = inspect(unknown);
  assert.equal(unknownReport.state, 'invalid');
  assert.equal(unknownReport.entries[0].status, 'invalid');
  assert.ok(unknownReport.problems.some((item) => item.code === 'SEED_ENTRY_INVALID'));

  const duplicate = sandbox();
  fs.writeFileSync(duplicate.registryFile, JSON.stringify({
    version: 2,
    entries: [entry('same', { kind: 'file_exists', path: 'docs/present.md' }), entry('same', { kind: 'file_exists', path: 'docs/absent.md' })],
  }));
  assert.ok(inspect(duplicate).problems.some((item) => item.code === 'SEED_DUPLICATE_ID'));

  const broken = sandbox();
  fs.writeFileSync(broken.registryFile, '{"version": 2, "entries": [');
  const brokenReport = inspect(broken);
  assert.equal(brokenReport.state, 'invalid');
  assert.ok(brokenReport.problems.some((item) => item.code === 'SEED_INVALID_JSON'));

  const noMission = sandbox();
  fs.rmSync(noMission.missionFile);
  assert.ok(inspect(noMission).problems.some((item) => item.code === 'SEED_MISSION_MISSING'));
});

test('выключенная запись не делает семя работающим', () => {
  const box = sandbox();
  fs.writeFileSync(box.registryFile, JSON.stringify({
    version: 2,
    entries: [entry('off', { kind: 'file_exists', path: 'docs/absent.md' }, { enabled: false })],
  }));
  const report = inspect(box);
  assert.equal(report.entries[0].status, 'disabled');
  assert.equal(report.state, 'empty');
});

test('владение семенем: проверяется там, где права вообще есть', (t) => {
  const box = sandbox();
  fs.writeFileSync(box.registryFile, JSON.stringify({
    version: 2,
    entries: [entry('present', { kind: 'file_exists', path: 'docs/present.md' })],
  }));

  if (typeof process.getuid !== 'function') {
    /* Windows: POSIX-владения нет, и отчёт обязан это сказать, а не соврать «ок». */
    const report = inspect(box);
    assert.equal(report.provenance.mission.verifiable, false);
    assert.equal(report.provenance.mission.ownerControlled, null);
    t.diagnostic('POSIX ownership is unavailable on this host');
    return;
  }

  fs.chmodSync(box.missionFile, 0o666);
  const writable = inspect(box);
  assert.ok(writable.problems.some((item) => item.code === 'SEED_SERVICE_WRITABLE'), 'запись сервису — проблема');
  assert.equal(writable.state, 'invalid');

  /* 0444: сервис (он же владелец в тесте) писать не может, но владелец — не root. */
  fs.chmodSync(box.missionFile, 0o444);
  const notRoot = inspect(box);
  assert.ok(notRoot.problems.some((item) => item.code === 'SEED_NOT_ROOT_OWNED'), 'семя не root — проблема');
});

test('CLI: seed печатает отчёт и возвращает 2 на непригодном семени', () => {
  const box = sandbox();
  fs.writeFileSync(box.registryFile, JSON.stringify({
    version: 2,
    entries: [entry('present', { kind: 'file_exists', path: 'docs/present.md' })],
  }));
  const ok = JSON.parse(execFileSync(process.execPath, [OPSD, 'seed', '--root', box.root], { encoding: 'utf8' }));
  assert.equal(ok.state, 'closed');
  assert.equal(ok.registry.enabled, 1);

  fs.writeFileSync(box.registryFile, JSON.stringify({ version: 2, entries: [entry('bad', { kind: 'nope' })] }));
  let failure = null;
  try {
    execFileSync(process.execPath, [OPSD, 'seed', '--root', box.root], { encoding: 'utf8' });
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'непригодное семя обязано дать ненулевой код');
  assert.equal(failure.status, 2);
  assert.equal(JSON.parse(failure.stdout).state, 'invalid');
});
