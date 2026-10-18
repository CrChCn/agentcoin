// Fixed, public installability assets. No filesystem, account state or request URL enters a body.
import { deflateSync } from 'node:zlib';

export const WEB_APP_PATHS = Object.freeze(['/app.webmanifest', '/app-worker.js', '/app-icon-192.png', '/app-icon-512.png']);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
// Opaque icon with the gold Agentcoin A. The mark stays inside the maskable safe area.
function icon(size) {
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + .5) / size, v = (y + .5) / size;
      const distance = Math.hypot(u - .5, v - .5);
      const ring = Math.abs(distance - .34) < .007;
      const left = Math.abs(u - (.5 - (v - .28) * .44)) < .024;
      const right = Math.abs(u - (.5 + (v - .28) * .44)) < .024;
      const crossbar = v > .55 && v < .595 && u > .385 && u < .615;
      const mark = v >= .28 && v <= .71 && (left || right || crossbar);
      const color = mark || ring ? [223, 185, 85] : distance < .335 ? [19, 26, 36] : [11, 16, 23];
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      scanlines[offset] = color[0]; scanlines[offset + 1] = color[1]; scanlines[offset + 2] = color[2]; scanlines[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}
const manifest = Buffer.from(JSON.stringify({
  id: '/imperial', name: 'Agentcoin', short_name: 'Agentcoin', lang: 'ru',
  description: 'Наблюдение за сетью Agentcoin и доступ к кабинету агента.',
  start_url: '/imperial', scope: '/', display: 'standalone', background_color: '#0b1017', theme_color: '#0b1017',
  icons: [192, 512].map(size => ({ src: `/app-icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' }))
}) + '\n');
// No fetch, message or push handlers: API responses, credentials and pages never enter a worker cache.
const worker = Buffer.from("'use strict';\nself.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });\nself.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });\n");
const assets = new Map([
  ['/app.webmanifest', { type: 'application/manifest+json; charset=utf-8', body: manifest }],
  ['/app-worker.js', { type: 'text/javascript; charset=utf-8', body: worker }],
  ['/app-icon-192.png', { type: 'image/png', body: icon(192) }],
  ['/app-icon-512.png', { type: 'image/png', body: icon(512) }]
]);

/** Return true only when a fixed asset path was handled. Caller supplies the exact pathname. */
export function serveWebApp(req, res, p) {
  const asset = assets.get(p);
  if (!asset) return false;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': asset.type };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = 'Method not allowed\n';
    res.writeHead(405, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD', 'Content-Length': Buffer.byteLength(body) });
    res.end(body); return true;
  }
  if (p === '/app-worker.js') headers['Content-Security-Policy'] = "default-src 'none'";
  res.writeHead(200, { ...headers, 'Content-Length': asset.body.length });
  res.end(req.method === 'HEAD' ? undefined : asset.body); return true;
}
