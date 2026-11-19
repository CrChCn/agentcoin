#!/usr/bin/env node
/* Политика инструментов модели (Stage A fix4).
   Codex CLI выполняет собственные shell-команды; оркестратор не может
   передать ему «callback на каждую команду». Поэтому единственная точка, через
   которую проходит каждая shell-команда модели, — tool proxy внутри sandbox
   (он монтируется как `bash`/`sh`), а правила живут здесь: и прокси, и тесты
   используют один и тот же модуль, чтобы стенд не расходился с боем.

   Правила намеренно узкие: команды задачи из контракта, read-only утилиты и
   git-операции. Транспорт наружу (curl/wget/ssh/docker/npm/apt), подстановки
   `$(...)`, backticks и перенаправления запрещены: канал к провайдеру есть
   только у самого Codex, у инструментов модели сети нет вообще. */

export const SAFE_FIRST = Object.freeze([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'file', 'stat',
  'diff', 'echo', 'printf', 'true', 'test', 'which', 'sort', 'uniq', 'cut', 'tr',
  'basename', 'dirname', 'realpath', 'sed', 'awk', 'node', 'mkdir', 'touch',
  'cp', 'mv', 'rm', 'chmod', 'ln',
]);

export const SAFE_GIT = Object.freeze([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'add', 'commit',
  'checkout', 'branch', 'stash', 'apply', 'init', 'config',
]);

/* Явные запреты важнее разрешений: даже если команда попала в allowlist
   задачи, транспорт наружу остаётся запрещён. */
export const DENIED_FIRST = Object.freeze([
  'curl', 'wget', 'http', 'https', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat',
  'netcat', 'telnet', 'ftp', 'docker', 'podman', 'nerdctl', 'kubectl', 'helm',
  'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'python', 'python3', 'gem',
  'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'apk', 'brew', 'sudo', 'su', 'doas',
  'mount', 'umount', 'unshare', 'nsenter', 'chroot', 'iptables', 'nft',
  'systemctl', 'service', 'crontab', 'kill', 'pkill', 'killall', 'shutdown',
  'reboot', 'poweroff', 'dd', 'mkfs', 'fdisk', 'parted', 'eval', 'exec', 'source',
]);

const SUBSTITUTION = /(?:^|[^\\])\$\(|`|\$\{|[<>]/;
const SEGMENT_SPLIT = /&&|\|\||;|\n|\|/;

const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function decideSegment(segment, policy) {
  const raw = normalize(segment);
  if (!raw) return { allow: false, code: 'EMPTY_COMMAND', reason: 'empty command' };
  if (policy.allow && policy.allow.some((entry) => raw === entry || raw.startsWith(`${entry} `))) {
    return { allow: true, rule: 'task-command', segment: raw };
  }
  if (SUBSTITUTION.test(raw)) {
    return { allow: false, code: 'TOOL_SUBSTITUTION_DENIED', reason: 'command substitution and redirection are not allowed', segment: raw };
  }
  const tokens = raw.split(' ');
  const first = tokens[0];
  if (DENIED_FIRST.includes(first)) {
    return { allow: false, code: 'TOOL_COMMAND_DENIED', reason: `${first} is denied by policy`, segment: raw };
  }
  if (first === 'git') {
    return SAFE_GIT.includes(tokens[1])
      ? { allow: true, rule: 'git', segment: raw }
      : { allow: false, code: 'TOOL_COMMAND_DENIED', reason: `git ${tokens[1] || ''} is not allowed`, segment: raw };
  }
  if (SAFE_FIRST.includes(first)) return { allow: true, rule: 'safe-utility', segment: raw };
  return { allow: false, code: 'TOOL_COMMAND_NOT_ALLOWED', reason: `${first} is not on the tool allowlist`, segment: raw };
}

export function decideToolPolicy(command, policy = {}) {
  const raw = normalize(command);
  if (!raw) return { allow: false, code: 'EMPTY_COMMAND', reason: 'empty command' };
  if (policy.enforce === false) return { allow: true, rule: 'audit-only', segments: [raw] };
  const segments = raw.split(SEGMENT_SPLIT).map((part) => part.trim()).filter(Boolean);
  if (!segments.length) return { allow: false, code: 'EMPTY_COMMAND', reason: 'empty command' };
  for (const segment of segments) {
    const decision = decideSegment(segment, policy);
    if (!decision.allow) return { ...decision, segments };
  }
  return { allow: true, segments, rule: 'all-segments-allowed' };
}

/* Политика одного запуска: команды задачи из контракта — единственное, что
   разрешено сверх read-only набора. */
export function policyForTask(task) {
  return {
    enforce: true,
    allow: Array.isArray(task && task.commandsAllowed) ? task.commandsAllowed.map(normalize) : [],
  };
}
