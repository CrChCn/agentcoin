#!/usr/bin/env node
/* ============================================================
   AGENTCOIN stream server — локальный стенд для эфира.
   - отдаёт stream/* (оверлей, телесуфлёр);
   - проксирует ТОЛЬКО read-only эндпоинты ноды под /api/*,
     чтобы OBS-браузер не зависел от CORS и от смены хоста;
   - без зависимостей, слушает только loopback.

   Запуск:  node stream/server.mjs
   Открыть: http://127.0.0.1:8790/overlay.html
            http://127.0.0.1:8790/teleprompter.html
   ============================================================ */
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGT_STREAM_PORT || 8790);
const NODE_URL = String(process.env.AGT_NODE_URL || 'https://node1.agentcoin.work').replace(/\/+$/, '');

// Белый список: прокси не должен превращаться в открытый релей.
const API_ALLOW = [
  /^\/life$/, /^\/info$/, /^\/escrow\/state$/,
  /^\/txproof\/[0-9a-f]{16,64}$/,
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function proxy(req, res, apiPath) {
  if (!API_ALLOW.some(re => re.test(apiPath))) return json(res, 404, { error: 'not_allowed' });
  try {
    const r = await fetch(NODE_URL + apiPath, { signal: AbortSignal.timeout(6000) });
    const text = await r.text();
    res.writeHead(r.status, {
      'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch (e) {
    json(res, 502, { error: 'node_unreachable', detail: String(e.message || e), node: NODE_URL });
  }
}

function serveFile(req, res, pathname) {
  const rel = pathname === '/' ? '/overlay.html' : pathname;
  const file = path.join(__dirname, path.normalize(rel).replace(/^([/\\])+/, ''));
  // только внутри stream/
  if (!file.startsWith(__dirname + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not_found', file: rel });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/api/')) return void proxy(req, res, url.pathname.slice(4));
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
  serveFile(req, res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stream] http://127.0.0.1:${PORT}/overlay.html  (нода: ${NODE_URL})`);
  console.log(`[stream] http://127.0.0.1:${PORT}/teleprompter.html`);
});
