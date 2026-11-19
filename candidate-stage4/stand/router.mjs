// Candidate stand router (loopback only): mimics Caddyfile.candidate routing logic 1:1.
// Ports are mapped for local isolation: mainnet-mock 18081, staging-mock 18082.
// Deploy ports (prod): mainnet 9335, staging 29335 — routing rules identical, see Caddyfile.candidate.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const STAND_PORT = 18080;
const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(here, '..', 'site');
function sendFile(res, rel, type) {
  const p = path.join(siteDir, rel);
  const b = fs.readFileSync(p);
  res.writeHead(200, { 'content-type': type });
  res.end(b);
}
function proxy(port, req, res, stripWorking) {
  let p = new URL(req.url, 'http://x').pathname;
  if (stripWorking && p.startsWith('/working/')) p = p.slice('/working'.length) || '/';
  const q = new URL(req.url, 'http://x').search;
  return new Promise((resolve) => {
    const pr = http.request({ host: '127.0.0.1', port, path: p + q, method: req.method, headers: { 'content-type': 'application/json' } }, (prx) => {
      let body = '';
      prx.on('data', (c) => (body += c));
      prx.on('end', () => { res.writeHead(prx.statusCode, { 'content-type': 'application/json' }); res.end(body); resolve(); });
    });
    pr.on('error', () => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"upstream_unavailable"}'); resolve(); });
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { pr.end(b); });
    } else pr.end();
  });
}
export function start(mainnetPort = 18081, stagingPort = 18082) {
  const srv = http.createServer(async (req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    const xHost = String(req.headers['x-test-host'] || '');
    const h = xHost || host;
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const q = u.search || '';
    res.setHeader('x-candidate', 'stage4-20261119');
    // ---- staging host ----
    if (h === 'api-staging.agentcoin.work') {
      // closed mutations: any write under /working/cabinet or /cabinet
      if ((p.startsWith('/working/cabinet/') || p.startsWith('/cabinet/')) && req.method !== 'GET' && req.method !== 'HEAD') {
        req.resume();
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"staging_mutation_unavailable"}');
        return;
      }
      // single-owner txproof reads -> staging only
      if (p.startsWith('/working/txproof/') && req.method === 'GET') {
        await proxy(stagingPort, req, res, true);
        return;
      }
      if ((p === '/working/balance' || p === '/working/node-info' || p === '/working/identity/meta') && req.method === 'GET') {
        await proxy(stagingPort, req, res, true);
        return;
      }
      // no fallback to mainnet, no redirect to mainnet: unknown staging path -> 404
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"staging_mutation_unavailable"}');
      return;
    }
    // ---- mainnet host ----
    if (p === '/imperial' || p === '/imperial.html' || p === '/imperial/') {
      res.writeHead(308, { location: '/' + q });
      res.end();
      return;
    }
    if (p === '/' && req.method === 'GET') { sendFile(res, 'index.html', 'text/html; charset=utf-8'); return; }
    if (p === '/agent-room' && req.method === 'GET') { sendFile(res, 'agent-room.html', 'text/html; charset=utf-8'); return; }
    if (p === '/settlement' && req.method === 'GET') { sendFile(res, 'settlement.html', 'text/html; charset=utf-8'); return; }
    if (p.startsWith('/_shell/') && req.method === 'GET') {
      const rel = p.slice(1);
      const t = rel.endsWith('.css') ? 'text/css' : 'application/javascript';
      try { sendFile(res, rel, t); } catch { res.writeHead(404); res.end('no'); }
      return;
    }
    if (p === '/app.js' && req.method === 'GET') {
      try { sendFile(res, p.slice(1), 'application/javascript'); } catch { res.writeHead(404); res.end('no'); }
      return;
    }
    if (p === '/info' && req.method === 'GET') { await proxy(mainnetPort, req, res, false); return; }
    if ((p === '/balance' || p === '/identity/meta' || p === '/peers/list' || p === '/peers/health') && req.method === 'GET') {
      await proxy(mainnetPort, req, res, false); return;
    }
    // ghost routes stay 404 (advertisement removed in candidate)
    if (p === '/peers/bootstrap' || p === '/ops/watchdog/state' || p === '/gateway/list') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    if (p === '/ecosphere' || p === '/ecosphere/') {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('not published');
      return;
    }
    if (p === '/tx' && req.method === 'POST') { await proxy(mainnetPort, req, res, false); return; }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  return new Promise((resolve) => srv.listen(STAND_PORT, '127.0.0.1', () => resolve(srv)));
}
if (process.argv[1] && process.argv[1].endsWith('router.mjs')) {
  const { start: s1 } = await import('./mock-mainnet.mjs');
  const { start: s2 } = await import('./mock-staging.mjs');
  await s1(); await s2(); await start();
  console.log('stand on ' + STAND_PORT);
}
