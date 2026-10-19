/** Legacy mutation tests run only against a node created and owned by this supervisor.
 * No external URL, token file, production data or inherited AGT configuration is accepted.
 */
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, realpath, mkdir, readFile, copyFile, lstat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repository = fileURLToPath(new URL('../', import.meta.url));
const WORKER = '--owned-isolated-fixture';
export function isolatedEnvironment(source = process.env) {
  // Allowlist OS essentials only: no NODE_OPTIONS, credentials, AGT paths or proxy settings.
  return Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].filter(k => source[k] !== undefined).map(k => [k, source[k]]));
}
export async function stageIsolatedSource(sourceRoot, destination) {
  // Copy only the static relative .mjs dependency graph and one public wordlist.
  // Never recursively copy a checkout, data directories, optional dynamic spore or .git.
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const seen = new Set();
  async function copyModule(relative) {
    if (!/^[a-zA-Z0-9_-]+\.mjs$/.test(relative)) throw new Error('Unsupported fixture dependency: ' + relative);
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = path.join(sourceRoot, relative);
    if (!(await lstat(source)).isFile()) throw new Error('Fixture module must be a regular file');
    const text = await readFile(source, 'utf8');
    await writeFile(path.join(destination, relative), text, { mode: 0o600 });
    for (const match of text.matchAll(/\bfrom\s*['"]\.\/([^'"]+\.mjs)['"]/g)) await copyModule(match[1]);
  }
  await copyModule('node.mjs');
  const wordlist = path.join(sourceRoot, 'bip39-english.txt');
  if (!(await lstat(wordlist)).isFile()) throw new Error('Fixture wordlist must be a regular file');
  await copyFile(wordlist, path.join(destination, 'bip39-english.txt'));
  return destination;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function freePort() {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
export async function isolatedLegacyTarget(scriptURL) {
  if (process.argv[2] === WORKER && process.argv.length === 3 && process.send) {
    const [message] = await once(process, 'message'); process.disconnect();
    if (message?.kind !== 'owned-fixture' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(message.url)) throw new Error('Invalid fixture handoff');
    return message.url;
  }
  if (process.argv.length !== 2) throw new Error('External targets and --army are disabled. Run without arguments to create an isolated temporary node.');
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'agt-isolated-test-'));
  let node, worker, deadline;
  let signalCode;
  const onSignal = () => { signalCode = 130; void stop(worker); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const bootstrap = path.join(root, 'bootstrap.json');
    await writeFile(bootstrap, JSON.stringify({ bootstrap: [] }));
    const stagedSource = await stageIsolatedSource(repository, path.join(root, 'source'));
    const fixtureToken = randomBytes(32).toString('hex');
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const env = { ...isolatedEnvironment(), HOME: root, USERPROFILE: root, AGT_DATA_DIR: path.join(root, 'data'), AGT_BOOTSTRAP_FILE: bootstrap, AGT_BIND: '127.0.0.1', AGT_ADMIN_MODE: 'local', AGT_ADMIN_TOKEN: fixtureToken, AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' };
    node = spawn(process.execPath, [path.join(stagedSource, 'node.mjs'), String(port)], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; node.stderr.on('data', b => { errors = (errors + b).slice(-2000); });
    node.on('error', e => { errors += e.message; });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (signalCode) throw new Error('Fixture interrupted');
      if (node.exitCode !== null) throw new Error('Fixture node failed: ' + errors);
      try { const r = await fetch(url + '/health', { signal: AbortSignal.timeout(250), redirect: 'error' }); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Fixture startup timed out: ' + errors);
    worker = fork(fileURLToPath(scriptURL), [WORKER], { cwd: root, env, execArgv: [], stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    const finished = once(worker, 'exit');
    worker.send({ kind: 'owned-fixture', url });
    deadline = setTimeout(() => { console.error('Isolated test exceeded five-minute deadline'); signalCode = 124; void stop(worker); }, 5 * 60_000);
    const [code] = await finished;
    process.exitCode = signalCode || code || (code === 0 ? 0 : 1);
  } finally {
    clearTimeout(deadline);
    await stop(worker); await stop(node); await rm(root, { recursive: true, force: true });
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
  // Do not execute the legacy mutation body in the supervisor.
  process.exit(process.exitCode || 0);
}
