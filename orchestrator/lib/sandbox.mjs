#!/usr/bin/env node
/* OS-sandbox для выполнения тестовых команд (Stage A fix3).
   Реальный режим не запускает код агента обычным spawnSync: команда уходит в
   bubblewrap (Linux) или в bubblewrap внутри WSL2 (Windows). Если backend не
   найден, реальный цикл не начинается — ISOLATED_RUNNER_UNAVAILABLE.

   Гарантии backend'а:
   - смонтирован только workspace (rw), системные каталоги — read-only;
   - своя пустая ФС /tmp и пустой /home (tmpfs), HOME=/home/sandbox;
   - сеть отсутствует (--unshare-all отключает сетевой namespace);
   - нет SSH_AUTH_SOCK, docker.sock, production-каталогов и device mounts;
   - PID namespace, лимиты nproc/память/CPU/размер файла и внешний тайм-аут;
   - окружение очищено (--clearenv) и заполняется только allowlist'ом;
   - после завершения среда уничтожается (--die-with-parent). */

import { spawnSync } from 'node:child_process';

import { toolEnv } from './envpolicy.mjs';

export const ISOLATED_RUNNER_UNAVAILABLE = 'ISOLATED_RUNNER_UNAVAILABLE';

export const LIMITS = Object.freeze({
  nproc: 256,
  addressSpaceKb: 2 * 1024 * 1024,
  cpuSeconds: 120,
  fileSizeKb: 64 * 1024,
  hostTimeoutMs: 180000,
});

let cached = null;

const WIN = process.platform === 'win32';

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

function wslProbe() {
  const probe = [
    'command -v bwrap >/dev/null || exit 3',
    'bwrap --unshare-all --die-with-parent',
    '--ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64',
    '--proc /proc --dev /dev -- /bin/true',
  ].join(' ');
  const result = spawnSync('wsl.exe', ['-e', 'bash', '-c', probe], {
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: toolEnv(),
    shell: false,
  });
  return { ok: result.status === 0, detail: `${result.status}: ${String(result.stderr || '').trim().slice(0, 200)}` };
}

/* Определение backend один раз на процесс. Возвращает либо рабочий backend,
   либо явную причину отказа — молчаливого fallback на spawnSync нет. */
export function detectSandbox({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const tried = [];
  if (WIN) {
    if (!hasCommand('wsl.exe')) {
      tried.push('wsl: not found');
    } else {
      const probe = wslProbe();
      if (probe.ok) {
        cached = { available: true, backend: 'wsl-bwrap', detail: 'bubblewrap inside WSL2', tried };
        return cached;
      }
      tried.push(`wsl-bwrap: ${probe.detail}`);
    }
  } else if (hasCommand('bwrap')) {
    cached = { available: true, backend: 'bwrap', detail: 'bubblewrap', tried };
    return cached;
  } else {
    tried.push('bwrap: not found');
  }
  cached = {
    available: false,
    backend: null,
    code: ISOLATED_RUNNER_UNAVAILABLE,
    detail: tried.join('; ') || 'no isolation backend',
    tried,
  };
  return cached;
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

/* Пути внутри sandbox — абсолютные и уже переведённые в Unix-вид. */
function bwrapArgs(workspaceUnix, argv) {
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/home',
    '--dir', '/home/sandbox',
    '--bind', workspaceUnix, workspaceUnix,
    '--chdir', workspaceUnix,
    '--clearenv',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'HOME', '/home/sandbox',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'TMP', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'NO_COLOR', '1',
    '--setenv', 'FORCE_COLOR', '0',
    '--',
    'bash', '-c', limitScript(), 'orch-sandbox', ...argv,
  ];
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

export function sandboxRun({ workspace, argv, timeoutMs = LIMITS.hostTimeoutMs, sandbox = detectSandbox() }) {
  if (!sandbox.available) {
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
  const workspaceUnix = sandbox.backend === 'wsl-bwrap' ? toWslPath(workspace) : workspace;
  const finalArgv = hardenNodeArgv(argv, workspaceUnix);
  const args = bwrapArgs(workspaceUnix, finalArgv);
  const command = sandbox.backend === 'wsl-bwrap' ? 'wsl.exe' : 'bwrap';
  const commandArgs = sandbox.backend === 'wsl-bwrap' ? ['-e', 'bwrap', ...args] : args;
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: toolEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    exitCode: typeof result.status === 'number' ? result.status : -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    sandboxed: true,
    backend: sandbox.backend,
    durationMs: Date.now() - started,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
  };
}
