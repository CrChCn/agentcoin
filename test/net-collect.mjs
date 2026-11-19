#!/usr/bin/env node
// Изолированные тесты механизма Этапа 2. Без доступа к production: fetch/ssh — моки.
// Покрывают 8 дефектов приёмки: ложный match, формат capabilities get,
// общий блок без хэша, SSH allowlist, структуры ответов, монитор,
// параллелизм 4, лимит тела потоком. Плюс цепочка raw→collect→diff.
import { collect, buildPlan, isReadOnlySshCommand, MAX_CONCURRENCY, readLimitedBody, getAdvertisedLists, extractCommonBlock, MAX_BODY_BYTES } from '../tools/net-collect.mjs';
import { diff } from '../tools/net-diff.mjs';

const PIN = { network: 'AGENTCOIN', genesis: '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e' };
const TIP_A = 'a'.repeat(64);
const TIP_B = 'b'.repeat(64);
const INFO_OK = JSON.stringify({ chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks: 50060 });
const HEALTH_OK = JSON.stringify({ ok: true, service: 'agt-node', blocks: 50060, tipHash: TIP_A, tipAgeSec: 5, chainValid: true });
const LIFE_OK = JSON.stringify({ alive: true, blocks: 50060, tipHash: TIP_A, tipAgeSec: 5, fresh: true, chainValid: true });

function testReg(extra = {}) {
  return {
    version: 2, updatedAt: '2026-11-20T10:00Z', chain: { network: PIN.network, genesis: PIN.genesis, confirmDepth: 6, feeAtomic: '0' },
    sources: {}, statusVocabulary: ['confirmed', 'partial', 'unknown', 'contradiction'],
    components: [{
      componentId: 'mainnet-node-1', kind: 'blockchain-node', purpose: 't', env: 'mainnet',
      host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [
        { host: 'agentcoin.work', method: 'GET', path: '/info', owner: true, note: 'pin' },
        { host: 'agentcoin.work', method: 'GET', path: '/health', owner: true, note: 'pin' },
      ],
      storage: null, dependsOn: [], network: 'n', expected: {}, observed: {},
      verification: { status: 'unknown', evidence: ['E01'], unknowns: ['u'], checkedAt: '2026-11-20T10:00Z' },
      checkMethod: 'm', proofSource: 'p',
      chain: { chainId: 'AGENTCOIN', genesis: PIN.genesis },
      observe: {
        ssh: { host: '10.0.0.1', user: 'root', port: 22 },
        localBase: 'http://127.0.0.1:9335',
        localEndpoints: ['/info', '/health'],
        units: ['agentcoin-node.service'],
        files: ['/opt/agentcoin-node/src/node.mjs'],
        listenPorts: [9335], publicBase: 'https://agentcoin.work',
      },
      ...extra,
    }],
  };
}

const curlI = (status, ct, body) => `HTTP/1.1 ${status} X\r\ncontent-type: ${ct}\r\n\r\n${body}`;
function mockSshOk(cmdVariant) {
  return async (ssh, cmd) => {
    if (cmd.startsWith('curl ')) {
      const body = cmd.includes('/health') ? HEALTH_OK : INFO_OK;
      return { stdout: curlI(200, 'application/json', body), stderr: '', exitCode: 0 };
    }
    if (cmd.startsWith('sha256sum')) {
      const files = cmd.replace(/^sha256sum\s+/, '').split(/\s+/);
      return { stdout: files.map((f) => `${'c'.repeat(64)}  ${f}`).join('\n') + '\n', stderr: '', exitCode: 0 };
    }
    if (cmd.startsWith('systemctl show')) return { stdout: 'ActiveState=active\nMainPID=1234\nExecStart=/usr/bin/node /opt/agentcoin-node/src/node.mjs 9335\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl is-active')) return { stdout: 'active\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ps ')) return { stdout: 'PID USER ARGS\n1234 root node /opt/agentcoin-node/src/node.mjs 9335\n1 root init\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ss ')) return { stdout: 'LISTEN 0 511 127.0.0.1:9335 *:* users:(("node",pid=1234,fd=1))\n', stderr: '', exitCode: 0 };
    return { stdout: 'x\n', stderr: '', exitCode: 0 };
  };
}
const results = [];
function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((e) => results.push({ name, ok: false, sample: String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 500) }));
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

