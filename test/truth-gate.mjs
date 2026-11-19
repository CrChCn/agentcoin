#!/usr/bin/env node
// test/truth-gate.mjs — сценарии Truth Gate без сети и production.
// Каждый кейс мутирует фикстуру и проверяет конкретный код/вердикт, а не «любой провал».
import fs from 'node:fs';
import { evaluateGate, renderMarkdown } from '../tools/truth-gate.mjs';
import { parseCaddyfile, scanMutationGuards, summarizeAdaptedJson } from '../tools/gate-collect.mjs';

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
    O('miner-stack', 'miner-stack:schedule', { expected: 'cron */10 + unit 60s', observed: { cronMine: true, minerUnitActive: true }, missing: [], operatorsIndependent: 'UNKNOWN: one miner service with N rotation addresses counts as one operator' }),
    O('miner-stack', 'miner-stack:operators', { minerServices: ['agentcoin-miner.service'], serviceCount: 1, uniqueAddresses: ['AGT' + '1'.repeat(40), 'AGT' + '2'.repeat(40)], addressCount: 2, singleService: true, operatorsIndependent: 'UNKNOWN: one miner service with N rotation addresses counts as one operator' }),
    O('caddy-h1', 'caddy-h1:config-node1', { host: '2.31.145.160', sha256: H(1), sites: [] }),
    O('caddy-h1', 'caddy-h1:map', { host: '2.31.145.160', configSha: H(1), routeCount: 3, overlapGroups: [], ambiguousCount: 0, routes: [] }),
    O('caddy-h1', 'caddy-h1:guard-scan', { findings: [], blockerCount: 0, warnCount: 0 }),
    O('caddy-h1', 'caddy-h1:order', { catchAllShadows: [] }),
    O('caddy-h1', 'caddy-h1:adapted', { sha256: H(9), servers: ['srv0'], routeCount: 0, overlapOrder: [], redactedKeys: 0 }),
    O('caddy-reserve', 'caddy-reserve:config-node2', { host: '91.99.191.236', sha256: H(2), sites: [] }),
    O('caddy-reserve', 'caddy-reserve:config-node3', { host: '64.225.104.125', sha256: H(3), sites: [] }),
    O('site-static', 'site-static:page-root', { path: '/', module: 'imperial-home', httpStatus: 200, finalUrl: 'https://agentcoin.work/', contentType: 'text/html', sha256: H(0xaa), bytes: 100, title: 'AGENTCOIN', h1: 'Империя', navHash: 'aaa', releaseMarker: 'site-v3', html: true, h1s: ['Империя'], shellScript: ['/panel.js'], stylesheet: [], canonical: null, networkIdentityRefs: 7, agentRoomEntry: false, apiErrorDisplay: true, languageSwitch: true }),
    O('site-static', 'site-static:page-imperial', { path: '/imperial', module: 'imperial-home', httpStatus: 200, finalUrl: 'https://agentcoin.work/imperial', contentType: 'text/html', sha256: H(0xaa), bytes: 100, title: 'AGENTCOIN', h1: 'Империя', navHash: 'aaa', releaseMarker: 'site-v3', html: true, h1s: ['Империя'], shellScript: ['/panel.js'], stylesheet: [], canonical: null, networkIdentityRefs: 7, agentRoomEntry: false, apiErrorDisplay: true, languageSwitch: true }),
    O('site-static', 'site-static:pages-summary', { pageCount: 3, duplicates: [{ sha256: H(0xaa), paths: ['/', '/imperial'], rootDuplicated: true, sameTitle: true, sameH1: true }], shell: {}, rootDuplicate: { sha256: H(0xaa), paths: ['/', '/imperial'] }, shellConsistent: true, releaseMarkerAbsent: [], shellProfiles: [
      { path: '/', shellScript: ['/panel.js'], stylesheet: [], navHash: 'aaa', releaseMarker: 'site-v3', networkIdentityRefs: 7, agentRoomEntry: false, apiErrorDisplay: true, languageSwitch: true, title: 'AGENTCOIN', h1: 'Империя' },
      { path: '/imperial', shellScript: ['/panel.js'], stylesheet: [], navHash: 'aaa', releaseMarker: 'site-v3', networkIdentityRefs: 7, agentRoomEntry: false, apiErrorDisplay: true, languageSwitch: true, title: 'AGENTCOIN', h1: 'Империя' },
      { path: '/agent-room', shellScript: ['/panel.js'], stylesheet: [], navHash: 'aaa', releaseMarker: 'site-v3', networkIdentityRefs: 1, agentRoomEntry: true, apiErrorDisplay: false, languageSwitch: false, title: 'Agent Room', h1: 'Agent Room' },
    ] }),
    O('agent-room', 'agent-room:page-agent-room', { path: '/agent-room', httpStatus: 200, sha256: H(0xbb), html: true, title: 'Agent Room', shellScript: ['/panel.js'], stylesheet: [], releaseMarker: 'site-v3' }),
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

