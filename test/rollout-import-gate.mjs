// Offline: scripts/check-module-imports.mjs — гейт, который раскатка прогоняет
// до копирования и после отката. Все каталоги временные, сеть и нода не нужны.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(root, 'scripts', 'check-module-imports.mjs');
const run = (staging, src) => spawnSync(process.execPath, [checker, staging, src], { encoding: 'utf8' });

const dirs = [];
function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-imports-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
const missingLines = stderr => stderr.split('\n').filter(line => line.includes('->'));

test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

test('пропуск: все относительные импорты разрешаются (staging + src)', () => {
  const src = workspace({ 'a.mjs': 'export const a = 1;\n' });
  const staging = workspace({
    'node.mjs': "import './b.mjs';\nimport './a.mjs';\nexport const node = 1;\n",
    'b.mjs': 'export const b = 2;\n',
  });
  const result = run(staging, src);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /импорты разрешаются/i);
});

test('пропавший модуль: отказ с именем импортёра и спецификатора', () => {
  const src = workspace({ 'a.mjs': 'export const a = 1;\n' });
  const staging = workspace({ 'node.mjs': "import './a.mjs';\nimport './gone.mjs';\n" });
  const result = run(staging, src);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /импорты не разрешаются \(1\)/);
  assert.deepEqual(missingLines(result.stderr), ['  node.mjs -> ./gone.mjs']);
  assert.equal(result.stdout, '');
});

test('дубликаты: один и тот же пропавший импорт попадает в отчёт один раз', () => {
  const src = workspace({ 'a.mjs': 'export const a = 1;\n' });
  const staging = workspace({
    'node.mjs': "import './gone.mjs';\nimport './gone.mjs';\nimport { x } from './gone.mjs';\n",
  });
  const result = run(staging, src);
  assert.equal(result.status, 1);
  assert.deepEqual(missingLines(result.stderr), ['  node.mjs -> ./gone.mjs']);
  assert.match(result.stderr, /импорты не разрешаются \(1\)/);
});

test('приоритет staging: исправленная копия модуля перекрывает битую в src', () => {
  // в src a.mjs сломан, в staging — исправлен; гейт должен проверять staging-версию
  const src = workspace({ 'a.mjs': "import './only-in-src.mjs';\n" });
  const staging = workspace({
    'node.mjs': "import './a.mjs';\n",
    'a.mjs': "import './ok.mjs';\n",
    'ok.mjs': 'export const ok = true;\n',
  });
  const result = run(staging, src);
  assert.equal(result.status, 0, result.stderr);

  // обратное направление: битая staging-копия не должна прятаться за целой src
  const srcGood = workspace({ 'node.mjs': "import './a.mjs';\n", 'a.mjs': 'export const a = 1;\n' });
  const stagingBad = workspace({ 'a.mjs': "import './nope.mjs';\n" });
  const broken = run(stagingBad, srcGood);
  assert.equal(broken.status, 1);
  assert.deepEqual(missingLines(broken.stderr), ['  a.mjs -> ./nope.mjs']);
});

test('транзитивные импорты из src тоже проверяются', () => {
  const src = workspace({ 'a.mjs': "import './b.mjs';\n" });
  const staging = workspace({ 'node.mjs': "import './a.mjs';\n" });
  const result = run(staging, src);
  assert.equal(result.status, 1);
  assert.deepEqual(missingLines(result.stderr), ['  a.mjs -> ./b.mjs']);
});

test('без аргументов — код 2 и подсказка по запуску', () => {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});
