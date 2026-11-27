#!/usr/bin/env node
/* Локальный предпросмотр НАСТОЯЩЕГО артефакта прода: статика из site/ + прокси
   публичного API ноды на node1. Так модуль видно в той же разметке, что уедет на сервер.
   Только loopback. */
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..', 'site');
const NODE = String(process.env.AGT_NODE_URL || 'https://node1.agentcoin.work').replace(/\/+$/, '');
const PORT = Number(process.env.PORT) || 3009;
const PROXY = new Set(['/life', '/info', '/escrow/state', '/stream/state', '/site/release']);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.zip': 'application/zip' };

function sendFile(res, rel) {
  const file = path.join(SITE, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(SITE)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      fs.readFile(file + '.html', (e2, b2) => {
        if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 ' + rel); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  if (PROXY.has(p)) {
    try {
      const upstream = await fetch(NODE + p, { signal: AbortSignal.timeout(9000), headers: { accept: 'application/json' } });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(text);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'upstream', detail: String(e.message || e) }));
    }
  }
  if (p === '/' || p === '') return sendFile(res, 'imperial.html');
  return sendFile(res, p);
}).listen(PORT, '127.0.0.1', () => console.log(`[site-preview] http://127.0.0.1:${PORT}/imperial.html  ·  API → ${NODE}`));
