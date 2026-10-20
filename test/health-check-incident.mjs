import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHealthConfig, createHealthApi, runHealthCheck } from '../health-check.mjs';
import { auditBalances } from '../audit-lib.mjs';

const root = path.resolve(os.tmpdir(), 'agt-health-config-test');
const missing = () => { throw new Error('ENOENT'); };
const cfg = (argv = [], env = {}, extra = {}) => resolveHealthConfig(argv, env,
  { root, read: missing, exists: () => false, platform: 'win32', ...extra });
const healthy = { chainValid: true, fresh: true, blocks: 101, tipAgeSec: 2 };
const goodAudit = async () => ({ checked: 2, height: 101, mismatches: [], transientSkipped: 0 });

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('each Windows port selects its own task and data directory', () => {
  for (const [port, task, dir] of [
    ['9335', 'AGTNode9335', 'data'], ['9341', 'AGTNode9341', 'data-node2'],
    ['9342', 'AGTNode9342', 'data-node3'], ['9336', 'AGTNodeTs', 'data-node-ts'],
  ]) {
    const config = cfg([port], port === '9336' ? { AGT_TS_BIND: '100.64.0.20' } : {});
    assert.equal(config.heal.task, task);
    assert.equal(config.dataDir, path.join(root, dir));
    assert.equal(config.port, Number(port));
  }
});

test('9336 requires explicit host/config; unknown port requires explicit data dir', () => {
  assert.throws(() => cfg(['9336']), /requires --host/);
  assert.equal(cfg(['9336', '--host', '100.64.0.21']).baseUrl, 'http://100.64.0.21:9336');
  assert.throws(() => cfg(['9555']), /requires --data-dir/);
  assert.equal(cfg(['9555', '--data-dir', 'custom']).dataDir, path.join(root, 'custom'));
});

test('tailnet ignored config is shared with watchdog and does not guess a user IP', () => {
  const config = cfg(['9336'], {}, { read: (file) => {
    if (file === path.join(root, 'data-agtx', 'ts-bind.txt')) return '100.64.0.22\n';
    throw new Error('ENOENT');
  } });
  assert.equal(config.baseUrl, 'http://100.64.0.22:9336');
  assert.equal(config.heal.task, 'AGTNodeTs');
});

test('remote target never restarts a local task or receives the local file token', () => {
  const config = cfg([], { AGT_NODE_URL: 'https://node.example:9341', AGT_ADMIN_TOKEN: 'SYNTHETIC-ENV-TOKEN' }, { read: () => 'PRIVATE-LOCAL-TOKEN' });
  assert.equal(config.heal, null);
  assert.equal(config.adminToken, null);
  assert.equal(config.baseUrl, 'https://node.example:9341');
});

test('explicit custom data dir never heals the wrong Windows task', () => {
  assert.equal(cfg(['9341', '--data-dir', 'other-chain']).heal, null);
  assert.equal(cfg(['9341', '--no-heal']).heal, null);
});

test('Linux VPS defaults and explicit systemd units map honestly', () => {
  const vps = cfg([], {}, { platform: 'linux', exists: (file) => file === path.join(root, 'data-vps') });
  assert.equal(vps.dataDir, path.join(root, 'data-vps'));
  assert.equal(vps.heal.unit, 'agt-node.service');
  assert.equal(cfg(['9341'], {}, { platform: 'linux' }).heal, null);
  assert.equal(cfg(['9341', '--systemd-unit', 'agt-node-b.service'], {}, { platform: 'linux' }).heal.unit, 'agt-node-b.service');
  assert.equal(cfg(['9335', '--data-dir', 'other-chain'], {}, { platform: 'linux' }).heal, null);
  assert.equal(cfg(['9335', '--data-dir', 'other-chain', '--systemd-unit', 'agt-custom.service'], {}, { platform: 'linux' }).heal.unit, 'agt-custom.service');
});

test('remote API and full balance audit suppress env token in every request', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-remote-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'chain.json'), JSON.stringify({ chain: [{ txs: [{ from: 'COINBASE', to: 'AGTsynthetic', amount: 5 }] }] }));
  const previous = process.env.AGT_ADMIN_TOKEN;
  process.env.AGT_ADMIN_TOKEN = 'SYNTHETIC-ENV-TOKEN';
  try {
    const config = cfg([], { AGT_NODE_URL: 'https://node.example:9341', AGT_DATA_DIR: dir, AGT_ADMIN_TOKEN: process.env.AGT_ADMIN_TOKEN });
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status: 200, json: async () => url.endsWith('/life') ? healthy : { balance: 5 } };
    };
    const result = await runHealthCheck(config, {
      api: createHealthApi(config, fetchFn),
      audit: (args) => auditBalances({ ...args, fetchFn }),
    });
    assert.equal(result.ok, true);
    // /life + /identity/meta (drift-проверка) + баланс только адресов из chain.json.
    assert.equal(calls.length, 3);
    assert.ok(calls.some((call) => call.url.endsWith('/identity/meta')));
    for (const call of calls) assert.equal(call.headers['x-admin-token'], undefined, call.url);
    // Standalone auditors also cannot implicitly forward process.env off-host.
    calls.length = 0;
    await auditBalances({ dataDir: dir, baseUrl: config.baseUrl, fetchFn });
    assert.equal(calls[0].headers['x-admin-token'], undefined);
    // Explicit null means no auth even for loopback; undefined keeps legacy local auth.
    calls.length = 0;
    await auditBalances({ dataDir: dir, baseUrl: 'http://127.0.0.1:9335', adminToken: null, fetchFn });
    assert.equal(calls[0].headers['x-admin-token'], undefined);
    calls.length = 0;
    await auditBalances({ dataDir: dir, baseUrl: 'http://127.0.0.1:9335', fetchFn });
    assert.equal(calls[0].headers['x-admin-token'], 'SYNTHETIC-ENV-TOKEN');
  } finally {
    if (previous === undefined) delete process.env.AGT_ADMIN_TOKEN;
    else process.env.AGT_ADMIN_TOKEN = previous;
  }
});

