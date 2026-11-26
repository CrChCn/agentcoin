// Offline acceptance: public pages select a node explicitly; installation and
// monitoring never inherit the project operator's personal topology.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-address-'));
let passed = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); passed++; }

function browser(page, saved = {}) {
  const html = read('site/' + page + '.html');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach(source => new vm.Script(source));
  const script = scripts.find(s => s.includes('const LS'));
  const prefix = page === 'dashboard' ? script.slice(0, script.indexOf('function esc(s)')) : script.slice(0, script.indexOf('const CABLS'));
  const requests = [], elements = new Map();
  const context = vm.createContext({
    URL, AbortSignal, location: new URL('https://visitor-node.example'),
    localStorage: {getItem:key => saved[key] ?? null, setItem:(key,value) => saved[key] = value},
    document: {getElementById:id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); }},
    alert:message => { throw new Error(message); },
    fetch:async (url, options) => { requests.push({url, options}); return {ok:false, status:503}; }
  });
  vm.runInContext(prefix, context);
  return {context, requests};
}

try {
  for (const page of ['dashboard', 'terminal']) {
    await test(page + ': same-origin default ignores old implicit failover storage', async () => {
      const {context, requests} = browser(page, {'agt-dash-host':'http://legacy.example', 'agt-term-host':'http://legacy.example'});
      assert.equal(vm.runInContext('API', context), 'https://visitor-node.example');
      await assert.rejects(vm.runInContext("j('/tx', {method:'POST', body:'{}'})", context), /HTTP 503/);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://visitor-node.example/tx');
      assert.equal(requests[0].options.method, 'POST');
    });
    await test(page + ': explicit choice only and unsafe URL rejection', async () => {
      const key = page === 'dashboard' ? 'agt-dash-node-v2' : 'agt-term-node-v2';
      const {context, requests} = browser(page, {[key]:'https://chosen-node.example/'});
      assert.equal(vm.runInContext('API', context), 'https://chosen-node.example');
      await assert.rejects(vm.runInContext("j('/info')", context), /HTTP 503/);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://chosen-node.example/info');
      for (const bad of ['javascript:alert(1)', 'https://user:pass@example.org', 'https://example.org/path', 'https://example.org/?x=1', 'https://example.org/#x']) {
        assert.throws(() => vm.runInContext('nodeOrigin(' + JSON.stringify(bad) + ')', context));
      }
      assert.equal(vm.runInContext("nodeOrigin('http://127.0.0.1:9888/')", context), 'http://127.0.0.1:9888');
    });
  }

  await test('all changed HTML inline scripts parse and preserve same-origin navigation', () => {
    for (const page of ['dashboard', 'terminal', 'index']) {
      const html = read('site/' + page + '.html');
      for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
      assert(!html.includes('fixLinks('));
      assert(!html.includes('const CANDS'));
    }
    assert(read('site/dashboard.html').includes("j('/network/nodes')"));
    // index.html — экспорт Next-фронтенда (отдельный стек), публичный вход показывают
    // его клиентские чанки. В самой странице не должно быть зашитой топологии оператора
    // и его локального API — иначе гость ходил бы на чужую ноду.
    const index = read('site/index.html');
    assert.doesNotMatch(index, /(?:node\d|agentcoin)\.agentcoin\.work/i, 'operator node leaked into index.html');
    assert.doesNotMatch(index, /127\.0\.0\.1:9335/, 'operator loopback endpoint leaked into index.html');
  });

  const deploy = read('scripts/deploy-vps.sh');
  const hostValidator = path.join(root, 'scripts', 'validate-site-host.sh');
  await test('deployment validates the site hostname before any system mutation', () => {
    // SITE пишется в AGT_PUBLIC_URL и в Caddyfile: мусор там = сломанный конфиг ноды.
    for (const bad of ['', 'http://node4.agentcoin.work', 'node4.agentcoin.work/path', 'u:p@node4.example', 'node 4.example', 'node4', '-node.example', 'node_4.example', 'node4\t.example', 'node4.example:443', 'node4.example.']) {
      const result = spawnSync('bash', [hostValidator, bad], {encoding:'utf8'});
      assert.notEqual(result.status, 0, JSON.stringify(bad));
    }
    for (const good of ['node4.agentcoin.work', 'Node5.Example.COM']) {
      const result = spawnSync('bash', [hostValidator, good], {encoding:'utf8'});
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, good.toLowerCase());
    }
    const at = deploy.indexOf('validate-site-host.sh');
    assert(at > 0, 'deploy must call the hostname validator');
    assert(at < deploy.indexOf('apt-get update'));
    assert(at < deploy.indexOf('tar xzf'));
    assert(at < deploy.indexOf('} > /etc/agentcoin-node.env'));
  });

  await test('empty seed list writes no peer entry, explicit seeds are joined', () => {
    // Аналог прежнего bootstrap-контракта: пустой список не должен превращаться в
    // пустую запись AGT_SEED_NODES, а явные сиды — попадать в env файла ноды.
    const anchor = deploy.indexOf('AGT_DATA_DIR=${DATA_DIR}');
    assert(anchor > 0, 'env block not found');
    const block = deploy.slice(deploy.lastIndexOf('{', anchor), deploy.indexOf('} > /etc/agentcoin-node.env', anchor) + 1);
    const runEnv = seeds => spawnSync('bash', ['-c', 'set -euo pipefail\n' + block], {
      encoding:'utf8',
      env:{...process.env, DATA_DIR:'/opt/agentcoin-node/data', INSTALL_DIR:'/opt/agentcoin-node', SITE:'node4.example', SEEDS:seeds}
    });
    const empty = runEnv('');
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout.includes('AGT_SEED_NODES'), false);
    const two = runEnv('https://a.example https://b.example');
    assert.equal(two.status, 0, two.stderr);
    assert.match(two.stdout, /AGT_SEED_NODES=https:\/\/a\.example,https:\/\/b\.example/);
  });

  for (const name of ['steward.mjs', 'moltbook-daily-report.mjs']) {
    await test(name + ': monitoring defaults only to own node, honors explicit targets', () => {
      const source = read(name);
      const start = source.indexOf('function loadNodeTargets()');
      const end = source.indexOf('\nconst ', start);
      const code = source.slice(start, end);
      function getTargets(env) {
        const context = vm.createContext({process:{env}, fs, URL});
        return JSON.parse(JSON.stringify(vm.runInContext(code + '\nloadNodeTargets()', context)));
      }
      assert.deepEqual(getTargets({}), [['own-node', 'http://127.0.0.1:9335']]);
      assert.deepEqual(getTargets({AGT_API:'https://my-node.example/'}), [['own-node', 'https://my-node.example']]);
      const config = path.join(tmp, 'targets.json');
      fs.writeFileSync(config, JSON.stringify([{name:'daughter', url:'https://daughter.example'}]));
      assert.deepEqual(getTargets({AGT_MONITOR_TARGETS_FILE:config}), [['daughter','https://daughter.example']]);
      fs.writeFileSync(config, JSON.stringify([{name:'bad', url:'https://user:pass@example.org'}]));
      assert.throws(() => getTargets({AGT_MONITOR_TARGETS_FILE:config}));
      fs.writeFileSync(config, '[]');
      assert.throws(() => getTargets({AGT_MONITOR_TARGETS_FILE:config}));
    });
  }

  await test('legacy onboarding rejects seed upload before network access', () => {
    const result = spawnSync(process.execPath, ['join-network.mjs','onboard','--recover','synthetic test words','--url','https://unreachable.invalid'],
      {cwd:root, encoding:'utf8', timeout:3000});
    assert.equal(result.status, 1);
    assert(result.stderr.includes('--recover удалён'));
    assert(!read('join-network.mjs').includes("'/wallet/recover'"));
  });

  console.log(`${passed}/${passed} address-configuration checks passed`);
} finally { fs.rmSync(tmp, {recursive:true, force:true}); }
