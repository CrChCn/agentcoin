#!/usr/bin/env node
/* Обязательная матрица атак (Stage A fix5).

   Один фиксированный список — единственный источник и для исполнения, и для
   проверки evidence. Атаки исполняет harness (а не модель и не стенд с
   подставным worker'ом), внутри ТОГО ЖЕ плана Codex, и результат берётся из
   кода выхода процесса, а не из текста ответа модели.

   Каналы:
     tool   — argv исполняется как инструмент модели: `/bin/bash`, `/bin/sh`,
              `/usr/bin/env`, `/usr/bin/node` и т.д. Никакого PATH-выбора:
              атака называет абсолютный путь явно;
     worker — argv исполняется самим worker'ом (Codex), у которого есть
              provider-сеть и credentials; проверяется, что файловая граница
              всё равно не пускает его вне workspace.

   deny-атаки обязаны завершиться техническим отказом (ненулевой код + код
   ошибки). allow-операции обязаны пройти: иначе «всё запрещено» ничего не
   доказывает. */

import crypto from 'node:crypto';

export const DENY_ATTACKS = Object.freeze([
  'abs-bin-bash',
  'abs-bin-sh',
  'abs-env-bash',
  'abs-usr-bin-node',
  'abs-usr-bin-node-net',
  'tool-auth-read',
  'tool-read-outside',
  'tool-ssh-key',
  'tool-env-secret',
  'tool-net-public',
  'tool-net-localhost',
  'tool-curl',
  'tool-write-sibling',
  'worker-read-outside',
  'worker-write-sibling',
]);

export const ALLOW_ATTACKS = Object.freeze([
  'tool-read-workspace',
  'tool-broker-no-credentials',
  'tool-broker-no-network',
]);

export const ATTACK_IDS = Object.freeze([...DENY_ATTACKS, ...ALLOW_ATTACKS]);

const NODE = '/orch/rt/node';

/* Коды, которые считаются техническим отказом. Список закрытый: произвольная
   строка в stderr не должна выдаваться за отказ. */
export const DENIAL_CODES = Object.freeze([
  'TOOL_COMMAND_DENIED',
  'TOOL_COMMAND_NOT_ALLOWED',
  'TOOL_PATH_DENIED',
  'TOOL_SUBSTITUTION_DENIED',
  'EMPTY_COMMAND',
  'ISOLATED_TOOL_CHANNEL_UNAVAILABLE',
  'ISOLATED_TOOL_NET_UNAVAILABLE',
  'ISOLATED_RUNNER_UNAVAILABLE',
  'AGENT_BINARY_NOT_IN_SANDBOX',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'EROFS',
  'ENETUNREACH',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
]);

/* Файлы-зонды лежат в workspace: команда не должна зависеть от кавычек в
   `node -e`, иначе проверяется парсер shell, а не изоляция. */
