import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { WEB_APP_PATHS, serveWebApp } from '../web-app.mjs';

async function server(t) {
  const s = http.createServer((req, res) => {
    if (!serveWebApp(req, res, new URL(req.url, 'http://localhost').pathname)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }));
  return `http://127.0.0.1:${s.address().port}`;
}

test('manifest uses fixed same-origin assets and GET/HEAD have matching lengths', async t => {
  const origin = await server(t);
  assert.deepEqual(WEB_APP_PATHS, ['/app.webmanifest', '/app-worker.js', '/app-icon-192.png', '/app-icon-512.png']);
  for (const p of WEB_APP_PATHS) {
    const get = await fetch(origin + p), body = Buffer.from(await get.arrayBuffer());
    const head = await fetch(origin + p, { method: 'HEAD' });
    assert.equal(get.status, 200); assert.equal(head.status, 200);
    assert.equal(Number(get.headers.get('content-length')), body.length);
    assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
    if (p === '/app.webmanifest') {
      assert.match(get.headers.get('content-type'), /^application\/manifest\+json/);
      const m = JSON.parse(body);
      assert.equal(m.start_url, '/imperial'); assert.equal(m.id, '/imperial'); assert.equal(m.scope, '/'); assert.equal(m.display, 'standalone');
      assert.equal(m.icons.length, 2);
      for (const i of m.icons) { assert.ok(WEB_APP_PATHS.includes(i.src)); assert.equal(new URL(i.src, origin).origin, origin); assert.equal(i.type, 'image/png'); }
    }
  }
});

