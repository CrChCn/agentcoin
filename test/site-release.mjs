import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SiteReleaseManager, SITE_RELEASE_FILES, SITE_RELEASE_SOURCE } from '../site-release.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function release(name, apiVersion = 2) {
  const bodies = Object.fromEntries(SITE_RELEASE_FILES.map(file => [file, file === 'panel.js' ? `window.approvedRelease=${JSON.stringify(name)};` : `<!doctype html><html><body>${name}:${file}</body></html>`]));
  return { bodies, manifest: { version: 1, release: name, apiVersion, files: Object.fromEntries(SITE_RELEASE_FILES.map(file => [file, digest(bodies[file])])) } };
}
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-site-release-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let current = release('release-one'), now = 1_900_000_000_000, hook;
  const requested = [];
  const fetchFn = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(url.startsWith(SITE_RELEASE_SOURCE + '/'), true);
    const file = url.slice(SITE_RELEASE_SOURCE.length + 1); requested.push(file);
    const special = await hook?.(file); if (special) return special;
    return new Response(file === 'release.json' ? JSON.stringify(current.manifest) : current.bodies[file], { status: 200 });
  };
  const manager = new SiteReleaseManager({ dataDir, fetchFn, now: () => now });
  return { dataDir, requested, manager, fetchFn, setRelease(value) { current = value; }, setHook(value) { hook = value; }, advance() { now += 10 * 60_000; }, clock: () => now };
}
function assertBundle(manager, r) {
  assert.equal(manager.status().release, r.manifest.release);
  for (const file of SITE_RELEASE_FILES) {
    const actual = fs.readFileSync(manager.resolvePage(file));
    assert.equal(digest(actual), r.manifest.files[file]);
  }
}
function assertNoStaging(f) { assert.equal(fs.readdirSync(path.join(f.dataDir, 'site-releases')).some(name => name.startsWith('.staging-')), false); }

test('complete owner manifest activates identical HTML and panel.js; requests are bounded and pinned', async t => {
  const f = fixture(t), expected = release('release-one');
  assert.equal(f.manager.resolvePage('index.html'), null);
  assert.equal(f.manager.resolvePage('../secret'), null);
  const result = await f.manager.refresh();
  assert.equal(result.ok, true); assert.equal(result.updated, true);
  assert.equal(f.requested.length, SITE_RELEASE_FILES.length + 1);
  assertBundle(f.manager, expected); assertNoStaging(f);
  const count = f.requested.length;
  assert.equal((await f.manager.refresh()).skipped, 'refresh_interval');
  assert.equal(f.requested.length, count);
  f.advance();
  assert.equal((await f.manager.refresh()).updated, false);
  assert.equal(f.requested.length, count + 1, 'unchanged manifest does not re-fetch every page');
  const publicStatus = JSON.stringify(f.manager.status());
  assert.equal(publicStatus.includes('https://'), false); assert.equal(publicStatus.includes(f.dataDir), false);
  assert.throws(() => new SiteReleaseManager({ dataDir: f.dataDir, sourceBase: 'http://127.0.0.1:9335' }), /invalid_release_source/);
  assert.throws(() => new SiteReleaseManager({ dataDir: f.dataDir, sourceBase: 'https://raw.githubusercontent.com/evil/agentcoin/main/site' }), /invalid_release_source/);
});

test('partial fetch failure and bad sha retain every page from the last approved generation', async t => {
  const f = fixture(t), before = release('release-one'); await f.manager.refresh();
  const oldPath = f.manager.resolvePage('index.html');
  f.setRelease(release('release-two')); f.advance();
  f.setHook(file => file === 'cabinet.html' ? new Response('offline', { status: 503 }) : null);
  let result = await f.manager.refresh();
  assert.equal(result.error, 'release_http_error'); assert.equal(result.retained, true);
  assert.equal(f.manager.resolvePage('index.html'), oldPath); assertBundle(f.manager, before); assertNoStaging(f);
  f.advance(); f.setHook(file => file === 'panel.js' ? new Response('tampered code') : null);
  result = await f.manager.refresh();
  assert.equal(result.error, 'release_hash_mismatch'); assertBundle(f.manager, before); assertNoStaging(f);
  f.advance(); f.setHook(null);
  assert.equal((await f.manager.refresh()).updated, true); assertBundle(f.manager, release('release-two'));
});

test('oversized header and streamed body, unsupported API and malformed file lists cannot replace active', async t => {
  const f = fixture(t), before = release('release-one'); await f.manager.refresh();
  f.setRelease(release('release-two')); f.advance();
  f.setHook(file => file === 'index.html' ? new Response('small body', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }) : null);
  assert.equal((await f.manager.refresh()).error, 'release_file_too_large'); assertBundle(f.manager, before);
  f.advance(); f.setHook(file => file === 'index.html' ? new Response('x'.repeat(2 * 1024 * 1024 + 1)) : null);
  assert.equal((await f.manager.refresh()).error, 'release_file_too_large'); assertBundle(f.manager, before);
  f.advance(); f.setHook(null); f.setRelease(release('release-three', 3));
  const requestedBefore = f.requested.length;
  assert.equal((await f.manager.refresh()).error, 'incompatible_release_api');
  assert.equal(f.requested.length, requestedBefore + 1); assertBundle(f.manager, before);
  f.advance(); const malformed = release('malformed'); malformed.manifest.files['../secret'] = '0'.repeat(64); f.setRelease(malformed);
  assert.equal((await f.manager.refresh()).error, 'invalid_release_schema'); assertBundle(f.manager, before);
  f.advance(); f.setHook(file => file === 'release.json' ? new Response('x'.repeat(16_385)) : null);
  assert.equal((await f.manager.refresh()).error, 'release_file_too_large'); assertBundle(f.manager, before); assertNoStaging(f);
});

test('activation is single-flight and remains old until the entire next bundle is verified', async t => {
  const f = fixture(t); await f.manager.refresh();
  const before = release('release-one'), next = release('release-two'); f.setRelease(next); f.advance();
  let releaseFetch, entered;
  const gate = new Promise(resolve => { releaseFetch = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.setHook(async file => { if (file === 'panel.js') { entered(); await gate; } });
  const a = f.manager.refresh(), b = f.manager.refresh(); assert.strictEqual(a, b);
  await started; assertBundle(f.manager, before);
  releaseFetch(); assert.equal((await a).updated, true); assertBundle(f.manager, next); assertNoStaging(f);
});

test('verified active generation survives restart/offline, corruption falls back, and release IDs are immutable', async t => {
  const f = fixture(t); await f.manager.refresh();
  const first = release('release-one');
  const restarted = new SiteReleaseManager({ dataDir: f.dataDir, fetchFn: async () => { throw new Error('offline'); }, now: f.clock });
  assertBundle(restarted, first);
  assert.equal((await restarted.refresh()).ok, false); assertBundle(restarted, first);
  f.advance(); f.setRelease(release('release-two')); await f.manager.refresh();
  f.advance(); const reused = release('release-one'); reused.bodies['index.html'] += 'different'; reused.manifest.files['index.html'] = digest(reused.bodies['index.html']); f.setRelease(reused);
  assert.equal((await f.manager.refresh()).error, 'release_id_reused'); assertBundle(f.manager, release('release-two'));
  fs.writeFileSync(f.manager.resolvePage('cabinet.html'), 'disk corruption');
  const damaged = new SiteReleaseManager({ dataDir: f.dataDir });
  assert.equal(damaged.resolvePage('index.html'), null);
  assert.equal(damaged.status().lastError, 'invalid_release_cache');
});
