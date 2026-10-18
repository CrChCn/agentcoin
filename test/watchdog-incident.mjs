import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { requestJson, probeHealth, parsePortOwner, launchWrapper, createWatchdog, readTailnetBind } from '../watchdog.mjs';

const node = { name: 'test', port: '19539', url: 'http://127.0.0.1:19539/life', wrapper: 'test.cmd' };
function harness(overrides = {}) {
  const calls = { launches: [], kills: [], cpu: 0, saves: 0 };
  const supervisor = createWatchdog({
    nodes: [node], now: () => 1_000_000, pause: async () => {},
    canLaunch: () => true,
    probe: async () => ({ alive: false, error: 'timeout' }), owner: async () => 0,
    launch: async (wrapper) => { calls.launches.push(wrapper); return true; },
    kill: async (pid, port) => { calls.kills.push([pid, port]); return true; },
    cpu: async () => { calls.cpu++; return 10; }, save: () => { calls.saves++; },
    ...overrides,
  });
  return { ...supervisor, calls, rec: supervisor.state.nodes[node.name] };
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('health parses boolean overloaded, preserves actual target URL, avoids /life', async () => {
  const urls = [];
  const result = await probeHealth({ ...node, url: 'http://100.64.0.8:9336/life' }, async (url) => {
    urls.push(url);
    return { status: 200, body: { ok: true, service: 'agt-node', overloaded: false, blocks: 100, tipAgeSec: 7 } };
  });
  assert.deepEqual(urls, ['http://100.64.0.8:9336/health']);
  assert.equal(result.alive, true);
  assert.equal(result.overloaded, false);
});

test('tailnet binding is explicit and absent config never probes or restarts', async () => {
  const missing = () => { throw new Error('ENOENT'); };
  assert.equal(readTailnetBind({}, missing), null);
  assert.equal(readTailnetBind({ AGT_TS_BIND: '0.0.0.0' }, missing), null);
  assert.equal(readTailnetBind({}, () => '100.64.0.20\n'), '100.64.0.20');
  assert.equal(readTailnetBind({ AGT_TS_BIND: '100.64.0.21' }, missing), '100.64.0.21');
  const disabled = { ...node, url: null, configurationError: 'configure TS binding' };
  const h = harness({ nodes: [disabled], probe: probeHealth,
    owner: async () => { throw new Error('must not inspect unconfigured service'); } });
  for (let i = 0; i < 8; i++) await h.cycle();
  assert.equal(h.rec.status, 'configuration_required');
  assert.deepEqual(h.calls.kills, []);
  assert.deepEqual(h.calls.launches, []);
});

test('HTTP 503 overload proves responsive service; false/string flag does not', async () => {
  for (const body of [{ overloaded: true }, { error: 'overloaded' }]) {
    const result = await probeHealth(node, async () => ({ status: 503, body }));
    assert.equal(result.alive, true);
    assert.equal(result.overloaded, true);
  }
  assert.equal((await probeHealth(node, async () => ({ status: 503, body: { overloaded: false } }))).alive, false);
  assert.equal((await probeHealth(node, async () => ({ status: 503, body: { overloaded: 'false' } }))).alive, false);
});

test('200 alone is not healthy; only a 404 selects legacy life contract', async () => {
  assert.equal((await probeHealth(node, async () => ({ status: 200, body: { error: 'wrong_service' } }))).alive, false);
  const urls = [];
  const result = await probeHealth(node, async (url) => {
    urls.push(url);
    return url.endsWith('/health') ? { status: 404 } : { status: 200, body: { alive: false, chainValid: false } };
  });
  assert.deepEqual(urls, ['http://127.0.0.1:19539/health', node.url]);
  assert.equal(result.alive, true, 'responsive node with invalid chain needs diagnosis, not restart');
  assert.equal(result.chainValid, false);
});

test('deadline destroys sockets when headers never arrive', async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => { closed = resolve; });
  const base = await serve(t, (req) => { req.socket.once('close', closed); });
  const result = await requestJson(base, { timeoutMs: 80 });
  assert.equal(result.error, 'timeout');
  await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('socket leaked')), 500))]);
});

test('deadline also covers a stalled body after HTTP 200 headers', async (t) => {
  const base = await serve(t, (_req, res) => { res.writeHead(200); res.write('{"ok":'); });
  assert.equal((await requestJson(base, { timeoutMs: 80 })).error, 'timeout');
});

test('bounded JSON response handles oversized, invalid and abruptly aborted bodies', async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/large') return res.end('x'.repeat(5000));
    if (req.url === '/abort') { res.writeHead(200); res.write('{'); return setImmediate(() => res.destroy()); }
    res.end('<html>wrong page</html>');
  });
  assert.equal((await requestJson(base + '/large')).error, 'response_too_large');
  assert.equal((await requestJson(base + '/invalid')).error, 'invalid_json');
  assert.ok((await requestJson(base + '/abort')).error);
});

test('responsive stale or overloaded nodes never trigger liveness restarts', async () => {
  for (const check of [
    { alive: true, overloaded: false, blocks: 12, tipAgeSec: 3600 },
    { alive: true, overloaded: true, blocks: 12, tipAgeSec: 5 },
    { alive: true, chainValid: false, blocks: 12, tipAgeSec: 5 },
  ]) {
    const h = harness({ probe: async () => check, owner: async () => { throw new Error('must not inspect healthy node'); } });
    for (let i = 0; i < 20; i++) await h.cycle();
    assert.equal(h.rec.fails, 0);
    assert.equal(h.rec.restarts, 0);
    assert.equal(h.calls.cpu, 0);
    assert.deepEqual(h.calls.launches, []);
    assert.equal(h.rec.status, check.overloaded ? 'overloaded' : check.chainValid === false ? 'chain_invalid' : 'stale');
  }
});

