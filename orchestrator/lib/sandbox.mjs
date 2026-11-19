#!/usr/bin/env node
/* OS-sandbox (Stage A fix4).
   Бинарник bwrap сам по себе ничего не доказывает: в среде, где он установлен,
   но не может создать user namespace (`bwrap: setting up uid map: Read-only
   file system`), прежняя проверка `hasCommand('bwrap')` объявляла backend
   рабочим. Теперь detectSandbox() выполняет реальный smoke-run с теми же
   параметрами, что и настоящий runner:

   - `--unshare-all` (включая сеть);
   - workspace — единственный rw-каталог, системные каталоги read-only;
   - tmpfs /tmp и /home (HOME=/home/sandbox), нет docker.sock/SSH;
   - `--clearenv` + allowlist;
   - Node permission model (`--permission --allow-fs-read/write=<ws>`);
   - проверки: чтение/запись внутри workspace разрешены; чтение/запись вне
     workspace, spawn дочернего процесса, сеть и унаследованное окружение —
     запрещены технически.

   Любая ошибка smoke-run — это ISOLATED_RUNNER_UNAVAILABLE, а не «наверное
   сработает». Наличие бинарника без smoke-теста реальный цикл не открывает. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { toolEnv } from './envpolicy.mjs';

export const ISOLATED_RUNNER_UNAVAILABLE = 'ISOLATED_RUNNER_UNAVAILABLE';
export const ISOLATED_TOOL_NET_UNAVAILABLE = 'ISOLATED_TOOL_NET_UNAVAILABLE';
export const ISOLATION_UNPROVEN = 'agent_isolation_unproven';

export const LIMITS = Object.freeze({
  nproc: 256,
  addressSpaceKb: 2 * 1024 * 1024,
  cpuSeconds: 120,
  fileSizeKb: 64 * 1024,
  hostTimeoutMs: 180000,
});

const WIN = process.platform === 'win32';

let cached = null;

function hasCommand(cmd) {
  const result = spawnSync(WIN ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: toolEnv(),
    shell: false,
  });
  return result.status === 0 && String(result.stdout || '').trim().length > 0;
}

export function toWslPath(winPath) {
  const abs = String(winPath).replace(/\\/g, '/');
  const match = /^([a-zA-Z]):\/(.*)$/.exec(abs);
  if (!match) return abs;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

export const toBackendPath = (p, backend) => (backend === 'wsl-bwrap' ? toWslPath(p) : String(p));

/* Список системных каталогов, которые реально есть в целевой среде.
   bwrap падает целиком, если `--ro-bind` указывает на отсутствующий путь,
   поэтому список вычисляется один раз, а не угадывается. */
const ROOT_CANDIDATES = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64'];

let rootDirsCache = null;

function detectRootDirs() {
  if (rootDirsCache) return rootDirsCache;
  let dirs = [];
  if (WIN) {
    const script = ROOT_CANDIDATES.map((dir) => `[ -e ${dir} ] && echo ${dir}`).join('; ');
    const result = spawnSync('wsl.exe', ['-e', 'bash', '-c', script], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: toolEnv(),
      shell: false,
    });
    dirs = String(result.stdout || '').split(/\s+/).filter((entry) => ROOT_CANDIDATES.includes(entry));
  } else {
    dirs = ROOT_CANDIDATES.filter((dir) => fs.existsSync(dir));
  }
  if (!dirs.includes('/usr') && !dirs.includes('/bin')) dirs = ['/usr', '/bin', '/lib'];
  rootDirsCache = dirs;
  return rootDirsCache;
}

/* Общий план монтирования: его используют и тестовый runner, и Codex-worker.
   `network: 'provider'` оставляет сетевой namespace хоста только тому
   процессу, которому разрешён канал к провайдеру; инструменты модели
   запускаются отдельно с `--unshare-net` (см. tools/tool-proxy.mjs). */
export function sandboxMountArgs({ workspaceUnix, network = 'none', extraMounts = [], capSysAdmin = false }) {
  const args = ['--unshare-all'];
  if (network === 'provider') args.push('--share-net');
  args.push('--die-with-parent', '--new-session');
  /* CAP_SYS_ADMIN нужен только для создания вложенного network/mount
     namespace внутри sandbox (tool proxy). Он живёт внутри user namespace,
     не даёт доступа к хостовым устройствам и путям. */
  if (capSysAdmin) args.push('--cap-add', 'CAP_SYS_ADMIN');
  for (const dir of detectRootDirs()) args.push('--ro-bind', dir, dir);
  args.push('--proc', '/proc', '--dev', '/dev');
  args.push('--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/home/sandbox');
  for (const mount of extraMounts) args.push(...mount);
  args.push('--bind', workspaceUnix, workspaceUnix, '--chdir', workspaceUnix);
  return args;
}