test('icons are complete valid RGBA PNGs at manifest dimensions', async t => {
  const origin = await server(t);
  const crc = bytes => { let value = 0xffffffff; for (const b of bytes) { value ^= b; for (let k = 0; k < 8; k++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  for (const size of [192, 512]) {
    const r = await fetch(`${origin}/app-icon-${size}.png`), b = Buffer.from(await r.arrayBuffer());
    assert.equal(r.headers.get('content-type'), 'image/png'); assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    let offset = 8; const chunks = [];
    while (offset < b.length) {
      const length = b.readUInt32BE(offset), type = b.toString('ascii', offset + 4, offset + 8), data = b.subarray(offset + 8, offset + 8 + length);
      assert.equal(b.readUInt32BE(offset + 8 + length), crc(b.subarray(offset + 4, offset + 8 + length)));
      chunks.push({ type, data }); offset += length + 12;
    }
    assert.equal(offset, b.length); assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
    assert.equal(chunks[0].data.readUInt32BE(0), size); assert.equal(chunks[0].data.readUInt32BE(4), size);
    assert.equal(chunks[0].data[8], 8); assert.equal(chunks[0].data[9], 6);
    const pixels = inflateSync(chunks[1].data); assert.equal(pixels.length, (size * 4 + 1) * size);
    for (let y = 0; y < size; y++) { assert.equal(pixels[y * (size * 4 + 1)], 0); for (let x = 0; x < size; x++) assert.equal(pixels[y * (size * 4 + 1) + x * 4 + 4], 255); }
  }
});

test('asset router rejects mutations and never resolves arbitrary or traversal paths', async t => {
  const origin = await server(t);
  for (const p of WEB_APP_PATHS) {
    const response = await fetch(origin + p, { method: 'POST', body: 'synthetic-private-token' });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD'); assert.equal(await response.text(), 'Method not allowed\n');
  }
  for (const p of ['/identity/meta', '/cabinet', '/app-worker.js/../secret', '/../app.webmanifest', '/%2e%2e/secret', '/app-icon-192.png/secret', '/app-worker.js?token=synthetic-private-token', '__proto__']) {
    const res = { writeHead() { assert.fail('unknown path must not write'); }, end() { assert.fail('unknown path must not end'); } };
    assert.equal(serveWebApp({ method: 'GET' }, res, p), false);
  }
});

test('service worker only activates and has no request interception, storage or token channel', async t => {
  const origin = await server(t), response = await fetch(origin + '/app-worker.js'), source = await response.text();
  const listeners = new Map(); let skips = 0, claims = 0;
  vm.runInNewContext(source, { self: { addEventListener(name, handler) { listeners.set(name, handler); }, skipWaiting() { skips++; return Promise.resolve(); }, clients: { claim() { claims++; return Promise.resolve(); } } } });
  assert.deepEqual([...listeners.keys()], ['install', 'activate']);
  for (const callback of listeners.values()) { let pending; callback({ waitUntil(value) { pending = value; } }); await pending; }
  assert.equal(skips, 1); assert.equal(claims, 1); assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
  assert.doesNotMatch(source, /caches|fetch\(|indexedDB|localStorage|postMessage|token/i);
});

function uiFixture(platform = 'Win32') {
  const ids = ['install-platform', 'install-node-url', 'install-client-only', 'install-primary', 'install-platform-note', 'install-terminal', 'install-termux-link', 'install-client-choice', 'install-command-label', 'install-command', 'install-copy', 'install-agent-task', 'install-status'];
  const elements = Object.fromEntries(ids.map(id => [id, { value: '', checked: false, disabled: false, hidden: false, textContent: '' }]));
  const platforms = ['windows', 'macos', 'linux', 'android', 'ios'];
  Object.defineProperties(elements['install-platform'], { options: { get: () => platforms.map(textContent => ({ textContent })) }, selectedIndex: { get: () => platforms.indexOf(elements['install-platform'].value) } });
  const copied = [], downloads = [], blobs = new Map();
  class UIURL extends URL { static createObjectURL(blob) { const id = 'blob:' + blobs.size; blobs.set(id, blob); return id; } static revokeObjectURL() {} }
  const context = { URL: UIURL, Blob, setTimeout() {}, window: { isSecureContext: false, addEventListener() {} }, navigator: { platform, userAgent: platform === 'Linux armv8l' ? 'Android' : '', maxTouchPoints: 0, clipboard: { async writeText(value) { copied.push(value); } } }, location: { protocol: 'https:', origin: 'https://node.example', hostname: 'node.example' }, document: { querySelector() { return {}; }, getElementById(id) { return elements[id]; }, body: { appendChild() {} }, createElement() { const anchor = { click() { downloads.push({ name: anchor.download, blob: blobs.get(anchor.href) }); }, remove() {} }; return anchor; } } };
  return { elements, copied, downloads, context };
}
test('installer commands preserve PowerShell variables, selected origin and mode; mobile claims stay honest', async () => {
  const source = await fs.readFile(new URL('../tools/install-ui.js', import.meta.url), 'utf8');
  const f = uiFixture(); vm.runInNewContext(source, f.context); const e = f.elements;
  assert.equal(e['install-node-url'].value, 'https://node.example');
  assert.match(e['install-command'].textContent, /^\$ErrorActionPreference='Stop'; \$s=/);
  assert.doesNotMatch(e['install-command'].textContent, /^powershell/);
  e['install-node-url'].value = 'https://selected.example:9443'; e['install-client-only'].checked = true; e['install-client-only'].onchange();
  await e['install-copy'].onclick();
  assert.match(f.copied[0], /-PeerUrl 'https:\/\/selected\.example:9443' -ClientOnly$/);
  await e['install-primary'].onclick();
  assert.equal(f.downloads[0].name, 'agentcoin-install.cmd'); assert.match(await f.downloads[0].blob.text(), /powershell\.exe -NoProfile -Command "\$ErrorActionPreference=/);
  await e['install-agent-task'].onclick(); assert.match(f.copied[1], /--client-only/); assert.match(f.copied[1], /https:\/\/selected\.example:9443/);
  for (const platform of ['macos', 'linux', 'android']) {
    e['install-platform'].value = platform; e['install-platform'].onchange();
    assert.match(e['install-command'].textContent, /sh "\$task_agt_bootstrap" --peer-url 'https:\/\/selected\.example:9443' --client-only/);
    assert.equal(spawnSync('sh', ['-n'], { input: e['install-command'].textContent, encoding: 'utf8' }).status, 0);
    if (platform === 'android') { assert.match(e['install-command'].textContent, /^pkg install -y curl/); assert.match(e['install-platform-note'].textContent, /останавливать фоновые/); }
    else { await e['install-primary'].onclick(); assert.equal(f.downloads.at(-1).name, platform === 'macos' ? 'agentcoin-install.command' : 'agentcoin-install.sh'); assert.equal(spawnSync('sh', ['-n'], { input: await f.downloads.at(-1).blob.text(), encoding: 'utf8' }).status, 0); }
  }
  e['install-platform'].value = 'ios'; e['install-platform'].onchange(); assert.equal(e['install-terminal'].hidden, true); assert.equal(e['install-client-choice'].hidden, true); assert.match(e['install-platform-note'].textContent, /отдельной среде/);
  await e['install-primary'].onclick(); assert.match(e['install-status'].textContent, /Safari/); assert.equal(f.downloads.length, 3);
  e['install-platform'].value = 'linux'; e['install-node-url'].value = 'https://user:secret@node.example'; e['install-platform'].onchange();
  assert.equal(e['install-primary'].disabled, true); assert.equal(e['install-copy'].disabled, true); assert.equal(e['install-agent-task'].disabled, true); assert.doesNotMatch(e['install-command'].textContent, /secret/);
});

test('landing supplies every installer control and has no secret inputs or legacy join claims', async () => {
  const html = await fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = await fs.readFile(new URL('../tools/install-ui.js', import.meta.url), 'utf8');
  for (const [, id] of source.matchAll(/\$\('(install-[a-z-]+)'\)/g)) assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} must exist exactly once`);
  assert.equal(html.split('id="install-platform"').length - 1, 1);
  for (const platform of ['windows', 'macos', 'linux', 'android', 'ios']) assert.ok(html.includes(`value="${platform}"`));
  assert.doesNotMatch(html, /type="password"|POST \/join|\/wallet\/create|\/faucet\/drip|10 AGT|зарабатывай вечно/i);
});
