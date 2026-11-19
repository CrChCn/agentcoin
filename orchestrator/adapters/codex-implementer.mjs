#!/usr/bin/env node
/* Исполнитель Codex. Отдельный id и отдельный процесс: оркестратор не
   принимает результат, если исполнитель и проверяющий совпадают. */

import * as codex from './codex-cli.mjs';

export const id = 'codex-implementer';
export const roles = ['implementer'];
export const simulated = false;
export const requiresSandbox = codex.requiresSandbox;
export const usesRunCommand = codex.usesRunCommand;

export const probe = () => ({ ...codex.probe(), adapter: id, provider: 'codex' });

export function run(ctx) {
  return codex.run({ ...ctx, role: 'implementer' });
}
