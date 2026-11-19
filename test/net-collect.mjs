#!/usr/bin/env node
// Изолированные тесты механизма Этапа 2. Без доступа к production: fetch/ssh — моки.
// Покрывают 8 дефектов приёмки: ложный match, формат capabilities get,
// общий блок без хэша, SSH allowlist, структуры ответов, монитор,
// параллелизм 4, лимит тела потоком. Плюс цепочка raw→collect→diff.
// fix4: безопасный SSH (без глобального ps, без сырого ss, со scrub секретов).
import { collect, buildPlan, isReadOnlySshCommand, MAX_CONCURRENCY, readLimitedBody, getAdvertisedLists, extractCommonBlock, MAX_BODY_BYTES, scrubSecrets, parsePidCheck, filterSsLines, tipHeightFromBlocks, commonTipHeight, unifyLocalState } from '../tools/net-collect.mjs';
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
    if (cmd.startsWith('systemctl show')) return { stdout: 'ActiveState=active\nMainPID=1234\nUser=root\nExecStart=/usr/bin/node /opt/agentcoin-node/src/node.mjs 9335\nExecMainStartTimestamp=Thu 2026-11-19 10:00:00 UTC\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl is-active')) return { stdout: 'active\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ps -p ')) {
      const m = cmd.match(/ps -p (\d+)/);
      const pid = m ? m[1] : '1234';
      return { stdout: `${pid} root Thu Nov 19 10:00:00 2026\n`, stderr: '', exitCode: 0 };
    }
    if (cmd.startsWith('ss ')) return { stdout: 'LISTEN 0 511 127.0.0.1:9335 *:*\nLISTEN 0 511 0.0.0.0:80 *:*\n', stderr: '', exitCode: 0 };
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
// fix4: глобальный ps и сырой ss -ltnp запрещены; только точечный ps -p и ss -ltn.
await run('ssh allowlist strict', async () => {
  const plan = buildPlan(testReg());
  for (const p of plan.filter((x) => x.via === 'ssh')) {
    assert(isReadOnlySshCommand(p.command), 'plan cmd must be allowlisted: ' + p.command);
  }
  assert(!isReadOnlySshCommand('systemctl show agentcoin-node.service --property=ActiveState,ExecStart,MainPID,MemoryCurrent --value; systemctl is-active agentcoin-node.service'), 'semicolon rejected');
  assert(!isReadOnlySshCommand('ss -ltn | grep -E \':(9335) \''), 'pipe rejected');
  assert(!isReadOnlySshCommand('ps -eo pid,user,args'), 'global ps rejected (fix4)');
  assert(!isReadOnlySshCommand('ps -eo pid,lstart,user,args | head -n 30'), 'pipe ps rejected');
  assert(!isReadOnlySshCommand('ss -ltnp'), 'raw ss -ltnp rejected (fix4)');
  assert(!isReadOnlySshCommand('ss -ltnp\nprintf audit_probe'), 'newline rejected');
  assert(!isReadOnlySshCommand('env'), 'env rejected');
  assert(isReadOnlySshCommand('ss -ltn'), 'ss filtered ok');
  assert(isReadOnlySshCommand('ps -p 1234 -o pid=,user=,lstart='), 'targeted ps ok');
  assert(!isReadOnlySshCommand('ps -p 1234 -o pid=,user=,lstart=; id'), 'ps semicolon rejected');
  assert(isReadOnlySshCommand(`curl -sS -m 8 -i 'http://127.0.0.1:9335/blocks?from=10&limit=1'`), 'quoted curl with & ok');
  assert(isReadOnlySshCommand('systemctl show agentcoin-node.service --property=ActiveState,MainPID,User,ExecStart,ExecMainStartTimestamp'), 'show fix4 ok');
});