// 1. исправный ответ
await run('healthy ok', async () => {
  const fetchFn = async (url) => url.includes('/health')
    ? ({ httpStatus: 200, contentType: 'application/json', body: HEALTH_OK })
    : ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  const { observations } = await collect(testReg(), { fetchFn, sshFn: mockSshOk(), evidenceDir: null });
  const info = observations.find((o) => o.checkId === 'mainnet-node-1:local-info');
  assert(info && info.status === 'ok', 'local-info should be ok: ' + JSON.stringify(info));
  assert(info.observedValue.blocks === 50060, 'blocks parsed');
  assert(observations.every((o) => o.startedAt && o.completedAt && o.sourceEndpoint), 'provenance fields');
});

// 2. тайм-аут
await run('timeout unavailable', async () => {
  const fetchFn = () => new Promise(() => {});
  const sshFn = async () => { throw new Error('hang'); };
  const { observations } = await collect(testReg(), { fetchFn, sshFn, httpTimeoutMs: 50, sshTimeoutMs: 50 });
  const pub = observations.find((o) => o.checkId === 'mainnet-node-1:pub-info');
  assert(pub.status === 'unavailable' && /timeout/.test(pub.error), 'http timeout: ' + JSON.stringify(pub));
  const loc = observations.find((o) => o.checkId === 'mainnet-node-1:local-info');
  assert(loc.status === 'unavailable', 'ssh fail unavailable');
});

// 3. HTTP 403/404/500
await run('http statuses distinguished', async () => {
  const mk = (code) => async (url) => url.includes('/health')
    ? ({ httpStatus: code, contentType: 'text/plain', body: 'x' })
    : ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  for (const [code, want] of [[403, 'mismatch'], [404, 'mismatch'], [500, 'unavailable']]) {
    const { observations } = await collect(testReg(), { fetchFn: mk(code), sshFn: async () => ({ stdout: '', stderr: 'no', exitCode: 1 }), httpTimeoutMs: 500, sshTimeoutMs: 200 });
    const h = observations.find((o) => o.checkId === 'mainnet-node-1:pub-health');
    assert(h.status === want, `${code} -> ${want}, got ${h.status} ${h.error}`);
  }
});

// 4. HTML вместо JSON
await run('html instead of json mismatch', async () => {
  const fetchFn = async () => ({ httpStatus: 200, contentType: 'text/html', body: '<html><body>catch-all</body></html>' });
  const { observations } = await collect(testReg(), { fetchFn, sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true });
  const h = observations.find((o) => o.checkId === 'mainnet-node-1:pub-info');
  assert(h.status === 'mismatch' && /content_type_mismatch|json_invalid/.test(h.error), 'html must be mismatch: ' + JSON.stringify(h));
});

// 4b. Структуры: {} null [] text/plain на /info — mismatch
await run('info shape validation', async () => {
  for (const [body, ct] of [['{}', 'application/json'], ['null', 'application/json'], ['[]', 'application/json'], ['{}', 'text/plain']]) {
    const { observations } = await collect(testReg(), {
      fetchFn: async () => ({ httpStatus: 200, contentType: ct, body }),
      sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
    });
    const h = observations.find((o) => o.checkId === 'mainnet-node-1:pub-info');
    assert(h.status === 'mismatch', `shape ${ct} ${body} must mismatch: ${JSON.stringify(h)}`);
  }
});

// 4c. Отсутствующий пин нельзя считать совпавшим
await run('missing pin is mismatch', async () => {
  const body = JSON.stringify({ blocks: 10 });
  const { observations } = await collect(testReg(), {
    fetchFn: async () => ({ httpStatus: 200, contentType: 'application/json', body }),
    sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
  });
  const h = observations.find((o) => o.checkId === 'mainnet-node-1:pub-info');
  assert(h.status === 'mismatch' && /structure_missing|pin/.test(h.error), 'pin missing: ' + JSON.stringify(h));
});

// 4d. Тёмный резерв: 404 без маркера ≠ ok
await run('dark 404 without marker mismatch', async () => {
  const reg = testReg();
  reg.components[0].routes = [{ host: 'node2.agentcoin.work', method: 'GET', path: '/health', owner: true, note: 'тёмный 403' }];
  reg.components[0].observe.publicBase = 'https://node2.agentcoin.work';
  const { observations } = await collect(reg, {
    fetchFn: async () => ({ httpStatus: 404, contentType: 'text/plain', body: 'not found' }),
    sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
  });
  const h = observations.find((o) => o.checkId === 'mainnet-node-1:pub-health');
  assert(h.status === 'mismatch' && /not_dark/.test(h.error), 'dark 404: ' + JSON.stringify(h));
  const { observations: o2 } = await collect(reg, {
    fetchFn: async () => ({ httpStatus: 403, contentType: 'text/plain', body: 'reserve node: dark (use https://agentcoin.work)' }),
    sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
  });
  const h2 = o2.find((o) => o.checkId === 'mainnet-node-1:pub-health');
  assert(h2.status === 'ok' && h2.observedValue.darkMarker === true, 'dark 403+marker ok: ' + JSON.stringify(h2));
});

