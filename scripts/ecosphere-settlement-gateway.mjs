#!/usr/bin/env node
/* Standalone-шлюз нативных расчётов: только /mainnet/* + /version (без TEST-стенда).
 * Источник истины — живая нода через публичный API (см. sdk/js/mainnet-node-api.mjs).
 * Запуск: node scripts/ecosphere-settlement-gateway.mjs [port]
 * Env: AGT_MAINNET_API (нода, дефолт http://127.0.0.1:9335),
 *      AGT_SETTLEMENT_POLICY (файл политики владельца),
 *      AGT_SETTLEMENT_STORE (файл журнала), AGT_SETTLEMENT_DEPTH (глубина).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMainnetGateway } from '../sdk/js/mainnet-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.argv[2] || process.env.AGT_SETTLEMENT_PORT || 18745);
const storeFile = process.env.AGT_SETTLEMENT_STORE || path.join(root, '.settlement-gateway', 'mainnet-settlements.json');
const policyFile = process.env.AGT_SETTLEMENT_POLICY || path.join(root, '.settlement-gateway', 'settlement-policy.json');
const gw = createMainnetGateway({
  nodeApiBase: process.env.AGT_MAINNET_API || 'http://127.0.0.1:9335',
  storeFile, policyFile,
  confirmDepth: Number(process.env.AGT_SETTLEMENT_DEPTH || 6),
});

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/version' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'agt-settlement-gateway', api: `http://127.0.0.1:${port}`, at: new Date().toISOString() }));
    return;
  }
  if (!u.pathname.startsWith('/mainnet/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const chunks = [];
  let bodyBytes = 0;
  let bodyTooLarge = false;
  req.on('data', (c) => { bodyBytes += c.length; if (bodyBytes > 65536) { bodyTooLarge = true; try { req.destroy(); } catch {} return; } chunks.push(c); });
  req.on('end', async () => {
    if (bodyTooLarge || bodyBytes > 65536) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'body_too_large' })); return; }
    let b = {};
    try { b = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad_json' })); return; }
    try {
      const r = await gw.handle(req, res, u, b);
      if (r === null) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); }
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'gateway_failed', hint: String(e.message || e).slice(0, 200) }));
    }
  });
});

await new Promise((r) => server.listen(port, '127.0.0.1', r));
fs.mkdirSync(path.dirname(storeFile), { recursive: true });
console.log(JSON.stringify({ gateway: `http://127.0.0.1:${port}`, store: storeFile, policy: policyFile }));
setInterval(() => {}, 60000);
