// Owner-published frontend bundles. Votes never execute or publish code.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SITE_RELEASE_FILES = Object.freeze(['index.html', 'imperial.html', 'terminal.html', 'dashboard.html', 'chat.html', 'jail.html', 'mbc20.html', 'cabinet.html', 'jobs.html', 'panel.js']);
export const SITE_RELEASE_SOURCE = 'https://raw.githubusercontent.com/CrChCn/agentcoin/main/site';
const MANIFEST_MAX = 16_384, PAGE_MAX = 2 * 1024 * 1024, INTERVAL = 10 * 60_000;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { const e = new Error(code); e.code = code; throw e; };
function shape(v, keys) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join('|') !== [...keys].sort().join('|')) fail('invalid_release_schema');
}
function manifest(v, apiVersion) {
  shape(v, ['version', 'release', 'apiVersion', 'files']);
  if (v.version !== 1 || typeof v.release !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(v.release)) fail('invalid_release_version');
  if (v.apiVersion !== apiVersion) fail('incompatible_release_api');
  shape(v.files, SITE_RELEASE_FILES);
  const files = {};
  for (const file of SITE_RELEASE_FILES) {
    if (typeof v.files[file] !== 'string' || !/^[a-f0-9]{64}$/.test(v.files[file])) fail('invalid_release_hash');
    files[file] = v.files[file];
  }
  return { version: 1, release: v.release, apiVersion: v.apiVersion, files };
}
function read(file, max) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) fail('invalid_release_cache');
  return fs.readFileSync(file);
}
function write(file, value, exclusive = false) {
  const temp = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (exclusive) fs.linkSync(temp, file); else fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

export class SiteReleaseManager {
  constructor({ dataDir, sourceBase = SITE_RELEASE_SOURCE, fetchFn = fetch, apiVersion = 2, now = Date.now } = {}) {
    if (typeof dataDir !== 'string' || !dataDir || typeof fetchFn !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(apiVersion) || apiVersion < 1) fail('invalid_release_config');
    if (typeof sourceBase !== 'string' || !/^https:\/\/raw\.githubusercontent\.com\/CrChCn\/agentcoin\/(?:main|[a-f0-9]{40})\/site\/?$/.test(sourceBase)) fail('invalid_release_source');
    this.root = path.join(dataDir, 'site-releases'); this.sourceBase = sourceBase.replace(/\/$/, '');
    this.fetchFn = fetchFn; this.apiVersion = apiVersion; this.now = now;
    this.active = null; this.pending = null; this.lastAttempt = null; this.lastError = null;
    fs.mkdirSync(path.join(this.root, 'history'), { recursive: true, mode: 0o700 });
    try {
      const pointer = JSON.parse(read(path.join(this.root, 'active.json'), MANIFEST_MAX));
      shape(pointer, ['version', 'generation', 'activatedAt']);
      if (pointer.version !== 1 || !/^[a-f0-9]{64}$/.test(pointer.generation) || !Number.isSafeInteger(pointer.activatedAt) || pointer.activatedAt < 0) fail('invalid_release_cache');
      this.active = { ...this._generation(pointer.generation), activatedAt: pointer.activatedAt };
    } catch (e) { if (e.code !== 'ENOENT') this.lastError = 'invalid_release_cache'; }
  }
  _generation(hash) {
    const dir = path.join(this.root, hash), stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_release_cache');
    const m = manifest(JSON.parse(read(path.join(dir, 'release.json'), MANIFEST_MAX)), this.apiVersion);
    if (sha(JSON.stringify(m)) !== hash) fail('invalid_release_cache');
    for (const file of SITE_RELEASE_FILES) if (sha(read(path.join(dir, file), PAGE_MAX)) !== m.files[file]) fail('invalid_release_cache');
    return { hash, manifest: m, dir };
  }
  status() {
    return { ok: true, apiVersion: this.apiVersion, release: this.active?.manifest.release || null,
      manifestHash: this.active?.hash || null, files: this.active ? { ...this.active.manifest.files } : {},
      activatedAt: this.active?.activatedAt ?? null, checkedAt: this.lastAttempt,
      lastError: this.lastError, refreshing: !!this.pending, approval: 'owner_published_repository_manifest' };
  }
  resolvePage(page) {
    if (!SITE_RELEASE_FILES.includes(page) || !this.active) return null;
    return path.join(this.active.dir, page);
  }
  refresh() {
    if (this.pending) return this.pending;
    if (this.lastAttempt !== null && this.now() - this.lastAttempt < INTERVAL) return Promise.resolve({ ok: !this.lastError, updated: false, skipped: 'refresh_interval', ...this._result() });
    this.lastAttempt = this.now();
    this.pending = this._refresh();
    const clear = () => { this.pending = null; };
    this.pending.then(clear, clear);
    return this.pending;
  }
  _result() { return { release: this.active?.manifest.release || null, manifestHash: this.active?.hash || null, retained: !!this.active }; }
  async _fetch(file, max, deadline) {
    const timeout = Math.min(8000, deadline - Date.now());
    if (timeout <= 0) fail('release_fetch_timeout');
    const controller = new AbortController(); let timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); const e = new Error('release_fetch_timeout'); e.code = e.message; reject(e); }, timeout); });
    try {
      return await Promise.race([expired, (async () => {
        const response = await this.fetchFn(this.sourceBase + '/' + file, { redirect: 'error', signal: controller.signal, cache: 'no-store' });
        if (!response.ok) fail('release_http_error');
        if (Number(response.headers?.get('content-length') || 0) > max) fail('release_file_too_large');
        const chunks = []; let size = 0;
        for await (const chunk of response.body || []) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > max) { controller.abort(); fail('release_file_too_large'); }
          chunks.push(bytes);
        }
        if (!size) fail('release_empty_file');
        return Buffer.concat(chunks);
      })()]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async _refresh() {
    let staging;
    try {
      const deadline = Date.now() + 25_000;
      const m = manifest(JSON.parse((await this._fetch('release.json', MANIFEST_MAX, deadline)).toString('utf8')), this.apiVersion);
      const hash = sha(JSON.stringify(m));
      const history = path.join(this.root, 'history', m.release + '.json');
      const checkHistory = () => { if (fs.existsSync(history) && read(history, 256).toString('utf8') !== hash) fail('release_id_reused'); };
      checkHistory();
      if (this.active?.hash === hash) { this.lastError = null; return { ok: true, updated: false, ...this._result() }; }
      const destination = path.join(this.root, hash);
      if (!fs.existsSync(destination)) {
        staging = fs.mkdtempSync(path.join(this.root, '.staging-'));
        for (const file of SITE_RELEASE_FILES) {
          const bytes = await this._fetch(file, PAGE_MAX, deadline);
          if (sha(bytes) !== m.files[file]) fail('release_hash_mismatch');
          write(path.join(staging, file), bytes);
        }
        write(path.join(staging, 'release.json'), JSON.stringify(m));
        try { fs.renameSync(staging, destination); staging = null; }
        catch (e) { if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
      }
      const next = this._generation(hash); // Complete disk revalidation before activation.
      checkHistory();
      if (!fs.existsSync(history)) {
        if (fs.readdirSync(path.join(this.root, 'history')).length >= 1024) fail('release_history_capacity');
        try { write(history, hash, true); } catch (e) { if (e.code !== 'EEXIST') throw e; checkHistory(); }
      }
      const activatedAt = this.now();
      write(path.join(this.root, 'active.json'), JSON.stringify({ version: 1, generation: hash, activatedAt }));
      this.active = { ...next, activatedAt }; this.lastError = null;
      return { ok: true, updated: true, ...this._result() };
    } catch (e) {
      this.lastError = ['incompatible_release_api', 'invalid_release_schema', 'invalid_release_version', 'invalid_release_hash', 'release_id_reused', 'release_http_error', 'release_file_too_large', 'release_hash_mismatch', 'release_fetch_timeout', 'release_empty_file', 'release_history_capacity'].includes(e.code) ? e.code : 'release_refresh_failed';
      return { ok: false, updated: false, error: this.lastError, ...this._result() };
    } finally { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
  }
}