// 5. неверный chainId/genesis
await run('wrong pin mismatch', async () => {
  const bad = JSON.stringify({ chainId: 'OTHER', genesisHash: PIN.genesis, blocks: 1 });
  const bad2 = JSON.stringify({ chainId: 'AGENTCOIN', genesisHash: 'f'.repeat(64), blocks: 1 });
  for (const body of [bad, bad2]) {
    const { observations } = await collect(testReg(), {
      fetchFn: async () => ({ httpStatus: 200, contentType: 'application/json', body }),
      sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
    });
    const h = observations.find((o) => o.checkId === 'mainnet-node-1:pub-info');
    assert(h.status === 'mismatch' && /chain_pin_mismatch/.test(h.error), 'pin: ' + JSON.stringify(h));
  }
});

// 6. capabilities реального формата get + полный охват без среза 12
await run('caps get format full coverage', async () => {
  const caps = JSON.stringify({ ok: true, get: ['/info', '/queue/history', '/gateway/list', '/ghost-xyz'] });
  const fetchFn = async (url) => {
    if (url.endsWith('/capabilities')) return { httpStatus: 200, contentType: 'application/json', body: caps };
    if (url.includes('/ghost-xyz')) return { httpStatus: 404, contentType: 'text/plain', body: 'not found' };
    if (url.includes('/queue/history')) return { httpStatus: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) };
    if (url.includes('/gateway/list')) return { httpStatus: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) };
    return { httpStatus: 200, contentType: 'application/json', body: INFO_OK };
  };
  const reg = testReg();
  reg.components[0].routes = [{ host: 'agentcoin.work', method: 'GET', path: '/info', owner: true, note: 'pin' }];
  const { observations } = await collect(reg, { fetchFn, sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true });
  const capsObs = observations.find((o) => o.checkId === 'mainnet-node-1:caps');
  assert(capsObs && capsObs.status === 'ok' && capsObs.observedValue.advertisedCount === 4, 'caps get parsed: ' + JSON.stringify(capsObs));
  const qh = observations.find((o) => o.checkId === 'mainnet-node-1:caps-probe-queue-history');
  const gl = observations.find((o) => o.checkId === 'mainnet-node-1:caps-probe-gateway-list');
  const ghost = observations.find((o) => o.checkId === 'mainnet-node-1:caps-probe-ghost-xyz');
  assert(qh && qh.status === 'ok', 'queue/history probed: ' + JSON.stringify(qh));
  assert(gl && gl.status === 'ok', 'gateway/list probed: ' + JSON.stringify(gl));
  assert(ghost && ghost.status === 'mismatch', 'ghost probe mismatch: ' + JSON.stringify(ghost));
});

// 6b. Параметризованные пути — явный пропуск без bare-запроса
await run('caps param path skipped', async () => {
  const caps = JSON.stringify({ ok: true, get: ['/info', '/txproof/:txid', '/balances'] });
  let requested = [];
  const fetchFn = async (url) => {
    requested.push(url);
    if (url.endsWith('/capabilities')) return { httpStatus: 200, contentType: 'application/json', body: caps };
    return { httpStatus: 200, contentType: 'application/json', body: INFO_OK };
  };
  const reg = testReg();
  reg.components[0].routes = [{ host: 'agentcoin.work', method: 'GET', path: '/info', owner: true, note: 'pin' }];
  const { observations } = await collect(reg, { fetchFn, sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true });
  const skip = observations.find((o) => /caps-skip-txproof-txid/.test(o.checkId));
  assert(skip && skip.status === 'not_checked' && /param_needs_value/.test(skip.error), 'param skipped: ' + JSON.stringify(skip));
  assert(!requested.some((u) => u.includes('/txproof/:txid') || u.endsWith('/txproof')), 'no бессмысленный bare-запрос');
});

