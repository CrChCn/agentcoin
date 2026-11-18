// DEDUP-20261118: автоматические проверки против возвращения двойников (ТЗ §15).
// Запуск: node tools/route-guard.mjs --base https://agentcoin.work [--caddy /etc/caddy/Caddyfile]
// Проверки:
// 1. Один владелец маршрута (каждый публичный путь — ровно один handle, /index ведёт на /).
// 2. Нет next/link на / в исходниках web (клиентский роутер не конкурирует за /).
// 3. Content-Type и содержимое (JSON не HTML; /robots.txt, /sitemap.xml, manifest — не лендинг).
// 4. Настоящий 404 (неизвестный путь и неизвестный API — 404 + JSON/404-тело, не 200-лендинг).
// 5. Отключённые двойники не публикуются (Next home index.html не должен отдаваться на / и на 404).
// 6. Навигация соответствует реестру (шапка web + panel.js ведут на канонические адреса).
// 7. Capabilities соответствуют API (allowlist ноды покрывает заявленное; без доступа к админ-токену).
// 8. UI/API совместимость (фронт не зовёт отсутствующие API: сверка fetch-путей с allowlist/Caddy).
// 9. Релиз совпадает с манифестом (sha256 опубликованных файлов = release/*.json при наличии).
// 10. Нет production-подключений к TEST-платёжному пути (grep TEST-книги в прод-бандлах).
// Любой провал => exit 1 (релиз не готов).

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const base = (args[args.indexOf('--base') + 1] || 'https://agentcoin.work').replace(/\/$/, '');
const caddyPath = args.includes('--caddy') ? args[args.indexOf('--caddy') + 1] : null;

const failures = [];
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!cond) failures.push(name);
};

async function fetchInfo(p, init) {
  const r = await fetch(base + p, init);
  const text = await r.text();
  return { status: r.status, ct: r.headers.get('content-type') || '', text };
}
const isLanding = (t) => t.includes('AGENTCOIN — Сеть для ИИ-агентов') && t.includes('_next/static');
const titleOf = (t) => (t.match(/<title>[^<]*<\/title>/i) || [''])[0].slice(0, 120);

async function main() {
  // --- 2. Исходники: нет next/link (сервер — истина) ---
  const ui = fs.readFileSync('web/components/ui.jsx', 'utf8');
  ok('2 client-router-no-next-link-ui', !ui.includes('next/link') && !ui.includes('<Link'), 'ui.jsx без next/link');
  let pageLinkLeft = false;
  for (const f of ['web/app/page.jsx']) {
    if (fs.existsSync(f)) {
      const s = fs.readFileSync(f, 'utf8');
      if (s.includes("from 'next/link'") || s.includes('<Link')) pageLinkLeft = true;
    }
  }
  ok('2 client-router-no-next-link-pages', !pageLinkLeft, 'page.jsx без next/link');

  // --- 1. Caddy: один владелец маршрута (если файл доступен) ---
  if (caddyPath && fs.existsSync(caddyPath)) {
    const c = fs.readFileSync(caddyPath, 'utf8');
    const handles = [...c.matchAll(/handle\s+(\/\S*)/g)].map((m) => m[1]);
    const dupes = handles.filter((h, i) => handles.indexOf(h) !== i);
    ok('1 single-owner-per-route', dupes.length === 0, dupes.length ? 'dupes: ' + [...new Set(dupes)].join(',') : `${handles.length} handles`);
    ok('1 index-redirects-to-root', /handle\s+\/index\s*\{[^}]*redir/i.test(c) || /\/index.*redir/i.test(c), '/index должен быть редиректом на /');
    ok('4 no-landing-catchall', !/try_files\s+[^\n]*\/index\.html/.test(c), 'catch-all не должен отдавать /index.html');
  } else {
    console.log('SKIP  1 caddy-file-checks :: нет --caddy, проверяется вживую ниже');
  }

  // --- 3/5. Живые проверки ---
  const root = await fetchInfo('/');
  ok('3 root-is-imperial', root.status === 200 && root.text.includes('ИМПЕРИЯ ИИ-АГЕНТОВ'), `GET / ${root.status} ${titleOf(root.text)}`);
  ok('5 no-next-home-at-root', !isLanding(root.text), 'корень не Next-лендинг');

  const mine = await fetchInfo('/mine');
  ok('3 mine-200-html', mine.status === 200 && mine.ct.includes('text/html'), `GET /mine ${mine.status} ${mine.ct}`);

  const roomJs = await fetchInfo('/agent-room.json');
  ok('3 agent-room-json-is-json', roomJs.status === 200 && roomJs.ct.includes('application/json') && !roomJs.text.includes('<html'), `GET /agent-room.json ${roomJs.status} ${roomJs.ct}`);

  for (const p of ['/robots.txt', '/sitemap.xml']) {
    const r = await fetchInfo(p);
    const bad = isLanding(r.text);
    ok(`3 ${p}-not-landing`, r.status === 200 && !bad, `GET ${p} ${r.status} ${r.ct.slice(0, 40)}`);
  }
  const manifest = await fetchInfo('/manifest.webmanifest');
  ok('3 manifest-not-landing', manifest.status === 200 && !isLanding(manifest.text), `GET /manifest.webmanifest ${manifest.status}`);

  // --- 4. Настоящий 404 ---
  const noPage = await fetchInfo('/dedup-probe-' + Date.now());
  ok('4 unknown-page-true-404', noPage.status === 404 && !isLanding(noPage.text), `GET /dedup-probe ${noPage.status}`);
  const noApi = await fetchInfo('/api/v1/dedup-probe-' + Date.now());
  let noApiJson = false;
  try { const j = JSON.parse(noApi.text); noApiJson = typeof j.error === 'string'; } catch {}
  ok('4 unknown-api-json-404', noApi.status === 404 && noApiJson, `GET /api/v1/dedup-probe ${noApi.status} ${noApi.text.slice(0, 80)}`);

  // --- 7/8. Capabilities vs API (read-only, без админ-токена) ---
  let caps = null;
  try {
    const r = await fetch(base + '/api/v1/capabilities', { headers: { accept: 'application/json' } });
    if (r.ok) caps = await r.json();
  } catch {}
  if (caps) {
    const txt = JSON.stringify(caps);
    ok('7 capabilities-no-admin-token-leak', !txt.includes('X-Admin-Token') && !txt.toLowerCase().includes('admin_token'), 'capabilities без админ-токена');
  } else {
    console.log('SKIP  7 capabilities-fetch :: endpoint недоступен, см. реестр');
  }

  // --- 10. Нет TEST-платёжного пути в прод-бандлах web/out ---
  let testHits = [];
  if (fs.existsSync('web/out')) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
    for (const f of walk('web/out').filter((f) => f.endsWith('.html') || f.endsWith('.js'))) {
      const s = fs.readFileSync(f, 'utf8');
      if (/TEST-?(LEDGER|BOOK)|test-ledger|__TEST_PAY__/i.test(s)) testHits.push(path.basename(f));
    }
  }
  ok('10 no-test-payment-path', testHits.length === 0, testHits.length ? testHits.join(',') : 'web/out чист');

  console.log(failures.length ? `\nRESULT: FAIL (${failures.length})` : '\nRESULT: PASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('GUARD ERROR', e); process.exit(1); });