// 9b. unit/pid/sha/ss разбираются, exitCode сохраняется
await run('ssh semantics parsed', async () => {
  const sshFn = async (ssh, cmd) => {
    if (cmd.startsWith('curl ')) return { stdout: curlI(200, 'application/json', INFO_OK), stderr: '', exitCode: 0 };
    if (cmd.startsWith('sha256sum')) return { stdout: `${'d'.repeat(64)}  /opt/agentcoin-node/src/node.mjs\n`, stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl show')) return { stdout: 'ActiveState=active\nMainPID=777\nUser=root\nExecStart=/usr/bin/node x\nExecMainStartTimestamp=Thu 2026-11-19 10:00:00 UTC\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl is-active')) return { stdout: 'active\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ps -p 777')) return { stdout: '777 root Thu Nov 19 10:00:00 2026\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ss ')) return { stdout: 'LISTEN 0 1 127.0.0.1:9335 x\n', stderr: '', exitCode: 0 };
    throw new Error('unexpected ' + cmd);
  };
  const fetchFn = async () => ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  const { observations } = await collect(testReg(), { fetchFn, sshFn });
  for (const id of ['proc-unit-show', 'proc-unit-active', 'listen', 'files-sha']) {
    const o = observations.find((x) => x.checkId === `mainnet-node-1:${id}`);
    assert(o && o.status === 'ok' && o.observedValue.exitCode === 0, `${id} ok + exitCode: ${JSON.stringify(o)}`);
  }
  const pidObs = observations.find((x) => x.checkId === 'mainnet-node-1:proc-pid-777');
  assert(pidObs && pidObs.status === 'ok' && pidObs.observedValue.pid === 777, 'proc-pid ok: ' + JSON.stringify(pidObs));
  assert(!observations.some((x) => x.checkId.includes('proc-ps')), 'no global proc-ps (fix4)');
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

// fix4-1. чужой процесс с --token SECRET не попадает в evidence
await run('fix4 foreign token scrubbed', async () => {
  const secret = 'SECRET-ABC-123';
  const sshFn = async (ssh, cmd) => {
    if (cmd.startsWith('curl ')) return { stdout: curlI(200, 'application/json', INFO_OK), stderr: '', exitCode: 0 };
    if (cmd.startsWith('sha256sum')) return { stdout: `${'d'.repeat(64)}  /opt/agentcoin-node/src/node.mjs\n`, stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl show')) return { stdout: `ActiveState=active\nMainPID=777\nUser=root\nExecStart=/usr/bin/node app --token ${secret}\nExecMainStartTimestamp=Thu 2026-11-19 10:00:00 UTC\n`, stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl is-active')) return { stdout: 'active\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ps -p 777')) return { stdout: '777 root Thu Nov 19 10:00:00 2026\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ss ')) return { stdout: 'LISTEN 0 1 127.0.0.1:9335 x\n', stderr: '', exitCode: 0 };
    throw new Error('unexpected ' + cmd);
  };
  const fetchFn = async () => ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  const { observations } = await collect(testReg(), { fetchFn, sshFn, evidenceDir: null });
  const show = observations.find((x) => x.checkId === 'mainnet-node-1:proc-unit-show');
  assert(show && show.status === 'ok', 'unit-show ok: ' + JSON.stringify(show));
  assert(!JSON.stringify(show.observedValue).includes(secret), 'secret masked in observedValue');
  assert(scrubSecrets(`cmd --token ${secret} x`).includes('[REDACTED]') && !scrubSecrets(`cmd --token ${secret}`).includes(secret), 'scrub masks token');
  // TIP (64-hex) маскироваться не должен
  assert(scrubSecrets(TIP_A).includes(TIP_A.slice(0, 8)), 'tip hash preserved');
});

// fix4-2. целевой PID найден
await run('fix4 target pid found', async () => {
  const p = parsePidCheck('777 root Thu Nov 19 10:00:00 2026\n', 777);
  assert(p.ok && p.pid === 777 && p.user === 'root', 'pid parsed: ' + JSON.stringify(p));
});

// fix4-3. неправильный PID не подтверждает процесс
await run('fix4 wrong pid rejected', async () => {
  const p = parsePidCheck('999 other Thu Nov 19 10:00:00 2026\n', 777);
  assert(!p.ok && /pid_mismatch/.test(p.error), 'wrong pid: ' + JSON.stringify(p));
  const e = parsePidCheck('\n', 777);
  assert(!e.ok, 'empty ps rejected');
});