// 7. Детерминированное пересечение деклараций → WARN ROUTE_PATTERN_OVERLAP, не BLOCKED.
// Порядок Caddy однозначен (строка 35 раньше 44): исполняется mainnet-node-1,
// env-staging — тень. Блокер ROUTE_OWNER_CONFLICT — только при неоднозначности.
check('deterministic route overlap → WARN, not BLOCKED', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  byId(i.observations, 'caddy-h1:map').observedValue.overlapGroups = [{
    host: 'api-staging.agentcoin.work', publicPath: '/working/txproof/*', internalPath: '/txproof/*', methods: ['GET'],
    matchingHandlers: [
      { owner: 'mainnet-node-1', target: 'http://127.0.0.1:9335', line: 35, matcher: '@owner_session_read', kind: 'handle', inRoute: false },
      { owner: 'env-staging', target: '127.0.0.1:29335', line: 44, matcher: '@public_reads', kind: 'handle', inRoute: false },
    ],
    handlerOrder: [35, 44], effectiveOwner: 'mainnet-node-1', effectiveTarget: 'http://127.0.0.1:9335',
    fallbackOwner: 'env-staging', fallbackTarget: '127.0.0.1:29335', ambiguous: false,
    reason: 'Caddy executes most specific first, ties by file order: line 35 wins',
  }];
  return run(i);
}, (r) => r.verdict === 'WARN' && r.warnings.some((w) => w.code === 'ROUTE_PATTERN_OVERLAP') && !codes(r).includes('ROUTE_OWNER_CONFLICT'));

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

// 29. operatorsIndependent=UNKNOWN присутствует в unknowns со своим кодом
check('operatorsIndependent=UNKNOWN is visible in unknowns', () => run(base()),
  (r) => r.unknowns.some((u) => u.code === 'MINER_OPERATOR_INDEPENDENCE_UNKNOWN' && u.componentId === 'miner-stack'));

// 30. Семь адресов одного miner service не становятся независимыми операторами
check('seven addresses of one miner service prove no independence', () => {
  const i = base();
  const ops = byId(i.observations, 'miner-stack:operators');
  ops.observedValue.uniqueAddresses = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
  ops.observedValue.addressCount = 7;
  ops.observedValue.singleService = true;
  const r = run(i);
  return { ...r, __single: ops.observedValue.singleService };
}, (r) => r.unknowns.some((u) => u.code === 'MINER_OPERATOR_INDEPENDENCE_UNKNOWN') && r.__single === true);

// 31. Разные shell-маркеры страниц → SITE_SHELL_INCONSISTENT (BLOCKED)
check('different shell markers → SITE_SHELL_INCONSISTENT', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const sum = byId(i.observations, 'site-static:pages-summary');
  sum.observedValue.shellProfiles = [
    { path: '/', shellScript: ['/panel.js'], stylesheet: [], releaseMarker: 'site-v3' },
    { path: '/agent-room', shellScript: ['/agent-room.js'], stylesheet: ['/ecosphere/styles.css'], releaseMarker: 'site-v3' },
  ];
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('SITE_SHELL_INCONSISTENT'));

// 32. Одинаковый shell на всех страницах → PASS (без shell-блокера)
check('same shell everywhere → PASS', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  return run(i);
}, (r) => r.verdict === 'PASS' && !codes(r).includes('SITE_SHELL_INCONSISTENT'));

// 33. Отсутствующий release-маркер → WARN, не BLOCKED
check('missing release marker → WARN', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const sum = byId(i.observations, 'site-static:pages-summary');
  sum.observedValue.shellProfiles = [
    { path: '/', shellScript: ['/panel.js'], stylesheet: [], releaseMarker: 'site-v3' },
    { path: '/agent-room', shellScript: ['/panel.js'], stylesheet: [], releaseMarker: null },
  ];
  return run(i);
}, (r) => r.verdict === 'WARN' && r.warnings.some((w) => w.code === 'SITE_RELEASE_MARKER_ABSENT') && !codes(r).includes('SITE_SHELL_INCONSISTENT'));

