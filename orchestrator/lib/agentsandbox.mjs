#!/usr/bin/env node
/* Изоляция Codex-worker (Stage A fix5).

   fix4 оставлял в namespace Codex настоящие `/bin/bash`, `/bin/sh`,
   `/usr/bin/env` и `/usr/bin/node`, а границей считал подмену PATH. Здесь
   поток другой и граница техническая:

     orchestrator
       ├─ broker sandbox (--unshare-all, свой mount/pid/net namespace)
       │    └─ tool-broker.mjs  ← unix socket ← команды модели
       │         • нет /run/credentials, нет CODEX_HOME
       │         • нет сети (проверяется реальным connect при старте)
       │         • rw только workspace
       │
       └─ codex sandbox (--share-net: только канал к провайдеру)
            └─ codex exec
                 • /bin,/sbin,/usr/bin,/usr/sbin,/usr/local/bin* = tmpfs
                 • единственные файлы там — клиенты broker'а (bash/sh)
                 • PATH=/orch/bin, node только /orch/rt/node
                 • /run/credentials/codex — credentials Codex (bind, rw)
                 • workspace rw, всё остальное read-only/tmpfs

   Поэтому `/bin/bash -c ...`, `/bin/sh`, `/usr/bin/env bash`, прямой
   `/usr/bin/node` и `child_process` не обходят прокси: настоящих shell'ов и
   интерпретаторов в namespace нет, а клиент broker'а выполняет команду в
   namespace без сети и без credentials.

   Уровни доказательства (preflight): installed → smokeTested → adapterEndToEnd.
   Третий уровень — только подписанный machine-bound evidence от
   tools/agent-hostile-check.mjs --real (см. lib/evidence.mjs). */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { ORCH_ROOT } from './package.mjs';
import {
  ISOLATED_RUNNER_UNAVAILABLE, ISOLATION_UNPROVEN, backendDirExists, backendFileExists, backendMaskDirs,
  backendNode, sandboxEnvArgs, sandboxMountArgs, toBackendPath,
} from './sandbox.mjs';
import { toolEnv } from './envpolicy.mjs';
import { policyForTask } from './toolpolicy.mjs';
import { ALLOW_ATTACKS, DENIAL_CODES, DENY_ATTACKS } from './attackmatrix.mjs';
import {
  EVIDENCE_VERSION, MAX_EVIDENCE_AGE_MS, consumeNonce, currentBuildFingerprint, hostFingerprint,
  loadKey, payloadDigest, verifySignature,
} from './evidence.mjs';
import { GENESIS, chainEntry, verifyChain } from './journal.mjs';

export const AGENT_EVIDENCE = path.join(ORCH_ROOT, 'evidence', 'agent-isolation.json');
export const TOOL_PROXY = path.join(ORCH_ROOT, 'tools', 'tool-proxy.mjs');
export const TOOL_BROKER = path.join(ORCH_ROOT, 'tools', 'tool-broker.mjs');
export const TOOL_POLICY_MODULE = path.join(ORCH_ROOT, 'lib', 'toolpolicy.mjs');
export const JOURNAL_MODULE = path.join(ORCH_ROOT, 'lib', 'journal.mjs');

export const NODE_IN_SANDBOX = '/orch/rt/node';
export const BROKER_SOCKET = '/orch/ipc/broker.sock';
export const ISOLATED_CODEX_HOME = '/run/credentials/codex';
export const AGENT_PATH = '/orch/bin';
/* Оставлено для совместимости с диагностикой: это НЕ граница безопасности. */
export const PROXY_PATH = AGENT_PATH;

const BROKER_READY_TIMEOUT_MS = 30000;

/* Копия auth.json/config.toml в одноразовый каталог: настоящий ~/.codex
   остаётся нетронутым, а внутрь Codex-sandbox попадает только то, что нужно
   CLI. Для инструментов модели этот каталог не смонтирован вообще. */
