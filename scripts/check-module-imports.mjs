#!/usr/bin/env node
// check-module-imports.mjs — проверка, что относительные импорты модулей ноды
// разрешаются, ЕЩЁ ДО копирования и рестарта. Ловит случай «привёз node.mjs,
// а новый seeds.mjs забыл»: раньше такой деплой падал уже в юните.
//
// Использование:
//   node check-module-imports.mjs <stagingDir> <srcDir>
// stagingDir — что собираемся положить (новые файлы), srcDir — что уже стоит.
// Файл из staging перекрывает одноимённый в srcDir — проверяется именно то
// состояние, которое получится после копирования.
import fs from 'node:fs';
import path from 'node:path';

const [rawStaging, rawSrc] = process.argv.slice(2);
if (!rawStaging || !rawSrc) {
  console.error('usage: node check-module-imports.mjs <stagingDir> <srcDir>');
  process.exit(2);
}
const stagingDir = path.resolve(rawStaging);
const srcDir = path.resolve(rawSrc);
for (const dir of [stagingDir, srcDir]) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`✗ нет каталога ${dir}`);
    process.exit(2);
  }
}

// from './x.mjs' | import('./x.mjs') | import './x.mjs' | export * from './x.mjs'
const SPEC_RE = /\bfrom\s*['"](\.[^'"\n]+)['"]|\bimport\s*\(\s*['"](\.[^'"\n]+)['"]\s*\)|(?:^|[\s;])import\s*['"](\.[^'"\n]+)['"]/g;

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const listMjs = dir => fs.readdirSync(dir).filter(n => n.endsWith('.mjs')).sort();

// путь файла относительно корня, в котором он лежит (staging или src)
function rootRel(absPath) {
  const inStaging = path.relative(stagingDir, absPath);
  if (!inStaging.startsWith('..')) return { rel: inStaging };
  return { rel: path.relative(srcDir, absPath) };
}

// staging-копия перекрывает одноимённый файл из src
function preferStaged(absPath) {
  const rel = path.relative(srcDir, absPath);
  if (rel.startsWith('..')) return absPath;
  const staged = path.join(stagingDir, rel);
  return isFile(staged) ? staged : absPath;
}

// импортёр может лежать в staging, а цель — ещё в src (или наоборот), поэтому
// ищем в обоих корнях по одному и тому же относительному пути
function resolveSpec(importerAbs, spec) {
  const { rel } = rootRel(importerAbs);
  for (const root of [stagingDir, srcDir]) {
    const base = path.resolve(root, path.dirname(rel), spec);
    for (const cand of [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.mjs'), path.join(base, 'index.js')]) {
      if (isFile(cand)) return preferStaged(cand);
    }
  }
  return null;
}

const queue = listMjs(stagingDir).map(n => preferStaged(path.join(stagingDir, n)));
if (!queue.length) {
  console.error(`✗ в ${stagingDir} нет ни одного .mjs`);
  process.exit(2);
}
const visited = new Set();
const missing = new Set();
let edges = 0;

while (queue.length) {
  const file = queue.shift();
  const real = path.resolve(file);
  if (visited.has(real)) continue;
  visited.add(real);
  let source;
  try { source = fs.readFileSync(real, 'utf8'); } catch (e) { missing.add(`${real}: не читается (${e.message})`); continue; }
  for (const m of source.matchAll(SPEC_RE)) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    edges++;
    const target = resolveSpec(real, spec);
    if (!target) { missing.add(`${path.basename(real)} -> ${spec}`); continue; }
    if (!visited.has(path.resolve(target))) queue.push(target);
  }
}

const files = [...visited];
if (missing.size) {
  console.error(`✗ импорты не разрешаются (${missing.size}):`);
  for (const line of missing) console.error(`  ${line}`);
  console.error('  доложи недостающие файлы в staging и повтори');
  process.exit(1);
}
console.log(`✓ импорты разрешаются: ${files.length} модулей, ${edges} относительных ссылок`);