// 34. Реальная неоднозначность порядка (route-блок + handle) → BLOCKED ROUTE_OWNER_CONFLICT
check('ambiguous route order → BLOCKED ROUTE_OWNER_CONFLICT', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  byId(i.observations, 'caddy-h1:map').observedValue.overlapGroups = [{
    host: 'agentcoin.work', publicPath: '/x/*', internalPath: '/x/*', methods: ['GET'],
    matchingHandlers: [
      { owner: 'site-static', target: '/srv/x', line: 10, matcher: '@a', kind: 'handle', inRoute: true },
      { owner: 'web-next', target: '127.0.0.1:3000', line: 20, matcher: '@b', kind: 'handle', inRoute: false },
    ],
    handlerOrder: [10, 20], effectiveOwner: 'site-static', effectiveTarget: '/srv/x',
    fallbackOwner: 'web-next', fallbackTarget: '127.0.0.1:3000', ambiguous: true,
    reason: 'mixed route-block and sorted handle: execution order not provable from file order',
  }];
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('ROUTE_OWNER_CONFLICT'));

// 35. Префикс /working сохраняется в публичном отчёте (unit: парсер + guard-scan)
check('working prefix preserved in public report', () => {
  const caddyfile = 'api-staging.agentcoin.work {\n\t@working_namespace path /working /working/*\n\thandle @working_namespace {\n\t\turi strip_prefix /working\n\t\t@owner_session_write {\n\t\t\tmethod POST\n\t\t\tpath /cabinet/login\n\t\t}\n\t\thandle @owner_session_write {\n\t\t\treverse_proxy http://127.0.0.1:9335\n\t\t}\n\t}\n}\n';
  const map = parseCaddyfile(caddyfile);
  const findings = scanMutationGuards(map, policy, []).filter((f) => f.code === 'TEST_MUTATION_TO_MAINNET');
  const verdict = findings.length ? 'BLOCKED' : 'PASS';
  return { verdict, blockers: [], warnings: [], unknowns: [], findings };
}, (r) => r.findings.length === 1 && r.findings[0].publicPath === '/working/cabinet/login' && r.findings[0].internalPath === '/cabinet/login');

// 36. staging→mainnet mutation → BLOCKED с внешним и внутренним путём
check('staging to mainnet mutation → BLOCKED with both paths', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  byId(i.observations, 'caddy-h1:guard-scan').observedValue.findings = [{
    host: ['api-staging.agentcoin.work'], publicHost: 'api-staging.agentcoin.work', methods: ['POST'],
    paths: ['/cabinet/login'], publicPaths: ['/working/cabinet/login'],
    internalPath: '/cabinet/login', publicPath: '/working/cabinet/login',
    upstream: 'http://127.0.0.1:9335', line: 13, guard: [], severity: 'BLOCKED', code: 'TEST_MUTATION_TO_MAINNET',
    testHost: true, toMainnet: true, effectiveOwner: 'mainnet-node-1',
    environmentFrom: 'staging', environmentTo: 'mainnet', applicationAuth: 'UNKNOWN', policyVerdict: 'BLOCKED',
  }];
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('TEST_MUTATION_TO_MAINNET')
  && r.blockers.some((b) => b.code === 'TEST_MUTATION_TO_MAINNET' && /\/working\/cabinet\/login/.test(b.message) && /internal \/cabinet\/login/.test(b.message)));

// 37. Auth прикладного уровня не проверена чтением → applicationAuth UNKNOWN (unit)
check('backend auth not probed → applicationAuth UNKNOWN', () => {
  const caddyfile = 'api-staging.agentcoin.work {\n\t@working_namespace path /working /working/*\n\thandle @working_namespace {\n\t\turi strip_prefix /working\n\t\t@owner_session_write {\n\t\t\tmethod POST\n\t\t\tpath /cabinet/login\n\t\t}\n\t\thandle @owner_session_write {\n\t\t\treverse_proxy http://127.0.0.1:9335\n\t\t}\n\t}\n}\n';
  const map = parseCaddyfile(caddyfile);
  const findings = scanMutationGuards(map, policy, []);
  const verdict = findings.length ? 'BLOCKED' : 'PASS';
  return { verdict, blockers: [], warnings: [], unknowns: [], findings };
}, (r) => r.findings.length === 1 && r.findings[0].applicationAuth === 'UNKNOWN');

