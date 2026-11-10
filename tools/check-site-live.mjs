#!/usr/bin/env node
// Живая проверка скелета: каждый узел дерева обязан отдавать СВОЮ страницу,
// а не аварийный index.html от catch-all статики. Сверяем байты ответа с файлом
// из репозитория — так видно и «страница не задеплоена», и «роут отдаёт чужое».
//
// Запуск: node tools/check-site-live.mjs --base http://127.0.0.1:8080
//         node tools/check-site-live.mjs --base https://agentcoin.work
// Код выхода 1 при любом расхождении, поэтому годится для деплой-гейта.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const baseArg = args.indexOf('--base') >= 0 ? args[args.indexOf('--base') + 1] : null;
if (!baseArg) {
  console.error('usage: node tools/check-site-live.mjs --base http://127.0.0.1:8080');
  process.exit(2);
}
const base = baseArg.replace(/\/$/, '');
const tree = JSON.parse(fs.readFileSync(path.join(root, 'site', 'tree.json'), 'utf8'));
const norm = s => s.replace(/\r\n/g, '\n');
const readSite = file => {
  const p = path.join(root, 'site', file);
  return fs.existsSync(p) ? norm(fs.readFileSync(p, 'utf8')) : null;
};
const indexBody = readSite('index.html');
const rows = [];
let failed = 0;

async function once(href) {
  const res = await fetch(base + href, { headers: { accept: 'text/html' }, redirect: 'manual' });
  const body = norm(await res.text());
  return { res, body };
}

const links = tree.sections.flatMap(s => s.links.map(l => ({ ...l, section: s.title })));
for (const link of links) {
  let out;
  try {
    out = await once(link.href);
  } catch (e) {
    rows.push({ state: 'FAIL', href: link.href, detail: 'сеть: ' + e.message });
    failed++;
    continue;
  }
  const { res, body } = out;
  const type = res.headers.get('content-type') || '';
  const expected = !link.generated && link.file ? readSite(link.file) : null;
  let state = 'OK';
  let detail = link.file || '';
  if (res.status !== 200) {
    state = 'FAIL'; detail = `HTTP ${res.status}`;
  } else if (!/text\/html/i.test(type)) {
    state = 'FAIL'; detail = `content-type ${type || '—'}`;
  } else if (!/\/panel\.js/.test(body)) {
    state = 'FAIL'; detail = 'нет /panel.js — страница вне скелета';
  } else if (link.generated === true) {
    // Страницу собирает код ноды (/stats): сверять нечего, но лендингом она быть не должна.
    if (link.href !== '/' && indexBody !== null && body === indexBody) {
      state = 'FALLBACK'; detail = 'catch-all отдал index.html вместо сгенерированной страницы';
    } else {
      detail = `generated (${body.length}b)`;
    }
  } else if (expected === null) {
    state = 'FAIL'; detail = `нет файла site/${link.file}`;
  } else if (body !== expected) {
    if (link.href !== '/' && indexBody !== null && body === indexBody) {
      state = 'FALLBACK'; detail = 'catch-all отдал index.html вместо страницы';
    } else {
      state = 'DIFF'; detail = `ответ ${body.length}b ≠ site/${link.file} ${expected.length}b`;
    }
  }
  if (state !== 'OK') failed++;
  rows.push({ state, href: link.href, detail });
}

await (async () => {
  try {
    const res = await fetch(base + '/tree.json', { headers: { accept: 'application/json' } });
    const type = res.headers.get('content-type') || '';
    const text = norm(await res.text());
    const local = norm(fs.readFileSync(path.join(root, 'site', 'tree.json'), 'utf8'));
    const same = (() => { try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(JSON.parse(local)); } catch { return false; } })();
    if (!same) {
      rows.push({ state: 'WARN', href: '/tree.json', detail: `/tree.json не совпадает с site/tree.json (${res.status}, ${type}) — навигация работает на вшитом дереве` });
    }
  } catch (e) {
    rows.push({ state: 'WARN', href: '/tree.json', detail: 'недоступен: ' + e.message });
  }
})();

const width = Math.min(28, Math.max(...rows.map(r => r.href.length)));
for (const r of rows) console.log(`${r.state.padEnd(8)} ${r.href.padEnd(width)} ${r.detail}`);
console.log(`check-site-live: ${links.length} узлов, ${failed} расхождений, база ${base}`);
process.exitCode = failed ? 1 : 0;