export function prepareCodexHome({ source, dest } = {}) {
  const from = source || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!fs.existsSync(from)) {
    return { ok: false, code: 'AGENT_CREDENTIALS_UNAVAILABLE', detail: `codex home not found: ${from}` };
  }
  const authFile = path.join(from, 'auth.json');
  if (!fs.existsSync(authFile)) {
    return { ok: false, code: 'AGENT_CREDENTIALS_UNAVAILABLE', detail: `no ChatGPT session in ${from}; API-key mode is not used` };
  }
  const target = dest || fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-home-'));
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(authFile, path.join(target, 'auth.json'));
  try {
    fs.chmodSync(path.join(target, 'auth.json'), 0o600);
    fs.chmodSync(target, 0o700);
  } catch {
    /* Windows/ACL: режим не выставляется, каталог всё равно одноразовый */
  }
  for (const name of ['config.toml', 'config.json']) {
    const sourceFile = path.join(from, name);
    if (fs.existsSync(sourceFile)) fs.copyFileSync(sourceFile, path.join(target, name));
  }
  return { ok: true, dir: target };
}

/* Единственная точка удаления временного состояния. fix5 удалял только
   IPC-каталог, поэтому копия ChatGPT-сессии в /tmp/orch-codex-home-* оставалась
   на диске. Идемпотентна: вызывается из finally, adapter.finish() и
   process.on('exit'). */
export function removeAgentPath(dir, { backend = null } = {}) {
  if (!dir) return { ok: true, dir, removed: false };
  try {
    if (backend === 'wsl-bwrap') {
      const result = spawnSync('wsl.exe', ['-e', 'rm', '-rf', '--', String(dir)], {
        stdio: 'ignore', timeout: 30000, env: toolEnv(), shell: false,
      });
      if (result.status !== 0) return { ok: false, dir, detail: `wsl rm -rf exited ${result.status}` };
      return { ok: true, dir, removed: true };
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (fs.existsSync(dir)) return { ok: false, dir, detail: 'path still exists after removal' };
    return { ok: true, dir, removed: true };
  } catch (err) {
    return { ok: false, dir, detail: String(err.message || err) };
  }
}

export const discardCodexHome = (dir) => removeAgentPath(dir);

function createIpcDir(backend) {
  if (backend === 'wsl-bwrap') {
    const result = spawnSync('wsl.exe', ['-e', 'mktemp', '-d', '/tmp/orch-ipc.XXXXXX'], {
      encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], env: toolEnv(), shell: false,
    });
    const dir = String(result.stdout || '').trim();
    if (result.status !== 0 || !dir.startsWith('/tmp/')) {
      return { ok: false, code: ISOLATED_RUNNER_UNAVAILABLE, detail: `cannot create the broker socket directory in WSL: ${String(result.stderr || '').trim()}` };
    }
    return { ok: true, dir };
  }
  return { ok: true, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ipc-')) };
}

/* Нормализация — только для боевого argv Codex. Атаки передаются как есть:
   иначе `/usr/bin/node` превратился бы в защищённый `/orch/rt/node`, и тест
   перестал бы проверять то, что должен. */
const isHostNode = (token) => token === process.execPath
  || (/^[A-Za-z]:[\\/]/.test(token) && /(^|[\\/])node\.exe$/i.test(token));

function normalizeArgv(argv, backend, agent = false) {
  const out = [];
  for (const token of argv) {
    if (typeof token !== 'string') {
      out.push(token);
      continue;
    }
    if (agent && isHostNode(token)) {
      out.push(NODE_IN_SANDBOX);
      continue;
    }
    if (backend === 'wsl-bwrap' && /^[A-Za-z]:[\\/]/.test(token)) {
      const unix = toBackendPath(token, backend);
      out.push(unix);
      continue;
    }
    out.push(token);
  }
  return out;
}

/* Файлы, которые надо пробросить внутрь: Codex entrypoint на Linux лежит вне
   /usr, а на WSL — на /mnt/c. Каталог пакета монтируется целиком, иначе
   require/ELF-загрузка entrypoint'а не найдёт свои файлы. */
function packageDirOf(entry) {
  /* Монтируется весь scope @openai, а не только пакет codex: codex.js
     запускает нативный бинарник из соседнего @openai/codex-<platform> и ищет
     рядом codex-code-mode-host. Без соседей CLI падает внутри sandbox. */
  const marker = `${path.sep}node_modules${path.sep}@openai`;
  const index = String(entry).indexOf(marker);
  return index === -1 ? null : String(entry).slice(0, index + marker.length);
}

/* Codex обращается к провайдеру из namespace'а с сетью хоста, но без
   resolv.conf и корневых сертификатов TLS-запрос падает. Монтируются только
   файлы резолвера и CA, а не весь /etc. */
const PROVIDER_ETC_FILES = Object.freeze(['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/gai.conf']);
const PROVIDER_ETC_DIRS = Object.freeze(['/etc/ssl', '/etc/ca-certificates', '/etc/pki']);

function providerNetworkMounts(backend) {
  const mounts = [];
  for (const file of PROVIDER_ETC_FILES) {
    if (backendFileExists(backend, file)) mounts.push(['--ro-bind', file, file]);
  }
  for (const dir of PROVIDER_ETC_DIRS) {
    if (backendDirExists(backend, dir)) mounts.push(['--ro-bind', dir, dir]);
  }
  return mounts;
}

function extraFileMounts(codexEntry, backend, mounts) {
  if (!codexEntry) return;
  /* Один путь для обоих бэкендов: scope @openai, если он есть, иначе сам
     entrypoint. Иначе на Linux (bwrap) монтировался только codex.js, и
     нативный бинарник платформенного пакета оставался снаружи. */
  const wsl = backend === 'wsl-bwrap';
  const dirExists = (dir) => (wsl ? backendDirExists(backend, dir) : (() => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  })());
  const fileExists = (file) => (wsl ? backendFileExists(backend, file) : fs.existsSync(file));
  const entryUnix = toBackendPath(codexEntry, backend);
  const packageDir = packageDirOf(codexEntry);
  if (packageDir) {
    const packageUnix = toBackendPath(packageDir, backend);
    if (dirExists(packageUnix)) {
      mounts.push(['--ro-bind', packageUnix, packageUnix]);
      return;
    }
  }
  if (fileExists(entryUnix)) mounts.push(['--ro-bind', entryUnix, entryUnix]);
}

