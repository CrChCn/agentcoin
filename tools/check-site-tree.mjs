#!/usr/bin/env node
// Валидатор канонического дерева империи (site/tree.json).
// Проверяет: JSON валиден; разделы/ссылки уникальны; каждый file лежит в site/;
// каждый href обслуживается нодой (p === 'href' в node.mjs) или входит в allowlist
// живых адресов (проверены вручную: / отдаёт imperial, /agent редиректит на /agent/).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tree = JSON.parse(fs.readFileSync(path.join(root, 'site', 'tree.json'), 'utf8'));
const nodeSrc = fs.readFileSync(path.join(root, 'node.mjs'), 'utf8');

const LIVE_ALLOWLIST = new Set(['/', '/agent']); // проверены живьём, хендлера p=== нет
const fail = (msg) => { console.error(`[site-tree] FAIL: ${msg}`); process.exitCode = 1; };

if (tree.version !== 1 || tree.root !== '/' || !Array.isArray(tree.sections) || !tree.sections.length) {
  fail('bad tree shape (version/root/sections)');
}
const seenSec = new Set(), seenHref = new Set();
let links = 0;
for (const sec of tree.sections || []) {
  if (!sec || typeof sec.id !== 'string' || !sec.id) fail('section without id');
  if (seenSec.has(sec.id)) fail(`duplicate section id: ${sec.id}`);
  seenSec.add(sec.id);
  if (typeof sec.title !== 'string' || !sec.title) fail(`section ${sec.id} without title`);
  if (!Array.isArray(sec.links) || !sec.links.length) fail(`section ${sec.id} without links`);
  for (const link of sec.links) {
    links++;
    if (typeof link?.title !== 'string' || !link.title) fail(`section ${sec.id}: link without title`);
    if (typeof link?.href !== 'string' || !link.href.startsWith('/')) fail(`section ${sec.id}: bad href ${link?.href}`);
    if (seenHref.has(link.href)) fail(`duplicate href: ${link.href}`);
    seenHref.add(link.href);
    if (typeof link?.file !== 'string' || !fs.existsSync(path.join(root, 'site', link.file))) {
      fail(`section ${sec.id}: file missing in site/: ${link?.file}`);
    }
    // Обслуживается нодой напрямую, Caddy-статикой (site/<имя>.html без расширения)
    // или входит в живой allowlist (проверены вручную).
    const base = link.href === '/' ? 'imperial' : link.href.slice(1);
    const caddyStatic = !base.includes('/') && fs.existsSync(path.join(root, 'site', base + '.html'));
    const served = LIVE_ALLOWLIST.has(link.href) || nodeSrc.includes(`p === '${link.href}'`) || caddyStatic;
    if (!served) fail(`section ${sec.id}: href not served (node/Caddy): ${link.href}`);
  }
}
console.log(`[site-tree] OK: ${seenSec.size} sections, ${links} links.`);