test('URL/argument validation rejects mismatched ports and credential redirects', () => {
  assert.throws(() => cfg(['9341'], { AGT_NODE_URL: 'http://127.0.0.1:9342' }), /Port disagrees/);
  assert.throws(() => cfg([], { AGT_NODE_URL: 'http://user:pass@127.0.0.1:9335' }), /without credentials/);
  assert.throws(() => cfg(['--host']), /requires a value/);
  assert.throws(() => cfg(['--timeout-ms', '0']), /Timeout/);
});

test('API timeout covers stalled JSON body, not only response headers', async (t) => {
  const base = await serve(t, (_req, res) => { res.writeHead(200); res.write('{'); });
  const api = createHealthApi({ baseUrl: base, timeoutMs: 60 });
  await assert.rejects(api('GET', '/life'), /abort|timeout/i);
});

test('API rejects redirects instead of forwarding an administrator token', async (t) => {
  let destinationRequests = 0;
  const target = await serve(t, (_req, res) => { destinationRequests++; res.end('{}'); });
  const origin = await serve(t, (_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  const api = createHealthApi({ baseUrl: origin, timeoutMs: 1000, adminToken: 'SYNTHETIC-TEST' });
  await assert.rejects(api('GET', '/life'));
  assert.equal(destinationRequests, 0);
});

test('successful recovery clears the old failure and audits the intended node', async () => {
  const config = cfg(['9342']);
  let lifeCalls = 0, healedTask, auditArgs, alerted = false;
  const result = await runHealthCheck(config, {
    api: async (_method, route) => {
      if (route === '/health') throw new Error('connection refused');
      if (++lifeCalls === 1) throw new Error('connection refused');
      return { status: 200, body: healthy };
    },
    heal: async (target) => { healedTask = target.task; }, pause: async () => {},
    audit: async (args) => { auditArgs = args; return goodAudit(); },
    alert: async () => { alerted = true; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.healed, true);
  assert.deepEqual(result.findings, []);
  assert.equal(healedTask, 'AGTNode9342');
  assert.equal(auditArgs.dataDir, path.join(root, 'data-node3'));
  assert.equal(auditArgs.baseUrl, 'http://127.0.0.1:9342');
  assert.equal(alerted, false);
});

test('responsive cheap health prevents duplicate starts when deep life is slow', async () => {
  for (const response of [{ status: 200, body: { ok: true } }, { status: 503, body: { overloaded: true } }]) {
    const result = await runHealthCheck(cfg(), {
      api: async (_method, route) => { if (route === '/life') throw new Error('timeout'); return response; },
      heal: async () => { throw new Error('must not heal'); },
      audit: async () => { throw new Error('must not audit unavailable node'); },
    });
    assert.equal(result.healAttempted, false);
    assert.equal(result.ok, false);
  }
});

test('a stale or invalid but responsive chain is diagnosed without restarting', async () => {
  const result = await runHealthCheck(cfg(['9341']), {
    api: async () => ({ status: 200, body: { ...healthy, fresh: false, chainValid: false, tipAgeSec: 700 } }),
    heal: async () => { throw new Error('must not restart'); }, audit: goodAudit,
  });
  assert.equal(result.healAttempted, false);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.includes('chain stale')));
  assert.ok(result.findings.some((finding) => finding.includes('chainValid=false')));
});

test('recovery followed by stale chain reports current staleness, not old connection error', async () => {
  let lifeCalls = 0;
  const result = await runHealthCheck(cfg(), {
    api: async (_method, route) => {
      if (route === '/health' || ++lifeCalls === 1) throw new Error('old refused');
      return { status: 200, body: { ...healthy, fresh: false, tipAgeSec: 500 } };
    }, heal: async () => {}, pause: async () => {}, audit: goodAudit,
  });
  assert.equal(result.healed, true);
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0], /chain stale/);
});

test('partial balance audit is not reported as a complete success', async () => {
  const result = await runHealthCheck(cfg(), {
    api: async () => ({ status: 200, body: healthy }),
    audit: async () => ({ ...await goodAudit(), transientSkipped: 1 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.status, /audit incomplete/);
});

test('shared balance audit bounds a stalled body and honors overall cancellation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-health-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'chain.json'), JSON.stringify({ chain: [{ txs: [{ from: 'COINBASE', to: 'AGTsynthetic', amount: 5 }] }] }));
  const baseUrl = await serve(t, (_req, res) => { res.writeHead(200); res.write('{'); });
  let calls = 0;
  const fetchFn = (...args) => { calls++; return fetch(...args); };
  const bounded = await auditBalances({ dataDir: dir, baseUrl, attempts: 1, timeoutMs: 40, fetchFn });
  assert.equal(bounded.ok, false);
  assert.equal(calls, 1);
  await assert.rejects(auditBalances({ dataDir: dir, baseUrl, attempts: 1,
    timeoutMs: 1000, signal: AbortSignal.timeout(40) }), /abort|timeout/i);
});
