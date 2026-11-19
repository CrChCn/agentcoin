#!/usr/bin/env node
// Изолированные тесты механизма Этапа 2. Без доступа к production: fetch/ssh — моки.
// Обязательные сценарии: исправный ответ; тайм-аут; 403/404/500; HTML вместо JSON;
// неверный chainId/genesis; capabilities с недоступным маршрутом; прокси node1;
// отсутствие SSH; частичный сбой; конечные тайм-ауты; ограниченный параллелизм;
// план только из реестра (без второго списка серверов); read-only команды.
import { collect, buildPlan, isReadOnlySshCommand, MAX_CONCURRENCY } from '../tools/net-collect.mjs';
import { diff } from '../tools/net-diff.mjs';

const PIN = { network: 'AGENTCOIN', genesis: '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e' };
const INFO_OK = JSON.stringify({ chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks: 50060, tipHash: 'aaa', tipAgeSec: 5 });
const HEALTH_OK = JSON.stringify({ ok: true, service: 'agt-node', blocks: 50060, tipHash: 'aaa', tipAgeSec: 5, chainValid: true });

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
const results = [];
function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((e) => results.push({ name, ok: false, sample: String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ').slice(0, 400) }));
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

// 1. исправный ответ
await run('healthy ok', async () => {
  const fetchFn = async () => ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  const sshFn = async (ssh, cmd) => {
    if (cmd.startsWith('curl ')) return { stdout: curlI(200, 'application/json', cmd.includes('/health') ? HEALTH_OK : INFO_OK), stderr: '', exitCode: 0 };
    if (cmd.startsWith('sha256sum')) return { stdout: 'abc123 ' + '/opt/agentcoin-node/src/node.mjs'.padStart(64, '0') + '\n', stderr: '', exitCode: 0 };
    return { stdout: 'active\n', stderr: '', exitCode: 0 };
  };
  const { observations } = await collect(testReg(), { fetchFn, sshFn, evidenceDir: null });
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
  assert(h.status === 'mismatch' && /json_invalid/.test(h.error), 'html must be mismatch: ' + JSON.stringify(h));
});

// 5. неверный chainId/genesis
await run('wrong pin mismatch', async () => {
  const bad = JSON.stringify({ chainId: 'OTHER', genesisHash: PIN.genesis, blocks: 1, tipHash: 'z' });
  const bad2 = JSON.stringify({ chainId: 'AGENTCOIN', genesisHash: 'f'.repeat(64), blocks: 1, tipHash: 'z' });
  for (const body of [bad, bad2]) {
    const { observations } = await collect(testReg(), {
      fetchFn: async () => ({ httpStatus: 200, contentType: 'application/json', body }),
      sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
    });
    const h = observations.find((o) => o.checkId === 'mainnet-node-1:pub-info');
    assert(h.status === 'mismatch' && /chain_pin_mismatch/.test(h.error), 'pin: ' + JSON.stringify(h));
  }
});

// 6. capabilities рекламирует недоступный маршрут
await run('caps ghost route mismatch', async () => {
  const caps = JSON.stringify({ availableReads: ['/info', '/ghost-xyz'] });
  const fetchFn = async (url) => {
    if (url.endsWith('/capabilities')) return { httpStatus: 200, contentType: 'application/json', body: caps };
    if (url.includes('/ghost-xyz')) return { httpStatus: 404, contentType: 'text/plain', body: 'not found' };
    return { httpStatus: 200, contentType: 'application/json', body: INFO_OK };
  };
  const { observations } = await collect(testReg(), { fetchFn, sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true });
  const probe = observations.find((o) => o.checkId === 'mainnet-node-1:caps-probe-ghost-xyz');
  assert(probe && probe.status === 'mismatch', 'ghost probe mismatch: ' + JSON.stringify(probe));
});

// 7. резерв возвращает проксированный ответ node1
await run('reserve proxy detected', async () => {
  const mkReg = () => {
    const r = testReg();
    r.components.push({
      componentId: 'mainnet-node-2', kind: 'blockchain-node', purpose: 't', env: 'mainnet',
      host: 'h2', process: 'p', sources: ['s'], expectedVersion: null,
      routes: [{ host: 'node2.agentcoin.work', method: 'GET', path: '/info', owner: true, note: 'dark 403 expected publicly, here 200-proxy' }],
      storage: null, dependsOn: [], network: 'n', expected: {}, observed: {},
      verification: { status: 'unknown', evidence: ['E14'], unknowns: ['u'], checkedAt: '2026-11-20T10:00Z' },
      checkMethod: 'm', proofSource: 'p', chain: { chainId: 'AGENTCOIN', genesis: PIN.genesis },
      observe: {
        ssh: { host: '10.0.0.2', user: 'root', port: 22 }, localBase: 'http://127.0.0.1:9335',
        localEndpoints: ['/info'], units: [], files: [], listenPorts: [], publicBase: 'https://node2.agentcoin.work',
      },
    });
    return r;
  };
  const n1 = JSON.stringify({ chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks: 100, tipHash: 'TIP-A' });
  const n2local = JSON.stringify({ chainId: 'AGENTCOIN', genesisHash: PIN.genesis, blocks: 95, tipHash: 'TIP-B' });
  const sshFn = async (ssh, cmd) => {
    const body = ssh.host === '10.0.0.1' ? n1 : n2local;
    if (cmd.startsWith('curl ')) return { stdout: curlI(200, 'application/json', body), stderr: '', exitCode: 0 };
    return { stdout: 'x\n', stderr: '', exitCode: 0 };
  };
  const fetchFn = async (url) => {
    // публичный ответ резерва повторяет node1
    if (url.includes('node2')) return { httpStatus: 200, contentType: 'application/json', body: n1 };
    return { httpStatus: 200, contentType: 'application/json', body: n1 };
  };
  const reg = mkReg();
  const { observations } = await collect(reg, { fetchFn, sshFn });
  const d = diff(reg, observations);
  assert(d.monitor.proxySuspect === true, 'proxy must be flagged: ' + d.monitor.conclusion.slice(0, 200));
  assert(/PROXY-LOOP/.test(d.monitor.conclusion), 'explicit PROXY-LOOP message');
});

// 8. отсутствует SSH-доступ
await run('no ssh access unavailable', async () => {
  const fetchFn = async () => ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  const sshFn = async () => { const e = new Error('connect: permission denied (publickey)'); e.code = 255; throw e; };
  const { observations } = await collect(testReg(), { fetchFn, sshFn });
  const loc = observations.find((o) => o.checkId === 'mainnet-node-1:local-info');
  assert(loc.status === 'unavailable' && /ssh/.test(loc.error), 'ssh unavailable: ' + JSON.stringify(loc));
  const pub = observations.find((o) => o.checkId === 'mainnet-node-1:pub-info');
  assert(pub.status === 'ok', 'https unaffected by ssh failure');
});

// 9. частичный сбой не уничтожает остальные
await run('partial failure isolated', async () => {
  const fetchFn = async (url) => url.includes('/health')
    ? ({ httpStatus: 500, contentType: 'text/plain', body: 'boom' })
    : ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK });
  const { observations } = await collect(testReg(), { fetchFn, sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true });
  const bad = observations.find((o) => o.checkId === 'mainnet-node-1:pub-health');
  const good = observations.find((o) => o.checkId === 'mainnet-node-1:pub-info');
  assert(bad.status === 'unavailable' && good.status === 'ok', 'isolation');
});

// 10. план только из реестра
await run('plan from registry only', async () => {
  const plan = buildPlan(testReg());
  assert(plan.length > 0, 'non-empty plan');
  const sshTargets = new Set(plan.filter((p) => p.via === 'ssh').map((p) => p.ssh.host));
  assert(sshTargets.size === 1 && sshTargets.has('10.0.0.1'), 'hosts from registry, got ' + [...sshTargets]);
  const seen = [];
  const sshFn = async (ssh) => { seen.push(ssh.host); return { stdout: 'x', stderr: '', exitCode: 0 }; };
  await collect(testReg({ observe: { ssh: { host: '192.0.2.9', user: 'root' }, localBase: 'http://127.0.0.1:9335', localEndpoints: ['/info'], units: [], files: [], listenPorts: [] } }),
    { fetchFn: async () => ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK }), sshFn });
  assert(seen.includes('192.0.2.9'), 'changed registry host is used: ' + seen);
  const emptyPlan = buildPlan({ components: [{ componentId: 'cli', kind: 'cli' }] });
  assert(emptyPlan.length === 0, 'no targets without observe/routes');
});