// 38. Блокер без evidence → сам гейт становится CORRUPT_OUTPUT
check('blocker without evidence → CORRUPT_OUTPUT', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const m = byId(i.observations, 'caddy-h1:map');
  m.evidenceFile = null;
  m.observedValue.overlapGroups = [{
    host: 'agentcoin.work', publicPath: '/x/*', internalPath: '/x/*', methods: ['GET'],
    matchingHandlers: [
      { owner: 'site-static', target: '/srv/x', line: 10, matcher: '@a', kind: 'handle', inRoute: true },
      { owner: 'web-next', target: '127.0.0.1:3000', line: 20, matcher: '@b', kind: 'handle', inRoute: false },
    ],
    handlerOrder: [10, 20], effectiveOwner: 'site-static', effectiveTarget: '/srv/x',
    fallbackOwner: 'web-next', fallbackTarget: '127.0.0.1:3000', ambiguous: true,
    reason: 'mixed route-block and sorted handle',
  }];
  return run(i);
}, (r) => r.verdict === 'BLOCKED' && codes(r).includes('CORRUPT_OUTPUT'));

// 39. Повторяющиеся undocumented-маршруты дедуплицируются с handlerLines
check('repeated undocumented routes deduplicated', () => {
  const i = base();
  byId(i.observations, 'site-static:pages-summary').observedValue.rootDuplicate = null;
  byId(i.observations, 'site-static:pages-summary').observedValue.duplicates = [];
  byId(i.observations, 'site-static:page-imperial').observedValue.sha256 = H(0xab);
  byId(i.observations, 'site-static:page-imperial').observedValue.title = 'Imperial — модуль';
  const mk = (line, matcher) => ({ hosts: ['agentcoin.work'], line, matcher, methods: ['GET'], paths: ['/balance'], publicPaths: ['/balance'], kind: 'handle', upstream: 'https://node1.agentcoin.work', owner: 'mainnet-node-1' });
  byId(i.observations, 'caddy-h1:map').observedValue.routes = [mk(35, '@a'), mk(44, '@b')];
  const r = run(i);
  const u = r.warnings.filter((w) => w.code === 'UNDOCUMENTED_ROUTE');
  return { ...r, __u: u };
}, (r) => r.__u.length === 1 && /35/.test(r.__u[0].message) && /44/.test(r.__u[0].message));

// 40. Путь evidence отсутствует в пакете → BLOCKED CORRUPT_OUTPUT
check('evidence path missing from package → BLOCKED', () => {
  const i = base();
  const missing = byId(i.observations, 'site-static:pages-summary').evidenceFile;
  const manifest = i.observations.map((o) => o.evidenceFile).filter(Boolean).filter((p) => p !== missing);
  const r = evaluateGate({ registry: i.registry, observations: i.observations, diff: i.diff, policy: i.policy, evidenceFiles: manifest });
  return r;
}, (r) => r.verdict === 'BLOCKED' && r.blockers.some((b) => b.code === 'CORRUPT_OUTPUT'));

// 41. Детерминизм гейта и Markdown с манифестом пакета
check('deterministic gate with manifest', () => {
  const i = base();
  const manifest = i.observations.map((o) => o.evidenceFile).filter(Boolean);
  const a = evaluateGate({ registry: i.registry, observations: i.observations, diff: i.diff, policy: i.policy, evidenceFiles: manifest });
  const b = evaluateGate({ registry: clone(i).registry, observations: clone(i).observations, diff: clone(i).diff, policy: clone(i).policy, evidenceFiles: manifest.slice() });
  const eq = JSON.stringify(a) === JSON.stringify(b);
  const mdEq = renderMarkdown(a, { policyVersion: 'x' }) === renderMarkdown(b, { policyVersion: 'x' });
  return { verdict: a.verdict, blockers: a.blockers, warnings: a.warnings, unknowns: a.unknowns, __eq: eq && mdEq };
}, (r) => r.__eq === true);

// 42. summarizeAdaptedJson находит вложенные маршруты в порядке исполнения
check('adapted summary finds nested routes in execution order', () => {
  const adapted = { apps: { http: { servers: { srv0: { routes: [
    { match: [{ method: ['GET'], path: ['/working', '/working/*'] }], handle: [{ handler: 'subroute', routes: [
      { match: [{ method: ['GET'], path: ['/txproof/*', '/mempool'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:9335' }] }] },
      { match: [{ method: ['GET'], path: ['/txproof/*'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:29335' }] }] },
    ] }] },
  ] } } } } };
  const s = summarizeAdaptedJson(adapted);
  const tx = s.orderedRoutes.filter((r) => r.match.some((m) => m.includes('txproof')));
  return { verdict: 'PASS', blockers: [], warnings: [], unknowns: [], __tx: tx.map((r) => r.dials[0]) };
}, (r) => r.__tx.length === 2 && r.__tx[0] === '127.0.0.1:9335' && r.__tx[1] === '127.0.0.1:29335');

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} — ${r.sample}`);
const failed = results.filter((r) => !r.ok);
console.log(`\nTRUTH GATE SELFTEST ${failed.length ? 'FAIL' : 'OK'} ${results.length - failed.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