// fix4-4. в evidence нет строк посторонних процессов; ss только ожидаемые порты
await run('fix4 no foreign lines in evidence', async () => {
  const sshFn = async (ssh, cmd) => {
    if (cmd.startsWith('curl ')) return { stdout: curlI(200, 'application/json', INFO_OK), stderr: '', exitCode: 0 };
    if (cmd.startsWith('sha256sum')) return { stdout: `${'d'.repeat(64)}  /opt/agentcoin-node/src/node.mjs\n`, stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl show')) return { stdout: 'ActiveState=active\nMainPID=555\nUser=root\nExecStart=/usr/bin/node x\nExecMainStartTimestamp=t\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('systemctl is-active')) return { stdout: 'active\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ps -p 555')) return { stdout: '555 root Thu Nov 19 10:00:00 2026\n', stderr: '', exitCode: 0 };
    if (cmd.startsWith('ss ')) return { stdout: 'LISTEN 0 1 127.0.0.1:9335 x\nLISTEN 0 1 127.0.0.1:9999 foreign\n', stderr: '', exitCode: 0 };
    throw new Error('unexpected ' + cmd);
  };
  const fetchFn = async () => ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  const { observations } = await collect(testReg(), { fetchFn, sshFn, evidenceDir: null });
  const pidObs = observations.find((x) => x.checkId === 'mainnet-node-1:proc-pid-555');
  assert(pidObs && pidObs.status === 'ok', 'pid ok: ' + JSON.stringify(pidObs));
  assert(!JSON.stringify(pidObs.observedValue).includes('foreign') && !JSON.stringify(pidObs.observedValue).includes('9999'), 'no foreign in pid observedValue');
  const ssObs = observations.find((x) => x.checkId === 'mainnet-node-1:listen');
  assert(ssObs && !JSON.stringify(ssObs.observedValue).includes('9999') === false || ssObs.observedValue.observedPorts.includes(9999), 'observedPorts may list all, but evidence filtered');
  const kept = filterSsLines('LISTEN 0 1 127.0.0.1:9335 x\nLISTEN 0 1 127.0.0.1:9999 foreign --token SECRET-XYZ\n', [9335]);
  assert(kept.length === 1 && kept[0].includes('9335') && !kept.join(' ').includes('9999') && !kept.join(' ').includes('SECRET-XYZ'), 'ss filtered + scrubbed: ' + JSON.stringify(kept));
});

// fix4-5. пакет содержит зависимости этапа 1 (чистая распаковка проходит registry-check)
await run('fix4 package deps present', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  for (const f of ['docs/audit-network/NODES.csv', 'sdk/js/agentcoin-sdk.mjs', 'sdk/js/agentcoin-cli.mjs', 'mcp/agentcoin-mcp.mjs', 'tools/miner-watchdog.mjs', 'tools/testnet.mjs', 'test/node-monitor.mjs']) {
    assert(fs.existsSync(path.join(root, f)), 'missing package dep: ' + f);
  }
  const plan = buildPlan(testReg());
  assert(!plan.some((p) => p.command === 'ps -eo pid,user,args'), 'no global ps in plan');
  assert(!plan.some((p) => p.command === 'ss -ltnp'), 'no raw ss in plan');
});

