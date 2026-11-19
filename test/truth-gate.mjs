#!/usr/bin/env node
// test/truth-gate.mjs — сценарии Truth Gate без сети и production.
// Каждый кейс мутирует фикстуру и проверяет конкретный код/вердикт, а не «любой провал».
import fs from 'node:fs';
import { evaluateGate, renderMarkdown } from '../tools/truth-gate.mjs';

const policy = JSON.parse(fs.readFileSync(new URL('../config/truth-gate-policy.json', import.meta.url), 'utf8'));
const GENESIS = '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e';
const H = (n) => String(n).padStart(2, '0').repeat(32);
const clone = (x) => JSON.parse(JSON.stringify(x));

function makeRegistry() {
  const ids = [
    'mainnet-node-1', 'mainnet-node-2', 'mainnet-node-3', 'miner-stack', 'caddy-h1', 'caddy-reserve',
    'site-static', 'web-next', 'agent-room', 'settlement-gateway', 'queue-orders-catalog', 'node-monitor',
    'env-mainnet', 'env-testnet', 'env-jobtest', 'env-staging', 'sdk-js', 'cli', 'mcp', 'api-gateway-pilot',
  ];
  return {
    version: 'test', updatedAt: '2026-11-19T00:00Z', sources: ['fixture'], statusVocabulary: ['ok'],
    chain: { network: 'AGENTCOIN', genesis: GENESIS, confirmDepth: 6, feeAtomic: '0' },
    components: ids.map((id) => ({ componentId: id, env: id.startsWith('env-') ? id.slice(4) : 'mainnet', routes: [], expected: {}, observed: {} })),
  };
}

const O = (componentId, checkId, observedValue = {}, extra = {}) => ({
  componentId, checkId, sourceHost: 'fixture', sourceEndpoint: 'fixture',
  startedAt: '2026-11-19T00:00:00.000Z', completedAt: '2026-11-19T00:00:01.000Z',
  status: 'ok', observedValue, evidenceFile: `evidence/${checkId.replace(/[^a-zA-Z0-9]+/g, '-')}.json`, error: null, ...extra,
});