export function sandboxEnvArgs(extraEnv = {}) {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/sandbox',
    TMPDIR: '/tmp',
    TMP: '/tmp',
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...extraEnv,
  };
  const args = ['--clearenv'];
  for (const [name, value] of Object.entries(env)) args.push('--setenv', name, String(value));
  return args;
}

/* Лимиты задаются шеллом внутри namespace: bwrap их не выставляет сам. */
function limitScript() {
  return [
    `ulimit -u ${LIMITS.nproc}`,
    `ulimit -v ${LIMITS.addressSpaceKb}`,
    `ulimit -t ${LIMITS.cpuSeconds}`,
    `ulimit -f ${LIMITS.fileSizeKb}`,
    'exec "$@"',
  ].join('; ');
}

/* `node --test` по умолчанию запускает каждый файл в дочернем процессе, а
   permission-модель Node запрещает child_process. Поэтому тесты идут в одном
   процессе, а файловая система ограничена workspace'ом. */
export function hardenNodeArgv(argv, workspaceUnix) {
  if (argv[0] !== 'node') return argv.slice();
  const rest = argv.slice(1);
  const hardened = ['--permission', `--allow-fs-read=${workspaceUnix}`, `--allow-fs-write=${workspaceUnix}`];
  if (rest.includes('--test') && !rest.some((flag) => flag.startsWith('--test-isolation'))) {
    hardened.push('--test-isolation=none');
  }
  return ['node', ...hardened, ...rest];
}

function spawnSandbox(sandbox, args, { timeoutMs, async = false }) {
  const command = sandbox.backend === 'wsl-bwrap' ? 'wsl.exe' : 'bwrap';
  const commandArgs = sandbox.backend === 'wsl-bwrap' ? ['-e', 'bwrap', ...args] : args;
  const options = {
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: toolEnv(),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  };
  return async ? spawn(command, commandArgs, options) : spawnSync(command, commandArgs, { ...options, encoding: 'utf8' });
}

export function sandboxRun({
  workspace,
  argv,
  timeoutMs = LIMITS.hostTimeoutMs,
  sandbox = detectSandbox(),
  network = 'none',
  harden = true,
  extraEnv = {},
  extraMounts = [],
  capSysAdmin = false,
}) {
  if (!sandbox || !sandbox.available) {
    return {
      exitCode: 126,
      stdout: '',
      stderr: `policy: ${ISOLATED_RUNNER_UNAVAILABLE}`,
      policyCode: ISOLATED_RUNNER_UNAVAILABLE,
      sandboxed: false,
      durationMs: 0,
    };
  }
  const started = Date.now();
  const workspaceUnix = toBackendPath(workspace, sandbox.backend);
  const finalArgv = harden ? hardenNodeArgv(argv, workspaceUnix) : argv.slice();
  const args = [
    ...sandboxMountArgs({ workspaceUnix, network, extraMounts, capSysAdmin }),
    ...sandboxEnvArgs(extraEnv),
    '--',
    'bash',
    '-c',
    limitScript(),
    'orch-sandbox',
    ...finalArgv,
  ];
  const result = spawnSandbox(sandbox, args, { timeoutMs });
  return {
    exitCode: typeof result.status === 'number' ? result.status : -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    sandboxed: true,
    backend: sandbox.backend,
    durationMs: Date.now() - started,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    spawnError: result.error ? String(result.error.message || result.error) : null,
  };
}

/* Асинхронный запуск для Codex-worker: нужен streaming stdout (JSONL),
   stdin для prompt и управляемое завершение дерева процессов. */
export function sandboxSpawn({ sandbox, args }) {
  return spawnSandbox(sandbox, args, { timeoutMs: 0, async: true });
}

/* ---------- smoke-run ---------- */