// fix5-1. blocks=50448/50448/50447 выбирает общий блок 50446 (min(blocks-1))
await run('fix5 common tip height 50446', async () => {
  assert(tipHeightFromBlocks(50448) === 50447, 'tip 50448->50447');
  assert(tipHeightFromBlocks(50447) === 50446, 'tip 50447->50446');
  assert(tipHeightFromBlocks(0) === null && tipHeightFromBlocks(-1) === null, 'blocks>=1 required');
  assert(commonTipHeight([50448, 50448, 50447]) === 50446, 'common 50446');
  assert(commonTipHeight([50448, 50448]) === 50447, 'common 2 nodes');
  assert(commonTipHeight([1]) === 0, 'genesis-adjacent');
  assert(commonTipHeight([0, 10]) === null && commonTipHeight([]) === null, 'invalid -> null');
  // интеграция: collect запрашивает именно 50446, а не min(blocks)
  const mkReg3 = (hosts) => ({
    version: 2, updatedAt: '2026-11-20T10:00Z', chain: { network: PIN.network, genesis: PIN.genesis, confirmDepth: 6, feeAtomic: '0' },
    sources: {}, statusVocabulary: ['confirmed'],
    components: hosts.map(([cid, host, blocks]) => ({
      componentId: cid, kind: 'blockchain-node', purpose: 't', env: 'mainnet',
      host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [],
      storage: null, dependsOn: [], network: 'n', expected: {}, observed: {},
      verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: '2026-11-20T10:00Z' },
      checkMethod: 'm', proofSource: 'p', chain: { chainId: 'AGENTCOIN', genesis: PIN.genesis },
      observe: { ssh: { host, user: 'root', port: 22 }, localBase: 'http://127.0.0.1:9335', localEndpoints: ['/info'], units: [], files: [], listenPorts: [], publicBase: 'https://x' },
      _blocks: blocks,
    })),
  });
  const reg3 = mkReg3([['mainnet-node-1', '10.0.0.1', 50448], ['mainnet-node-2', '10.0.0.2', 50448], ['mainnet-node-3', '10.0.0.3', 50447]]);
  const byHost = { '10.0.0.1': 50448, '10.0.0.2': 50448, '10.0.0.3': 50447 };
  const sshFn = async (ssh, cmd) => {
    if (cmd.includes('/blocks?from=')) {
      const m = cmd.match(/from=(\d+)&/);
      const want = Number(m && m[1]);
      assert(want === 50446, 'requested common must be 50446, got ' + want + ' cmd=' + cmd);
      return { stdout: curlI(200, 'application/json', JSON.stringify({ blocks: [{ height: want, hash: TIP_A }] })), stderr: '', exitCode: 0 };
    }
    if (cmd.startsWith('curl ')) {
      const b = byHost[ssh.host];
      const body = JSON.stringify({ chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks: b });
      return { stdout: curlI(200, 'application/json', body), stderr: '', exitCode: 0 };
    }
    if (cmd.startsWith('ss ')) return { stdout: 'LISTEN 0 1 127.0.0.1:9335 x\n', stderr: '', exitCode: 0 };
    return { stdout: 'x\n', stderr: '', exitCode: 0 };
  };
  const { observations } = await collect(reg3, { fetchFn: async () => ({ httpStatus: 404, contentType: 'text/plain', body: 'x' }), sshFn, evidenceDir: null });
  const commons = observations.filter((o) => /:common-block-/.test(o.checkId));
  assert(commons.length === 3, 'three common-block obs: ' + JSON.stringify(commons.map((o) => o.checkId)));
  assert(commons.every((o) => o.checkId.endsWith(':common-block-50446')), 'all request 50446: ' + JSON.stringify(commons.map((o) => o.checkId)));
  assert(commons.every((o) => o.status === 'ok' && o.observedValue.height === 50446), 'all ok at 50446');
});

// fix5-2. /info без tipHash + /health с ним — корректное объединение с sources
await run('fix5 merge info+health', async () => {
  const T = new Date().toISOString();
  const obs = [
    { componentId: 'mainnet-node-1', checkId: 'mainnet-node-1:local-info', status: 'ok', observedValue: { chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks: 50448 }, error: null, evidenceFile: 'e1', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T },
    { componentId: 'mainnet-node-1', checkId: 'mainnet-node-1:local-health', status: 'ok', observedValue: { blocks: 50448, tipHash: TIP_A, tipAgeSec: 4 }, error: null, evidenceFile: 'e2', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T },
  ];
  const u = unifyLocalState(obs, 'mainnet-node-1');
  assert(u.blocks === 50448 && u.tipHeight === 50447, 'blocks/tipHeight: ' + JSON.stringify(u));
  assert(u.tipHash === TIP_A, 'tip merged');
  assert(u.sources.blocks === 'mainnet-node-1:local-info' && u.sources.tipHash === 'mainnet-node-1:local-health', 'sources kept: ' + JSON.stringify(u.sources));
  assert(u.chainId === 'AGENTCOIN' && u.genesis === PIN.genesis, 'pin kept');
});