function makeObservations(blocks = 1000) {
  const mh = blocks - 1;
  const obs = [
    O('mainnet-node-1', 'mainnet-node-1:local-info', { chainId: 'AGENTCOIN', genesisHash: GENESIS, blocks }),
    O('mainnet-node-1', 'mainnet-node-1:local-health', { blocks, tipHash: H(0x11), chainId: 'AGENTCOIN' }),
    O('mainnet-node-1', 'mainnet-node-1:proc-unit-show', { ActiveState: 'active', MainPID: '1' }),
    O('mainnet-node-1', 'mainnet-node-1:caps', { advertisedReads: ['/info', '/health'], advertisedCount: 2 }),
    O('mainnet-node-1', `mainnet-node-1:monitor-block-${mh}`, { requestedHeight: mh, height: mh, hash: H(0x11) }),
    O('mainnet-node-1', 'mainnet-node-1:pub-info', { httpStatus: 200 }),
    O('mainnet-node-2', 'mainnet-node-2:local-info', { chainId: 'AGENTCOIN', genesisHash: GENESIS, blocks }),
    O('mainnet-node-2', 'mainnet-node-2:proc-unit-show', { ActiveState: 'active', MainPID: '2' }),
    O('mainnet-node-2', `mainnet-node-2:monitor-block-${mh}`, { requestedHeight: mh, height: mh, hash: H(0x11) }),
    O('mainnet-node-3', 'mainnet-node-3:local-info', { chainId: 'AGENTCOIN', genesisHash: GENESIS, blocks }),
    O('mainnet-node-3', 'mainnet-node-3:proc-unit-show', { ActiveState: 'active', MainPID: '3' }),
    O('mainnet-node-3', `mainnet-node-3:monitor-block-${mh}`, { requestedHeight: mh, height: mh, hash: H(0x11) }),
    O('node-monitor', 'node-monitor:pub-nodes', { nodes: [{ name: 'Эта нода', blocks, tipHash: H(0x11) }] }),
    O('miner-stack', 'miner-stack:units', { unitCount: 3, units: ['agentcoin-miner.service', 'agentcoin-watchdog.service'], minerLike: ['agentcoin-miner.service', 'agentcoin-watchdog.service'] }),
    O('miner-stack', 'miner-stack:timers', { timers: [], heartbeat: true }),
    O('miner-stack', 'miner-stack:cron', { lineCount: 2, minerJobs: ['*/10 * * * * /opt/agentcoin-node/mine-cron.sh'], watchdogJobs: ['*/5 * * * * /opt/agentcoin-node/watchdog.sh'], lines: [] }),
    O('miner-stack', 'miner-stack:miner-unit', { unit: 'agentcoin-miner.service', activeState: 'active', mainPid: 10, intervalSec: 60, addresses: ['AGT' + '1'.repeat(40)] }),
    O('miner-stack', 'miner-stack:watchdog-unit', { unit: 'agentcoin-watchdog.service', activeState: 'active', mainPid: 11, watchTarget: '/opt/agentcoin-sups/watchdog-svc.mjs' }),
    O('miner-stack', 'miner-stack:recent-blocks', { from: blocks - 3, to: blocks - 1, count: 3, uniqueCount: 2, uniqueProducers: ['AGT' + '1'.repeat(40), 'AGT' + '2'.repeat(40)], producers: [] }),
    O('miner-stack', 'miner-stack:schedule', { expected: 'cron */10 + unit 60s', observed: { cronMine: true, minerUnitActive: true }, missing: [] }),
    O('caddy-h1', 'caddy-h1:config-node1', { host: '2.31.145.160', sha256: H(1), sites: [] }),
    O('caddy-h1', 'caddy-h1:map', { host: '2.31.145.160', configSha: H(1), routeCount: 3, conflicts: [], routes: [] }),
    O('caddy-h1', 'caddy-h1:guard-scan', { findings: [], blockerCount: 0, warnCount: 0 }),
    O('caddy-h1', 'caddy-h1:order', { catchAllShadows: [] }),
    O('caddy-reserve', 'caddy-reserve:config-node2', { host: '91.99.191.236', sha256: H(2), sites: [] }),
    O('caddy-reserve', 'caddy-reserve:config-node3', { host: '64.225.104.125', sha256: H(3), sites: [] }),
    O('site-static', 'site-static:page-root', { path: '/', module: 'imperial-home', httpStatus: 200, finalUrl: 'https://agentcoin.work/', contentType: 'text/html', sha256: H(0xaa), bytes: 100, title: 'AGENTCOIN', h1: 'Империя', navHash: 'aaa', releaseMarker: 'site-v3', html: true, h1s: ['Империя'] }),
    O('site-static', 'site-static:page-imperial', { path: '/imperial', module: 'imperial-home', httpStatus: 200, finalUrl: 'https://agentcoin.work/imperial', contentType: 'text/html', sha256: H(0xaa), bytes: 100, title: 'AGENTCOIN', h1: 'Империя', navHash: 'aaa', releaseMarker: 'site-v3', html: true, h1s: ['Империя'] }),
    O('site-static', 'site-static:pages-summary', { pageCount: 2, duplicates: [{ sha256: H(0xaa), paths: ['/', '/imperial'], rootDuplicated: true, sameTitle: true, sameH1: true }], shell: {}, rootDuplicate: { sha256: H(0xaa), paths: ['/', '/imperial'] } }),
    O('agent-room', 'agent-room:page-agent-room', { path: '/agent-room', httpStatus: 200, sha256: H(0xbb), html: true, title: 'Agent Room' }),
    O('web-next', 'web-next:pub-jobs', { httpStatus: 200 }),
    O('queue-orders-catalog', 'queue-orders-catalog:pub-queue-status', { httpStatus: 200 }),
    O('settlement-gateway', 'settlement-gateway:route-bare', { path: '/mainnet/settlements', httpStatus: 404, errorCode: 'not_found', classification: 'PARAM_REQUIRED' }),
    O('settlement-gateway', 'settlement-gateway:route-param', { path: '/mainnet/settlements/:orderId/status', httpStatus: 404, errorCode: 'settlement_not_found', classification: 'PARAM_REQUIRED', routeExists: true }),
    O('settlement-gateway', 'settlement-gateway:source-sha', { files: [], contractPinned: true }),
    O('env-mainnet', 'env-mainnet:env-unit', { unit: 'agentcoin-node.service', activeState: 'active', mainPid: 100, user: 'root', environmentFiles: '/etc/agentcoin-node.env' }),
    O('env-mainnet', 'env-mainnet:env-chain', { port: 9335, chainId: 'AGENTCOIN', genesis: GENESIS, blocks }),
    O('env-mainnet', 'env-mainnet:env-data', { cwd: '/', dataDir: '/opt/agentcoin-node/data', dirs: [{ path: '/opt/agentcoin-node/data', user: 'root', mode: '700' }], dataDirSource: 'allowlisted env DATA_DIR' }),
    O('env-mainnet', 'env-mainnet:chain-pin', { pin: { chainId: 'AGENTCOIN', genesis: GENESIS }, seen: [{ componentId: 'mainnet-node-1', chainId: 'AGENTCOIN', genesis: GENESIS, blocks }], missing: [], allMatch: true }),
    O('env-testnet', 'env-testnet:env-unit', { unit: 'agentcoin-staging-node.service', activeState: 'active', mainPid: 101, user: 'agt-staging' }),
    O('env-testnet', 'env-testnet:env-chain', { port: 19335, chainId: 'AGT_TESTNET', genesis: H(0xc1), blocks: 1 }),
    O('env-testnet', 'env-testnet:env-data', { cwd: '/opt/agentcoin-staging/releases/x', dataDir: '/opt/agentcoin-staging/data', dirs: [] }),
    O('env-testnet', 'env-testnet:env-route', { publicRoutes: [], mutationRoutes: [], count: 0 }),
    O('env-jobtest', 'env-jobtest:env-unit', { unit: 'agentcoin-autonomous-job-test-node.service', activeState: 'active', mainPid: 102, user: 'agt-job-test' }),
    O('env-jobtest', 'env-jobtest:env-chain', { port: 19336, chainId: 'AGENTCOIN_JOB_TEST', genesis: H(0xc2), blocks: 13 }),
    O('env-jobtest', 'env-jobtest:env-data', { cwd: '/opt/agentcoin-job-test/releases/y', dataDir: '/opt/agentcoin-job-test/data', dirs: [] }),
    O('env-staging', 'env-staging:env-unit', { unit: 'agentcoin-staging-api.service', activeState: 'active', mainPid: 103, user: 'agt-staging' }),
    O('env-staging', 'env-staging:env-chain', { port: 19443, chainId: 'AGT_TESTNET', genesis: H(0xc1), blocks: 1 }),
    O('env-staging', 'env-staging:env-data', { cwd: '/opt/agentcoin-staging/releases/x', dataDir: '/opt/agentcoin-staging/data-api', dirs: [] }),
    O('sdk-js', 'sdk-js:files', { files: [{ path: 'sdk/js/agentcoin-sdk.mjs', exists: true, syntax: 'ok' }] }),
    O('sdk-js', 'sdk-js:semantics', { found: [], missing: [] }),
    O('cli', 'cli:files', { files: [{ exists: true, syntax: 'ok' }] }),
    O('cli', 'cli:semantics', { found: [], missing: [] }),
    O('mcp', 'mcp:files', { files: [{ exists: true, syntax: 'ok' }] }),
    O('mcp', 'mcp:semantics', { found: [], missing: [] }),
    O('api-gateway-pilot', 'api-gateway-pilot:offline', { exitCode: 0 }),
    O('security', 'security:secret-scan', { scannedFiles: 1, findings: [] }),
    O('security', 'security:mutation-not-called', { mutationCalls: [], checked: 10 }),
  ];
  return obs;
}