const SMOKE_BASH = String.raw`
WS="$1"; OUT="$2"; OUTW="$3"
res() { printf '{"check":"%s","ok":%s,"detail":"%s"}\n' "$1" "$2" "$3"; }
if [ -r "$WS/allowed.txt" ]; then res read-allowed-bwrap true "read allowed"; else res read-allowed-bwrap false "denied"; fi
if ( printf 'ok' > "$WS/written-bwrap.txt" ) 2>/dev/null; then res write-allowed-bwrap true "write allowed"; else res write-allowed-bwrap false "denied"; fi
if ( cat "$OUT" ) >/dev/null 2>&1; then res read-outside-bwrap false "outside read succeeded"; else res read-outside-bwrap true "denied"; fi
if ( printf pwn > "$OUTW" ) >/dev/null 2>&1; then res write-outside-bwrap false "outside write succeeded"; else res write-outside-bwrap true "denied"; fi
if [ -n "$ORCH_SMOKE_CANARY" ]; then res env-clean false "host env leaked"; else res env-clean true "cleared"; fi
if [ -e /var/run/docker.sock ]; then res docker-socket-hidden false "socket visible"; else res docker-socket-hidden true "absent"; fi
if [ -n "$SSH_AUTH_SOCK" ]; then res ssh-agent-hidden false "socket visible"; else res ssh-agent-hidden true "absent"; fi
if [ -z "$(ls -A /home/sandbox 2>/dev/null)" ]; then res home-empty true "empty"; else res home-empty false "not empty"; fi
`;

const SMOKE_NODE = String.raw`
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const out = (check, ok, detail) => process.stdout.write(JSON.stringify({ check, ok, detail: String(detail).slice(0, 120) }) + '\n');
try { fs.readFileSync('allowed.txt', 'utf8'); out('read-allowed-node', true, 'read allowed'); }
catch (err) { out('read-allowed-node', false, err.code || err.message); }
try { fs.writeFileSync('written-node.txt', 'ok'); out('write-allowed-node', true, 'write allowed'); }
catch (err) { out('write-allowed-node', false, err.code || err.message); }
try { fs.readFileSync(process.argv[2], 'utf8'); out('read-outside-node', false, 'outside read succeeded'); }
catch (err) { out('read-outside-node', true, err.code || err.message); }
try { fs.writeFileSync(process.argv[3], 'pwn'); out('write-outside-node', false, 'outside write succeeded'); }
catch (err) { out('write-outside-node', true, err.code || err.message); }
try { execFileSync('/bin/sh', ['-c', 'echo pwn'], { stdio: 'ignore' }); out('spawn-node-denied', false, 'child process started'); }
catch (err) { out('spawn-node-denied', true, err.code || err.message); }
`;

const SMOKE_NET = String.raw`
import net from 'node:net';
const socket = net.connect({ host: '1.1.1.1', port: 443 });
socket.setTimeout(2000);
const done = (ok, detail) => { process.stdout.write(JSON.stringify({ check: 'net-denied', ok, detail }) + '\n'); process.exit(0); };
socket.once('connect', () => { socket.destroy(); done(false, 'connected'); });
socket.once('timeout', () => { socket.destroy(); done(true, 'ETIMEDOUT'); });
socket.once('error', (err) => done(true, err.code || err.message));
`;

export const SMOKE_CHECKS = Object.freeze([
  'read-allowed-bwrap',
  'write-allowed-bwrap',
  'read-outside-bwrap',
  'write-outside-bwrap',
  'env-clean',
  'docker-socket-hidden',
  'ssh-agent-hidden',
  'read-allowed-node',
  'write-allowed-node',
  'read-outside-node',
  'write-outside-node',
  'spawn-node-denied',
  'home-empty',
  'net-denied',
]);

/* Чистая функция: любой отсутствующий или проваленный шаг — отказ. Так
   проверяется и реальный прогон, и deliberately сломанный backend в тестах. */
export function evaluateSmoke({ backend, checks = {} }) {
  const failed = SMOKE_CHECKS.filter((name) => !checks[name] || checks[name].ok !== true);
  if (failed.length) {
    const detail = failed
      .slice(0, 4)
      .map((name) => `${name} (${checks[name] ? checks[name].detail : 'no result'})`)
      .join('; ');
    return {
      ok: false,
      code: ISOLATED_RUNNER_UNAVAILABLE,
      detail: `backend ${backend} failed its smoke test: ${detail}${failed.length > 4 ? `; +${failed.length - 4} more` : ''}`,
      failed,
      checks,
    };
  }
  return { ok: true, checks, failed: [] };
}

function parseChecks(stdout) {
  const checks = {};
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const item = JSON.parse(line);
      if (item && typeof item.check === 'string') checks[item.check] = { ok: item.ok === true, detail: String(item.detail || '') };
    } catch {
      /* посторонняя строка */
    }
  }
  return checks;
}

