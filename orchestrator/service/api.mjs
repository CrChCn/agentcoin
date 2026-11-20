#!/usr/bin/env node
/* Read-only Ops API. Наружу отдаёт только allowlisted публичное представление
   (contracts/public-status.schema.json): без путей, usernames, PID, внутренних
   адресов, промптов, stderr, credentials, памяти проекта и имён секретов.

   Слушает только loopback — 127.0.0.1 и ::1. Не-GET/HEAD → 405. */

import http from 'node:http';

import { OpsStore } from './store.mjs';
import { buildPublicStatus } from './publicview.mjs';

const startedAt = new Date();

function send(res, code, body, { headOnly = false } = {}) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(headOnly ? undefined : payload);
}

export function createApi({ root, mission = null, staleAfterSec = Number(process.env.OPS_STALE_AFTER_SEC || 900) } = {}) {
  return http.createServer((req, res) => {
    const headOnly = req.method === 'HEAD';
    if (!['GET', 'HEAD'].includes(req.method)) {
      send(res, 405, { ok: false, error: 'method_not_allowed', note: 'the ops API is read-only' });
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://ops.local');
    } catch {
      send(res, 400, { ok: false, error: 'bad_request' });
      return;
    }
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (route === '/' || route === '/ops') {
      send(res, 200, {
        ok: true, readonly: true, service: 'agentcoin-ops',
        endpoints: ['/ops/status', '/ops/queue', '/ops/health', '/ops/releases', '/ops/memory'],
        note: 'наблюдение разрешено; задачи, deployment и остановка — только у владельца',
      }, { headOnly });
      return;
    }

    if (route === '/ops/health') {
      const status = buildPublicStatus({ root, mission, staleAfterSec });
      send(res, 200, {
        ok: !status.orchestrator.stale,
        service: status.service,
        generatedAt: status.generatedAt,
        stale: status.orchestrator.stale,
        heartbeatAgeSec: status.orchestrator.heartbeatAgeSec,
        uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      }, { headOnly });
      return;
    }

    if (route === '/ops/status' || route === '/ops/queue') {
      send(res, 200, buildPublicStatus({ root, mission, staleAfterSec }), { headOnly });
      return;
    }

    if (route === '/ops/releases') {
      send(res, 200, { ok: true, readonly: true, deployment: 'not-enabled', releases: [] }, { headOnly });
      return;
    }

    if (route === '/ops/memory') {
      /* Только счётчики: содержимое памяти проекта — операционная информация. */
      const store = new OpsStore(root, { readOnly: true });
      const memory = store.memory();
      send(res, 200, {
        ok: true, readonly: true,
        decisions: (memory.decisions || []).length,
        lessons: (memory.lessons || []).length,
      }, { headOnly });
      return;
    }

    send(res, 404, { ok: false, error: 'not_found' }, { headOnly });
  });
}

/* Два loopback-сокета, никаких других адресов: публикацию наружу делает Caddy,
   а не сам сервис. ::1 может отсутствовать в окружении — это не ошибка. */
export async function startApi({ root, mission = null, hosts = ['127.0.0.1', '::1'], port = 8799 }) {
  const servers = [];
  const addresses = [];
  for (const host of hosts) {
    const server = createApi({ root, mission });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      servers.push(server);
      addresses.push(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
    } catch (err) {
      if (host === '::1' && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) continue;
      for (const started of servers) started.close();
      throw err;
    }
  }
  if (!servers.length) throw Object.assign(new Error('no loopback listener could be started'), { code: 'API_NO_LISTENER' });
  return { servers, addresses, close: () => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))) };
}
