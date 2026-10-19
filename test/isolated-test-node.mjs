import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, access, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment, stageIsolatedSource } from '../tools/isolated-test-node.mjs';
const repository = fileURLToPath(new URL('../', import.meta.url));
async function run(file, args = [], env = {}) {
  const child = spawn(process.execPath, [file, ...args], { cwd: repository, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  try { const [code] = await once(child, 'exit'); return { code, output }; } finally { clearTimeout(timer); }
}
test('environment allowlist removes inherited administrative and runtime injection settings', () => {
  assert.deepEqual(isolatedEnvironment({ PATH: '/bin', AGT_ADMIN_TOKEN: 'secret', AGT_DATA_DIR: '/production', NODE_OPTIONS: '--import=evil', HTTP_PROXY: 'http://evil', GH_TOKEN: 'secret' }), { PATH: '/bin' });
});
test('every legacy mutation test rejects supplied targets and army before any network', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const file of ['soak-test.mjs', 'test/accept-AGIP-2.mjs', 'test/accept-AGIP-3.mjs', 'test/cabinet-cancel.mjs', 'test/accept-AGIP-4.mjs']) {
    const result = await run(file, [url, '--army'], { AGT_ADMIN_TOKEN: 'must-not-send', AGT_DATA_DIR: '/must-not-touch' });
    assert.notEqual(result.code, 0, file); assert.match(result.output, /External targets and --army are disabled/);
  }
  assert.equal(requests, 0);
});
test('noargs starts an owned fresh node, sanitizes worker environment and removes data after exit', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'agt-isolation-probe-'));
  try {
    const script = path.join(temp, 'probe.mjs');
    await writeFile(script, `import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { isolatedLegacyTarget } from ${JSON.stringify(new URL('../tools/isolated-test-node.mjs', import.meta.url).href)};
const url = await isolatedLegacyTarget(import.meta.url);
assert.match(process.env.AGT_ADMIN_TOKEN, /^[0-9a-f]{64}$/);
assert.notEqual(process.env.AGT_ADMIN_TOKEN, 'production-token');
assert.equal(process.env.AGT_SPORE, '0');
assert.equal(process.env.AGT_SECRET_PROBE, undefined);
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.AGT_SITE_SYNC, '0');
assert.equal(process.env.AGT_PEER_DISCOVERY, '0');
const info = await (await fetch(url + '/info')).json();
assert.equal(info.blocks, 1);
const w = await (await fetch(url + '/wallet/create', {method:'POST', headers:{'content-type':'application/json'},body:'{"label":"synthetic-isolation-test"}'})).json();
assert.match(w.address, /^AGT[0-9a-f]{40}$/);
console.log('FIXTURE_ROOT=' + process.cwd());
process.exit(0);
`);
    const result = await run(script, [], { AGT_ADMIN_TOKEN: 'production-token', AGT_SECRET_PROBE: 'secret', GH_TOKEN: 'secret', AGT_DATA_DIR: '/production', AGT_BIND: '0.0.0.0' });
    assert.equal(result.code, 0, result.output);
    const root = result.output.match(/FIXTURE_ROOT=(.+)/)?.[1]; assert.ok(root);
    await assert.rejects(access(root), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('source staging excludes synthetic operator token, passports, spore and operational data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agt-source-isolation-'));
  try {
    const source = path.join(root, 'source'), staged = path.join(root, 'staged');
    await mkdir(path.join(source, 'data-agtx'), { recursive: true });
    await mkdir(path.join(source, 'data-agents'));
    await writeFile(path.join(source, 'data-agtx', 'admin-token.txt'), 'SYNTHETIC-OPERATOR-TOKEN');
    await writeFile(path.join(source, 'data-agents', 'passports.json'), '["SYNTHETIC-OPERATOR-PASSPORT"]');
    await writeFile(path.join(source, 'node.mjs'), `import { helper } from './helper.mjs'; if (false) await import('./spore.mjs');`);
    await writeFile(path.join(source, 'helper.mjs'), 'export const helper = 1;');
    await writeFile(path.join(source, 'spore.mjs'), 'throw Error("must not copy optional local code");');
    await writeFile(path.join(source, 'bip39-english.txt'), 'public-wordlist');
    await stageIsolatedSource(source, staged);
    assert.deepEqual((await readdir(staged)).sort(), ['bip39-english.txt', 'helper.mjs', 'node.mjs']);
    await assert.rejects(access(path.join(staged, 'data-agtx', 'admin-token.txt')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(staged, 'data-agents', 'passports.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
