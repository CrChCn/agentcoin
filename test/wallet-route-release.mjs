#!/usr/bin/env node
// P0.1: канонический /wallet отдаёт проверяемый релиз.
// Штатная сборка (корневой node.mjs in-place, свежий AGT_DATA_DIR, outbound-guard):
//   GET /wallet, /wallet.html — 200 text/html, байты == site/wallet.html (sha256),
//   Cache-Control: no-store; legacy /user-wallet-page.html жив; /cabinet не тронут;
//   site/release.json содержит wallet.html с хешем git-blob (одобренный бандл).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  await new Promise((r) => srv.close(r));
  return p;
}

test('release route: /wallet serves committed wallet.html bytes; legacy page alive; manifest pins hash', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w2r-route-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const guardPath = path.join(tmp, 'no-outbound.mjs'), blockedFile = path.join(tmp, 'outbound-attempts.txt');
  fs.writeFileSync(guardPath, `import fs from 'node:fs';\nconst deny=()=>{throw new Error('test_outbound_network_forbidden');};\nglobalThis.fetch=async()=>deny();\n`);
  const port = await freePort();
  const child = spawn(process.execPath,
    ['--import', pathToFileURL(guardPath).href, path.join(root, 'node.mjs'), String(port)],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGT_DATA_DIR: path.join(tmp, 'data'), AGT_BIND: '127.0.0.1',
        AGT_ADMIN_MODE: 'off', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0',
        AGT_IDENTITY_ROLE: 'issuer', AGT_IDENTITY_AUDIENCE: 'route-test:' + port,
        AGT_TEST_BLOCKED_FILE: blockedFile } });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    const ended = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    try { await ended; } finally { clearTimeout(force); }
  };
  t.after(stop);
  const origin = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    if (child.exitCode !== null) throw new Error('test node exited early');
    try { const r = await fetch(origin + '/life'); if (r.status === 200) up = true; }
    catch { await delay(50); }
  }
  assert.equal(up, true, 'stock node boots');

  const walletDisk = fs.readFileSync(path.join(root, 'site', 'wallet.html'));
  const walletHash = sha(walletDisk);

  const w = await fetch(origin + '/wallet', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(w.status, 200, 'GET /wallet 200');
  assert.ok((w.headers.get('content-type') || '').includes('text/html'), 'GET /wallet content-type html');
  assert.ok((w.headers.get('cache-control') || '').includes('no-store'), 'no-store');
  assert.equal(sha(Buffer.from(await w.arrayBuffer())), walletHash, 'GET /wallet bytes == site/wallet.html sha256');

  const wh = await fetch(origin + '/wallet.html', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(wh.status, 200, 'GET /wallet.html 200');
  assert.equal(sha(Buffer.from(await wh.arrayBuffer())), walletHash, '/wallet.html same release bytes');

  const legacy = await fetch(origin + '/user-wallet-page.html', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(legacy.status, 200, 'legacy /user-wallet-page.html alive');
  assert.ok((await legacy.text()).includes('Кошелёк AGENTCOIN'), 'legacy markers intact');

  const cab = await fetch(origin + '/cabinet', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(cab.status, 200, '/cabinet untouched');
  assert.ok((await cab.text()).includes('Кошелёк AGENTCOIN'), '/cabinet still legacy page');

  const fmt = await fetch(origin + '/wallet-format.js', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(fmt.status, 200, '/wallet-format.js served');

  // Одобренный бандл: release.json пинит wallet.html хешем коммитнутых байтов.
  const rel = JSON.parse(fs.readFileSync(path.join(root, 'site', 'release.json'), 'utf8'));
  assert.ok(rel.files && typeof rel.files['wallet.html'] === 'string', 'manifest lists wallet.html');
  const blob = execFileSync('git', ['show', 'HEAD:site/wallet.html'], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(rel.files['wallet.html'], sha(blob), 'manifest hash == git blob HEAD:site/wallet.html');
  console.log('    wallet.html sha256:', walletHash.slice(0, 16) + '… release:', rel.release);
  await stop();
});
