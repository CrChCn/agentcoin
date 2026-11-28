#!/usr/bin/env node
/**
 * site-release.mjs — выпуск статики сайта из собранного Next-экспорта.
 *
 * Зачем: прод отдаёт `/srv/agentcoin-empire/current`, а ручные страницы
 * (imperial.html, auctions.html, docs/) живут рядом с экспортом. Поэтому релиз
 * собирается как КОПИЯ текущего релиза + аддитивная заливка экспорта: старые
 * ручные файлы и чанки не затираются, но новые страницы и их чанки появляются.
 *
 * Использование:
 *   node scripts/site-release.mjs --export web/out \
 *        [--tag i18n-docs-20261127] [--host root@2.31.145.160] \
 *        [--key ~/.ssh/agentcoin-deploy] [--pages jobs,mine,docs] [--sync-site] [--dry-run]
 *
 *   --sync-site  после успешной выкатки обновить локальное дерево site/ теми же
 *                файлами экспорта (чтобы выкатка из site/ не откатила страницы).
 *
 * Что НЕ копируется: index.html (корень — imperial.html через Caddy) и 404.html
 * (своя страница сайта). Остальные страницы экспорта + _next/ — аддитивно.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const REMOTE_ROOT = '/srv/agentcoin-empire';
const SKIP = new Set(['index.html', '404.html']);

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (name) => process.argv.includes('--' + name);

const exportDir = arg('export');
if (!exportDir) {
  console.error('usage: node scripts/site-release.mjs --export <web/out> [--tag ...] [--sync-site] [--dry-run]');
  process.exit(2);
}
const EXPORT = path.resolve(process.cwd(), exportDir);
const HOST = String(arg('host', 'root@2.31.145.160'));
const KEY = String(arg('key', '~/.ssh/agentcoin-deploy')).replace(/^~/, os.homedir());
const DRY = has('dry-run');
const SYNC_SITE = has('sync-site');
const TAG = String(arg('tag', 'site-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'z').toLowerCase()));
const PAGES = String(arg('pages', 'jobs,mine,docs')).split(',').map((s) => s.trim()).filter(Boolean);

// Публичные доки: единый список — тот, что на странице /docs (web/app/docs/page.jsx).
// Для каждого файла источник — docs/<файл>.md: релиз сам кладёт его в site/docs и в
// новый релиз на проде, поэтому «добавил доку, забыл скопировать» больше не бывает.
// Исключение — файлы, у которых публичная версия осознанно отличается от docs/.
const DOCS_PAGE = path.join(ROOT, 'web', 'app', 'docs', 'page.jsx');
const DOCS_SKIP_SYNC = new Map([
  ['SEED-NODES.md', 'docs/SEED-NODES.md — стенд (127.0.0.1), на сайте — гайд по mainnet-сидам'],
]);
const publicDocs = () => {
  let src = '';
  try { src = fs.readFileSync(DOCS_PAGE, 'utf8'); } catch (e) {
    console.warn(`⚠ не прочитал ${path.relative(ROOT, DOCS_PAGE)}: ${String(e.message || e).trim()}`);
    return [];
  }
  return [...new Set([...src.matchAll(/\['([A-Za-z0-9._-]+\.md)'/g)].map((m) => m[1]))];
};
const DOC_FILES = [];
const DOC_NO_SOURCE = [];
for (const name of publicDocs()) {
  if (DOCS_SKIP_SYNC.has(name)) continue;
  const from = path.join(ROOT, 'docs', name);
  if (fs.existsSync(from)) DOC_FILES.push({ name, from });
  else DOC_NO_SOURCE.push(name); // публичная копия живёт только в site/ — не трогаем
}

if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(TAG)) { console.error('invalid --tag (a-z0-9._-).'); process.exit(2); }
if (!fs.existsSync(path.join(EXPORT, '_next')) || !fs.existsSync(path.join(EXPORT, 'jobs.html'))) {
  console.error(`✗ ${EXPORT} не похож на Next-экспорт (нужны _next/ и jobs.html). Собери: npm run build`);
  process.exit(1);
}

/** Файлы экспорта, которые уезжают на прод: все страницы (включая вложенные
 *  вроде docs/view.html) кроме SKIP, плюс _next. */
function listHtml(dir = EXPORT, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '_next') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listHtml(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.html') && !SKIP.has(rel)) out.push(rel);
  }
  return out;
}
function exportItems() {
  return { pages: listHtml().sort(), dirs: ['_next'] };
}

const ssh = (cmd) => execFileSync('ssh', ['-i', KEY, '-o', 'StrictHostKeyChecking=no', HOST, cmd], { encoding: 'utf8' });
// ВАЖНО: scp с отдельными файлами кладёт их в basename целевого каталога и ТЕРЯЕТ
// вложенность (docs/view.html → view.html). Поэтому файлы группируются по
// каталогам и заливаются в свой каталог назначения.

const { pages, dirs } = exportItems();
console.log(`→ экспорт: ${EXPORT}`);
console.log(`  страницы: ${pages.join(', ')}`);
if (DRY) { console.log('  --dry-run: ничего не меняю.'); process.exit(0); }

const NEW = `${REMOTE_ROOT}/releases/${TAG}`;
let previous = '';
try {
  previous = ssh(`readlink -f ${REMOTE_ROOT}/current`).trim();
  if (!previous) throw new Error('current пуст');
  ssh(`rm -rf ${NEW} && cp -a ${previous} ${NEW} && echo ok`);
  console.log(`→ релиз ${TAG}: копия ${path.basename(previous)}`);
} catch (e) {
  console.error('✗ не удалось подготовить релиз:', String(e.message || e).trim());
  process.exit(1);
}

