import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const siteOrigin = 'https://agentcoin.work';
const tree = JSON.parse(readFileSync(new URL('../site/tree.json', import.meta.url), 'utf8'));
const excludedDirs = new Set([
  'docs', 'data', 'wallets', 'secrets', 'config', 'src', 'candidate-stage4',
  'release', 'node_modules', '.next',
]);

function* siteFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !excludedDirs.has(entry.name)) {
      yield* siteFiles(path);
    } else if (entry.isFile() && /\.(?:html|[cm]?js|jsx|ts|tsx|webmanifest)$/.test(entry.name)) {
      yield path;
    }
  }
}

function attribute(tag, name) {
  const match = tag.match(new RegExp('\\s' + name + String.raw`\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

test('the machine tree points to one home page with the root canonical URL', () => {
  assert.equal(tree.root, '/');
  const home = tree.sections.find(section => section.id === 'home');
  assert.ok(home);
  const rootLinks = tree.sections.flatMap(section => section.links).filter(link => link.href === '/');
  assert.equal(rootLinks.length, 1);
  assert.ok(home.links.includes(rootLinks[0]));

  const page = readFileSync(new URL('../site/' + rootLinks[0].file, import.meta.url), 'utf8');
  const head = page.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  assert.ok(head, 'home page has a head element');
  const canonicals = [...head[1].matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter(tag => attribute(tag, 'rel')?.toLowerCase() === 'canonical');
  assert.deepEqual(canonicals.map(tag => attribute(tag, 'href')), [siteOrigin + '/']);

  const manifest = JSON.parse(readFileSync(new URL('../site/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, '/');
});

test('site links, forms, navigation, and the machine tree avoid legacy home routes', () => {
  const legacyHome = /^\/(?:imperial|index)(?:\.html)?\/?$/i;
  const violations = [];

  function check(value, path, base, routeLiteral = false) {
    if (!URL.canParse(value, base)) return;
    const url = new URL(value, base);
    // Next.js runtime chunks can use /index as a filesystem route name.
    if (routeLiteral && path.startsWith('site/_next/') && /^\/index\/?$/.test(value)) return;
    if (url.hostname === 'agentcoin.work' && legacyHome.test(url.pathname)) {
      violations.push(path + ' → ' + value);
    }
  }

  for (const section of tree.sections) {
    for (const link of section.links) {
      for (const key of ['href', 'canonical', 'redirect']) {
        if (link[key]) check(link[key], 'site/tree.json', siteOrigin);
      }
    }
  }

  for (const dir of ['site', 'web']) {
    for (const path of siteFiles(dir)) {
      const source = readFileSync(path, 'utf8');
      const base = siteOrigin + '/' + (dir === 'site' ? path.slice('site/'.length) : '');

      for (const match of source.matchAll(/(?:\s|\.)(?:href|action|formaction)\s*=\s*(?:\{\s*)?(?:"([^"]*)"|'([^']*)'|([^\s>"'{][^\s>]*))/gi)) {
        check(match[1] ?? match[2] ?? match[3], path, base);
      }

      // Shared navigation also stores destinations as JavaScript string literals.
      const routes = /["'\x60]((?:\/|https?:\/\/)[^"'\x60\s]*)["'\x60]/gi;
      for (const [, value] of source.matchAll(routes)) check(value, path, base, true);
    }
  }

  assert.deepEqual([...new Set(violations)], []);
});

test('the home page carries exactly one visible install target for the panel link', () => {
  const home = tree.sections.find(section => section.id === 'home');
  const homeLink = home.links.find(link => link.href === '/');
  assert.equal(homeLink.file, 'imperial.html', 'the canonical home is the static imperial page');

  const page = readFileSync(new URL('../site/' + homeLink.file, import.meta.url), 'utf8');
  const installTags = [...page.matchAll(/<[^>]*\sid\s*=\s*(?:"install"|'install'|install)(?:\s|>|\/)/gi)]
    .map(([tag]) => tag);
  assert.equal(installTags.length, 1, 'exactly one id="install" on the home page');

  const tag = installTags[0];
  assert.match(tag, /^<section\b/i, 'the install target is a content section, not an empty anchor');
  assert.doesNotMatch(tag, /\shidden(?:[=>\s]|$)|aria-hidden\s*=\s*["']?true|display\s*:\s*none/i, 'the install target is not hidden');

  const start = page.indexOf(tag);
  const end = page.indexOf('</section>', start + tag.length);
  assert.ok(end > start, 'the install section is closed');
  const text = page.slice(start + tag.length, end)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  assert.ok(text.length >= 80, 'the install section has real visible content');
  assert.match(text, /Skill/, 'the install section names the Skill');
  assert.match(text, /устан/i, 'the install section explains installation');

  const panel = readFileSync(new URL('../site/panel.js', import.meta.url), 'utf8');
  const installLinks = [...panel.matchAll(/["'`](\/#install)["'`]/g)].map(([, href]) => href);
  assert.ok(installLinks.length >= 1, 'panel.js links to the /#install target');
  assert.doesNotMatch(panel, /\/index#install/, 'panel.js no longer links the retired /index page');
});
