#!/usr/bin/env node
/* Окружение по принципу default-deny (Stage A fix3).
   Наследование process.env запрещено: любой посторонний ключ (DATABASE_URL,
   SESSION_COOKIE, AUTH_HEADER, cloud-переменные) — это утечка, а не удобство.
   Каждый потребитель получает свой минимальный набор.

   Разделение важнее списка: рабочие команды (тесты, git, reviewer checks) не
   видят ни HOME, ни ключей, ни сокетов; Codex CLI получает HOME, потому что
   иначе не сможет прочитать свою ChatGPT-сессию, но ключи API ему всё равно
   не передаются — режим API-key заблокирован до появления credential broker. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Имена, которые не передаются никому: даже если попали в allowlist по
   ошибке, фильтр по имени срабатывает первым. */
export const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|MNEMONIC|SEED|WALLET|DATABASE|CONNECTION|DSN|BEARER|CERT|SSH_|AWS_|AZURE_|GCP_|GOOGLE_|GITHUB_|GITLAB_|NPM_|NODE_OPTIONS|NODE_TEST_CONTEXT|NODE_V8_COVERAGE|NODE_CHANNEL_FD|NODE_UNIQUE_ID)/i;

export const BASE_ALLOWED = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'NO_COLOR', 'FORCE_COLOR', 'TERM',
]);

export const WINDOWS_ALLOWED = Object.freeze(['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR']);

export const API_KEY_NAMES = Object.freeze(['CODEX_API_KEY', 'OPENAI_API_KEY']);

/* Имена, наличие которых означает режим API-key. Такой режим запрещён:
   ключ должен жить в credential broker, а не в окружении рабочего процесса. */
export function apiKeyMode(env = process.env) {
  const found = API_KEY_NAMES.filter((name) => typeof env[name] === 'string' && env[name].length > 0);
  return { active: found.length > 0, names: found };
}

/* default-deny: только явно перечисленные имена, только из BASE_ALLOWED,
   плюс то, что передал сам оркестратор через extra. */
export function buildEnv({
  platform = process.platform,
  source = process.env,
  allow = BASE_ALLOWED,
  extra = {},
} = {}) {
  const names = new Set(allow);
  if (platform === 'win32') for (const name of WINDOWS_ALLOWED) names.add(name);
  const env = {};
  for (const name of names) {
    if (SECRET_NAME.test(name)) continue;
    const value = source[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    env[name] = String(value);
  }
  return env;
}

/* Рабочая команда: ни HOME, ни ключей, ни сокетов агента. */
export function runnerEnv({ platform = process.platform, source = process.env, extra = {} } = {}) {
  return buildEnv({ platform, source, extra: { NO_COLOR: '1', FORCE_COLOR: '0', ...extra } });
}

/* Codex CLI: нужен HOME (ChatGPT-сессия), но не ключи и не сокеты.
   CODEX_HOME разрешён явно: это каталог состояния CLI, а не рабочий код. */
export function codexEnv({ platform = process.platform, source = process.env, home, codexHome } = {}) {
  const extra = {};
  const resolvedHome = home || source.HOME || source.USERPROFILE;
  if (resolvedHome) extra.HOME = resolvedHome;
  if (codexHome || source.CODEX_HOME) extra.CODEX_HOME = codexHome || source.CODEX_HOME;
  const env = buildEnv({ platform, source, extra });
  for (const name of API_KEY_NAMES) delete env[name];
  return env;
}

/* git: изолированный HOME, чтобы не читались ~/.gitconfig и ~/.ssh. */
export function gitEnv({ platform = process.platform, source = process.env, home, extra = {} } = {}) {
  const safeHome = home || path.join(os.tmpdir(), 'orch-git-home');
  try {
    fs.mkdirSync(safeHome, { recursive: true });
  } catch {
    /* каталог уже существует или недоступен — git всё равно останется без ~/.gitconfig */
  }
  return buildEnv({
    platform,
    source,
    extra: {
      HOME: safeHome,
      USERPROFILE: safeHome,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      ...extra,
    },
  });
}

/* Упаковщик и прочие внутренние инструменты: только база. */
export function toolEnv(options = {}) {
  return buildEnv(options);
}

/* Диагностика для отчёта и preflight: какие имена были бы унаследованы. */
export function inheritedSecrets(env = process.env) {
  return Object.keys(env).filter((name) => SECRET_NAME.test(name)).sort();
}