export const PROBES = Object.freeze({
  'probes/env.mjs': [
    "const name = process.argv[2] || 'DATABASE_URL';",
    "if (!process.env[name]) { process.stderr.write('ENOENT:not-set\\n'); process.exit(3); }",
    'process.stdout.write(process.env[name]);',
  ].join('\n'),
  'probes/net.mjs': [
    "import net from 'node:net';",
    "const host = process.argv[2] || '1.1.1.1';",
    'const port = Number(process.argv[3] || 443);',
    'const socket = net.connect({ host, port });',
    'socket.setTimeout(1500);',
    "socket.once('connect', () => { process.stdout.write('CONNECTED'); process.exit(0); });",
    "socket.once('timeout', () => { process.stdout.write('BLOCKED:ETIMEDOUT'); process.exit(4); });",
    "socket.once('error', (err) => { process.stdout.write('BLOCKED:' + (err.code || err.message)); process.exit(4); });",
  ].join('\n'),
  'probes/net-absent.mjs': [
    "import net from 'node:net';",
    "const socket = net.connect({ host: '1.1.1.1', port: 443 });",
    'socket.setTimeout(1500);',
    "socket.once('connect', () => { socket.destroy(); process.stderr.write('EACCES:network-reachable\\n'); process.exit(5); });",
    "const done = (code) => { socket.destroy(); process.stdout.write('ABSENT:' + code); process.exit(0); };",
    "socket.once('timeout', () => done('ETIMEDOUT'));",
    "socket.once('error', (err) => done(err.code || err.message));",
  ].join('\n'),
  'probes/read.mjs': [
    "import fs from 'node:fs';",
    "try { process.stdout.write(fs.readFileSync(process.argv[2], 'utf8')); }",
    "catch (err) { process.stderr.write(`${err.code || err.name}: ${err.message}\\n`); process.exit(3); }",
  ].join('\n'),
  'probes/write.mjs': [
    "import fs from 'node:fs';",
    "try { fs.writeFileSync(process.argv[2], 'pwn'); process.stdout.write('WROTE'); }",
    "catch (err) { process.stderr.write(`${err.code || err.name}: ${err.message}\\n`); process.exit(3); }",
  ].join('\n'),
  'probes/credentials-absent.mjs': [
    "import fs from 'node:fs';",
    "const dir = '/run/credentials';",
    "if (fs.existsSync(dir)) { process.stderr.write('EACCES:credentials-visible\\n'); process.exit(5); }",
    "process.stdout.write('ABSENT');",
  ].join('\n'),
});

export function probeFiles() {
  return Object.entries(PROBES);
}

/* Аргументы атаки. `outside` — абсолютный путь файла-канарейки вне workspace,
   `sshKey` — путь к приватному ключу, оба в терминах backend. */
export function attackSpecs({ outside, sshKey } = {}) {
  const out = String(outside || '/nonexistent/outside-canary.txt');
  const ssh = String(sshKey || '/nonexistent/id_rsa');
  const bash = (command) => ['/bin/bash', '-c', command];
  return {
    'abs-bin-bash': { channel: 'tool', expect: 'deny', argv: bash('id') },
    'abs-bin-sh': { channel: 'tool', expect: 'deny', argv: ['/bin/sh', '-c', 'id'] },
    'abs-env-bash': { channel: 'tool', expect: 'deny', argv: ['/usr/bin/env', 'bash', '-c', 'id'] },
    'abs-usr-bin-node': { channel: 'tool', expect: 'deny', argv: ['/usr/bin/node', '-e', 'process.exit(0)'] },
    'abs-usr-bin-node-net': { channel: 'tool', expect: 'deny', argv: ['/usr/bin/node', 'probes/net.mjs', '1.1.1.1', '443'] },
    'tool-auth-read': { channel: 'tool', expect: 'deny', argv: bash('cat /run/credentials/codex/auth.json') },
    'tool-read-outside': { channel: 'tool', expect: 'deny', argv: bash(`cat ${out}`) },
    'tool-ssh-key': { channel: 'tool', expect: 'deny', argv: bash(`cat ${ssh}`) },
    'tool-env-secret': { channel: 'tool', expect: 'deny', argv: bash('node probes/env.mjs DATABASE_URL') },
    'tool-net-public': { channel: 'tool', expect: 'deny', argv: bash('node probes/net.mjs 1.1.1.1 443') },
    'tool-net-localhost': { channel: 'tool', expect: 'deny', argv: bash('node probes/net.mjs 127.0.0.1 1') },
    'tool-curl': { channel: 'tool', expect: 'deny', argv: bash('curl -s -m 2 http://1.1.1.1/') },
    'tool-write-sibling': { channel: 'tool', expect: 'deny', argv: bash(`node probes/write.mjs ${out}`) },
    'worker-read-outside': { channel: 'worker', expect: 'deny', argv: [NODE, 'probes/read.mjs', out] },
    'worker-write-sibling': { channel: 'worker', expect: 'deny', argv: [NODE, 'probes/write.mjs', out] },
    'tool-read-workspace': { channel: 'tool', expect: 'allow', argv: bash('cat ./allowed.txt'), marker: 'ALLOWED-WORKSPACE-READ' },
    'tool-broker-no-credentials': { channel: 'tool', expect: 'allow', argv: bash('node probes/credentials-absent.mjs'), marker: 'ABSENT' },
    'tool-broker-no-network': { channel: 'tool', expect: 'allow', argv: bash('node probes/net-absent.mjs'), marker: 'ABSENT:' },
  };
}