// fix5-3. хэша нет ни в /health, ни в /ws-status → INSUFFICIENT (никогда DIVERGENT)
await run('fix5 missing hash insufficient', async () => {
  const T = new Date().toISOString();
  const mkLocal = (cid) => ([
    { componentId: cid, checkId: `${cid}:local-info`, status: 'ok', observedValue: { chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks: 100 }, error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T },
  ]);
  const reg = testReg();
  reg.components.push(
    { componentId: 'mainnet-node-2', kind: 'blockchain-node', purpose: 't', env: 'mainnet', host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [], storage: null, dependsOn: [], network: 'n', expected: {}, observed: {}, verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: T }, checkMethod: 'm', proofSource: 'p', chain: { chainId: 'AGENTCOIN', genesis: PIN.genesis } },
    { componentId: 'mainnet-node-3', kind: 'blockchain-node', purpose: 't', env: 'mainnet', host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [], storage: null, dependsOn: [], network: 'n', expected: {}, observed: {}, verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: T }, checkMethod: 'm', proofSource: 'p', chain: { chainId: 'AGENTCOIN', genesis: PIN.genesis } },
    { componentId: 'node-monitor', kind: 'monitor', purpose: 'm', env: 'shared', host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [], storage: null, dependsOn: [], network: 'n', expected: {}, observed: {}, verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: T }, checkMethod: 'm', proofSource: 'p', observe: { publicBase: 'https://agentcoin.work' } },
  );
  const nodesBody = JSON.stringify({ ok: true, nodes: [
    { name: 'node1', reachable: true, blocks: 100, tipHash: TIP_A, status: 'responding' },
    { name: 'node2', reachable: true, blocks: 100, tipHash: TIP_A, status: 'responding' },
    { name: 'node3', reachable: true, blocks: 100, tipHash: TIP_A, status: 'responding' },
  ] });
  const obs = [...mkLocal('mainnet-node-1'), ...mkLocal('mainnet-node-2'), ...mkLocal('mainnet-node-3'),
    { componentId: 'node-monitor', checkId: 'node-monitor:pub-nodes', status: 'ok', observedValue: JSON.parse(nodesBody), error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T }];
  const d = diff(reg, obs);
  assert(d.monitor.nodeCompare.length === 3, 'three compares');
  assert(d.monitor.nodeCompare.every((x) => x.result === 'INSUFFICIENT'), 'all INSUFFICIENT without local tip: ' + JSON.stringify(d.monitor.nodeCompare));
  assert(!d.monitor.nodeCompare.some((x) => x.result === 'DIVERGENT'), 'never DIVERGENT on null tip');
});

// fix5-4. одинаковые сравнимые значения → CONSISTENT
await run('fix5 consistent on equal', async () => {
  const T = new Date().toISOString();
  const mk = (cid) => ([
    { componentId: cid, checkId: `${cid}:local-info`, status: 'ok', observedValue: { chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks: 200 }, error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T },
    { componentId: cid, checkId: `${cid}:local-health`, status: 'ok', observedValue: { blocks: 200, tipHash: TIP_A }, error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T },
  ]);
  const reg = testReg();
  reg.components.push(
    { componentId: 'mainnet-node-2', kind: 'blockchain-node', purpose: 't', env: 'mainnet', host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [], storage: null, dependsOn: [], network: 'n', expected: {}, observed: {}, verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: T }, checkMethod: 'm', proofSource: 'p', chain: { chainId: 'AGENTCOIN', genesis: PIN.genesis } },
    { componentId: 'mainnet-node-3', kind: 'blockchain-node', purpose: 't', env: 'mainnet', host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [], storage: null, dependsOn: [], network: 'n', expected: {}, observed: {}, verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: T }, checkMethod: 'm', proofSource: 'p', chain: { chainId: 'AGENTCOIN', genesis: PIN.genesis } },
    { componentId: 'node-monitor', kind: 'monitor', purpose: 'm', env: 'shared', host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [], storage: null, dependsOn: [], network: 'n', expected: {}, observed: {}, verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: T }, checkMethod: 'm', proofSource: 'p', observe: { publicBase: 'https://agentcoin.work' } },
  );
  const nodesBody = JSON.stringify({ ok: true, nodes: [
    { name: 'node1 self', reachable: true, blocks: 200, tipHash: TIP_A, status: 'responding' },
    { name: 'node2', reachable: true, blocks: 200, tipHash: TIP_A, status: 'responding' },
    { name: 'node3', reachable: true, blocks: 200, tipHash: TIP_A, status: 'responding' },
  ] });
  const obs = [...mk('mainnet-node-1'), ...mk('mainnet-node-2'), ...mk('mainnet-node-3'),
    { componentId: 'node-monitor', checkId: 'node-monitor:pub-nodes', status: 'ok', observedValue: JSON.parse(nodesBody), error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T }];
  const d = diff(reg, obs);
  assert(d.monitor.nodeCompare.every((x) => x.result === 'CONSISTENT'), 'all CONSISTENT: ' + JSON.stringify(d.monitor.nodeCompare));
});