export function smokeTest({ backend = WIN ? 'wsl-bwrap' : 'bwrap', sandbox = { available: true, backend } } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-'));
  const ws = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(ws, 'allowed.txt'), 'allowed\n');
  fs.writeFileSync(path.join(outside, 'canary.txt'), 'OUTSIDE-CANARY\n');
  fs.writeFileSync(path.join(ws, 'probe-bash.sh'), SMOKE_BASH);
  fs.writeFileSync(path.join(ws, 'probe-node.mjs'), SMOKE_NODE);
  fs.writeFileSync(path.join(ws, 'probe-net.mjs'), SMOKE_NET);

  const uni = (p) => toBackendPath(p, backend);
  const outsideRead = uni(path.join(outside, 'canary.txt'));
  const outsideWrite = uni(path.join(outside, 'pwn.txt'));

  const previous = process.env.ORCH_SMOKE_CANARY;
  process.env.ORCH_SMOKE_CANARY = 'canary-value';
  let checks;
  try {
    const bash = sandboxRun({
      workspace: ws,
      argv: ['bash', 'probe-bash.sh', uni(ws), outsideRead, outsideWrite],
      sandbox,
      timeoutMs: 60000,
    });
    const node = sandboxRun({
      workspace: ws,
      argv: ['node', 'probe-node.mjs', outsideRead, outsideWrite],
      sandbox,
      timeoutMs: 60000,
    });
    const net = sandboxRun({
      workspace: ws,
      argv: ['node', 'probe-net.mjs'],
      sandbox,
      harden: false,
      timeoutMs: 60000,
    });
    checks = { ...parseChecks(bash.stdout), ...parseChecks(node.stdout), ...parseChecks(net.stdout) };
    if (!Object.keys(checks).length) {
      const reason = (bash.stderr || node.stderr || net.stderr || bash.spawnError || 'no output').trim().slice(-300);
      return {
        ok: false,
        code: ISOLATED_RUNNER_UNAVAILABLE,
        detail: `backend ${backend} cannot run the smoke test: ${reason}`,
        failed: SMOKE_CHECKS.slice(),
        checks,
      };
    }
    if (bash.exitCode !== 0 && !checks['read-allowed-bwrap']) {
      return {
        ok: false,
        code: ISOLATED_RUNNER_UNAVAILABLE,
        detail: `backend ${backend} smoke run exited ${bash.exitCode}: ${(bash.stderr || '').trim().slice(-300)}`,
        failed: SMOKE_CHECKS.slice(),
        checks,
      };
    }
    return evaluateSmoke({ backend, checks });
  } finally {
    if (previous === undefined) delete process.env.ORCH_SMOKE_CANARY;
    else process.env.ORCH_SMOKE_CANARY = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/* Определение backend один раз на процесс. Возвращает либо smoke-tested
   backend, либо явную причину отказа — молчаливого fallback на spawnSync нет. */
export function detectSandbox({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const installedBackend = WIN ? 'wsl-bwrap' : 'bwrap';
  const installed = WIN ? hasCommand('wsl.exe') : hasCommand('bwrap');
  if (!installed) {
    cached = {
      available: false,
      backend: null,
      installedBackend,
      code: ISOLATED_RUNNER_UNAVAILABLE,
      detail: WIN ? 'wsl.exe not found' : 'bwrap not found',
      levels: { installed: false, smokeTested: false, adapterEndToEnd: false },
      smoke: null,
    };
    return cached;
  }
  let smoke;
  try {
    smoke = smokeTest({ backend: installedBackend });
  } catch (err) {
    smoke = { ok: false, code: ISOLATED_RUNNER_UNAVAILABLE, detail: `smoke test crashed: ${err.message || err}` };
  }
  cached = {
    available: smoke.ok === true,
    backend: smoke.ok ? installedBackend : null,
    installedBackend,
    code: smoke.ok ? null : ISOLATED_RUNNER_UNAVAILABLE,
    detail: smoke.ok ? `${installedBackend} passed the isolation smoke test` : smoke.detail,
    levels: { installed: true, smokeTested: smoke.ok === true, adapterEndToEnd: false },
    smoke: smoke.ok ? { required: SMOKE_CHECKS } : { failed: smoke.failed || [], checks: smoke.checks || {} },
  };
  return cached;
}
