#!/usr/bin/env node
/* Сборка набора файлов ноды: рекурсивно по относительным импортам от node.mjs.
   node.mjs — не один файл: он импортирует core.mjs, а тот — остальные модули.
   Пакет из одного node.mjs падал при первом запуске на ERR_MODULE_NOT_FOUND
   (bip39-lite.mjs), поэтому набор считается здесь, а не пишется руками.

   Внешние спецификаторы (node:*, ленивый абсолютный vendor-путь) не копируются,
   но записываются в PROVENANCE.txt: так видно, что именно требуется от хоста. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(HERE, 'src');
const ENTRY = 'node.mjs';

const FROM_RE = /\bfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/* Комментарии и шаблонные литералы вымарываются: в них встречается код,
   который печатают обработчики (`from "..."` внутри строки), и это не импорт.
   Без маскировки в PROVENANCE попадал мусор вместо списка зависимостей. */
function maskNonCode(source) {
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

const files = new Set();
const missing = [];
const external = new Set();

function resolveRelative(fromRel, spec) {
  const base = path.posix.join(path.posix.dirname(fromRel), spec);
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.json`, `${base}/index.mjs`];
  return candidates.find((candidate) => {
    const abs = path.join(ROOT, candidate);
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  }) || null;
}

function visit(rel) {
  if (files.has(rel)) return;
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { missing.push(rel); return; }
  files.add(rel);
  const source = maskNonCode(fs.readFileSync(abs, 'utf8'));
  for (const re of [FROM_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      const spec = match[1];
      if (!spec.startsWith('.')) { external.add(spec); continue; }
      const hit = resolveRelative(rel, spec);
      if (!hit) { missing.push(`${spec} (from ${rel})`); continue; }
      visit(hit);
    }
  }
}

visit(ENTRY);

/* Из найденного оставляем только настоящие спецификаторы: встроенные модули
   (node:*) и абсолютные пути (vendor). Остальное — текст из строк кода,
   который regex принимает за импорт. */
const realExternal = [...external]
  .filter((spec) => /^node:[a-z/_-]+$/.test(spec) || /^\/[\w./@-]+$/.test(spec))
  .sort();

if (missing.length) {
  console.error(`node package closure is broken:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

/* Файлы из Windows-дерева приходят с CRLF. systemd запускает node.mjs напрямую
   через shebang, и `#!/usr/bin/env node\r` даёт status=127
   («/usr/bin/env: 'node\r': No such file or directory»), а в env-файле
   \r прилипает к значению. Поэтому текстовые файлы пакета приводятся к LF. */
const TEXT_FILE = /\.(mjs|js|json|sh|md|txt|service|example)$/;
function toLf(data, rel) {
  if (!TEXT_FILE.test(rel)) return data;
  const text = data.toString('utf8');
  const fixed = text.replace(/\r\n/g, '\n');
  return fixed === text ? data : Buffer.from(fixed, 'utf8');
}

fs.rmSync(SRC, { recursive: true, force: true });
fs.mkdirSync(SRC, { recursive: true });

const sums = [];
for (const rel of [...files].sort()) {
  const data = toLf(fs.readFileSync(path.join(ROOT, rel)), rel);
  const out = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  sums.push(`${crypto.createHash('sha256').update(data).digest('hex')}  ${rel}`);
}
fs.writeFileSync(path.join(SRC, 'SHA256SUMS'), `${sums.join('\n')}\n`);
fs.writeFileSync(path.join(SRC, 'PROVENANCE.txt'), [
  `entry: ${ENTRY}`,
  `files: ${files.size}`,
  `builtAt: ${new Date().toISOString()}`,
  '',
  'external specifiers (not packaged):',
  ...realExternal.map((spec) => `  ${spec}`),
  '',
  'vendor (optional, lazy): /opt/agentcoin-node/vendor/node_modules/snarkjs — без него PoUW ZK',
  'отвечает 503 zk_unavailable, нода остаётся живой.',
  '',
].join('\n'));

console.log(`node package closure: ${files.size} files`);
for (const spec of realExternal) console.log(`  external: ${spec}`);