// 7. ложный match при пропущенных проверках → partial
await run('not_checked excludes match', async () => {
  const CAPS_OK = JSON.stringify({ ok: true, get: ['/info'] });
  const fetchFn = async (url) => url.includes('/capabilities')
    ? ({ httpStatus: 200, contentType: 'application/json', body: CAPS_OK })
    : url.includes('/health')
      ? ({ httpStatus: 200, contentType: 'application/json', body: HEALTH_OK })
      : ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  const { observations } = await collect(testReg(), { fetchFn, sshFn: mockSshOk(), publicOnly: true });
  const d = diff(testReg(), observations);
  const row = d.rows.find((r) => r.componentId === 'mainnet-node-1');
  assert(row.verdict === 'partial', 'must be partial not match: ' + JSON.stringify({ verdict: row.verdict, note: row.note }));
  assert(/not_checked/.test(row.note) && /public=/.test(row.note), 'explicit skips in note: ' + row.note);
});

// 8. общий блок: хэш извлекается, без хэша — unknown без вывода о совпадении
await run('common block hash extraction', async () => {
  const good = JSON.stringify({ blocks: [{ height: 100, hash: TIP_A }], height: 101 });
  const ex = extractCommonBlock(good, 100);
  assert(ex.ok && ex.hash === TIP_A && ex.height === 100, 'extract ok');
  const nogood = JSON.stringify({ blocks: [{ height: 100 }], height: 101 });
  const ex2 = extractCommonBlock(nogood, 100);
  assert(!ex2.ok && ex2.error === 'no_valid_hash', 'no hash');
  // end-to-end: два common-block с разными валидными хэшами → fork; без хэша → не match
  const reg = testReg();
  const mkObs = (cid, h) => ({ componentId: cid, checkId: `${cid}:common-block-100`, status: 'ok', observedValue: { height: 100, hash: h, requestedHeight: 100 }, error: null, evidenceFile: 'evidence/x.json', sourceHost: 'h', sourceEndpoint: 's', startedAt: 't', completedAt: new Date().toISOString() });
  const mkLocal = (cid, blocks, tip) => ({ componentId: cid, checkId: `${cid}:local-info`, status: 'ok', observedValue: { blocks, tipHash: tip, chainId: 'AGENTCOIN', genesisHash: PIN.genesis }, error: null, evidenceFile: 'evidence/x.json', sourceHost: 'h', sourceEndpoint: 's', startedAt: 't', completedAt: new Date().toISOString() });
  const d1 = diff(reg, [mkObs('mainnet-node-1', TIP_A), { ...mkObs('mainnet-node-1', TIP_A), checkId: 'x:common-block-100', componentId: 'mainnet-node-2' }, mkLocal('mainnet-node-1', 100, TIP_A), { ...mkLocal('mainnet-node-2', 100, TIP_A), checkId: 'mainnet-node-2:local-info' }]);
  assert(d1.monitor.commonBlock && d1.monitor.commonBlock.sameChain === true, 'same chain');
  assert(/does not prove absence/.test(d1.monitor.conclusion), 'no categorical не-форк: ' + d1.monitor.conclusion);
  const badObs = { componentId: 'mainnet-node-1', checkId: 'mainnet-node-1:common-block-100', status: 'unknown', observedValue: { requestedHeight: 100, bodyHead: 'x' }, error: 'no_valid_hash', evidenceFile: null, sourceHost: 'h', sourceEndpoint: 's', startedAt: 't', completedAt: 't' };
  const d2 = diff(reg, [badObs, { ...badObs, componentId: 'mainnet-node-2', checkId: 'x:common-block-100' }]);
  assert(d2.monitor.commonBlock.sameChain === null, 'no hash → null, без вывода о совпадении');
});

// 9. SSH allowlist: составные команды запрещены, перевод строки запрещён
await run('ssh allowlist strict', async () => {
  const plan = buildPlan(testReg());
  for (const p of plan.filter((x) => x.via === 'ssh')) {
    assert(isReadOnlySshCommand(p.command), 'plan cmd must be allowlisted: ' + p.command);
  }
  assert(!isReadOnlySshCommand('systemctl show agentcoin-node.service --property=ActiveState,ExecStart,MainPID,MemoryCurrent --value; systemctl is-active agentcoin-node.service'), 'semicolon rejected');
  assert(!isReadOnlySshCommand('ss -ltnp | grep -E \':(9335) \' || ss -ltnp | head -n 20'), 'pipe rejected');
  assert(!isReadOnlySshCommand('ps -eo pid,lstart,user,args | head -n 30'), 'pipe ps rejected');
  assert(!isReadOnlySshCommand('ss -ltnp\nprintf audit_probe'), 'newline rejected');
  assert(!isReadOnlySshCommand('env'), 'env rejected');
  assert(isReadOnlySshCommand('ss -ltnp'), 'ss exact ok');
  assert(isReadOnlySshCommand(`curl -sS -m 8 -i 'http://127.0.0.1:9335/blocks?from=10&limit=1'`), 'quoted curl with & ok');
  assert(isReadOnlySshCommand('systemctl show agentcoin-node.service --property=ActiveState,MainPID,ExecStart'), 'show ok');
});