test('CPU deferral does not fabricate restarts or consume the next cooldown', async () => {
  let load = 99;
  const h = harness({ cpu: async () => load });
  for (let i = 0; i < 4; i++) await h.cycle();
  assert.equal(h.rec.status, 'restart_deferred');
  assert.equal(h.rec.restarts, 0);
  assert.equal(h.rec.lastRestartAt, 0);
  assert.equal(h.rec.lastRestartAttemptAt, undefined);
  load = 10;
  await h.cycle();
  assert.deepEqual(h.calls.launches, ['test.cmd']);
  assert.equal(h.rec.restarts, 1);
  assert.equal(h.rec.status, 'starting');
});

test('only one dead node restarts per cycle; postponed node retains eligibility', async () => {
  const second = { ...node, name: 'second', port: '19540', wrapper: 'second.cmd' };
  const h = harness({ nodes: [node, second] });
  await h.cycle();
  await h.cycle();
  assert.deepEqual(h.calls.launches, ['test.cmd']);
  assert.equal(h.state.nodes.second.lastRestartAt, 0);
  assert.equal(h.state.nodes.second.restarts, 0);
  await h.cycle();
  assert.deepEqual(h.calls.launches, ['test.cmd', 'second.cmd']);
});

test('unknown owner or listener found on recheck prevents duplicate spawn', async () => {
  for (const owners of [[null], [0, null], [0, 91]]) {
    let i = 0;
    const h = harness({ owner: async () => owners[Math.min(i++, owners.length - 1)] });
    await h.cycle(); await h.cycle();
    assert.deepEqual(h.calls.launches, []);
    assert.equal(h.rec.restarts, 0);
  }
});

test('failed stop never spawns a second listener', async () => {
  const h = harness({ owner: async () => 91, sickLimit: 1, kill: async () => false });
  await h.cycle(); await h.cycle();
  assert.equal(h.rec.status, 'stop_failed');
  assert.equal(h.rec.restarts, 0);
  assert.deepEqual(h.calls.launches, []);
});

test('missing wrapper is diagnosed before killing an existing process', async () => {
  const h = harness({ owner: async () => 91, sickLimit: 1, canLaunch: () => false });
  await h.cycle(); await h.cycle();
  assert.equal(h.rec.status, 'wrapper_missing');
  assert.deepEqual(h.calls.kills, []);
  assert.deepEqual(h.calls.launches, []);
});

test('unexpected HTTP 200 service is diagnosed without killing its listener', async () => {
  const h = harness({ probe: async () => ({ alive: false, responsive: true, error: 'invalid_health_http_200' }),
    owner: async () => { throw new Error('must not inspect or kill another service'); } });
  for (let i = 0; i < 8; i++) await h.cycle();
  assert.equal(h.rec.status, 'unexpected_health');
  assert.deepEqual(h.calls.kills, []);
  assert.deepEqual(h.calls.launches, []);
});

test('hard restart awaits port release and successful launch before counting', async () => {
  const order = [];
  const h = harness({ owner: async () => 91, sickLimit: 1,
    kill: async () => { order.push('stop'); await Promise.resolve(); order.push('free'); return true; },
    launch: async () => { order.push('spawn'); return true; },
  });
  await h.cycle(); await h.cycle();
  assert.deepEqual(order, ['stop', 'free', 'spawn']);
  assert.equal(h.rec.restarts, 1);
});

test('failed wrapper launch is recorded honestly and throttled', async () => {
  let launches = 0;
  const h = harness({ launch: async () => { launches++; return false; } });
  await h.cycle(); await h.cycle();
  assert.equal(h.rec.status, 'restart_failed');
  assert.equal(h.rec.restarts, 0);
  assert.equal(h.rec.lastRestartAt, 0);
  assert.equal(h.rec.restartAttempts, 1);
  await h.cycle();
  assert.equal(h.rec.status, 'restart_cooldown');
  assert.equal(launches, 1);
});

test('cycles do not overlap even while a probe is in flight', async () => {
  let finish;
  const h = harness({ probe: () => new Promise((resolve) => { finish = resolve; }) });
  const first = h.cycle();
  assert.equal(await h.cycle(), false);
  finish({ alive: true });
  assert.equal(await first, true);
  assert.equal(h.calls.saves, 1);
});

test('a healthy response resets consecutive sickness after a transient failure', async () => {
  let alive = false;
  const h = harness({ probe: async () => ({ alive }), owner: async () => 91 });
  await h.cycle(); await h.cycle();
  assert.equal(h.rec.sick, 1);
  alive = true;
  await h.cycle();
  assert.equal(h.rec.sick, 0);
  assert.equal(h.rec.fails, 0);
});

test('netstat parser matches local exact port including IPv6, never remote port', () => {
  const rows = '  TCP  127.0.0.1:93350  0.0.0.0:0 LISTENING 10\r\n'
    + ' TCP 127.0.0.1:5555 127.0.0.1:9335 ESTABLISHED 20\r\n'
    + ' TCP [::]:9335 [::]:0 LISTENING 91';
  assert.equal(parsePortOwner(rows, 9335), 91);
  assert.equal(parsePortOwner(rows, 9341), 0);
});

test('wrapper ENOENT is handled asynchronously; missing wrapper never spawns', async () => {
  assert.equal(await launchWrapper('missing.cmd', { exists: () => false,
    spawnFn: () => { throw new Error('must not spawn'); } }), false);
  assert.equal(await launchWrapper('test.cmd', { exists: () => true, spawnFn: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  } }), false);
});
