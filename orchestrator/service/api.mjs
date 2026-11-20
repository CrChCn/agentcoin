#!/usr/bin/env node
/* Read-only Ops API. Наружу отдаёт только наблюдение: состояние, очередь,
   память, историю принятых заданий. Ни одной операции записи здесь нет:
   не-GET запросы отклоняются 405, файлы читаются только из OPS_ROOT,
   ответы помечены no-store. Публичная страница /ops получает эти данные
   через Caddy; сам сервис слушает только loopback. */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { Store } from '../state/store.mjs';
import { OpsStore, STATUS } from './store.mjs';

const startedAt = new Date();

function json(res, code, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (res.req && res.req.method === 'HEAD') res.end();
  else res.end(payload);
}

function taskView(store, item) {
  const view = {
    taskId: item.taskId,
    title: item.title,
    status: item.status,
    attempts: item.attempts,
    origin: item.origin,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    result: item.result || null,
    lastError: item.lastError || null,
  };
  if (item.status === STATUS.DONE || item.status === STATUS.FAILED || item.status === STATUS.BLOCKED) {
    try {
      const report = new Store(store.paths.base, { readOnly: true });
      const state = report.load(item.taskId);
      view.journal = { events: state.seq, state: state.state, iteration: state.iteration };
    } catch {
      view.journal = { error: 'unreadable' };
    }
  }
  return view;
}

export function createApi({ root, publicOrigin = null }) {
  const store = new OpsStore(root, { readOnly: true });

  return http.createServer((req, res) => {
    res.req = req;
    if (!['GET', 'HEAD'].includes(req.method)) {
      json(res, 405, { ok: false, error: 'method_not_allowed', note: 'the ops API is read-only' });
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://ops.local');
    } catch {
      json(res, 400, { ok: false, error: 'bad_request' });
      return;
    }
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (route === '/ops/health') {
      const age = store.heartbeatAgeSec();
      const staleAfterSec = Number(process.env.OPS_STALE_AFTER_SEC || 900);
      json(res, 200, {
        ok: age == null ? false : age <= staleAfterSec,
        service: 'agentcoin-ops-api',
        startedAt: startedAt.toISOString(),
        heartbeatAgeSec: age,
        staleAfterSec,
        readonly: true,
      });
      return;
    }

    if (route === '/ops/status') {
      const beat = store.readHeartbeat();
      const checkpoint = store.readCheckpoint();
      const queue = store.counts();
      const memory = store.memory();
      const age = store.heartbeatAgeSec();
      json(res, 200, {
        ok: true,
        readonly: true,
        generatedAt: new Date().toISOString(),
        host: store.host,
        orchestrator: {
          state: beat.state || 'unknown',
          pid: beat.pid || null,
          heartbeatAt: beat.at || null,
          heartbeatAgeSec: age,
          stale: age == null ? true : age > Number(process.env.OPS_STALE_AFTER_SEC || 900),
        },
        checkpoint,
        queue,
        memory: {
          facts: memory.facts || {},
          decisions: (memory.decisions || []).slice(-10),
          lessons: (memory.lessons || []).slice(-10),
        },
      });
      return;
    }

    if (route === '/ops/queue') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      const items = store.list()
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, limit)
        .map((item) => taskView(store, item));
      json(res, 200, { ok: true, readonly: true, counts: store.counts(), items });
      return;
    }

    if (route === '/ops/releases') {
      /* Разрешённые релизы появятся на этапе deployer; сейчас список пуст и
         явно об этом говорит. */
      const dir = path.join(store.paths.runsDir, 'releases');
      const releases = fs.existsSync(dir) ? fs.readdirSync(dir).slice(-20) : [];
      json(res, 200, { ok: true, readonly: true, deployment: 'not-enabled', releases });
      return;
    }

    if (route === '/ops/memory') {
      json(res, 200, { ok: true, readonly: true, memory: store.memory(), lessons: store.lessons(50) });
      return;
    }

    if (route === '/' || route === '/ops' || route === '/ops/') {
      json(res, 200, {
        ok: true,
        readonly: true,
        service: 'agentcoin-ops',
        publicOrigin,
        endpoints: ['/ops/status', '/ops/queue', '/ops/health', '/ops/memory', '/ops/releases'],
        note: 'наблюдение разрешено; создание задач, deployment и остановка — только у владельца',
      });
      return;
    }

    json(res, 404, { ok: false, error: 'not_found', route });
  });
}

export function startApi({ root, host = '127.0.0.1', port = 8799, publicOrigin = null }) {
  const server = createApi({ root, publicOrigin });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, address: `http://${host}:${port}` }));
  });
}