const diffClean = { monitor: { proxySuspect: false, nodeCompare: [
  { componentId: 'mainnet-node-1', result: 'CONSISTENT', proofHeight: 999 },
  { componentId: 'mainnet-node-2', result: 'CONSISTENT', proofHeight: 999 },
  { componentId: 'mainnet-node-3', result: 'CONSISTENT', proofHeight: 999 },
] } };

function base() {
  return { registry: makeRegistry(), observations: makeObservations(), diff: clone(diffClean), policy: clone(policy) };
}
function byId(obs, id) { return obs.find((o) => o.checkId === id); }
function run(input) { return evaluateGate(input); }
function codes(res) { return res.blockers.map((b) => b.code); }

const results = [];
function check(name, fn, expect) {
  let res;
  let err = null;
  try { res = fn(); } catch (e) { err = String((e && e.stack) || e); }
  let ok = false;
  let sample = '';
  if (err) { sample = 'THREW: ' + err.split('\n')[0]; }
  else if (expect(res)) { ok = true; sample = `${res.verdict} blockers=${res.blockers.length}`; }
  else { sample = `${res.verdict} blockers=[${codes(res).join(',')}] warnings=[${res.warnings.map((w) => w.code).join(',')}]`; }
  results.push({ name, ok, sample });
}