// 9b. unit/ps/sha/ss разбираются, exitCode сохраняется
await run('ssh semantics parsed', async () => {
  const sshFn = async (ssh, cmd) => {
    if (cmd.startsWith('curl ')) return { stdout: curlI(200, 'application/json', INFO_OK), stderr: '', exitCode: 0 };
    if (cmd.startsWith('sha256sum')) return { stdout: `${'d'.repeat(64)}  /opt/agentcoin-node/src/node.mjs\n`, stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl show')) return { stdout: 'ActiveState=active\nMainPID=777\nExecStart=/usr/bin/node x\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl is-active')) return { stdout: 'active\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ps ')) return { stdout: 'PID USER ARGS\n777 root node /opt/agentcoin-node/src/node.mjs 9335\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ss ')) return { stdout: 'LISTEN 0 1 127.0.0.1:9335 x\n', stderr: '', exitCode: 0 };
    throw new Error('unexpected ' + cmd);
  };
  const fetchFn = async () => ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  const { observations } = await collect(testReg(), { fetchFn, sshFn });
  for (const id of ['proc-unit-show', 'proc-unit-active', 'proc-ps', 'listen', 'files-sha']) {
    const o = observations.find((x) => x.checkId === `mainnet-node-1:${id}`);
    assert(o && o.status === 'ok' && o.observedValue.exitCode === 0, `${id} ok + exitCode: ${JSON.stringify(o)}`);
  }
  // inactive unit → mismatch, а не ok
  const sshInactive = async (ssh, cmd) => {
    if (cmd.startsWith('systemctl show')) return { stdout: 'ActiveState=inactive\nMainPID=0\nExecStart=\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl is-active')) return { stdout: 'inactive\n', stderr: '', exitCode: 3 };
    return mockSshOk()(ssh, cmd);
  };
  const { observations: o2 } = await collect(testReg(), { fetchFn, sshFn: sshInactive });
  const u = o2.find((x) => x.checkId === 'mainnet-node-1:proc-unit-show');
  assert(u.status === 'mismatch' && /unit_inactive/.test(u.error), 'inactive mismatch: ' + JSON.stringify(u));
});

// 10. монитор: записи сопоставляются, при недостатке — INSUFFICIENT
await run('monitor nodeCompare insufficient', async () => {
  const reg = testReg();
  reg.components.push({
    componentId: 'node-monitor', kind: 'monitor', purpose: 'm', env: 'shared',
    host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [],
    storage: null, dependsOn: [], network: 'n', expected: {}, observed: {},
    verification: { status: 'unknown', evidence: ['E04'], unknowns: ['u'], checkedAt: '2026-11-20T10:00Z' },
    checkMethod: 'm', proofSource: 'p',
    observe: { publicBase: 'https://agentcoin.work' },
  });
  const nodesBody = JSON.stringify({ ok: true, nodes: [{ name: 'Эта нода', reachable: true, blocks: 100, tipHash: TIP_A, status: 'responding' }], maxObservedBlocks: 100 });
  const fetchFn = async (url) => {
    if (url.includes('/network/nodes')) return { httpStatus: 200, contentType: 'application/json', body: nodesBody };
    if (url.includes('/health')) return { httpStatus: 200, contentType: 'application/json', body: HEALTH_OK };
    return { httpStatus: 200, contentType: 'application/json', body: INFO_OK };
  };
  const { observations } = await collect(reg, { fetchFn, sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true });
  const d = diff(reg, observations);
  assert(d.monitor.nodeCompare.some((x) => x.result === 'INSUFFICIENT'), 'insufficient when locals missing: ' + JSON.stringify(d.monitor.nodeCompare));
});

// 11. параллелизм ≤ 4
await run('bounded concurrency 4', async () => {
  let cur = 0, max = 0;
  const fetchFn = async () => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 20)); cur--; return { httpStatus: 200, contentType: 'application/json', body: INFO_OK }; };
  const reg = testReg();
  reg.components[0].routes = Array.from({ length: 10 }, (_, i) => ({ host: 'agentcoin.work', method: 'GET', path: `/page${i}`, owner: true, note: 'static' }));
  await collect(reg, { fetchFn, sshFn: async () => ({ stdout: 'x', stderr: '', exitCode: 0 }), publicOnly: true, concurrency: 99 });
  assert(max <= 4, 'max concurrency ' + max);
  assert(MAX_CONCURRENCY === 4, 'default cap 4');
});

