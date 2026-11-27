/* agentnet/api.mjs — /api/v1/network/*: подписанные версионированные ответы,
   SSE-события, статика сайта. Каждый ответ: schemaVersion, generatedAt,
   sourceIndexer, observedAt, expiresAt, signature. */
'use strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { canonicalJson } from './util.mjs';
import { nodeIdFromPublicKeyPem, verifyWithPublicKey } from './identity.mjs';

export const SCHEMA_VERSION = 1;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function signedBody(body) {
  const { signature, pubkey, ...rest } = body;
  return canonicalJson(rest);
}

export function signResponse(identity, kind, data, { ttlMs = 15000, observedAt = Date.now(), extra = {} } = {}) {
  const now = Date.now();
  const body = {
    schemaVersion: SCHEMA_VERSION,
    kind,
    generatedAt: new Date(now).toISOString(),
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    sourceIndexer: identity.nodeId,
    ...extra,
    data,
  };
  body.signature = identity.signB64u(Buffer.from(signedBody(body), 'utf8'));
  body.pubkey = identity.publicKeyPem;
  return body;
}

export function verifySignedResponse(doc, { now = Date.now(), expectedKind = null, pubkeyPem = null } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!doc || typeof doc !== 'object') return fail('not_object');
  if (doc.schemaVersion !== SCHEMA_VERSION) return fail('schema_mismatch');
  if (expectedKind && doc.kind !== expectedKind) return fail('kind_mismatch');
  if (!doc.data || typeof doc.data !== 'object') return fail('no_data');
  if (!doc.signature || !doc.pubkey) return fail('unsigned');
  if (Date.parse(doc.expiresAt) <= now) return fail('expired');
  if (Date.parse(doc.generatedAt) > now + 120000) return fail('from_future');
  let derived;
  try { derived = nodeIdFromPublicKeyPem(doc.pubkey); } catch { return fail('bad_pubkey'); }
  if (derived !== doc.sourceIndexer) return fail('source_indexer_key_mismatch');
  if (pubkeyPem && pubkeyPem !== doc.pubkey) return fail('unexpected_indexer_key');
  if (!verifyWithPublicKey(doc.pubkey, Buffer.from(signedBody(doc), 'utf8'), doc.signature)) {
    return fail('bad_signature');
  }
  return { ok: true, data: doc.data, sourceIndexer: doc.sourceIndexer, observedAt: doc.observedAt };
}

export class NetworkApi {
  constructor({ identity, host = '127.0.0.1', port = 0, siteDir = null, hub = null, log = () => {}, ttlMs = 15000 } = {}) {
    this.identity = identity;
    this.host = host;
    this.port = port;
    this.siteDir = siteDir;
    this.hub = hub;
    this.log = log;
    this.ttlMs = ttlMs;
    this.routes = new Map();
    this.server = null;
    this.actualPort = null;
    this.startedAt = Date.now();
    this.requests = 0;
  }

  route(kind, fn) {
    this.routes.set(kind, fn);
    return this;
  }

  signed(kind, data, opts = {}) {
    return signResponse(this.identity, kind, data, { ttlMs: this.ttlMs, ...opts });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => { this._handle(req, res); });
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        this.actualPort = this.server.address().port;
        resolve(this);
      });
    });
  }

  stop() {
    if (this.hub) this.hub.close();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  get url() { return `http://${this.host === '0.0.0.0' ? '127.0.0.1' : this.host}:${this.actualPort}`; }

  async _handle(req, res) {
    this.requests++;
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const json = (code, obj, headers = {}) => {
      const body = JSON.stringify(obj, null, 2);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        ...headers,
      });
      res.end(body);
    };
    try {
      if (p === '/health') {
        return json(200, { ok: true, source: this.identity.nodeId, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) });
      }
      if (p === '/api/v1/network/events' && this.hub) {
        return this.hub.attach(req, res);
      }
      const prefix = '/api/v1/network/';
      if (p.startsWith(prefix)) {
        let rest = p.slice(prefix.length);
        const parts = rest.split('/').filter(Boolean);
        const fn = this.routes.get(rest) || this.routes.get(parts[0]);
        if (!fn) return json(404, { error: 'unknown_endpoint', path: p });
        const params = parts.slice(1);
        const data = await fn({ req, url, query: url.searchParams, params, path: p });
        if (data && data.__stream) return;
        const envelope = this.signed(parts[0], data);
        return json(200, envelope);
      }
      if (this.siteDir && (req.method === 'GET' || req.method === 'HEAD')) {
        return this._serveStatic(p, res);
      }
      return json(404, { error: 'not_found' });
    } catch (e) {
      this.log(`[api] ${p}: ${e.message}`);
      return json(500, { error: 'internal', message: e.message });
    }
  }

  _serveStatic(pathname, res) {
    const rel = pathname === '/'
      ? (fs.existsSync(path.join(this.siteDir, 'index.html')) ? 'index.html' : 'network.html')
      : decodeURIComponent(pathname.replace(/^\/+/, ''));
    const root = path.resolve(this.siteDir);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  }
}