// 1. Здоровая система → PASS (фикстура без двойника главной)
check('healthy system → PASS', () => {
  const i = base();
  const sum = byId(i.observations, 'site-static:pages-summary');
  sum.observedValue = { pageCount: 2, duplicates: [], shell: {}, rootDuplicate: null };
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  return run(i);
}, (r) => r.verdict === 'PASS' && r.blockers.length === 0);

// 2. Одинаковая история трёх нод → PASS
check('three nodes same history → PASS', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.diff.monitor.nodeCompare = ['mainnet-node-1', 'mainnet-node-2', 'mainnet-node-3'].map((c) => ({ componentId: c, result: 'CONSISTENT', proofHeight: 999 }));
  return run(i);
}, (r) => r.verdict === 'PASS');

// 3. Транзиентный лаг → WARN, не BLOCKED
check('transient lag → WARN', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.diff.monitor.nodeCompare = [{ componentId: 'mainnet-node-2', result: 'LAGGING', localTipHeight: 998, monitorTipHeight: 999 }];
  return run(i);
}, (r) => r.verdict === 'WARN' && !codes(r).includes('SAME_HEIGHT_FORK') && r.warnings.some((w) => w.code === 'LAGGING'));

// 4. Same-height fork → BLOCKED
check('same-height fork → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  byId(i.observations, 'mainnet-node-3:monitor-block-999').observedValue.hash = H(0x99);
  i.diff.monitor.nodeCompare[2].result = 'DIVERGENT';
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('SAME_HEIGHT_FORK'));

// 5. chainId/genesis mismatch → BLOCKED
check('chain pin mismatch → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const o = byId(i.observations, 'mainnet-node-2:local-info');
  o.status = 'mismatch'; o.error = 'chain_pin_mismatch: genesis != registry pin';
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('CHAIN_PIN_MISMATCH'));

// 6. Общий DATA_DIR → BLOCKED
check('shared writable DATA_DIR → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  byId(i.observations, 'env-testnet:env-data').observedValue.dataDir = '/opt/agentcoin-node/data';
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('SHARED_WRITABLE_DATA_DIR'));

// 7. Конфликт владельцев маршрута → BLOCKED
check('duplicate route owner → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  byId(i.observations, 'caddy-h1:map').observedValue.conflicts = [{ host: 'agentcoin.work', path: '/', methods: ['GET'], first: { owner: 'site-static', target: '/srv/x' }, second: { owner: 'web-next', target: '127.0.0.1:3000' } }];
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('ROUTE_OWNER_CONFLICT'));

// 8. Двойная главная → BLOCKED
check('duplicate root product → BLOCKED', () => run(base()),
  (r) => r.verdict === 'BLOCKED' && codes(r).includes('DUPLICATE_ROOT_PRODUCT'));

