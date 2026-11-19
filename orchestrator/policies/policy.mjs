#!/usr/bin/env node
/* Политика оркестратора: только типизированные действия, только разрешённые
   пути и команды. Это граница процесса, а не OS-sandbox: она проверяет то,
   что вернул агент, и то, что реально изменилось в workspace. */

import fs from 'node:fs';
import path from 'node:path';
import { walk } from '../lib/fsx.mjs';

export const TYPED_ACTIONS = Object.freeze([
  'checkout',
  'apply_patch',
  'run_test',
  'build_artifact',
  'calculate_hash',
  'submit_review',
  'prepare_deployment',
]);

/* prepare_deployment существует как типизированное действие, но у оркестратора
   этапа A нет полномочий на деплой. Будущий Deployment Runner — отдельный
   компонент со своим allowlist; здесь действие всегда отказывает. */
export function assertActionAllowed(action) {
  if (!TYPED_ACTIONS.includes(action)) {
    return { ok: false, code: 'ACTION_NOT_TYPED', action };
  }
  if (action === 'prepare_deployment') {
    return { ok: false, code: 'DEPLOYMENT_RUNNER_NOT_PROVISIONED', action };
  }
  return { ok: true, action };
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

export function pathCovered(entries, file) {
  const target = norm(file);
  return entries.some((entry) => {
    const base = norm(entry).replace(/\/+$/, '');
    return target === base || target.startsWith(`${base}/`);
  });
}

export function isSafeRelativePath(file) {
  const p = norm(file);
  return Boolean(p) && !p.startsWith('/') && !/^[a-zA-Z]:/.test(p) && !p.split('/').includes('..');
}

export function checkFile(task, file) {
  if (!isSafeRelativePath(file)) return { ok: false, code: 'UNSAFE_PATH', file };
  if (task.scope.forbiddenPaths.length && pathCovered(task.scope.forbiddenPaths, file)) {
    return { ok: false, code: 'FORBIDDEN_PATH', file };
  }
  if (!pathCovered(task.scope.allowedPaths, file)) return { ok: false, code: 'PATH_NOT_ALLOWED', file };
  return { ok: true, file };
}

const SHELL_META = /[;&|<>`$(){}[\]*?~!"'\n\r]/;

export function parseCommand(command) {
  const raw = String(command || '').trim();
  if (!raw) return { ok: false, code: 'EMPTY_COMMAND' };
  if (SHELL_META.test(raw)) return { ok: false, code: 'SHELL_METACHARACTERS_DENIED', command: raw };
  const argv = raw.split(/\s+/);
  if (argv[0] !== 'node') return { ok: false, code: 'COMMAND_INTERPRETER_NOT_ALLOWED', command: raw };
  return { ok: true, argv };
}

export function checkCommand(task, command) {
  const parsed = parseCommand(command);
  if (!parsed.ok) return parsed;
  if (!task.commandsAllowed.includes(String(command).trim())) {
    return { ok: false, code: 'COMMAND_NOT_ALLOWED', command: String(command).trim() };
  }
  return parsed;
}

export function checkChangedFiles(task, files) {
  const violations = [];
  for (const item of files) {
    const result = checkFile(task, item.file);
    if (!result.ok) violations.push(result);
  }
  return violations;
}

export function checkCommandsRun(task, commands) {
  const violations = [];
  for (const command of commands) {
    const result = checkCommand(task, command);
    if (!result.ok) violations.push(result);
  }
  return violations;
}

/* Проверка выхода за пределы песочницы задачи: пишем в sandbox/<taskId>/,
   исполнитель работает в sandbox/<taskId>/implementer. Любой файл рядом с
   корнем исполнителя — попытка выйти из workspace. */
export function scanEscape(sandboxDir, workspaceDirs) {
  const allowed = (Array.isArray(workspaceDirs) ? workspaceDirs : [workspaceDirs]).map((p) => path.resolve(p));
  const violations = [];
  if (!fs.existsSync(sandboxDir)) return violations;
  for (const item of walk(sandboxDir)) {
    const abs = path.resolve(item.abs);
    if (allowed.some((dir) => abs === dir || abs.startsWith(dir + path.sep))) continue;
    violations.push({ ok: false, code: 'ESCAPE_WORKSPACE', file: abs.slice(path.resolve(sandboxDir).length + 1) });
  }
  return violations;
}

export function checkResult(task, state, result, changed) {
  const violations = [];
  if (result.taskId !== task.taskId) violations.push({ code: 'TASK_ID_MISMATCH' });
  if (result.iteration !== state.iteration) violations.push({ code: 'ITERATION_MISMATCH' });
  if (state.baseCommit && result.baseCommit !== state.baseCommit) violations.push({ code: 'BASE_COMMIT_MISMATCH' });
  if (result.status !== 'submitted') violations.push({ code: 'BAD_RESULT_STATUS' });
  const declared = new Set(result.changedFiles);
  for (const item of changed) {
    if (!declared.has(item.file)) violations.push({ code: 'CHANGED_FILES_UNDECLARED', file: item.file });
  }
  for (const file of declared) {
    if (!changed.some((item) => item.file === file)) violations.push({ code: 'DECLARED_FILE_UNCHANGED', file });
  }
  violations.push(...checkChangedFiles(task, changed));
  violations.push(...checkCommandsRun(task, result.commandsRun));
  return violations;
}

export function deadlinePassed(task, now = Date.now()) {
  return Date.parse(task.deadline) <= now;
}

export function isViolation(list) {
  return Array.isArray(list) && list.length > 0;
}