/* Аргументы боевого запуска НЕ монтируются по одному: fix4 так возвращал в
   namespace настоящие `/bin/bash` и `/usr/bin/node` поверх tmpfs, чем сам
   открывал абсолютный обход. Внутри уже есть /orch/bin (клиенты broker'а),
   /orch/rt/node и каталог Codex; всё остальное — либо workspace, либо отказ. */

function stubSource() {
  /* Shebang указывает на bind node внутри sandbox: /usr/bin/env недоступен
     намеренно, поэтому `#!/usr/bin/env node` здесь не годится. */
  return ['#!/orch/rt/node', "import('/orch/lib/tool-proxy.mjs');", ''].join('\n');
}

export function buildAgentPlan({
  sandbox,
  workspace,
  logDir,
  task,
  credentialsDir = null,
  codexEntry = null,
  extraEnv = {},
  tmpRoot = null,
} = {}) {
  if (!sandbox || sandbox.available !== true || !sandbox.levels || sandbox.levels.smokeTested !== true) {
    return {
      ok: false,
      code: ISOLATED_RUNNER_UNAVAILABLE,
      detail: `codex worker needs a smoke-tested isolation backend: ${(sandbox && sandbox.detail) || 'none detected'}`,
    };
  }
  if (!workspace || !logDir) {
    return { ok: false, code: 'AGENT_PLAN_INCOMPLETE', detail: 'agent plan requires a workspace and a log directory' };
  }
  const backend = sandbox.backend;
  const workspaceUnix = toBackendPath(workspace, backend);
  const logUnix = toBackendPath(logDir, backend);
  const nodePath = backendNode(backend);
  if (!nodePath) {
    return { ok: false, code: ISOLATED_RUNNER_UNAVAILABLE, detail: 'no node interpreter inside the isolation backend' };
  }
  const ipc = createIpcDir(backend);
  if (!ipc.ok) return ipc;
  const ipcUnix = ipc.dir;

  const scratch = tmpRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-plan-'));
  fs.mkdirSync(scratch, { recursive: true });
  const policyFile = path.join(scratch, 'tool-policy.json');
  fs.writeFileSync(policyFile, `${JSON.stringify(policyForTask(task), null, 2)}\n`);
  fs.mkdirSync(logDir, { recursive: true });

  const binDir = path.join(scratch, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const stub = stubSource();
  for (const name of ['bash', 'sh']) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, stub);
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      /* Windows/ACL: файл всё равно во временном разделе, доступном WSL */
    }
  }

  const maskDirs = backendMaskDirs(backend);
  const staticMounts = [
    ['--dir', '/orch'],
    ['--dir', '/orch/bin'],
    ['--dir', '/orch/lib'],
    ['--dir', '/orch/rt'],
    ['--dir', '/orch/ipc'],
    ['--ro-bind', toBackendPath(path.join(binDir, 'bash'), backend), '/orch/bin/bash'],
    ['--ro-bind', toBackendPath(path.join(binDir, 'sh'), backend), '/orch/bin/sh'],
    ['--ro-bind', toBackendPath(nodePath, backend), NODE_IN_SANDBOX],
    ['--ro-bind', toBackendPath(TOOL_PROXY, backend), '/orch/lib/tool-proxy.mjs'],
    ['--ro-bind', toBackendPath(TOOL_POLICY_MODULE, backend), '/orch/lib/toolpolicy.mjs'],
    ['--ro-bind', toBackendPath(JOURNAL_MODULE, backend), '/orch/lib/journal.mjs'],
    ['--ro-bind', toBackendPath(policyFile, backend), '/orch/policy.json'],
    ['--bind', ipcUnix, '/orch/ipc'],
    ['--dir', '/run'],
    ['--tmpfs', '/run/credentials'],
    ['--dir', ISOLATED_CODEX_HOME],
  ];

  /* Порядок важен: сначала tmpfs на каждый каталог исполняемых файлов, затем
     клиенты broker'а. Настоящих shell'ов и node там не остаётся. */
  for (const dir of maskDirs) staticMounts.push(['--tmpfs', dir]);
  for (const dir of maskDirs) {
    staticMounts.push(['--ro-bind', toBackendPath(path.join(binDir, 'bash'), backend), `${dir}/bash`]);
    staticMounts.push(['--ro-bind', toBackendPath(path.join(binDir, 'sh'), backend), `${dir}/sh`]);
  }
  if (credentialsDir) staticMounts.push(['--bind', toBackendPath(credentialsDir, backend), ISOLATED_CODEX_HOME]);
  staticMounts.push(...providerNetworkMounts(backend));

  const baseEnv = {
    PATH: AGENT_PATH,
    HOME: '/home/sandbox',
    TMPDIR: '/tmp',
    TMP: '/tmp',
    CODEX_HOME: ISOLATED_CODEX_HOME,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...extraEnv,
  };

  const unixOf = (value) => (value && backend === 'wsl-bwrap' ? toBackendPath(value, backend) : value);

  const plan = {
    ok: true,
    backend,
    workspace,
    workspaceUnix,
    scratch,
    policyFile,
    credentialsDir,
    ipcDir: ipc.dir,
    ipcUnix,
    nodePath,
    cleaned: null,
    codexEntry,
    journalPath: path.join(logDir, 'tool-calls.jsonl'),
    brokerEntries: [],
    broker: null,
    network: 'split: provider only in the Codex namespace, none for tools',
    wrap(argv, { agent = false } = {}) {
      const mounts = staticMounts.map((mount) => mount.slice());
      extraFileMounts(codexEntry, backend, mounts);
      const normalized = normalizeArgv(argv, backend, agent);
      const args = [
        ...sandboxMountArgs({ workspaceUnix, network: 'provider', extraMounts: mounts }),
        ...sandboxEnvArgs(baseEnv),
        '--',
        ...normalized,
      ];
      return {
        ok: true,
        cmd: backend === 'wsl-bwrap' ? 'wsl.exe' : 'bwrap',
        args: backend === 'wsl-bwrap' ? ['-e', 'bwrap', ...args] : args,
        env: toolEnv(),
        backend,
        journalPath: plan.journalPath,
      };
    },
    brokerSpec() {
      const mounts = [
        ['--dir', '/orch'], ['--dir', '/orch/lib'], ['--dir', '/orch/rt'], ['--dir', '/orch/ipc'],
        ['--ro-bind', toBackendPath(TOOL_BROKER, backend), '/orch/broker.mjs'],
        ['--ro-bind', toBackendPath(TOOL_POLICY_MODULE, backend), '/orch/lib/toolpolicy.mjs'],
        ['--ro-bind', toBackendPath(JOURNAL_MODULE, backend), '/orch/lib/journal.mjs'],
        ['--ro-bind', toBackendPath(policyFile, backend), '/orch/policy.json'],
        ['--ro-bind', toBackendPath(nodePath, backend), NODE_IN_SANDBOX],
        ['--bind', ipcUnix, '/orch/ipc'],
      ];
      const args = [
        ...sandboxMountArgs({ workspaceUnix, network: 'none', extraMounts: mounts }),
        ...sandboxEnvArgs({
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: '/home/sandbox',
          TMPDIR: '/tmp',
          TMP: '/tmp',
          LANG: 'C.UTF-8',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        }),
        '--',
        NODE_IN_SANDBOX, '/orch/broker.mjs',
        '--workspace', workspaceUnix,
        '--policy', '/orch/policy.json',
        '--socket', BROKER_SOCKET,
      ];
      return {
        cmd: backend === 'wsl-bwrap' ? 'wsl.exe' : 'bwrap',
        args: backend === 'wsl-bwrap' ? ['-e', 'bwrap', ...args] : args,
        env: toolEnv(),
      };
    },
    async startBroker({ timeoutMs = BROKER_READY_TIMEOUT_MS } = {}) {
      if (plan.broker && plan.broker.ready) return { ok: true, pid: plan.broker.child.pid };
      const spec = plan.brokerSpec();
      const child = spawn(spec.cmd, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spec.env,
        shell: false,
        windowsHide: true,
      });
      plan.broker = { child, ready: false };
      return new Promise((resolve) => {
        let buffer = '';
        let stderr = '';
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!result.ok) {
            plan.broker = null;
            try { child.kill('SIGKILL'); } catch { /* уже завершился */ }
          }
          resolve(result);
        };
        const timer = setTimeout(() => finish({
          ok: false,
          code: 'ISOLATED_TOOL_CHANNEL_UNAVAILABLE',
          detail: `broker did not become ready within ${timeoutMs} ms: ${stderr.trim().slice(-300)}`,
        }), timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.trim().startsWith('{')) continue;
            let item;
            try {
              item = JSON.parse(line);
            } catch {
              continue;
            }
            if (item.broker === 'ready') {
              plan.broker.ready = true;
              plan.broker.pid = child.pid;
              finish({ ok: true, pid: child.pid, ready: item });
            } else if (item.broker === 'refused') {
              finish({ ok: false, code: item.code || 'ISOLATED_TOOL_CHANNEL_UNAVAILABLE', detail: item.detail || 'broker refused to start' });
            } else if (item.hash) {
              /* Единственный писатель журнала — broker; оркестратор только
                 сохраняет полученные звенья. */
              plan.brokerEntries.push(item);
              try {
                fs.appendFileSync(plan.journalPath, `${JSON.stringify(item)}\n`);
              } catch {
                /* журнал уже принят в память; потеря файла не делает команду разрешённой */
              }
            }
          }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (err) => finish({
          ok: false,
          code: 'ISOLATED_TOOL_CHANNEL_UNAVAILABLE',
          detail: `cannot start the broker sandbox: ${err.message || err}`,
        }));
        child.on('exit', (code) => {
          plan.broker = null;
          finish({
            ok: false,
            code: 'ISOLATED_TOOL_CHANNEL_UNAVAILABLE',
            detail: `broker exited ${code} before it was ready: ${stderr.trim().slice(-300)}`,
          });
        });
      });
    },
    stopBroker() {
      const broker = plan.broker;
      plan.broker = null;
      if (!broker) return;
      try { broker.child.kill('SIGTERM'); } catch { /* уже завершился */ }
      const hard = setTimeout(() => {
        try { broker.child.kill('SIGKILL'); } catch { /* уже завершился */ }
      }, 3000);
      if (hard.unref) hard.unref();
    },
    /* Дать уже записанным звеньям дойти до процесса, не останавливая broker:
       нужно, чтобы отделить журнал матрицы от журнала Codex. */
    async flushBroker({ waitMs = 120 } = {}) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return plan.brokerEntries.length;
    },
    /* spawnSync блокирует event loop: stdout broker'а доходит только после
       возврата в цикл. Перед чтением журнала его надо дождаться, иначе
       доказательство выглядит пустым при живом канале. */
    async drainBroker({ timeoutMs = 8000 } = {}) {
      const broker = plan.broker;
      if (!broker) return { ok: true, entries: plan.brokerEntries.length };
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        broker.child.once('close', finish);
        plan.stopBroker();
      });
      return { ok: true, entries: plan.brokerEntries.length };
    },
    /* Удаляет ВСЁ временное: broker socket, IPC-каталог, scratch (policy и
       stub-клиенты), одноразовый CODEX_HOME с auth.json. Возвращает отчёт,
       который попадает в evidence, поэтому «удалено» — проверяемый факт, а не
       намерение. Повторный вызов возвращает тот же отчёт. */
    cleanup() {
      if (plan.cleaned) return plan.cleaned;
      plan.stopBroker();
      if (plan.exitCleanup) {
        try { process.removeListener('exit', plan.exitCleanup); } catch { /* уже снят */ }
      }
      const removed = [];
      const failed = [];
      const targets = [
        { label: 'broker-socket', dir: path.posix.join(ipcUnix, 'broker.sock') },
        { label: 'ipc', dir: ipcUnix },
        { label: 'scratch', dir: unixOf(scratch) },
        { label: 'codex-home', dir: unixOf(credentialsDir) },
      ];
      for (const target of targets) {
        const result = removeAgentPath(target.dir, { backend });
        if (!result.ok) failed.push({ label: target.label, detail: result.detail });
        else if (result.removed) removed.push(target.label);
      }
      const authCopyRemoved = !credentialsDir || !fs.existsSync(credentialsDir);
      plan.cleaned = { ok: failed.length === 0 && authCopyRemoved, removed, failed, authCopyRemoved };
      return plan.cleaned;
    },
  };

  /* Процесс может завершиться исключением или через process.exit(): 'exit'
     срабатывает в обоих случаях, а удаление синхронное. Сигналы (SIGTERM)
     обрабатывает harness, который владеет одноразовым CODEX_HOME. */
  plan.exitCleanup = () => {
    try { plan.cleanup(); } catch { /* процесс уже завершается */ }
  };
  process.once('exit', plan.exitCleanup);
  return plan;
}

