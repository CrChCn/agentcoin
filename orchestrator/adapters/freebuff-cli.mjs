#!/usr/bin/env node
/* Freebuff CLI / Desktop: официального программного запуска агента нет.
   Проверено локально (`freebuff --help`, `freebuff -v`) и по официальной
   документации: клиент интерактивный, не принимает prompt аргументом и не
   имеет scriptable JSON-режима. Управление браузером/клавиатурой/экраном
   сознательно не используется. */

import { spawnSync } from 'node:child_process';

export const id = 'freebuff-cli';
export const roles = ['implementer', 'reviewer'];
export const simulated = false;

export const EVIDENCE = {
  docs: 'https://docs.freebuff.page/cli/',
  quote: 'The CLI takes a short list of flags. It is an interactive client: it does not accept an initial prompt as an argument, and it is not a scriptable JSON mode.',
  desktop: 'Freebuff Desktop (installer on this machine: Freebuff-0.0.147-win-x64.exe) exposes no documented local API/CLI for starting an agent task.',
};

function execCli(args) {
  const bin = process.env.FREEBUFF_BIN || 'freebuff';
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

export function probe() {
  const version = execCli(['-v']);
  if (!version.ok && version.error) {
    /* Даже когда локальный бинарник не отвечает, причина отказа прежняя:
       официальная поверхность интерактивная и не имеет JSON-режима.
       Иначе сообщение зависело бы от таймаута процесса, а не от факта. */
    return {
      available: false,
      programmatic: false,
      authenticated: false,
      reason: `Freebuff CLI not runnable here (${version.error}); the official surface is still interactive: it does not accept an initial prompt as an argument and has no scriptable JSON mode`,
      requiresHuman: 'сессию Freebuff ведёт человек в TUI/Desktop; программного API запуска задачи нет',
      evidence: EVIDENCE.docs,
      evidenceQuote: EVIDENCE.quote,
    };
  }
  const help = execCli(['--help']);
  return {
    available: version.ok,
    programmatic: false,
    authenticated: false,
    version: version.stdout.split('\n')[0] || null,
    reason: 'официальный CLI интерактивный: нет prompt-аргумента и scriptable JSON-режима',
    requiresHuman: 'сессию Freebuff ведёт человек в TUI/Desktop; программного API запуска задачи нет',
    evidence: EVIDENCE.docs,
    evidenceQuote: EVIDENCE.quote,
    observedFlags: (help.stdout.match(/--[a-z-]+/g) || []).filter((v, i, a) => a.indexOf(v) === i),
    observedHelpExitCode: help.status,
  };
}

export async function run() {
  throw Object.assign(
    new Error('Freebuff has no official programmatic agent interface; refusing to automate the UI'),
    { code: 'AGENT_NOT_SCRIPTABLE', adapter: id, evidence: EVIDENCE },
  );
}
