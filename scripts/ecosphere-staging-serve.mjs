#!/usr/bin/env node
/* Ecosphere staging — отдельный экземпляр: своё хранилище, тест-ключи, HTTPS-терминация снаружи.
 * API: тот же stand-server (genesis stand-genesis-001, faucet ≤1000000, TEST-единицы).
 * Статика: site/ecosphere + sdk/js на том же origin (apiBase '' работает).
 * Запуск: node scripts/ecosphere-staging-serve.mjs [port]
 * Проверка: GET /info, /queue/auth-capabilities, /version
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStand } from '../sdk/js/stand-server.mjs';
import { createMainnetGateway } from '../sdk/js/mainnet-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stageRoot = path.resolve(root, '.staging-ecosphere');
const dataRoot = path.join(stageRoot, 'data');
fs.mkdirSync(dataRoot, { recursive: true });
// отдельный релиз-каталог + откат: держим prev
const versionFile = path.join(stageRoot, 'VERSION');
const port = Number(process.argv[2] || process.env.ECOSPHERE_STAGING_PORT || 18743);

const stand = await createStand(stageRoot);
const standUrl = stand.url;
// Нативный AGT-шлюз: чтение основной цепи (read-only) + приём УЖЕ подписанных tx.
// TEST-книга стенда остаётся только для изолированных тестов и НЕ является
// публичным платёжным путём: в UI помечена отдельно (см. mainnet.html).
const mainnet = createMainnetGateway({
  mainnetDataDir: path.join(root, 'data'),
  storeFile: path.join(stageRoot, 'mainnet-settlements.json'),
  policyFile: process.env.AGT_SETTLEMENT_POLICY || path.join(stageRoot, 'settlement-policy.json'),
  nodeUrl: process.env.AGT_MAINNET_NODE || 'http://127.0.0.1:9333',
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const roots = [
  { prefix: '/ecosphere/', dir: path.join(root, 'site', 'ecosphere') },
  { prefix: '/sdk/js/', dir: path.join(root, 'sdk', 'js') },
];
function serveFile(fp, res) {
  try {
    const st = fs.statSync(fp);
    if (!st.isFile()) return false;
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
    return true;
  } catch { return false; }
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/' || p === '/ecosphere' || p === '/ecosphere/') {
    res.writeHead(302, { Location: '/ecosphere/index.html' }); res.end(); return;
  }
  if (p === '/version') {
    let v = {};
    try { v = JSON.parse(fs.readFileSync(versionFile, 'utf8')); } catch { v = { error: 'no_version' }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); return;
  }
  for (const r of roots) {
    if (p.startsWith(r.prefix)) {
      const rel = decodeURIComponent(p.slice(r.prefix.length).split('?')[0]);
      if (rel.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
      if (serveFile(path.join(r.dir, rel || 'index.html'), res)) return;
    }
  }
  // Mainnet-маршруты — локально в этом процессе (цепь читается из файла, ключей нет).
  if (u.pathname.startsWith('/mainnet/')) {
    const chunks0 = [];
    let n0 = 0;
    req.on('data', (c) => { n0 += c.length; if (n0 > 65536) { try { req.destroy(); } catch {} return; } chunks0.push(c); });
    req.on('end', async () => {
      if (n0 > 65536) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'body_too_large' })); return; }
      let b = {};
      try { b = chunks0.length ? JSON.parse(Buffer.concat(chunks0).toString('utf8')) : {}; }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad_json' })); return; }
      try {
        const r = await mainnet.handle(req, res, u, b);
        if (r === null) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); }
      } catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'mainnet_failed', hint: String(e.message || e).slice(0, 200) })); }
    });
    return;
  }
  // API: прокси в стенд (сохраняем метод/тело/query)
  const target = standUrl + req.url;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const r = await fetch(target, { method: req.method, headers: { 'Content-Type': 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
      const text = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'proxy_failed' })); }
  });
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));
const ver = { name: 'ecosphere-staging', genesis: stand.genesis, api: `http://127.0.0.1:${port}`, standUrl, https: 'TLS terminates at Caddy on target host; loopback HTTP only locally', version: '0.1.0+pass4', commit: 'ddeba0f', at: new Date().toISOString(), dataDir: dataRoot, faucetLimit: 1000000, units: 'TEST-единицы стенда, не AGT блокчейна' };
fs.writeFileSync(versionFile, JSON.stringify(ver, null, 2));
console.log(JSON.stringify({ staging: ver.api, version: ver.version, genesis: ver.genesis }));
// держим процесс; остановка — Ctrl+C (данные dataDir сохраняются для отката/рестарта)
setInterval(() => {}, 60000);
