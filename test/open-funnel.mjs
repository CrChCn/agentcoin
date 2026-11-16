import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { stageIsolatedSource, isolatedEnvironment } from '../tools/isolated-test-node.mjs';
import { pathToFileURL } from 'node:url';
const coreUrl = () => pathToFileURL(path.join(root, 'source', 'core.mjs')).href;

let child; let root; let base;
test.before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'agt-open-funnel-'));
  const source = await stageIsolatedSource(path.resolve(import.meta.dirname, '..'), path.join(root, 'source'));
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.join(source, 'data-agents'), { recursive: true });
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(r => server.close(r));
  await writeFile(path.join(root, 'bootstrap.json'), '{"bootstrap":[]}');
  child = spawn(process.execPath, [path.join(source, 'node.mjs'), String(port)], {
    cwd: root,
    env: { ...isolatedEnvironment(), AGT_DATA_DIR: path.join(root, 'data'), AGT_BIND: '127.0.0.1', AGT_BOOTSTRAP_FILE: path.join(root, 'bootstrap.json'), AGT_ADMIN_MODE: 'local', AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' },
    stdio: 'ignore',
  });
  base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'isolated node starts');
});
test.after(async () => {
  if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
  await rm(root, { recursive: true, force: true });
});

const OUTSIDER = { 'x-forwarded-for': '203.0.113.9' }; // эмуляция внешнего запроса через прокси
const j = async (m, p, b, outsider = false) => {
  const headers = { 'content-type': 'application/json', ...(outsider ? OUTSIDER : {}) };
  const r = await fetch(base + p, { method: m, headers, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test('queue claim/done reachable publicly', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  void privateKey;
  const core = await import(coreUrl());
  const addr = core.addressFromPub(publicKey.export({ type: 'spki', format: 'pem' }));
  // честный путь чужака: /join ставит в очередь, claim берёт задачу
  const jn = await j('POST', '/join', { label: 'funnel' }, true);
  assert.equal(jn.status, 201, 'join public: ' + JSON.stringify(jn.body).slice(0, 120));
  const a2 = jn.body.address;
  const c = await j('POST', '/queue/claim', { taker: a2 }, true);
  assert.equal(c.status, 200, 'claim public: ' + JSON.stringify(c.body).slice(0, 120));
  assert.ok(typeof c.body.task === 'string' && c.body.task.length > 10, 'task issued');
  const d = await j('POST', '/queue/done', { jobId: c.body.jobId || c.body.job || 'x', summary: 'short' }, true);
  assert.equal(d.status, 200, 'done public');
  void addr;
});

test('community/send requires passport for outsiders', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const core = await import(coreUrl());
  const addr = core.addressFromPub(publicKey.export({ type: 'spki', format: 'pem' }));
  const r = await j('POST', '/community/send', { sender: addr, text: 'spam attempt' }, true);
  assert.equal(r.status, 403, 'no passport -> 403, got ' + r.status);
  assert.equal(r.body.reason, 'passport_required');
});

test('community/send works with passport', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const core = await import(coreUrl());
  const addr = core.addressFromPub(pub);
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const meta = await j('GET', '/identity/meta', null, true);
  assert.ok(meta.body.ok !== false, 'meta reachable');
  const ch = await j('POST', '/identity/challenge', { address: addr, pub, handle: 'funnel-test' }, true);
  assert.ok(ch.body.ok, 'challenge: ' + JSON.stringify(ch.body).slice(0, 120));
  const sig = crypto.sign(null, Buffer.from(ch.body.message, 'utf8'), priv).toString('hex');
  const reg = await j('POST', '/identity/register', { challengeId: ch.body.challengeId, signature: sig }, true);
  assert.ok(reg.body.ok, 'register: ' + JSON.stringify(reg.body).slice(0, 160));
  const r = await j('POST', '/community/send', { sender: addr, senderHandle: 'funnel-test', text: 'funnel test post — ignore' }, true);
  assert.equal(r.status, 201, 'send with passport: ' + JSON.stringify(r.body).slice(0, 160));
});
