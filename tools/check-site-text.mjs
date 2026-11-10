#!/usr/bin/env node
// Проверка правописания и опрятности текста сайта: битая кодировка, смешанные
// алфавиты («cовет» с латинской c), пробел перед знаком, двойная пунктуация,
// непарные «ёлочки», двойные пробелы внутри фразы, потерянная запятая перед
// вводными словами. Проверяется только человеческий текст: HTML-текст вне
// <script>/<style> и строковые литералы панели, а не код.
// Запуск: node tools/check-site-text.mjs [файл ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const htmlFiles = args.length ? args.filter(f => f.endsWith('.html')) : fs.readdirSync(path.join(root, 'site')).filter(f => f.endsWith('.html')).map(f => path.join('site', f));
const jsFiles = args.length ? [] : ['tools/imperial-panel.js', 'tools/install-ui.js', 'tools/profile-memory.js', 'tools/cabinet-helper.js', 'site/empire-i18n.js'];

const CYR = /[\u0400-\u04FF]/;
const findings = [];
const add = (file, line, kind, text) => findings.push({ file, line, kind, text });

// Вводные слова/обороты, которые в русском требуют запятой. Ошибки ищем только там,
// где вводное слово стоит в начале фразы или внутри неё и запятой рядом нет.
const INTRO = ['конечно', 'например', 'кстати', 'впрочем', 'однако', 'поэтому', 'кажется', 'вероятно', 'пожалуй', 'итак', 'внимание'];

function checkText(file, line, raw) {
  // t — текст с пробелами на месте тегов (для проверки слов и пунктуации фразы),
  // tj — тот же текст с вырезанными тегами: только он годится для проверки
  // пробела перед знаком, иначе `</span>: ` ложно выглядит как « :».
  const t = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const tj = raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!t || !CYR.test(t)) return;
  if (/[\u00D0\u00D1\u00E2\uFFFD]/.test(raw)) add(file, line, 'mojibake', t.slice(0, 80));

  // Латиница внутри русского слова — почти всегда опечатка (латинская c/o/e/a/p/x).
  // Дефисные composites вроде AGT-адрес или PIN-код — законная норма, их не трогаем.
  for (const m of t.matchAll(/[\w\u0400-\u04FF'\u2019]+/g)) {
    const w = m[0];
    const cyr = (w.match(/[\u0400-\u04FF]/g) || []).length;
    const lat = (w.match(/[A-Za-z]/g) || []).length;
    // Хватит и одной латинской буквы внутри русского слова: «cовет» с латинской c
    // визуально неотличим, но это опечатка, а не бренд.
    if (cyr > 1 && lat >= 1) add(file, line, 'mixed-alphabet', w);
  }

  if (/\s[,;:!?](?=\s|$)/.test(tj)) add(file, line, 'space-before-punct', tj.slice(0, 80));
  if (/[,;]\s*[,;]|\.{4,}|!{2,}|\?{2,}/.test(tj)) add(file, line, 'double-punct', tj.slice(0, 80));
  const open = (t.match(/«/g) || []).length;
  const close = (t.match(/»/g) || []).length;
  if (open !== close) add(file, line, 'quote-balance', t.slice(0, 80));
  // Двойной пробел ищем внутри одного текстового узла: между соседними тегами
  // пробелы форматирования нормальны и о тексте ничего не говорят.
  for (const node of raw.split(/<[^>]*>/)) {
    if (/[А-Яа-я][ \t]{2,}[А-Яа-я]/.test(node) || /[ \t]{2,}[А-Яа-я]/.test(node.trimStart()) && /[А-Яа-я]/.test(node)) {
      add(file, line, 'double-space', node.trim().slice(0, 80));
      break;
    }
  }
  for (const word of INTRO) {
    const re = new RegExp('(^|[^,;:—(-])\\s+' + word + '\\s', 'i');
    if (re.test(' ' + t + ' ')) add(file, line, 'missing-comma', word + ' — ' + t.slice(0, 70));
  }
}

for (const rel of htmlFiles) {
  const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const label = path.relative(root, file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  const stripped = src
    .replace(/<script\b[\s\S]*?<\/script>/gi, m => m.replace(/[^\n]/g, ' '))
    .replace(/<style\b[\s\S]*?<\/style>/gi, m => m.replace(/[^\n]/g, ' '));
  stripped.split('\n').forEach((line, i) => {
    const text = line
      .replace(/&nbsp;/g, ' ')
      .replace(/&laquo;/g, '«')
      .replace(/&raquo;/g, '»')
      .replace(/&mdash;/g, '—')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    checkText(label, i + 1, text);
  });
}

for (const rel of jsFiles) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    // Экранированные \n и \t — разметка строки в коде, а не буквы текста.
    for (const m of line.matchAll(re)) checkText(rel, i + 1, m[2].replace(/\\[nrt]/g, ' '));
  });
}

const uniq = new Map();
for (const f of findings) {
  const key = `${f.file}:${f.line}:${f.kind}:${f.text}`;
  if (!uniq.has(key)) uniq.set(key, f);
}
for (const f of uniq.values()) console.log(`${f.file}:${f.line} [${f.kind}] ${f.text}`);
console.log(`check-site-text: ${uniq.size} замечаний (текст ${htmlFiles.length} страниц${jsFiles.length ? ' + ' + jsFiles.length + ' модулей' : ''})`);
if (uniq.size) process.exitCode = 1;