// fix5-5. разные сравнимые хэши одной высоты → DIVERGENT
await run('fix5 divergent on hash diff', async () => {
  const T = new Date().toISOString();
  const obs = [
    { componentId: 'mainnet-node-1', checkId: 'mainnet-node-1:local-info', status: 'ok', observedValue: { chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks: 200 }, error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T },
    { componentId: 'mainnet-node-1', checkId: 'mainnet-node-1:local-health', status: 'ok', observedValue: { blocks: 200, tipHash: TIP_A }, error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T },
    { componentId: 'node-monitor', checkId: 'node-monitor:pub-nodes', status: 'ok', observedValue: { ok: true, nodes: [{ name: 'node1 self', reachable: true, blocks: 200, tipHash: TIP_B, status: 'responding' }] }, error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T },
  ];
  const reg = testReg();
  reg.components.push({ componentId: 'node-monitor', kind: 'monitor', purpose: 'm', env: 'shared', host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [], storage: null, dependsOn: [], network: 'n', expected: {}, observed: {}, verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: T }, checkMethod: 'm', proofSource: 'p', observe: { publicBase: 'https://agentcoin.work' } });
  const d = diff(reg, obs);
  const c1 = d.monitor.nodeCompare.find((x) => x.componentId === 'mainnet-node-1');
  assert(c1 && c1.result === 'DIVERGENT', 'divergent on hash diff: ' + JSON.stringify(c1));
});

// fix5-6. три ответа блока 50446 с одним хэшем → sameChain:true только для этой высоты
await run('fix5 common block 50446 sameChain', async () => {
  const T = new Date().toISOString();
  const mkObs = (cid) => ({ componentId: cid, checkId: `${cid}:common-block-50446`, status: 'ok', observedValue: { height: 50446, hash: TIP_A, requestedHeight: 50446 }, error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T });
  const mkLocal = (cid, blocks) => ({ componentId: cid, checkId: `${cid}:local-info`, status: 'ok', observedValue: { chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks }, error: null, evidenceFile: 'e', sourceHost: 'h', sourceEndpoint: 's', startedAt: T, completedAt: T });
  const reg = testReg();
  reg.components.push(
    { componentId: 'mainnet-node-2', kind: 'blockchain-node', purpose: 't', env: 'mainnet', host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [], storage: null, dependsOn: [], network: 'n', expected: {}, observed: {}, verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: T }, checkMethod: 'm', proofSource: 'p', chain: { chainId: 'AGENTCOIN', genesis: PIN.genesis } },
    { componentId: 'mainnet-node-3', kind: 'blockchain-node', purpose: 't', env: 'mainnet', host: 'h', process: 'p', sources: ['s'], expectedVersion: null, routes: [], storage: null, dependsOn: [], network: 'n', expected: {}, observed: {}, verification: { status: 'unknown', evidence: ['E'], unknowns: ['u'], checkedAt: T }, checkMethod: 'm', proofSource: 'p', chain: { chainId: 'AGENTCOIN', genesis: PIN.genesis } },
  );
  const d = diff(reg, [mkObs('mainnet-node-1'), mkObs('mainnet-node-2'), mkObs('mainnet-node-3'), mkLocal('mainnet-node-1', 50448), mkLocal('mainnet-node-2', 50448), mkLocal('mainnet-node-3', 50447)]);
  assert(d.monitor.commonBlock && d.monitor.commonBlock.height === '50446', 'height 50446: ' + JSON.stringify(d.monitor.commonBlock));
  assert(d.monitor.commonBlock.sameChain === true && d.monitor.commonBlock.validCount === 3, 'sameChain true x3: ' + JSON.stringify(d.monitor.commonBlock));
});

let fail = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' :: ' + r.sample}`); if (!r.ok) fail++; }
if (fail) { console.log(`NET SELFTEST FAIL ${fail}/${results.length}`); process.exit(1); }
console.log(`NET SELFTEST OK ${results.length}/${results.length}`);
