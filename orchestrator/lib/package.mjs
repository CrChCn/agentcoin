#!/usr/bin/env node
/* Комплектность пакета. Набор файлов выводится из реального графа импортов,
   а не из ручного списка: ручной список уже один раз разошёлся с деревом и
   ZIP перестал запускаться. Любой относительный импорт обязан найти файл,
   и этот файл обязан попасть в архив. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FROM_RE = /\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/* Каталоги состояния/журналов/артефактов содержат по одному подкаталогу на
   задачу. Эти подкаталоги — runtime, их в архив не берём; сами модули
   (state/store.mjs, artifacts/store.mjs, artifacts/apply.mjs) остаются. */
const CONTAINER_DIRS = new Set(['state', 'logs', 'artifacts']);
const SKIP_NAMES = new Set(['node_modules', '.git', 'runs', 'workspaces', 'dist']);

const DATA_PREFIXES = ['contracts/', 'fixtures/', 'evidence/'];
/* Доказательство уровня 3 привязано к машине и конкретному потоку Codex.
   В архив оно не попадает: иначе распакованный архив открыл бы автономный
   запуск на другой машине без собственной hostile-проверки. */
const MACHINE_EVIDENCE = new Set(['evidence/agent-isolation.json', 'evidence/agent-isolation.txt']);
/* Файлы, которые не связаны импортом, но нужны в архиве: hostile-атакующий
   скрипт копируется в стенд по пути, а не импортируется. */
const REQUIRED_DATA = [
  'README.md', '.gitignore', 'state/.gitkeep', 'logs/.gitkeep', 'artifacts/.gitkeep',
  'tests/hostile/attacks.mjs', 'tests/hostile/agent-standin.mjs',
];

export function walkTree(root = ORCH_ROOT) {
  const files = [];
  const visit = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (CONTAINER_DIRS.has(rel)) continue;
        visit(path.join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  visit(path.resolve(root), '');
  return files.sort();
}

/* Шаблонные литералы и комментарии вымарываются: в них встречается код,
   который генерируют фикстуры (`from '../src/pricing.mjs'`), и это не импорт
   самого модуля. Строки в кавычках не трогаем — в них лежат спецификаторы. */
export function maskNonCode(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '`') { j += 1; break; }
        j += 1;
      }
      out += ' '.repeat(Math.min(j, source.length) - i);
      i = j;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j += 1;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const j = end === -1 ? source.length : end + 2;
      out += source.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function importsOf(source) {
  const found = new Set();
  const masked = maskNonCode(source);
  for (const re of [FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(masked))) found.add(match[1]);
  }
  return [...found].sort();
}

export const isRelativeSpecifier = (spec) => spec.startsWith('./') || spec.startsWith('../');

export function resolveImport(fromRel, specifier, root = ORCH_ROOT) {
  const base = path.posix.join(path.posix.dirname(fromRel.split(path.sep).join('/')), specifier);
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.json`, `${base}/index.mjs`];
  for (const candidate of candidates) {
    const abs = path.join(root, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return candidate;
  }
  return null;
}

/* Рекурсивный обход графа. missing заполняется и для несуществующего
   entrypoint, и для неразрешимого относительного импорта. */
export function closure(entrypoints, root = ORCH_ROOT) {
  const seen = new Set();
  const missing = [];
  const queue = entrypoints.map((entry) => entry.split(path.sep).join('/'));

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      missing.push({ file: rel, importedBy: null, specifier: null, kind: 'entrypoint_missing' });
      continue;
    }
    seen.add(rel);
    if (!rel.endsWith('.mjs')) continue;
    const source = fs.readFileSync(abs, 'utf8');
    for (const specifier of importsOf(source)) {
      if (!isRelativeSpecifier(specifier)) continue;
      const resolved = resolveImport(rel, specifier, root);
      if (!resolved) {
        missing.push({ file: rel, importedBy: rel, specifier, kind: 'import_missing' });
        continue;
      }
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return { files: [...seen].sort(), missing };
}

export function runtimeEntrypoints(root = ORCH_ROOT) {
  const adaptersDir = path.join(root, 'adapters');
  const adapters = fs.readdirSync(adaptersDir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `adapters/${name}`);
  return ['orchestrator.mjs', ...adapters].sort();
}

export function testEntrypoints(root = ORCH_ROOT) {
  const testsDir = path.join(root, 'tests');
  return fs.readdirSync(testsDir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `tests/${name}`)
    .sort();
}

export function toolEntrypoints(root = ORCH_ROOT) {
  const toolsDir = path.join(root, 'tools');
  if (!fs.existsSync(toolsDir)) return [];
  return fs.readdirSync(toolsDir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => `tools/${name}`)
    .sort();
}

export function buildShipList({ root = ORCH_ROOT, include = [] } = {}) {
  const entrypoints = [
    ...runtimeEntrypoints(root),
    ...testEntrypoints(root),
    ...toolEntrypoints(root),
    ...include,
  ];
  const graph = closure(entrypoints, root);
  const files = new Set(graph.files);

  for (const rel of walkTree(root)) {
    if (MACHINE_EVIDENCE.has(rel)) continue;
    if (DATA_PREFIXES.some((prefix) => rel.startsWith(prefix))) files.add(rel);
  }
  for (const rel of REQUIRED_DATA) {
    if (fs.existsSync(path.join(root, rel))) files.add(rel);
  }

  /* Импорт может указывать на файл, который существует, но не попал в
     список (например, .json вне каталогов данных). Проверяем уже по
     итоговому набору, а не по диску. */
  const missing = [...graph.missing];
  for (const rel of files) {
    if (!rel.endsWith('.mjs')) continue;
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const specifier of importsOf(source)) {
      if (!isRelativeSpecifier(specifier)) continue;
      const resolved = resolveImport(rel, specifier, root);
      if (!resolved) continue; // уже отмечено обходом графа
      if (!files.has(resolved)) {
        missing.push({ file: rel, importedBy: rel, specifier, kind: 'import_not_packaged' });
      }
    }
  }

  return { files: [...files].sort(), missing, entrypoints: entrypoints.sort() };
}

export function describeMissing(missing) {
  return missing
    .map((item) => (item.kind === 'entrypoint_missing'
      ? `entrypoint not found: ${item.file}`
      : `import not resolvable: ${item.specifier} in ${item.file}${item.kind === 'import_not_packaged' ? ' (file exists but is not packaged)' : ''}`))
    .join('\n');
}