// 9. Capability ghost → WARN
check('capability ghost → WARN', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.observations.push(O('mainnet-node-1', 'mainnet-node-1:caps-probe-ghost', { httpStatus: 404 }, { status: 'mismatch', error: 'http_404_on_advertised_route' }));
  return run(i);
}, (r) => r.verdict === 'WARN' && !codes(r).includes('CAPABILITY_GHOST'));

// 10. Mutation-route без защиты → BLOCKED
check('unproven mutation route → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  byId(i.observations, 'caddy-h1:guard-scan').observedValue.findings = [{ host: ['agentcoin.work'], methods: ['POST'], paths: ['/cabinet/op-submit'], upstream: 'https://node1.agentcoin.work', guard: [], severity: 'BLOCKED', code: 'UNPROVEN_MUTATION_ROUTE' }];
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('UNPROVEN_MUTATION_ROUTE'));

// 11. Offline expected → не блокирует
check('offline expected does not block', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.observations = i.observations.filter((o) => o.componentId !== 'api-gateway-pilot');
  const r = run(i);
  return { ...r, __status: r.coverage.components['api-gateway-pilot'].status };
}, (r) => r.verdict !== 'BLOCKED' && r.__status === 'OFFLINE_EXPECTED');

// 12. Необоснованный not_checked → BLOCKED
check('unjustified not_checked → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.observations.push(O('cli', 'cli:not-checked', null, { status: 'not_checked', error: 'skipped because tired' }));
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('UNJUSTIFIED_NOT_CHECKED'));

// 13. Timeout не превращается в форк
check('timeout is not a fork', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'mainnet-node-3:monitor-block-999').status = 'unavailable';
  byId(i.observations, 'mainnet-node-3:monitor-block-999').error = 'http_timeout';
  i.diff.monitor.nodeCompare[2] = { componentId: 'mainnet-node-3', result: 'INSUFFICIENT', reason: 'probe unavailable: http_timeout' };
  return run(i);
}, (r) => !codes(r).includes('SAME_HEIGHT_FORK') && r.warnings.some((w) => w.code === 'TIMEOUT_OR_UNAVAILABLE'));

// 14. Отсутствующий evidence → BLOCKED
check('missing evidence → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  byId(i.observations, 'mainnet-node-1:local-info').evidenceFile = null;
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('MISSING_EVIDENCE'));

// 15. Повреждённый вход → BLOCKED
check('corrupt registry → BLOCKED', () => {
  const i = base();
  i.registry = { components: 'broken' };
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('CORRUPT_INPUT'));

// 16. Параметризованный маршрут → PARAM_REQUIRED, не mismatch
check('param route → PARAM_REQUIRED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const r = run(i);
  const o = byId(i.observations, 'settlement-gateway:route-bare');
  return { ...r, __cls: o.observedValue.classification, __status: r.coverage.components['settlement-gateway'].status };
}, (r) => r.__cls === 'PARAM_REQUIRED' && r.__status === 'PASS' && !r.blockers.some((b) => b.code === 'SETTLEMENT_CONTRACT_BROKEN'));

// 17. Catch-all перекрывает модуль → BLOCKED
check('catch-all shadows module → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const o = byId(i.observations, 'caddy-h1:order');
  o.status = 'mismatch'; o.error = 'catch_all_shadows_module: [{"module":"/agent-room"}]';
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('CATCH_ALL_SHADOWS_MODULE'));

// 18. testnet пишет в mainnet → BLOCKED
check('test host writes to mainnet → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  byId(i.observations, 'caddy-h1:guard-scan').observedValue.findings = [{ host: ['api-staging.agentcoin.work'], methods: ['POST'], paths: ['/cabinet/login'], upstream: 'http://127.0.0.1:9335', guard: [], severity: 'BLOCKED', code: 'TEST_MUTATION_TO_MAINNET' }];
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('TEST_MUTATION_TO_MAINNET'));

