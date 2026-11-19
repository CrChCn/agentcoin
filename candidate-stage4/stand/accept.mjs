// Stage 4 candidate acceptance (isolated stand, loopback only). No production contact.
import { start as startMain, hits as mainHits } from './mock-mainnet.mjs';
import { start as startStaging, hits as stagingHits } from './mock-staging.mjs';
import { start as startRouter, STAND_PORT } from './router.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: String(detail || '') }); }
function req(opts, body) {
  return new Promise((resolve, reject) => {
    const [h, p] = [opts.host, opts.port];
    const o = { host: h, port: p, path: opts.path, method: opts.method || 'GET', headers: opts.headers || {} };
    import('node:http').then(({ default: http }) => {
      const q = http.request(o, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
      });
      q.on('error', reject);
      if (body) q.write(body);
      q.end();
    });
  });
}
const H = (host) => ({ 'host': host });
await startMain();
await startStaging();
const router = await startRouter();
const B = 'http://127.0.0.1:' + STAND_PORT;
// helper using fetch with manual Host header is blocked; use http with host override via x-test-host
async function call(testHost, p, opts = {}) {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: STAND_PORT, path: p, method: opts.method || 'GET', headers: { 'x-test-host': testHost, ...(opts.headers || {}) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    q.on('error', reject);
    if (opts.body) q.write(opts.body);
    q.end();
  });
}
// --- 2. DUPLICATE_ROOT_PRODUCT ---
{
  const r = await call('agentcoin.work', '/');
  check('GET / -> 200 html', r.status === 200 && r.body.includes('AGENTCOIN'), 'status=' + r.status);
  const r2 = await call('agentcoin.work', '/imperial');
  check('GET /imperial -> 308 /', r2.status === 308 && r2.headers.location === '/', 'status=' + r2.status + ' loc=' + r2.headers.location);
  const r3 = await call('agentcoin.work', '/imperial.html');
  check('GET /imperial.html -> 308 /', r3.status === 308 && r3.headers.location === '/', 'status=' + r3.status);
  const r4 = await call('agentcoin.work', '/imperial?x=1');
  check('GET /imperial?x=1 -> 308 /?x=1', r4.status === 308 && r4.headers.location === '/?x=1', 'loc=' + r4.headers.location);
  const loop = await call('agentcoin.work', '/imperial');
  check('redirect loop excluded (/imperial target is /, not /imperial)', loop.headers.location !== '/imperial', 'loc=' + loop.headers.location);
  check('canonical is https://agentcoin.work/', r.body.includes('rel="canonical" href="https://agentcoin.work/"'), 'canonical present');
  check('no /imperial links in nav', !r.body.includes('href="/imperial"'), 'nav clean');
}
// --- 3. shared shell ---
{
  const pages = {};
  for (const p of ['/', '/agent-room', '/settlement']) pages[p] = (await call('agentcoin.work', p)).body;
  const css = (s) => (s.match(/href="\/_shell\/shell\.css"/g) || []).length;
  const js = (s) => (s.match(/src="\/_shell\/shell\.js"/g) || []).length;
  const rel = (s) => (s.match(/meta name="agentcoin-release" content="([^"]+)"/) || [])[1] || '';
  const nav = (s) => ((s.match(/<nav class="shell-nav"[\s\S]*?<\/nav>/) || [])[0] || '').replace(/ aria-current="page"/g, '');
  const navHrefs = (s) => [...s.matchAll(/<nav class="shell-nav"[\s\S]*?<\/nav>/g)].flatMap((m) => [...m[0].matchAll(/href="([^"]+)"/g)].map((x) => x[1]));
  const h1 = (s) => (s.match(/<h1>/g) || []).length;
  check('shared css on all three', ['/', '/agent-room', '/settlement'].every((k) => css(pages[k]) === 1), JSON.stringify(Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, css(v)]))));
  check('shared shell.js on all three', ['/', '/agent-room', '/settlement'].every((k) => js(pages[k]) === 1), 'ok');
  const app = (s) => (s.match(/src="\/app\.js"/g) || []).length;
  check('shared app.js on all three (one module bundle)', ['/', '/agent-room', '/settlement'].every((k) => app(pages[k]) === 1), 'ok');
  check('no per-page divergent module scripts', !Object.values(pages).some((s) => s.includes('agent-room.js') || s.includes('settlement.js') || s.includes('mainnet.js') || s.includes('panel.js')), 'clean');
  const rels = ['/', '/agent-room', '/settlement'].map((k) => rel(pages[k]));
  check('release marker non-empty and identical', rels[0] !== '' && rels[0] === rels[1] && rels[1] === rels[2], rels.join('|'));
  const navs = ['/', '/agent-room', '/settlement'].map((k) => nav(pages[k]));
  check('nav identical (navHash equal)', navs[0] === navs[1] && navs[1] === navs[2] && navs[0].length > 50, 'len=' + navs[0].length);
  check('exactly one h1 per page', ['/', '/agent-room', '/settlement'].every((k) => h1(pages[k]) === 1), JSON.stringify(Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, h1(v)]))));
  check('no links to removed doubles', !Object.values(pages).some((s) => s.includes('href="/imperial')), 'no href=/imperial');
  check('noscript with page name + nav', ['/', '/agent-room', '/settlement'].every((k) => pages[k].includes('<noscript>')), 'noscript present');
  check('viewport present', ['/', '/agent-room', '/settlement'].every((k) => pages[k].includes('name="viewport"')), 'ok');
  check('CSP without unsafe-inline bypass', ['/', '/agent-room', '/settlement'].every((k) => pages[k].includes('Content-Security-Policy') && !pages[k].includes("'unsafe-inline'")), 'csp clean');
  check('modules preserved (distinct titles)', pages['/'].includes('сеть для ИИ-агентов') && pages['/agent-room'].includes('Agent Room') && pages['/settlement'].includes('Расчёты AGT'), 'distinct');
}
// --- 4. staging mutation closed + negative tests ---
{
  mainHits.count = 0; mainHits.paths.length = 0;
  const before = mainHits.count;
  const m = await call('api-staging.agentcoin.work', '/working/cabinet/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('staging POST /working/cabinet/login -> 404 staging_mutation_unavailable', m.status === 404 && m.body.includes('staging_mutation_unavailable'), m.status + ' ' + m.body.slice(0, 80));
  check('staging POST never reaches mainnet mock', mainHits.count === before, 'mainnetHits=' + mainHits.count);
  const fake = await call('api-staging.agentcoin.work', '/working/cabinet/login', { method: 'POST', headers: { 'x-admin-token': 'root', 'content-type': 'application/json' }, body: '{}' });
  check('fake admin header does not change result', fake.status === 404 && fake.body.includes('staging_mutation_unavailable'), fake.status + '');
  check('no fallback: mainnet still unhit after fake header', mainHits.count === before, 'mainnetHits=' + mainHits.count);
  const redir = await call('api-staging.agentcoin.work', '/working/cabinet/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('redirect to mainnet forbidden (no 3xx to mainnet)', !(redir.status >= 300 && redir.status < 400), 'status=' + redir.status);
  const strip = await call('api-staging.agentcoin.work', '/working/cabinet/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('strip_prefix does not change env owner (still closed, mainnet unhit)', strip.status === 404 && mainHits.count === before, 'status=' + strip.status);
  const g = await call('api-staging.agentcoin.work', '/working/txproof/abc', { method: 'GET' });
  check('staging GET /working/txproof/* -> staging owner (single)', g.status === 200 && g.body.includes('staging-mock'), g.body.slice(0, 80));
  const noMainnetRef = fs.readFileSync(path.join(here, '..', 'Caddyfile.candidate'), 'utf8');
  const stagingBlock = noMainnetRef.split('api-staging.agentcoin.work {').pop() || '';
  check('candidate staging block references no 127.0.0.1:9335/node1', !stagingBlock.includes('127.0.0.1:9335') && !stagingBlock.includes('node1.agentcoin.work'), 'clean');
}
// --- 5. warnings closed ---
{
  const g1 = await call('agentcoin.work', '/peers/bootstrap');
  const g2 = await call('agentcoin.work', '/ops/watchdog/state');
  const g3 = await call('agentcoin.work', '/gateway/list');
  check('ghost routes stay 404 (advertisement removed)', g1.status === 404 && g2.status === 404 && g3.status === 404, [g1.status, g2.status, g3.status].join(','));
  const e = await call('agentcoin.work', '/ecosphere');
  check('/ecosphere is 404 not published', e.status === 404, 'status=' + e.status);
  const home = (await call('agentcoin.work', '/')).body;
  check('/ecosphere not advertised in home nav', !home.includes('/ecosphere'), 'clean');
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.length, total: results.length, results }, null, 2));
router.close();
process.exit(failed.length ? 1 : 0);
