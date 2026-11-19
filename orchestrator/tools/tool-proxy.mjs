#!/usr/bin/env node
/* Tool proxy (Stage A fix4). Монтируется внутрь sandbox как `/orch/bin/bash`
   и `/orch/bin/sh`: любая shell-команда, которую Codex запускает по PATH,
   попадает сюда, а не в системный shell.

   Что делает прокси:
   1. разбирает аргументы как `bash -lc "<command>"`;
   2. применяет allowlist (lib/toolpolicy.mjs) и отклоняет запрещённое
      технически — exit 126, без запуска;
   3. пишет журнал каждой попытки в /orch/log/tool-calls.jsonl (наружу, в
      каталог журналов оркестратора);
   4. запускает разрешённую команду в ДОПОЛНИТЕЛЬНЫХ mount+network
      namespace: сеть пустая, /run/credentials и /home замаскированы tmpfs,
      поэтому даже разрешённая команда не видит auth-хранилище Codex.

   Если создать эти namespace нельзя (нет CAP_SYS_ADMIN, нет unshare) —
   команда не выполняется: ISOLATED_TOOL_NET_UNAVAILABLE. Fail-closed. */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { decideToolPolicy } from '../lib/toolpolicy.mjs';

const POLICY_FILE = '/orch/policy.json';
const LOG_DIR = '/orch/log';
const LOG_FILE = `${LOG_DIR}/tool-calls.jsonl`;
const UNSHARE = '/usr/bin/unshare';
const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';

function readPolicy() {
  try {
    return JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
  } catch {
    /* Нет политики — значит нет и разрешения: пустой allowlist. */
    return { enforce: true, allow: [], missing: true };
  }
}

function appendLog(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    /* журнал — доказательство, а не условие выполнения: его отсутствие не
       должно превращаться в разрешение */
  }
}

/* `bash -lc "cmd"`, `bash -c cmd`, `bash -l -c cmd`, `bash script.sh`. */
export function parseShellArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)) return { command: args[i + 1] ?? '', args };
    if (token === '-c') return { command: args[i + 1] ?? '', args };
    if (token.startsWith('-')) continue;
    return { command: args.slice(i).join(' '), args };
  }
  return { command: '', args };
}

function toolEnv() {
  return {
    PATH: SAFE_PATH,
    HOME: '/home/sandbox',
    TMPDIR: '/tmp',
    TMP: '/tmp',
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

const MASK_SCRIPT = [
  'mount -t tmpfs -o size=64k,mode=700 tmpfs /run/credentials 2>/dev/null || true',
  'mount -t tmpfs -o size=64k,mode=700 tmpfs /home 2>/dev/null || true',
  'exec /bin/sh -c "$1"',
].join('; ');

function main() {
  const { command, args } = parseShellArgs(process.argv.slice(2));
  const policy = readPolicy();
  const decision = decideToolPolicy(command, policy);
  const at = new Date().toISOString();
  if (!decision.allow) {
    appendLog({ at, command, argv: args, allow: false, code: decision.code, reason: decision.reason || null });
    process.stderr.write(`policy: ${decision.code}: ${decision.reason || 'command denied'}\n`);
    return 126;
  }
  const cwd = process.cwd();
  const result = spawnSync(UNSHARE, ['--mount', '--net', '--', '/bin/sh', '-c', MASK_SCRIPT, 'orch-tool', command], {
    stdio: 'inherit',
    env: toolEnv(),
    cwd,
    timeout: 600000,
  });
  if (result.error) {
    appendLog({ at, command, allow: false, code: 'ISOLATED_TOOL_NET_UNAVAILABLE', reason: String(result.error.message || result.error) });
    process.stderr.write(`policy: ISOLATED_TOOL_NET_UNAVAILABLE: ${String(result.error.message || result.error)}\n`);
    return 126;
  }
  appendLog({ at, command, allow: true, exitCode: result.status, cwd });
  return typeof result.status === 'number' ? result.status : 126;
}

if (process.argv[1] && /tool-proxy\.mjs$|\/orch\/bin\/(bash|sh)$/.test(process.argv[1])) {
  process.exitCode = main();
} else {
  process.exitCode = main();
}