// 11. параллелизм ограничен, тайм-ауты конечны
await run('bounded concurrency', async () => {
  let cur = 0, max = 0;
  const fetchFn = async () => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 20)); cur--; return { httpStatus: 200, contentType: 'application/json', body: INFO_OK }; };
  const reg = testReg();
  reg.components[0].routes = Array.from({ length: 10 }, (_, i) => ({ host: 'agentcoin.work', method: 'GET', path: `/page${i}`, owner: true, note: 'static' }));
  await collect(reg, { fetchFn, sshFn: async () => ({ stdout: 'x', stderr: '', exitCode: 0 }), publicOnly: true, concurrency: 2 });
  assert(max <= 2, 'max concurrency ' + max);
  assert(MAX_CONCURRENCY === 4, 'default cap 4');
});

// 12. read-only allowlist
await run('ssh allowlist', async () => {
  assert(isReadOnlySshCommand('curl -sS -m 8 -i http://127.0.0.1:9335/info'), 'curl ok');
  assert(isReadOnlySshCommand('sha256sum /opt/agentcoin-node/src/node.mjs'), 'sha ok');
  assert(!isReadOnlySshCommand('curl -sS -m 8 -i http://127.0.0.1:9335/info; rm -rf /'), 'chain rejected');
  assert(!isReadOnlySshCommand('env'), 'env rejected');
  assert(!isReadOnlySshCommand('cat /opt/agentcoin-node/.env'), '.env rejected');
  assert(!isReadOnlySshCommand('curl -sS http://evil.example/x'), 'remote base rejected');
});