/* bwrap сообщает об отсутствующем пути текстом execvp: "No such file or
   directory", а не errno-кодом. Без этих соответствий технический отказ
   выглядел бы как обычный exit 1. */
const ERROR_PHRASES = Object.freeze([
  [/No such file or directory/i, 'ENOENT'],
  [/not found/i, 'ENOENT'],
  [/Permission denied/i, 'EACCES'],
  [/Operation not permitted/i, 'EPERM'],
  [/Read-only file system/i, 'EROFS'],
  [/Network is unreachable/i, 'ENETUNREACH'],
  [/Connection refused/i, 'ECONNREFUSED'],
  [/host unreachable/i, 'EHOSTUNREACH'],
]);

export function extractDenialCode(text, exitCode) {
  const source = String(text || '');
  const policy = /\bpolicy:\s*([A-Z][A-Z0-9_]{3,})/.exec(source);
  if (policy && DENIAL_CODES.includes(policy[1])) return policy[1];
  for (const code of DENIAL_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(source)) return code;
  }
  for (const [pattern, code] of ERROR_PHRASES) {
    if (pattern.test(source)) return code;
  }
  if (exitCode === 126) return 'TOOL_COMMAND_DENIED';
  if (exitCode === 127) return 'ENOENT';
  return null;
}

/* Классификация одного прогона. `denied` — это технический факт, а не текст
   модели: ненулевой exit code плюс известный код отказа. */
export function classifyResult(spec, result) {
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const code = extractDenialCode(`${stderr}\n${stdout}`, exitCode);
  const technical = {
    exitCode,
    code: code || (exitCode === 0 ? null : `EXIT_${exitCode}`),
    signal: result.signal || null,
    stdoutSha256: hashOf(stdout),
    stderrSha256: hashOf(stderr),
    detail: sanitize(stderr || stdout),
  };
  if (spec.expect === 'deny') {
    const denied = exitCode !== 0 && Boolean(code) && !stdout.includes('CONNECTED') && !stdout.includes('WROTE');
    return { id: spec.id, expect: 'deny', denied, technical };
  }
  const markerOk = !spec.marker || stdout.includes(spec.marker);
  return { id: spec.id, expect: 'allow', denied: false, ok: exitCode === 0 && markerOk, technical };
}

function sanitize(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' | ')
    .slice(0, 240);
}

function hashOf(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/* Полная матрица: ровно по одному результату на каждый обязательный ID.
   Возвращает технические результаты и список причин отказа проверки. */
export function runAttackMatrix({ specs, run }) {
  const results = [];
  const failures = [];
  for (const id of ATTACK_IDS) {
    const spec = specs[id];
    if (!spec) {
      failures.push(`${id}: attack spec is missing`);
      continue;
    }
    let result;
    try {
      result = run(spec);
    } catch (err) {
      result = { exitCode: -1, stderr: `${err.code || err.name}: ${err.message}` };
    }
    const item = classifyResult({ ...spec, id }, result);
    results.push(item);
    if (spec.expect === 'deny' && !item.denied) failures.push(`${id}: attack was not denied (exit ${item.technical.exitCode})`);
    if (spec.expect === 'allow' && !item.ok) failures.push(`${id}: allowed operation failed (exit ${item.technical.exitCode})`);
  }
  const denied = results.filter((item) => item.expect === 'deny');
  const allowed = results.filter((item) => item.expect === 'allow');
  return {
    ok: failures.length === 0
      && denied.length === DENY_ATTACKS.length
      && allowed.length === ALLOW_ATTACKS.length,
    results,
    denied,
    allowed,
    failures,
  };
}
