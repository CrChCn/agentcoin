#!/usr/bin/env node
/* Изоляция Codex-worker (Stage A fix4).

   fix3 запускал настоящий Codex прямым `spawn()` на хосте и передавал
   `runCommand`, который адаптер никогда не вызывал: модель исполняла команды
   своими инструментами мимо sandbox. Здесь поток другой:

     orchestrator
       → bwrap (mount/pid/net/userns)
         → codex exec                 (канал к провайдеру: сеть разрешена)
           → bash/sh = tool proxy      (канал инструментов: сеть запрещена,
                                        /run/credentials и /home замаскированы)

   Codex получает ровно то, что нужно CLI: workspace rw, read-only системные
   каталоги, пустой HOME, свой CODEX_HOME в /run/credentials (только auth.json
   и config.toml, скопированные во временный каталог), и PATH, где bash/sh
   подменены прокси. Ключи API не передаются вообще (режим API-key запрещён).

   Уровни доказательства (см. preflight):
     1. installed        — бинарник найден;
     2. smokeTested      — detectSandbox() реально прогнал runner;
     3. adapterEndToEnd  — реальный Codex-поток прошёл hostile-проверку
                           (evidence/agent-isolation.json), только тогда
                           автономный запуск разрешён. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ORCH_ROOT } from './package.mjs';
import { ISOLATED_RUNNER_UNAVAILABLE, ISOLATION_UNPROVEN, sandboxEnvArgs, sandboxMountArgs, toBackendPath } from './sandbox.mjs';
import { toolEnv } from './envpolicy.mjs';
import { policyForTask } from './toolpolicy.mjs';

export const AGENT_EVIDENCE = path.join(ORCH_ROOT, 'evidence', 'agent-isolation.json');
export const TOOL_PROXY = path.join(ORCH_ROOT, 'tools', 'tool-proxy.mjs');
export const TOOL_POLICY_MODULE = path.join(ORCH_ROOT, 'lib', 'toolpolicy.mjs');
export const PROXY_PATH = '/orch/bin:/usr/local/bin:/usr/bin:/bin';
export const ISOLATED_CODEX_HOME = '/run/credentials/codex';

const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/* Уровень 3: доказательство строится только реальным прогоном Codex
   (tools/agent-hostile-check.mjs --real). Стенд с подставным worker'ом
   пишет отдельный файл и автономный запуск не открывает. */
export function isolationEvidence(file = AGENT_EVIDENCE, now = Date.now()) {
  const missing = {
    ok: false,
    code: ISOLATION_UNPROVEN,
    detail: `no end-to-end evidence for the real Codex worker; run \`node tools/agent-hostile-check.mjs --real\` (${path.relative(ORCH_ROOT, file).split(path.sep).join('/')})`,
    file,
  };
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return missing;
  }
  const attacks = Array.isArray(evidence.attacks) ? evidence.attacks : [];
  const denied = attacks.filter((item) => item && item.denied === true).length;
  const fresh = Number.isFinite(Date.parse(evidence.at)) && now - Date.parse(evidence.at) <= MAX_EVIDENCE_AGE_MS;
  const ok = evidence.ok === true
    && evidence.adapter === 'codex-cli'
    && typeof evidence.threadId === 'string'
    && evidence.threadId.length >= 8
    && evidence.backend
    && attacks.length >= 1
    && denied === attacks.length
    && fresh;
  if (!ok) {
    return {
      ...missing,
      detail: `end-to-end evidence does not meet the level-3 criteria (ok/adapter/threadId/backend/attacks/freshness): ${path.relative(ORCH_ROOT, file).split(path.sep).join('/')}`,
    };
  }
  return { ok: true, file, threadId: evidence.threadId, backend: evidence.backend, at: evidence.at, attacks: attacks.length };
}

/* Копия auth.json/config.toml в одноразовый каталог: настоящий ~/.codex
   остаётся нетронутым, а внутрь sandbox попадает только то, что нужно CLI.
   Каталог не входит в workspace и маскируется для инструментов модели. */
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
  } catch {
    /* Windows/ACL: режим не выставляется, каталог всё равно одноразовый */
  }
  for (const name of ['config.toml', 'config.json']) {
    const sourceFile = path.join(from, name);
    if (fs.existsSync(sourceFile)) fs.copyFileSync(sourceFile, path.join(target, name));
  }
  return { ok: true, dir: target };
}

