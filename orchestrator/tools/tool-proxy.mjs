#!/usr/bin/env node
/* Tool proxy — клиент broker'а (Stage A fix5).

   Этот файл больше не исполняет команды и ничего не маскирует: он только
   передаёт разобранный argv в broker по unix-сокету и возвращает его
   результат. Исполнение происходит в ДРУГОМ namespace (tools/tool-broker.mjs):
   без сети, без /run/credentials, без CODEX_HOME.

   Монтируется как `/orch/bin/bash`, `/orch/bin/sh` и как `/bin/bash`,
   `/bin/sh`, `/usr/bin/bash`, `/usr/bin/sh` внутри namespace Codex. Поэтому
   абсолютный путь не обходит прокси: настоящих shell'ов в namespace нет
   вообще, а всё остальное (`/usr/bin/env`, `/usr/bin/node`) отсутствует.

   Fail-closed: нет сокета или broker отказал — команда не выполняется,
   возвращается ISOLATED_TOOL_CHANNEL_UNAVAILABLE (exit 126). Прежние
   `mount ... || true` удалены вместе с самим маскированием: маскирование
   теперь делает bwrap, и его ошибка завершает запуск. */

import fs from 'node:fs';
import net from 'node:net';

const SOCKET = '/orch/ipc/broker.sock';
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RESPONSE = 8 * 1024 * 1024;

/* `bash -lc "cmd"`, `bash -c cmd`, `bash -l -c cmd`, `bash script.sh`. */
export function parseShellArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)) return { mode: 'command', command: args[i + 1] ?? '', args };
    if (token === '-c') return { mode: 'command', command: args[i + 1] ?? '', args };
    if (token.startsWith('-')) continue;
    return { mode: 'script', script: token, args: args.slice(i + 1), argv: args };
  }
  return { mode: 'empty', command: '', args };
}

function unavailable(detail) {
  process.stderr.write(`policy: ISOLATED_TOOL_CHANNEL_UNAVAILABLE: ${detail}\n`);
  process.exitCode = 126;
}

function readScript(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`policy: TOOL_COMMAND_NOT_ALLOWED: cannot read script ${file}: ${err.code || err.message}\n`);
    process.exitCode = 126;
    return null;
  }
}

export function requestFor(argv) {
  const parsed = parseShellArgs(argv);
  if (parsed.mode === 'command') return { command: parsed.command };
  if (parsed.mode === 'script') {
    const source = readScript(parsed.script);
    if (source === null) return null;
    return { command: source };
  }
  return { command: '' };
}

function main() {
  const request = requestFor(process.argv.slice(2));
  if (!request) return 126;
  const id = `${process.pid}-${Date.now()}`;
  const socket = net.connect(SOCKET);
  let buffer = '';
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.destroy();
    unavailable(`broker did not answer within ${REQUEST_TIMEOUT_MS} ms`);
  }, REQUEST_TIMEOUT_MS);

  const finish = (response) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    if (response.stdout) process.stdout.write(String(response.stdout));
    if (response.stderr) process.stderr.write(String(response.stderr));
    process.exitCode = typeof response.exitCode === 'number' ? response.exitCode : 126;
  };

  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ id, cwd: process.cwd(), command: request.command })}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_RESPONSE) {
      finish({ exitCode: 126, stderr: 'policy: ISOLATED_TOOL_CHANNEL_UNAVAILABLE: response too large\n' });
      return;
    }
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      try {
        finish(JSON.parse(line));
      } catch {
        finish({ exitCode: 126, stderr: 'policy: ISOLATED_TOOL_CHANNEL_UNAVAILABLE: malformed broker response\n' });
      }
      return;
    }
  });
  socket.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unavailable(`${SOCKET}: ${err.code || err.message}`);
  });
  socket.on('close', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unavailable('broker closed the channel without a result');
  });
  return null;
}

/* Стенд запускает файл напрямую (`node tools/tool-proxy.mjs`), но в sandbox он
   импортируется из stub-файла (`/bin/bash`, `/bin/sh`, `/usr/bin/bash`).
   Юнит-тесты импортируют модуль ради чистых функций и не должны запускать
   клиент: main() срабатывает только для этих двух способов запуска. */
const invoked = String(process.argv[1] || '');
if (/tool-proxy\.mjs$/.test(invoked) || /(^|\/)(usr\/)?(bin|sbin)\/(bash|sh)$/.test(invoked)) main();