/* Журнал прокси — единственное место, где видно, что модель пыталась
   выполнить. Читается после прогона и попадает в evidence/журнал. */
export function readToolJournal(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((item) => item && typeof item === 'object');
  } catch {
    return [];
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Человекочитаемая разница manifest'ов: какие runtime-файлы изменены,
   добавлены или удалены. Хэши в detail не печатаются целиком. */
function manifestDiff(recorded, current) {
  const toMap = (files) => new Map((Array.isArray(files) ? files : []).map((item) => [item.path, item.sha256]));
  const before = toMap(recorded);
  const after = toMap(current);
  const changed = [];
  for (const [file, hash] of before) {
    if (!after.has(file)) changed.push(`${file} removed`);
    else if (after.get(file) !== hash) changed.push(`${file} changed`);
  }
  for (const file of after.keys()) {
    if (!before.has(file)) changed.push(`${file} added`);
  }
  if (!changed.length) return null;
  const head = changed.slice(0, 4).join(', ');
  return changed.length > 4 ? `${head}, +${changed.length - 4} more` : head;
}

/* Уровень 3. Любое расхождение — agent_isolation_unproven, а не «наверное
   этот файл настоящий». Ручной JSON без подписи, nonce и привязки к сборке
   отклоняется на первом же шаге. */
export function isolationEvidence(file = AGENT_EVIDENCE, {
  backend = null,
  now = Date.now(),
  env = process.env,
  build = null,
  host = null,
} = {}) {
  const relative = path.relative(ORCH_ROOT, file).split(path.sep).join('/');
  const fail = (detail) => ({ ok: false, code: ISOLATION_UNPROVEN, detail, file });
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fail(`no machine-bound end-to-end evidence for the real Codex worker; run \`node tools/agent-hostile-check.mjs --real\` (${relative})`);
  }

  if (evidence.version !== EVIDENCE_VERSION) return fail(`evidence version ${evidence.version} is not ${EVIDENCE_VERSION} (${relative})`);
  if (evidence.ok !== true || evidence.mode !== 'real' || evidence.harness !== 'agent-hostile-check') {
    return fail(`evidence was not produced by the real hostile harness (${relative})`);
  }
  if (evidence.adapter !== 'codex-cli') return fail(`evidence adapter is not codex-cli (${relative})`);
  if (typeof evidence.threadId !== 'string' || evidence.threadId.length < 8) return fail('evidence has no real Codex thread id');
  if (!evidence.backend) return fail('evidence has no isolation backend');
  if (backend && evidence.backend !== backend) {
    return fail(`evidence was produced on backend ${evidence.backend}, current backend is ${backend}`);
  }

  const at = Date.parse(evidence.at);
  if (!Number.isFinite(at) || at - now > 5 * 60 * 1000 || now - at > MAX_EVIDENCE_AGE_MS) {
    return fail(`evidence timestamp ${evidence.at || 'missing'} is stale or in the future`);
  }

  const expectedHost = host || hostFingerprint();
  if (!evidence.host || evidence.host.fingerprint !== expectedHost) {
    return fail('evidence host fingerprint does not match this machine');
  }

  const current = build || currentBuildFingerprint({ backend: evidence.backend, env });
  if (!evidence.build) return fail('evidence has no build fingerprint');

  /* fix6: привязка — весь runtime manifest, а не восемь выбранных файлов.
     Один изменённый байт в adapters/, engine, prompts, envpolicy или схеме
     меняет rootHash. */
  const manifest = evidence.build.manifest;
  if (!manifest || typeof manifest.rootHash !== 'string' || !Array.isArray(manifest.files)) {
    return fail('evidence has no runtime manifest: level 3 must be bound to the whole orchestrator runtime closure');
  }
  if (!current.manifest || typeof current.manifest.rootHash !== 'string') {
    return fail('cannot compute the runtime manifest for this tree (a runtime file is missing)');
  }

  const evidenceHasGit = evidence.build.commit !== null && evidence.build.commit !== undefined;
  const treeHasGit = current.commit !== null && current.commit !== undefined;
  if (evidenceHasGit !== treeHasGit) {
    return fail('evidence git binding does not match this tree (a commit exists on one side only)');
  }
  if (evidenceHasGit && evidence.build.commit !== current.commit) {
    return fail(`evidence was built from commit ${String(evidence.build.commit).slice(0, 12)}, current commit is ${String(current.commit).slice(0, 12)}`);
  }
  if (evidenceHasGit) {
    if (evidence.build.dirty !== false || evidence.build.dirtyFiles !== 0) {
      return fail(`evidence was produced from a dirty working tree (${evidence.build.dirtyFiles} files); only a clean commit can open level 3`);
    }
    if (current.dirty !== false || current.dirtyFiles !== 0) {
      return fail(`the working tree is dirty (${current.dirtyFiles} files); commit or stash the orchestrator changes before trusting level-3 evidence`);
    }
  } else if (evidence.build.dirty !== null && evidence.build.dirty !== undefined) {
    return fail('evidence claims a git state for a tree without git history');
  }

  if (current.manifest.rootHash !== manifest.rootHash) {
    const changed = manifestDiff(manifest.files, current.manifest.files);
    return fail(`runtime manifest does not match this build${changed ? ` (${changed})` : ''}: one changed runtime file invalidates the evidence`);
  }
  if (manifest.count !== current.manifest.count) {
    return fail(`runtime manifest lists ${manifest.count} files, current tree has ${current.manifest.count}`);
  }

  if (!same(evidence.build.bwrap, current.bwrap)) return fail('evidence bwrap fingerprint does not match this machine');
  if (!same(evidence.build.codex, current.codex)) return fail('evidence Codex fingerprint does not match the installed CLI');
  if (!evidence.build.bwrap || !evidence.build.bwrap.sha256) return fail('evidence has no bwrap SHA256');

  /* fix6: копия auth.json должна быть удалена, и harness обязан это
     засвидетельствовать. */
  if (!evidence.cleanup || evidence.cleanup.ok !== true || evidence.cleanup.authCopyRemoved !== true) {
    return fail('evidence does not prove that the temporary CODEX_HOME with auth.json was removed');
  }

  const attacks = Array.isArray(evidence.attacks) ? evidence.attacks : [];
  if (!attacks.length) return fail('evidence has no attack results');
  const seen = new Set();
  for (const item of attacks) {
    const id = item && item.id;
    if (typeof id !== 'string') return fail('evidence attack without an id');
    if (!DENY_ATTACKS.includes(id) && !ALLOW_ATTACKS.includes(id)) return fail(`evidence contains unknown attack id: ${id}`);
    if (seen.has(id)) return fail(`evidence repeats attack id: ${id}`);
    seen.add(id);
  }
  const missing = [...DENY_ATTACKS, ...ALLOW_ATTACKS].filter((id) => !seen.has(id));
  if (missing.length) return fail(`evidence is missing mandatory attacks: ${missing.join(', ')}`);
  for (const id of DENY_ATTACKS) {
    const item = attacks.find((entry) => entry.id === id);
    const technical = item.technical || {};
    if (item.denied !== true || technical.exitCode === 0 || !DENIAL_CODES.includes(technical.code)) {
      return fail(`attack ${id} was not technically denied (exit ${technical.exitCode}, code ${technical.code || 'none'})`);
    }
  }
  for (const id of ALLOW_ATTACKS) {
    const item = attacks.find((entry) => entry.id === id);
    const technical = item.technical || {};
    if (item.ok !== true || technical.exitCode !== 0) {
      return fail(`allowed operation ${id} did not succeed (exit ${technical.exitCode})`);
    }
  }

  const journal = evidence.journal || {};
  const chain = verifyChain(journal.entries);
  if (!chain.ok) return fail(`tool journal hash chain is broken at entry ${chain.index}: ${chain.reason}`);
  if (!chain.length) return fail('tool journal is empty: the tool channel was never exercised');
  if (journal.head !== chain.head) return fail('tool journal head does not match its entries');

  if (!evidence.leaks || !Array.isArray(evidence.leaks.found) || evidence.leaks.found.length) {
    return fail('evidence reports secret leaks from the temporary auth.json copy');
  }
  if (!Array.isArray(evidence.leaks.scanned) || !evidence.leaks.scanned.length) {
    return fail('evidence does not list the hashed auth.json secrets it scanned for');
  }

  const key = loadKey({ env });
  if (!key.ok) return fail(key.detail);
  const signature = verifySignature(evidence, { key: key.key });
  if (!signature.ok) return fail(`evidence signature is not verifiable: ${signature.detail}`);

  const nonce = consumeNonce(evidence.nonce, payloadDigest(evidence), { env, now });
  if (!nonce.ok) return fail(`evidence nonce rejected: ${nonce.detail}`);

  return {
    ok: true,
    file,
    threadId: evidence.threadId,
    backend: evidence.backend,
    at: evidence.at,
    attacks: attacks.length,
    denied: attacks.filter((item) => item.denied === true).length,
    allowed: attacks.filter((item) => item.ok === true).length,
    commit: evidence.build.commit,
    build: evidence.build,
    host: evidence.host,
    keyId: key.keyId,
  };
}

/* Сборка evidence из результатов прогона: подпись, nonce, хэш-цепочка.
   Используется только tools/agent-hostile-check.mjs --real. */
export function buildEvidence({ nonce, backend, threadId, exitCode, build, host, results, journalEntries, leaks, cleanup = null }) {
  let prev = GENESIS;
  const entries = (journalEntries || []).map((entry) => {
    const chained = chainEntry(entry, prev);
    prev = chained.hash;
    return chained;
  });
  return {
    version: EVIDENCE_VERSION,
    ok: true,
    mode: 'real',
    harness: 'agent-hostile-check',
    adapter: 'codex-cli',
    backend,
    at: new Date().toISOString(),
    nonce,
    host,
    build,
    threadId,
    codex: { exitCode },
    cleanup,
    attacks: results,
    journal: { entries, head: prev, length: entries.length },
    leaks,
  };
}