try {
  const byDir = new Map();
  for (const p of pages) {
    const rel = p.split('/').slice(0, -1).join('/'); // '' для корня
    if (!byDir.has(rel)) byDir.set(rel, []);
    byDir.get(rel).push(path.join(EXPORT, p));
  }
  ssh([...byDir.keys()].filter(Boolean).map((d) => `mkdir -p ${NEW}/${d}`).join(' && ') || 'true');
  for (const [rel, files] of byDir) {
    const dest = rel ? `${HOST}:${NEW}/${rel}/` : `${HOST}:${NEW}/`;
    execFileSync('scp', ['-q', '-i', KEY, '-o', 'StrictHostKeyChecking=no', ...files, dest], { stdio: 'inherit' });
  }
  for (const d of dirs) {
    execFileSync('scp', ['-q', '-r', '-i', KEY, '-o', 'StrictHostKeyChecking=no', path.join(EXPORT, d), `${HOST}:${NEW}/`], { stdio: 'inherit' });
  }
  if (DOC_FILES.length) {
    ssh(`mkdir -p ${NEW}/docs`);
    execFileSync('scp', ['-q', '-i', KEY, '-o', 'StrictHostKeyChecking=no', ...DOC_FILES.map((d) => d.from), `${HOST}:${NEW}/docs/`], { stdio: 'inherit' });
  }
  console.log(`→ залито: ${pages.length} страниц (включая вложенные) + ${dirs.join(', ')}`);
  console.log(`→ доки: ${DOC_FILES.length} из docs/ → /docs на проде${DOC_NO_SOURCE.length ? ` (только в site/, без источника в docs/: ${DOC_NO_SOURCE.join(', ')})` : ''}`);
  for (const [name, why] of DOCS_SKIP_SYNC) console.log(`  · ${name} не синхронизируется: ${why}`);
} catch (e) {
  console.error('✗ заливка не удалась, симлинк не тронут:', String(e.message || e).trim());
  process.exit(1);
}

// Атомарное переключение: current никогда не бывает «наполовину» новым.
ssh(`ln -sfn ${NEW} ${REMOTE_ROOT}/.current.tmp && mv -T ${REMOTE_ROOT}/.current.tmp ${REMOTE_ROOT}/current && echo ok`);

// Проверка — через fetch самого Node: curl на Windows не понимает -o /dev/null
// и валит проверку ложным «Command failed».
const get = async (url) => {
  const ctl = AbortSignal.timeout(20000);
  const r = await fetch(url, { signal: ctl, headers: { 'cache-control': 'no-cache' } });
  return { status: r.status, text: await r.text() };
};
const fail = [];
// Сверка опубликованных доков с docs/: 200 и те же байты (по LF — CRLF чекаута не шумит).
const lf = (s) => s.replace(/\r\n/g, '\n');
for (const d of DOC_FILES) {
  try {
    const { status, text } = await get(`https://agentcoin.work/docs/${d.name}`);
    if (status !== 200) fail.push(`docs/${d.name} → ${status}`);
    else if (lf(text) !== lf(fs.readFileSync(d.from, 'utf8'))) fail.push(`docs/${d.name}: содержимое не совпало с docs/${d.name}`);
    else console.log(`  ✓ /docs/${d.name} 200 и совпадает с docs/`);
  } catch (e) {
    fail.push(`docs/${d.name}: ${String(e.message || e).trim()}`);
  }
}
for (const page of PAGES) {
  try {
    const { status, text } = await get(`https://agentcoin.work/${page}`);
    if (status !== 200) { fail.push(`${page}: HTML → ${status}`); continue; }
    const chunk = (text.match(/_next\/static\/chunks\/app\/[a-z0-9-]+\/page-[a-z0-9]+\.js/) || [])[0];
    if (!chunk) { fail.push(`${page}: в HTML нет page-чанка`); continue; }
    const res = await fetch(`https://agentcoin.work/${chunk}`, { method: 'GET', signal: AbortSignal.timeout(20000) });
    if (res.status !== 200) fail.push(`${page}: чанк ${chunk} → ${res.status}`);
    else console.log(`  ✓ /${page} → ${chunk} 200`);
  } catch (e) {
    fail.push(`${page}: ${String(e.message || e).trim()}`);
  }
}

if (fail.length) {
  console.error('✗ проверка не прошла:');
  for (const f of fail) console.error('   ' + f);
  if (previous) {
    ssh(`ln -sfn ${previous} ${REMOTE_ROOT}/.current.tmp && mv -T ${REMOTE_ROOT}/.current.tmp ${REMOTE_ROOT}/current && echo ok`);
    console.error(`↩ откат на ${path.basename(previous)}`);
  }
  process.exit(1);
}

if (SYNC_SITE) {
  const dest = path.join(ROOT, 'site');
  for (const p of pages) {
    const target = path.join(dest, p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(EXPORT, p), target);
  }
  fs.cpSync(path.join(EXPORT, '_next'), path.join(dest, '_next'), { recursive: true, force: true });
  for (const d of DOC_FILES) {
    const target = path.join(dest, 'docs', d.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(d.from, target);
  }
  console.log(`→ site/ обновлён теми же файлами (${pages.length} страниц + _next + ${DOC_FILES.length} доков)`);
  console.log('  дальше: git commit site/ && node tools/build-site-release.mjs');
}

console.log(`✓ релиз ${TAG} в проде: ${PAGES.map((p) => '/' + p).join(' ')}`);
console.log(`  откат: ln -sfn ${previous} ${REMOTE_ROOT}/.current.tmp && mv -T ${REMOTE_ROOT}/.current.tmp ${REMOTE_ROOT}/current`);
