#!/usr/bin/env node
/* Tool broker (Stage A fix5).

   Единственный исполнитель команд модели. Запускается в ОТДЕЛЬНОМ sandbox:
   свой mount/network namespace, `--unshare-all`, без `/run/credentials`, без
   CODEX_HOME, без provider-сети, HOME — пустой tmpfs. Поэтому даже успешная
   команда не может ни выйти в сеть, ни прочитать auth.json Codex.

   Codex в своём namespace не имеет ни одного настоящего shell/интерпретатора:
   `/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`, `/usr/local/bin*` заменены tmpfs, в
   котором лежат только клиенты `/bin/bash` и `/bin/sh`, а PATH ведёт в
   `/orch/bin`. Любая попытка исполнения — по PATH или абсолютным путём —
   приходит сюда по unix-сокету, а не в реальный shell.

   Журнал пишется ТОЛЬКО в stdout broker'а: дочерние команды получают свои
   pipes и не могут ни дописать, ни переписать строку. Каждая запись — звено
   хэш-цепочки (lib/journal.mjs), head попадает в evidence.

   Fail-closed: если self-check показывает видимые credentials или доступную
   сеть, broker не открывает сокет и завершается с кодом 3. */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { chainEntry } from '/orch/lib/journal.mjs';
import { decideToolPolicy } from '/orch/lib/toolpolicy.mjs';

const SOCKET = '/orch/ipc/broker.sock';
const POLICY_FILE = '/orch/policy.json';
const CREDENTIALS = '/run/credentials';
const MAX_OUTPUT = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};

const WORKSPACE = path.resolve(flag('--workspace', process.cwd()));
const POLICY_PATH = flag('--policy', POLICY_FILE);
const SOCKET_PATH = flag('--socket', SOCKET);

function readPolicy() {
  try {
    return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  } catch {
    /* Нет политики — значит нет и разрешения. */
    return { enforce: true, allow: [], missing: true };
  }
}

const say = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

let seq = 0;
let prev = 'genesis';

function journal(base) {
  seq += 1;
  const entry = chainEntry({ seq, at: new Date().toISOString(), ...base }, prev);
  prev = entry.hash;
  say(entry);
  return entry;
}

function fail(code, detail) {
  say({ broker: 'refused', code, detail: String(detail || '').slice(0, 400) });
  process.exitCode = 3;
}

function commandEnv() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/sandbox',
    TMPDIR: '/tmp',
    TMP: '/tmp',
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

function insideWorkspace(cwd) {
  const resolved = path.resolve(cwd || WORKSPACE);
  if (resolved === WORKSPACE) return resolved;
  return resolved.startsWith(`${WORKSPACE}${path.sep}`) ? resolved : WORKSPACE;
}

function runCommand(command, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: commandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => (current.length > MAX_OUTPUT ? current : (current + chunk).slice(0, MAX_OUTPUT));
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk.toString('utf8')); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk.toString('utf8')); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* процесс уже мог завершиться */ }
    }, COMMAND_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 126, stdout, stderr: `${stderr}${err.code || err.name}: ${err.message}`, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === 'number' ? code : 126,
        stdout,
        stderr: timedOut ? `${stderr}\nETIMEDOUT: command exceeded ${COMMAND_TIMEOUT_MS} ms` : stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

async function handle(request) {
  const command = String(request.command || '');
  const cwd = insideWorkspace(request.cwd);
  const policy = readPolicy();
  const decision = decideToolPolicy(command, policy);
  if (!decision.allow) {
    journal({ command, cwd, allow: false, code: decision.code, reason: decision.reason || null, exitCode: 126, durationMs: 0 });
    return { id: request.id, exitCode: 126, code: decision.code, stdout: '', stderr: `policy: ${decision.code}: ${decision.reason || 'command denied'}\n` };
  }
  const result = await runCommand(command, cwd);
  journal({
    command,
    cwd,
    allow: true,
    code: result.exitCode === 0 ? 'OK' : (result.timedOut ? 'ETIMEDOUT' : `EXIT_${result.exitCode}`),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  });
  return { id: request.id, exitCode: result.exitCode, code: result.exitCode === 0 ? 'OK' : `EXIT_${result.exitCode}`, stdout: result.stdout, stderr: result.stderr };
}

/* Self-check — часть протокола, а не лог: без него broker не обслуживает ни
   одной команды. Сеть проверяется реальным connect, credentials — реальным
   чтением каталога. */
function networkAbsent() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    let settled = false;
    const finish = (absent, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ absent, detail });
    };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(false, 'connected'));
    socket.once('timeout', () => finish(true, 'ETIMEDOUT'));
    socket.once('error', (err) => finish(true, err.code || err.message));
  });
}

async function main() {
  if (fs.existsSync(CREDENTIALS)) {
    fail('BROKER_CREDENTIALS_VISIBLE', `${CREDENTIALS} is mounted in the tool namespace`);
    return 3;
  }
  const network = await networkAbsent();
  if (!network.absent) {
    fail('ISOLATED_TOOL_NET_UNAVAILABLE', `the tool namespace can reach the network: ${network.detail}`);
    return 3;
  }
  try {
    fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* сокета ещё нет */ }
  } catch (err) {
    fail('ISOLATED_TOOL_CHANNEL_UNAVAILABLE', `cannot prepare ${SOCKET_PATH}: ${err.message || err}`);
    return 3;
  }

  let queue = Promise.resolve();
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        if (request.op === 'ping') {
          socket.write(`${JSON.stringify({ id: request.id, pong: true })}\n`);
          continue;
        }
        queue = queue
          .then(() => handle(request))
          .then((response) => socket.write(`${JSON.stringify(response)}\n`))
          .catch((err) => socket.write(`${JSON.stringify({ id: request.id, exitCode: 126, code: 'ISOLATED_TOOL_CHANNEL_UNAVAILABLE', stderr: `policy: ISOLATED_TOOL_CHANNEL_UNAVAILABLE: ${err.message || err}\n` })}\n`));
      }
    });
    socket.on('error', () => { /* клиент мог умереть вместе с командой */ });
  });

  server.on('error', (err) => {
    fail('ISOLATED_TOOL_CHANNEL_UNAVAILABLE', `cannot listen on ${SOCKET_PATH}: ${err.message || err}`);
    process.exit(3);
  });

  const stop = () => {
    try { server.close(); } catch { /* уже закрыт */ }
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* уже удалён */ }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  server.listen(SOCKET_PATH, () => {
    say({ broker: 'ready', pid: process.pid, socket: SOCKET_PATH, workspace: WORKSPACE, credentialsVisible: false, networkAbsent: true, policy: POLICY_PATH });
  });
  return null;
}

main().then((code) => {
  if (typeof code === 'number') process.exitCode = code;
}).catch((err) => {
  fail('ISOLATED_TOOL_CHANNEL_UNAVAILABLE', err && err.message ? err.message : err);
  process.exitCode = 3;
});