// 19. Секрет в evidence → BLOCKED
check('secret in evidence → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const s = byId(i.observations, 'security:secret-scan');
  s.status = 'mismatch'; s.error = 'secret_in_evidence: 1';
  s.observedValue = { scannedFiles: 1, findings: [{ file: 'evidence/x.txt', pattern: 'private-key-block' }] };
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('SECRET_IN_EVIDENCE'));

// 20. Детерминированная повторная генерация
check('deterministic regeneration', () => run(base()), (r) => {
  const a = JSON.stringify(r);
  const b = JSON.stringify(run(base()));
  return a === b && renderMarkdown(r, { policyVersion: 'x' }) === renderMarkdown(run(base()), { policyVersion: 'x' });
});

// 21. Монитор выдаёт чужую ноду → BLOCKED
check('monitor impersonation → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.diff.monitor.proxySuspect = true;
  i.diff.monitor.proxyNote = 'node2 entry repeats node1 tip while local differs';
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('MONITOR_IMPERSONATION'));

// 22. Критический компонент без наблюдения → BLOCKED
check('critical component unwatched → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.observations = i.observations.filter((o) => o.componentId !== 'env-staging');
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('CRITICAL_COMPONENT_UNWATCHED'));

// 23. Сломанный settlement-контракт → BLOCKED
check('settlement contract broken → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const o = byId(i.observations, 'settlement-gateway:route-param');
  o.status = 'mismatch'; o.error = 'settlement_contract_unproven: http_404 not_found';
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('SETTLEMENT_CONTRACT_BROKEN'));

// 24. Вызов mutation-route → BLOCKED
check('mutation route called → BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const m = byId(i.observations, 'security:mutation-not-called');
  m.status = 'mismatch'; m.error = 'mutation_called: x';
  m.observedValue = { mutationCalls: [{ checkId: 'x', reason: 'post' }], checked: 1 };
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('MUTATION_ROUTE_CALLED'));

// 25. NOT_APPLICABLE — статус, а не not_checked
check('not applicable component', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.policy.notApplicable = ['api-gateway-pilot'];
  i.observations = i.observations.filter((o) => o.componentId !== 'api-gateway-pilot');
  const r = run(i);
  return { ...r, __status: r.coverage.components['api-gateway-pilot'].status };
}, (r) => r.__status === 'NOT_APPLICABLE' && r.verdict !== 'BLOCKED');

// 26. Одинаковая высота, один хэш — без DIVERGENT и без форка
check('same height same hash → no fork', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  return run(i);
}, (r) => !codes(r).includes('SAME_HEIGHT_FORK'));

// 27. LAGGING не даёт DIVERGENT-блокера даже при разных вершинах
check('lagging differing tips is not a fork', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.observations = i.observations.filter((o) => o.checkId !== 'mainnet-node-2:monitor-block-999');
  i.diff.monitor.nodeCompare = [
    { componentId: 'mainnet-node-1', result: 'CONSISTENT', proofHeight: 999 },
    { componentId: 'mainnet-node-2', result: 'LAGGING', localTipHeight: 995, monitorTipHeight: 999 },
    { componentId: 'mainnet-node-3', result: 'ADVANCED', proofHeight: 999 },
  ];
  return run(i);
}, (r) => !codes(r).includes('SAME_HEIGHT_FORK') && r.warnings.some((w) => w.code === 'LAGGING'));

// 28. UNKNOWN не скрывается: пустое наблюдение компонента видно в покрытии
check('unknown is visible, not hidden', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  i.observations = i.observations.filter((o) => o.componentId !== 'mcp');
  const r = run(i);
  return { ...r, __status: r.coverage.components.mcp.status, __unknown: r.unknowns.some((u) => u.componentId === 'mcp') };
}, (r) => r.__status === 'UNKNOWN' && r.__unknown);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} — ${r.sample}`);
const failed = results.filter((r) => !r.ok);
console.log(`\nTRUTH GATE SELFTEST ${failed.length ? 'FAIL' : 'OK'} ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
