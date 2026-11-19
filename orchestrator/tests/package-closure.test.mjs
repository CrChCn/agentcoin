import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ORCH_ROOT, buildShipList, closure, describeMissing, importsOf, isRelativeSpecifier,
  resolveImport, runtimeEntrypoints, testEntrypoints, walkTree,
} from '../lib/package.mjs';

/* Комплектность: проверка идёт по реальному графу импортов, а не по списку
   файлов. Запускается и в рабочем дереве, и после распаковки архива — во
   втором случае дополнительно сверяет SHA256SUMS. */

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const REQUIRED_MODULES = [
  'orchestrator.mjs',
  'state/store.mjs',
  'artifacts/store.mjs',
  'artifacts/apply.mjs',
  'lib/engine.mjs',
  'lib/fsx.mjs',
  'lib/git.mjs',
  'lib/prompts.mjs',
  'lib/schema.mjs',
  'lib/zip.mjs',
  'lib/secrets.mjs',
  'lib/package.mjs',
  'lib/cleanroom.mjs',
  'lib/safefs.mjs',
  'lib/lock.mjs',
  'adapters/resolver.mjs',
  'adapters/codex-cli.mjs',
  'adapters/codex-implementer.mjs',
  'adapters/codex-reviewer.mjs',
  'adapters/fixture-implementer.mjs',
  'adapters/fixture-reviewer.mjs',
  'adapters/freebuff-cli.mjs',
  'policies/policy.mjs',
  'tools/pack.mjs',
  'tools/clean-check.mjs',
  'tools/environment-matrix.mjs',
  'tests/helpers.mjs',
  'tests/codex-cli-double.mjs',
  'tests/lock-holder.mjs',
  'tests/lock.test.mjs',
  'tests/symlink.test.mjs',
  'tests/test-isolation.test.mjs',
];

test('every runtime module imported by the orchestrator exists', () => {
  for (const rel of REQUIRED_MODULES) {
    assert.ok(fs.existsSync(path.join(ORCH_ROOT, rel)), `missing module: ${rel}`);
  }
});

test('static and literal dynamic imports all resolve inside the source tree', () => {
  /* fixtures/ — это груз задания: его файлы копируются в рабочее дерево
     агента, где их относительные импорты (../src/pricing.mjs) разрешаются.
     Граф модулей оркестратора их не включает. */
  const sources = walkTree(ORCH_ROOT)
    .filter((rel) => rel.endsWith('.mjs') && !rel.startsWith('fixtures/'));
  assert.ok(sources.length > 20, `unexpectedly few modules: ${sources.length}`);

  const broken = [];
  for (const rel of sources) {
    const source = fs.readFileSync(path.join(ORCH_ROOT, rel), 'utf8');
    for (const specifier of importsOf(source)) {
      if (!isRelativeSpecifier(specifier)) continue;
      if (!resolveImport(rel, specifier)) broken.push(`${rel} -> ${specifier}`);
    }
  }
  assert.deepEqual(broken, [], `unresolvable imports:\n${broken.join('\n')}`);
});

test('the closure of runtime and test entrypoints is complete and self-contained', () => {
  const entrypoints = [...runtimeEntrypoints(), ...testEntrypoints(), 'tools/pack.mjs', 'tools/clean-check.mjs'];
  const result = closure(entrypoints);
  assert.deepEqual(result.missing, [], describeMissing(result.missing));

  const files = new Set(result.files);
  for (const required of ['state/store.mjs', 'artifacts/store.mjs', 'artifacts/apply.mjs']) {
    assert.ok(files.has(required), `${required} is not reachable from any entrypoint`);
  }

  const { files: ship, missing } = buildShipList();
  assert.deepEqual(missing, [], describeMissing(missing));
  for (const rel of files) assert.ok(ship.includes(rel), `closure file not in package list: ${rel}`);
});

test('orchestrator, adapters and test entrypoints load as modules', async () => {
  const orchestrator = await import(new URL('../orchestrator.mjs', import.meta.url).href);
  assert.equal(typeof orchestrator, 'object');

  const resolver = await import(new URL('../adapters/resolver.mjs', import.meta.url).href);
  const ids = resolver.listAdapters().map((adapter) => adapter.id);
  for (const id of ['codex-implementer', 'codex-reviewer', 'fixture-implementer', 'fixture-reviewer']) {
    assert.ok(ids.includes(id), `adapter not registered: ${id}`);
  }
  for (const name of ['codex-implementer.mjs', 'codex-reviewer.mjs', 'codex-cli.mjs', 'fixture-implementer.mjs', 'fixture-reviewer.mjs']) {
    const module = await import(new URL(`../adapters/${name}`, import.meta.url).href);
    assert.equal(typeof module.id, 'string', `${name} does not export an id`);
  }

  /* Тестовые entrypoint проверяются синтаксически: импорт запустил бы их. */
  for (const rel of testEntrypoints()) {
    const check = spawnSync(process.execPath, ['--check', path.join(ORCH_ROOT, rel)], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(check.status, 0, `${rel} does not parse:\n${check.stderr}`);
  }
});

test('unpacked archive is complete: SHA256SUMS covers every file', () => {
  const sumsFile = path.join(ORCH_ROOT, 'SHA256SUMS');
  if (!fs.existsSync(sumsFile)) {
    /* В рабочем дереве SHA256SUMS нет: он создаётся при упаковке.
       Тест обязан выполняться после распаковки архива. */
    return;
  }
  const lines = fs.readFileSync(sumsFile, 'utf8').trim().split('\n').filter(Boolean);
  const listed = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s{1,2}(.+)$/.exec(line);
    assert.ok(match, `malformed SHA256SUMS line: ${line}`);
    const [, digest, rel] = match;
    const abs = path.join(ORCH_ROOT, rel);
    assert.ok(fs.existsSync(abs), `SHA256SUMS lists a missing file: ${rel}`);
    assert.equal(sha256(fs.readFileSync(abs)), digest, `hash mismatch: ${rel}`);
    listed.add(rel);
  }

  const present = walkTree(ORCH_ROOT).filter((rel) => rel !== 'SHA256SUMS');
  const unlisted = present.filter((rel) => !listed.has(rel));
  assert.deepEqual(unlisted, [], `files present but not in SHA256SUMS: ${unlisted.join(', ')}`);

  assert.ok(listed.has('FILELIST.txt'), 'SHA256SUMS must cover FILELIST.txt');

  const fileList = path.join(ORCH_ROOT, 'FILELIST.txt');
  assert.ok(fs.existsSync(fileList), 'FILELIST.txt is missing from the package');
  const listedNames = new Set(fs.readFileSync(fileList, 'utf8').trim().split('\n')
    .map((line) => /^[a-f0-9]{64}\s+\d+\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]));
  for (const rel of present) {
    if (rel === 'FILELIST.txt' || rel === 'SHA256SUMS') continue;
    assert.ok(listedNames.has(rel), `FILELIST.txt misses ${rel}`);
  }
});