function bindAbsolute(argv, backend, mounts) {
  const files = [];
  for (const token of argv) {
    if (typeof token !== 'string') continue;
    if (backend === 'wsl-bwrap') {
      if (/^[A-Za-z]:[\\/]/.test(token)) return { ok: false, code: 'AGENT_BINARY_NOT_IN_SANDBOX', detail: `host path cannot exist inside the WSL sandbox: ${token}` };
      continue;
    }
    if (path.isAbsolute(token) && fs.existsSync(token) && fs.statSync(token).isFile()) files.push(token);
  }
  for (const file of files) mounts.push(['--ro-bind', file, file]);
  return { ok: true, files };
}

/* План запуска Codex-worker. `wrap()` получает готовый argv CLI (node/codex и
   аргументы) и возвращает команду для spawn: bwrap + тот же argv. */
export function buildAgentPlan({
  sandbox,
  workspace,
  logDir,
  task,
  credentialsDir = null,
  network = 'provider',
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
  const scratch = tmpRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-plan-'));
  const policyFile = path.join(scratch, 'tool-policy.json');
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  fs.writeFileSync(policyFile, `${JSON.stringify(policyForTask(task), null, 2)}\n`);
  fs.mkdirSync(logDir, { recursive: true });

  /* `bash`/`sh` внутри sandbox — сгенерированные wrapper'ы, а не файл из
     репозитория: при распаковке архива чужим unzip бит исполнения теряется, и
     Codex получил бы EACCES вместо tool proxy. Режим выставляется здесь. */
  const binDir = path.join(scratch, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = ['#!/bin/sh', 'exec node /orch/lib/tool-proxy.mjs "$@"', ''].join('\n');
  for (const name of ['bash', 'sh']) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, wrapper);
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      /* Windows/ACL: каталог всё равно во временном разделе, доступном WSL */
    }
  }

  const staticMounts = [
    ['--dir', '/orch'],
    ['--dir', '/orch/bin'],
    ['--dir', '/orch/lib'],
    ['--dir', '/orch/log'],
    ['--dir', '/run'],
    ['--tmpfs', '/run/credentials'],
    ['--dir', ISOLATED_CODEX_HOME],
    ['--ro-bind', toBackendPath(path.join(binDir, 'bash'), backend), '/orch/bin/bash'],
    ['--ro-bind', toBackendPath(path.join(binDir, 'sh'), backend), '/orch/bin/sh'],
    ['--ro-bind', toBackendPath(TOOL_PROXY, backend), '/orch/lib/tool-proxy.mjs'],
    ['--ro-bind', toBackendPath(TOOL_POLICY_MODULE, backend), '/orch/lib/toolpolicy.mjs'],
    ['--ro-bind', toBackendPath(policyFile, backend), '/orch/policy.json'],
    ['--bind', logUnix, '/orch/log'],
  ];
  if (credentialsDir) staticMounts.push(['--bind', toBackendPath(credentialsDir, backend), ISOLATED_CODEX_HOME]);

  const baseEnv = {
    PATH: PROXY_PATH,
    HOME: '/home/sandbox',
    TMPDIR: '/tmp',
    TMP: '/tmp',
    CODEX_HOME: ISOLATED_CODEX_HOME,
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...extraEnv,
  };

  return {
    ok: true,
    backend,
    workspace,
    workspaceUnix,
    scratch,
    policyFile,
    journalPath: path.join(logDir, 'tool-calls.jsonl'),
    network,
    wrap(argv) {
      const mounts = staticMounts.map((mount) => mount.slice());
      const bound = bindAbsolute(argv, backend, mounts);
      if (!bound.ok) return bound;
      const args = [
        ...sandboxMountArgs({ workspaceUnix, network, extraMounts: mounts, capSysAdmin: true }),
        ...sandboxEnvArgs(baseEnv),
        '--',
        ...argv,
      ];
      return {
        ok: true,
        cmd: backend === 'wsl-bwrap' ? 'wsl.exe' : 'bwrap',
        args: backend === 'wsl-bwrap' ? ['-e', 'bwrap', ...args] : args,
        env: toolEnv(),
        backend,
        journalPath: this.journalPath,
      };
    },
  };
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
      .filter(Boolean);
  } catch {
    return [];
  }
}
