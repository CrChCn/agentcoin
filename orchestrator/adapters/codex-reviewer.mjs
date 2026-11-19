#!/usr/bin/env node
/* Независимый проверяющий Codex. Никогда не продолжает сессию исполнителя:
   resumeId не передаётся, рабочее дерево — копия базы с применённым
   артефактом, без истории исполнителя. */

import * as codex from './codex-cli.mjs';

export const id = 'codex-reviewer';
export const roles = ['reviewer'];
export const simulated = false;
export const requiresSandbox = codex.requiresSandbox;
export const usesRunCommand = codex.usesRunCommand;

export const probe = () => ({ ...codex.probe(), adapter: id, provider: 'codex' });

export function run(ctx) {
  return codex.run({ ...ctx, role: 'reviewer', resumeId: null });
}
