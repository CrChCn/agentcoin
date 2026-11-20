#!/usr/bin/env node
/* Tool proxy — клиент broker'а (Stage A fix6).

   Этот файл не исполняет команды, не маскирует и не читает файлы: он только
   передаёт разобранный argv в broker по unix-сокету и возвращает результат.
   Исполнение происходит в ДРУГОМ namespace (tools/tool-broker.mjs): без сети,
   без /run/credentials, без CODEX_HOME.

   fix6 закрыл script-mode. fix5 в режиме `bash file` вызывал
   `fs.readFileSync(file)` ВНУТРИ namespace Codex, где виден
   /run/credentials/codex/auth.json. Поэтому `/bin/bash
   /run/credentials/codex/auth.json` возвращал содержимое credentials до
   политики broker'а. Теперь:

   - принимается только `-c` / `-lc` (команда строкой);
   - `bash file`, `sh file`, `bash -- file`, `bash -s` — технический отказ
     TOOL_SCRIPT_MODE_DENIED;
   - в модуле нет ни одного вызова fs: нечего читать и нечего утекать.

   Fail-closed: нет сокета или broker отказал — команда не выполняется,
   возвращается ISOLATED_TOOL_CHANNEL_UNAVAILABLE (exit 126). */

import net from 'node:net';

const SOCKET = '/orch/ipc/broker.sock';
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RESPONSE = 8 * 1024 * 1024;

export const SCRIPT_MODE_DENIED = 'TOOL_SCRIPT_MODE_DENIED';

/* `bash -lc "cmd"`, `bash -c cmd`, `bash -l -c cmd` — единственные
   поддерживаемые формы. Любой не-флаговый аргумент означает файл-скрипт. */
export function parseShellArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '-c') return { mode: 'command', command: args[i + 1] ?? '' };
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)) return { mode: 'command', command: args[i + 1] ?? '' };
    if (token === '-s' || token === '--stdin') return { mode: 'script', script: '<stdin>' };
    if (token.startsWith('-')) continue;
    return { mode: 'script', script: token };
  }
  return { mode: 'empty', command: '' };
}

function deny(code, detail) {
  process.stderr.write(`policy: ${code}: ${detail}\n`);
  process.exitCode = 126;
}

function unavailable(detail) {
  deny('ISOLATED_TOOL_CHANNEL_UNAVAILABLE', detail);
}

export function requestFor(argv) {
  const parsed = parseShellArgs(argv);
  if (parsed.mode === 'command') {
    if (!parsed.command) return { refuse: { code: 'EMPTY_COMMAND', detail: 'shell was given -c without a command' } };
    return { command: parsed.command };
  }
  if (parsed.mode === 'script') {
    return {
      refuse: {
        code: SCRIPT_MODE_DENIED,
        detail: `script mode is not supported: the proxy never reads files (${parsed.script})`,
      },
    };
  }
  return { refuse: { code: 'EMPTY_COMMAND', detail: 'shell was invoked without a command' } };
}

function main() {
  const request = requestFor(process.argv.slice(2));
  if (request.refuse) {
    deny(request.refuse.code, request.refuse.detail);
    return 126;
  }
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