// 13. общий блок: match vs fork
await run('common block verdict', async () => {
  const reg = testReg();
  const mkObs = (cid, blocks, tip, h) => ({ componentId: cid, checkId: `${cid}:common-block-100`, status: 'ok', observedValue: { blocks: [{ height: 100, hash: h }] }, error: null, evidenceFile: 'evidence/x.json', sourceHost: 'h', sourceEndpoint: 's', startedAt: 't', completedAt: 't' });
  const d1 = diff(reg, [mkObs('mainnet-node-1', 0, 't', 'SAME'), { ...mkObs('mainnet-node-1', 0, 't', 'SAME'), checkId: 'x:common-block-100', componentId: 'mainnet-node-2' }]);
  assert(d1.monitor.commonBlock && d1.monitor.commonBlock.sameChain === true, 'same chain');
  const d2 = diff(reg, [mkObs('mainnet-node-1', 0, 't', 'H1'), { ...mkObs('mainnet-node-1', 0, 't', 'H2'), checkId: 'x:common-block-100', componentId: 'mainnet-node-2' }]);
  assert(d2.monitor.commonBlock.sameChain === false, 'fork signal');
});

// 14. голый путь с документированным 404 — not_checked, а не mismatch
await run('bare param path not_checked', async () => {
  const reg = testReg();
  reg.components[0].routes.push({ host: 'agentcoin.work', method: 'GET', path: '/api/v1/txproof', owner: true, note: 'канон с :txid; голый /txproof/xxx 404' });
  const { observations } = await collect(reg, {
    fetchFn: async () => ({ httpStatus: 404, contentType: 'application/json', body: '{}' }),
    sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
  });
  const p = observations.find((o) => o.checkId === 'mainnet-node-1:pub-api-v1-txproof');
  assert(p && p.status === 'not_checked' && /bare_path/.test(p.error), 'bare 404 not_checked: ' + JSON.stringify(p));
});

// 15. staging-only 404 на проде — ok (согласуется с областью), а не mismatch
await run('staging scope 404 ok', async () => {
  const reg = testReg({ componentId: 'queue-x', env: 'staging-only', routes: [
    { host: 'agentcoin.work', method: 'GET', path: '/catalog/offers', owner: true, note: 'assignment' },
  ] });
  const { observations } = await collect(reg, {
    fetchFn: async () => ({ httpStatus: 404, contentType: null, body: '' }),
    sshFn: async () => ({ stdout: '', stderr: '', exitCode: 1 }), publicOnly: true,
  });
  const p = observations.find((o) => o.checkId === 'queue-x:pub-catalog-offers');
  assert(p && p.status === 'ok' && /scopeConsistent/.test(JSON.stringify(p.observedValue)), 'staging 404 ok: ' + JSON.stringify(p));
});

// 16. имена evidence портативны (без ':' — иначе Windows пишет в NTFS ADS)
await run('evidence names portable', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');
  const dir = p.join(os.tmpdir(), `stage2-ev-${Date.now()}`);
  const { observations } = await collect(testReg(), {
    fetchFn: async () => ({ httpStatus: 200, contentType: 'application/json', body: INFO_OK }),
    sshFn: async (ssh, cmd) => {
      if (cmd.startsWith('curl ')) return { stdout: curlI(200, 'application/json', INFO_OK), stderr: '', exitCode: 0 };
      return { stdout: 'x\n', stderr: '', exitCode: 0 };
    },
    evidenceDir: p.join(dir, 'evidence'),
  });
  const names = observations.map((o) => o.evidenceFile).filter(Boolean);
  assert(names.length > 0, 'evidence recorded');
  assert(names.every((n) => !/[:\\]/.test(n) && n.startsWith('evidence/')), 'portable names: ' + names[0]);
  const files = fs.readdirSync(p.join(dir, 'evidence'));
  assert(files.every((f) => !/:/.test(f)), 'files on disk without ADS');
  for (const n of names) assert(fs.existsSync(p.join(dir, n)), 'evidence on disk: ' + n);
  fs.rmSync(dir, { recursive: true, force: true });
});

let fail = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' :: ' + r.sample}`); if (!r.ok) fail++; }
if (fail) { console.log(`NET SELFTEST FAIL ${fail}/${results.length}`); process.exit(1); }
console.log(`NET SELFTEST OK ${results.length}/${results.length}`);