// 12. лимит тела потоком с усечением
await run('stream body limit truncates', async () => {
  const big = 'x'.repeat(MAX_BODY_BYTES + 1000);
  const enc = new TextEncoder().encode(big);
  const stream = new ReadableStream({ start(c) { c.enqueue(enc); c.close(); } });
  const resp = new Response(stream, { headers: { 'content-type': 'text/plain' } });
  const { text, truncated } = await readLimitedBody(resp, MAX_BODY_BYTES);
  assert(truncated === true, 'truncated flag');
  assert(text.length <= MAX_BODY_BYTES, 'size capped');
});

// 12b. редирект — mismatch, а не unavailable
await run('redirect is mismatch', async () => {
  const { observations } = await collect(testReg(), {
    fetchFn: async () => ({ httpStatus: 308, contentType: null, body: '', location: '/' }),
    sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
  });
  const h = observations.find((o) => o.checkId === 'mainnet-node-1:pub-info');
  assert(h.status === 'mismatch' && /redirect/.test(h.error), 'redirect: ' + JSON.stringify(h));
  // caps-проба с редиректом (/index → /) — ok с пометкой redirect, а не находка
  const reg2 = testReg();
  reg2.components[0].routes = [{ host: 'agentcoin.work', method: 'GET', path: '/info', owner: true, note: 'pin' }];
  const capsR = JSON.stringify({ ok: true, get: ['/info', '/index'] });
  const { observations: o3 } = await collect(reg2, {
    fetchFn: async (url) => {
      if (url.endsWith('/capabilities')) return { httpStatus: 200, contentType: 'application/json', body: capsR };
      if (url.endsWith('/index')) return { httpStatus: 308, contentType: null, body: '', location: '/' };
      return { httpStatus: 200, contentType: 'application/json', body: INFO_OK };
    },
    sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
  });
  const idx = o3.find((o) => o.checkId === 'mainnet-node-1:caps-probe-index');
  assert(idx && idx.status === 'ok' && idx.observedValue.redirect === true, 'caps redirect ok: ' + JSON.stringify(idx));
});

// 13. цепочка raw→collect→diff: /queue/history и /gateway/list проверяются
await run('end to end caps chain', async () => {
  const capsRaw = JSON.stringify({ ok: true, get: ['/info', '/queue/history', '/gateway/list'] });
  const fetchFn = async (url) => {
    if (url.endsWith('/capabilities')) return { httpStatus: 200, contentType: 'application/json', body: capsRaw };
    return { httpStatus: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) };
  };
  const reg = testReg();
  reg.components[0].routes = [{ host: 'agentcoin.work', method: 'GET', path: '/info', owner: true, note: 'pin' }];
  // подменяем INFO на generic ok для caps-probe путей не-/info: здесь упрощённо требуем object
  const { observations } = await collect(reg, { fetchFn: async (url) => {
    if (url.endsWith('/capabilities')) return { httpStatus: 200, contentType: 'application/json', body: capsRaw };
    if (url.endsWith('/info')) return { httpStatus: 200, contentType: 'application/json', body: INFO_OK };
    return { httpStatus: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) };
  }, sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true });
  const d = diff(reg, observations);
  assert(observations.some((o) => o.checkId.includes('queue-history')), 'queue/history observed in chain');
  assert(observations.some((o) => o.checkId.includes('gateway-list')), 'gateway/list observed in chain');
  assert(d.rows.length > 0, 'diff rows');
});

// 14. план только из реестра
await run('plan from registry only', async () => {
  const plan = buildPlan(testReg());
  assert(plan.length > 0, 'non-empty plan');
  const sshTargets = new Set(plan.filter((p) => p.via === 'ssh').map((p) => p.ssh.host));
  assert(sshTargets.size === 1 && sshTargets.has('10.0.0.1'), 'hosts from registry, got ' + [...sshTargets]);
});

let fail = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' :: ' + r.sample}`); if (!r.ok) fail++; }
if (fail) { console.log(`NET SELFTEST FAIL ${fail}/${results.length}`); process.exit(1); }
console.log(`NET SELFTEST OK ${results.length}/${results.length}`);
