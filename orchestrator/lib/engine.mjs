#!/usr/bin/env node
/* Движок оркестратора. Никакой бизнес-логики сети: только типизированные
   переходы, изолированные каталоги, контракты и остановки. */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Store } from '../state/store.mjs';
import { assertRole } from '../adapters/resolver.mjs';
import { assertValid, SchemaError } from './schema.mjs';
import { canonical, copyTree, ensureDir, readJson, rmrf, sha256, writeJsonAtomic } from './fsx.mjs';
import { changedFiles, cloneAt, initRepo, revParse } from './git.mjs';
import { applyArtifactTo, buildArtifact, verifyArtifactFiles } from '../artifacts/store.mjs';
import { checkCommand, checkResult, deadlinePassed, parseCommand, scanEscape } from '../policies/policy.mjs';
import { assertRegularFileWithin, assertSafeParents, findSymlinks, safeRootDir } from './safefs.mjs';
import { acquireLock } from './lock.mjs';
import { implementerPrompt, reviewerPrompt } from './prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ORCH_ROOT = path.resolve(HERE, '..');
export const FIXTURE_DIR = path.join(ORCH_ROOT, 'fixtures', 'task-src');
export const REVIEWER_CHECKS_DIR = path.join(ORCH_ROOT, 'fixtures', 'reviewer-checks');
export const CONTRACTS_DIR = path.join(ORCH_ROOT, 'contracts');

export const schemas = {
  task: readJson(path.join(CONTRACTS_DIR, 'task.schema.json'), null),
  implementerResult: readJson(path.join(CONTRACTS_DIR, 'implementer-result.schema.json'), null),
  reviewResult: readJson(path.join(CONTRACTS_DIR, 'review-result.schema.json'), null),
};

export const IMPLEMENTER_SCHEMA = path.join(CONTRACTS_DIR, 'implementer-result.schema.json');
export const REVIEW_SCHEMA = path.join(CONTRACTS_DIR, 'review-result.schema.json');

export const TERMINAL = new Set(['ACCEPTED', 'BLOCKED', 'FAILED', 'CANCELLED']);

const rel = (root, target) => path.relative(root, target).replace(/\\/g, '/');
const nowIso = () => new Date().toISOString();

const invariant = (message) => {
  throw Object.assign(new Error(message), { code: 'TASK_INVARIANT_VIOLATION' });
};

const MINUTE_MS = 60000;

const emptyRoleUsage = () => ({
  inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, runs: 0,
});

function addRoleUsage(previous, usage) {
  const base = { ...emptyRoleUsage(), ...(previous || {}) };
  if (!usage) return { ...base, runs: base.runs + 1 };
  return {
    inputTokens: base.inputTokens + (usage.inputTokens || 0),
    cachedInputTokens: base.cachedInputTokens + (usage.cachedInputTokens || 0),
    outputTokens: base.outputTokens + (usage.outputTokens || 0),
    reasoningTokens: base.reasoningTokens + (usage.reasoningTokens || 0),
    totalTokens: base.totalTokens + (usage.totalTokens || 0),
    runs: base.runs + 1,
  };
}

export function runtimeMsOf(state, role) {
  return ((state.runtimeMs || {})[role]) || 0;
}

export function totalRuntimeMsOf(state) {
  return runtimeMsOf(state, 'implementer') + runtimeMsOf(state, 'reviewer');
}

function totalTokensOf(state) {
  return (state.usage && state.usage.totalTokens) || 0;
}

/* Остаток бюджета роли: минимум из лимита роли и общего лимита.
   CLI не отдаёт денежный лимит, поэтому считаются токены и секунды. */
function remainingBudgetMs(state, task, role) {
  const perAgent = task.maxRuntimePerAgentMinutes * MINUTE_MS - runtimeMsOf(state, role);
  const total = task.maxTotalRuntimeMinutes * MINUTE_MS - totalRuntimeMsOf(state);
  return Math.max(0, Math.min(perAgent, total));
}

function budgetStop(state, task, role) {
  if (totalTokensOf(state) >= task.maxTotalTokens) {
    return {
      code: 'max_total_tokens_exceeded',
      detail: `recorded usage ${totalTokensOf(state)} tokens reached maxTotalTokens ${task.maxTotalTokens}`,
    };
  }
  const remaining = remainingBudgetMs(state, task, role);
  if (remaining < 5000) {
    return {
      code: 'max_runtime_exceeded',
      detail: `role ${role} has ${Math.round(remaining / 1000)}s left (per-agent ${task.maxRuntimePerAgentMinutes} min, total ${task.maxTotalRuntimeMinutes} min)`,
    };
  }
  return null;
}

function budgetSnapshot(state, task) {
  return {
    maxIterations: task.maxIterations,
    maxRuntimePerAgentMinutes: task.maxRuntimePerAgentMinutes,
    maxTotalRuntimeMinutes: task.maxTotalRuntimeMinutes,
    maxTotalTokens: task.maxTotalTokens,
    usedTokens: totalTokensOf(state),
    usedRuntimeMs: { implementer: runtimeMsOf(state, 'implementer'), reviewer: runtimeMsOf(state, 'reviewer'), total: totalRuntimeMsOf(state) },
  };
}

/* Учёт запуска: thread_id, usage из turn.completed, измеренное время.
   Пишется в журнал вместе с переходом; при BLOCKED — тоже. */
function accounting({ root, state, role, outcome, elapsedMs, iteration, kind }) {
  const previous = state.usage || {};
  const session = outcome.session || {};
  const usage = {
    implementer: previous.implementer || emptyRoleUsage(),
    reviewer: previous.reviewer || emptyRoleUsage(),
    totalTokens: totalTokensOf(state) + ((session.usage && session.usage.totalTokens) || 0),
  };
  usage[role] = addRoleUsage(previous[role], session.usage || null);

  const runtimeMs = { implementer: runtimeMsOf(state, 'implementer'), reviewer: runtimeMsOf(state, 'reviewer') };
  runtimeMs[role] += elapsedMs;

  const sessions = { implementer: [], reviewer: [], ...(state.sessions || {}) };
  const entry = {
    role,
    adapter: state[role],
    iteration,
    kind,
    threadId: session.id || null,
    at: nowIso(),
    runtimeMs: elapsedMs,
    usage: session.usage || null,
    rawUsage: session.rawUsage || null,
    transcript: session.transcript ? rel(root, session.transcript) : null,
    command: session.argv || null,
  };
  sessions[role] = [...(sessions[role] || []), entry];
  return { usage, runtimeMs, sessions, lastSession: entry };
}

export function loadTask(taskFile) {
  const task = readJson(path.resolve(taskFile), null);
  if (!task) throw new Error(`task file not found: ${taskFile}`);
  assertValid(schemas.task, task, 'task');

  // Инварианты, которые JSON Schema не выражает: путь не может выйти из
  // workspace, '.' не может разрешить весь корень, команда — не shell.
  for (const entry of [...task.scope.allowedPaths, ...task.scope.forbiddenPaths]) {
    if (entry === '.' || entry.startsWith('/') || /^[A-Za-z]:/.test(entry) || entry.split('/').includes('..')) {
      invariant(`scope path must stay inside the workspace: ${entry}`);
    }
  }
  for (const command of task.commandsAllowed) {
    const parsed = parseCommand(command);
    if (!parsed.ok) invariant(`command not permitted by policy (${parsed.code}): ${command}`);
  }
  if (task.maxRuntimePerAgentMinutes > task.maxTotalRuntimeMinutes) {
    invariant('maxRuntimePerAgentMinutes cannot exceed maxTotalRuntimeMinutes');
  }
  return task;
}

export function workspacePaths(root, taskId) {
  const wsRoot = path.join(path.resolve(root), 'workspaces', taskId);
  return {
    wsRoot,
    implementerDir: path.join(wsRoot, 'implementer'),
    reviewerDir: path.join(wsRoot, 'reviewer'),
  };
}

export function commandRunner(workspace, task) {
  return (command) => {
    const parsed = checkCommand(task, command);
    if (!parsed.ok) {
      return { exitCode: 126, stdout: '', stderr: `policy: ${parsed.code}`, policyCode: parsed.code, durationMs: 0 };
    }
    const started = Date.now();
    // Наследование NODE_TEST_CONTEXT/NODE_OPTIONS превращает вложенный
    // `node --test` в подпроцесс внешнего раннера и скрывает падения.
    const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'NODE_CHANNEL_FD', 'NODE_UNIQUE_ID']) {
      delete env[key];
    }
    const result = spawnSync(parsed.argv[0], parsed.argv.slice(1), {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env,
    });
    return {
      exitCode: typeof result.status === 'number' ? result.status : -1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      durationMs: Date.now() - started,
      timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    };
  };
}

function appendLog(file, entry) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify({ at: nowIso(), ...entry })}\n`);
}

/* Режим задания неизменяем: id адаптеров пишутся в состояние при инициализации,
   повторный init с другим содержимым отклоняется (taskId immutable). */
export function taskMode(state) {
  if (state.mode === 'real' || state.mode === 'fixture') return state.mode;
  const realById = String(state.implementer || '').startsWith('codex-')
    || String(state.reviewer || '').startsWith('codex-');
  return realById ? 'real' : 'fixture';
}

function modeViolation(state) {
  const mode = taskMode(state);
  if (state.mode && state.mode !== mode) {
    return { code: 'AGENT_MODE_MISMATCH', detail: `recorded mode ${state.mode} does not match adapters ${state.implementer}/${state.reviewer}` };
  }
  if (mode === 'real' && state.realAgentsArmed !== true) {
    return { code: 'REAL_AGENT_NOT_ARMED', detail: 'real agent adapters require an explicit --confirm-real-agents <taskId> at init' };
  }
  return null;
}

export function initTask({
  root, taskFile, implementer = 'fixture-implementer', reviewer = 'fixture-reviewer', confirmRealAgents = null,
}) {
  const task = loadTask(taskFile);
  const implementerAdapter = assertRole(implementer, 'implementer');
  const reviewerAdapter = assertRole(reviewer, 'reviewer');
  if (implementer === reviewer) throw Object.assign(new Error('implementer and reviewer must differ'), { code: 'SELF_REVIEW' });

  const real = implementerAdapter.simulated !== true || reviewerAdapter.simulated !== true;
  if (real && confirmRealAgents !== task.taskId) {
    throw Object.assign(
      new Error(`real agent adapters require explicit confirmation: --confirm-real-agents ${task.taskId}`),
      { code: 'REAL_AGENT_NOT_ARMED', taskId: task.taskId },
    );
  }
  const store = new Store(root);
  return store.init(task, {
    implementer, reviewer, mode: real ? 'real' : 'fixture', realAgentsArmed: real && confirmRealAgents === task.taskId,
  });
}

function checkout({ store, root, state }) {
  const task = state.task;
  if (deadlinePassed(task)) {
    return store.markBlocked(task.taskId, {
      action: 'deadline_check',
      actor: 'orchestrator',
      code: 'deadline_exceeded',
      detail: `deadline ${task.deadline} is in the past`,
    });
  }
  const { wsRoot, implementerDir, reviewerDir } = workspacePaths(root, task.taskId);
  ensureDir(wsRoot);
  if (!fs.existsSync(path.join(implementerDir, '.git'))) {
    copyTree(FIXTURE_DIR, implementerDir);
    initRepo(implementerDir);
  }
  const baseCommit = revParse(implementerDir, 'HEAD');
  return store.transition({
    taskId: task.taskId,
    to: 'READY',
    action: 'checkout',
    actor: 'orchestrator',
    payload: {
      patch: {
        baseCommit,
        workspaces: { implementer: rel(root, implementerDir), reviewer: rel(root, reviewerDir) },
        reason: `isolated workspaces prepared from fixture, base ${baseCommit.slice(0, 8)}`,
      },
    },
  });
}

function capabilityBlock(store, state, capability) {
  const code = capability.programmatic === false
    ? 'agent_not_scriptable'
    : capability.available === false
      ? 'agent_unavailable'
      : 'agent_unauthenticated';
  return store.markBlocked(state.taskId, {
    action: 'capability_check',
    actor: 'orchestrator',
    code,
    detail: capability.requiresHuman || capability.reason || 'agent interface is not usable programmatically',
    patch: { capability, blockedAdapter: capability.adapter || null },
  });
}

async function runImplementer({ store, root, state }) {
  const task = state.task;
  const modeIssue = modeViolation(state);
  if (modeIssue) {
    return store.markBlocked(task.taskId, {
      action: 'agent_mode_check', actor: 'orchestrator', code: modeIssue.code, detail: modeIssue.detail,
    });
  }
  if (deadlinePassed(task)) {
    return store.markBlocked(task.taskId, {
      action: 'deadline_check', actor: 'orchestrator', code: 'deadline_exceeded',
      detail: `deadline ${task.deadline} is in the past`,
    });
  }
  const iteration = state.state === 'IMPLEMENTING' ? state.iteration : state.iteration + 1;
  if (iteration > task.maxIterations) {
    return store.markBlocked(task.taskId, {
      action: 'iteration_limit', actor: 'orchestrator', code: 'max_iterations_exceeded',
      detail: `iteration ${iteration} exceeds maxIterations ${task.maxIterations}`,
    });
  }

  const adapter = assertRole(state.implementer, 'implementer');
  const capability = { ...adapter.probe(), adapter: state.implementer };
  if (capability.available === false || capability.programmatic === false || capability.authenticated === false) {
    return capabilityBlock(store, state, capability);
  }

  const stop = budgetStop(state, task, 'implementer');
  if (stop) {
    return store.markBlocked(task.taskId, {
      action: 'budget_check', actor: 'orchestrator', code: stop.code, detail: stop.detail,
      patch: { budget: budgetSnapshot(state, task) },
    });
  }

  if (state.state === 'READY') {
    state = store.transition({
      taskId: task.taskId, to: 'IMPLEMENTING', action: 'start_iteration', actor: 'orchestrator',
      payload: { iteration, patch: { reason: `iteration ${iteration} started` } },
    });
  }

  const { wsRoot, implementerDir, reviewerDir } = workspacePaths(root, task.taskId);
  // Рабочее дерево проверяющего пересоздаётся из базы перед каждым ревью и на
  // время работы исполнителя отсутствует: читать ему нечего.
  rmrf(reviewerDir);

  const logFile = path.join(root, 'logs', task.taskId, `iteration-${iteration}.log`);
  const codexLogDir = path.join(root, 'logs', task.taskId, 'codex');
  const logStem = `implementer-${iteration}`;
  const transcriptPath = path.join(codexLogDir, `${logStem}.jsonl`);
  const promptPath = path.join(root, 'logs', task.taskId, 'prompts', `${logStem}.txt`);
  const outputPath = path.join(root, 'logs', task.taskId, `${logStem}.result.json`);
  const metaPath = path.join(codexLogDir, `${logStem}.meta.json`);
  const resumeId = iteration > 1 ? ((state.sessions?.implementer || []).at(-1)?.threadId || null) : null;
  const budgetMs = remainingBudgetMs(state, task, 'implementer');
  const prompt = implementerPrompt({
    task, iteration, baseCommit: state.baseCommit, findings: state.findings || [],
    workspace: implementerDir, resume: Boolean(resumeId),
  });
  const runCommand = commandRunner(implementerDir, task);
  const started = Date.now();

  let outcome;
  try {
    outcome = await adapter.run({
      task, iteration, workspace: implementerDir, baseCommit: state.baseCommit,
      findings: state.findings || [], runCommand, logFile,
      prompt, schemaPath: IMPLEMENTER_SCHEMA, outputPath, promptPath, transcriptPath, metaPath,
      resumeId, timeoutMs: budgetMs, sandbox: 'workspace-write',
    });
  } catch (err) {
    appendLog(logFile, { phase: 'implementer', adapter: state.implementer, error: String(err.message || err) });
    if (err.code === 'AGENT_NOT_SCRIPTABLE') {
      return store.markBlocked(task.taskId, {
        action: 'adapter_refusal', actor: state.implementer, code: 'agent_not_scriptable',
        detail: err.message, patch: { adapterEvidence: err.evidence || null },
      });
    }
    return store.markBlocked(task.taskId, {
      action: 'adapter_error', actor: state.implementer, code: 'adapter_error', detail: String(err.message || err),
    });
  }
  const elapsedMs = Date.now() - started;
  const evidence = accounting({ root, state, role: 'implementer', outcome, elapsedMs, iteration, kind: resumeId ? 'resume' : 'fresh' });
  appendLog(logFile, {
    phase: 'implementer', adapter: state.implementer, iteration,
    durationMs: elapsedMs, blocked: outcome.blocked || null,
    threadId: evidence.lastSession.threadId, resume: resumeId || null,
    usage: evidence.lastSession.usage,
    resultCommit: outcome.result ? outcome.result.resultCommit : null,
  });

  if (outcome.blocked) {
    return store.markBlocked(task.taskId, {
      action: 'adapter_blocked', actor: state.implementer, code: outcome.blocked.code, detail: outcome.blocked.detail,
      patch: evidence,
    });
  }
  if (!outcome.result) {
    return store.markBlocked(task.taskId, {
      action: 'adapter_contract', actor: state.implementer, code: 'result_missing',
      detail: 'implementer returned no result object', patch: evidence,
    });
  }

  let modelResult;
  try {
    modelResult = assertValid(schemas.implementerResult, outcome.result, 'implementer-result');
  } catch (err) {
    return store.markBlocked(task.taskId, {
      action: 'result_contract', actor: 'orchestrator', code: 'contract_violation',
      detail: err instanceof SchemaError ? err.message : String(err.message || err),
      patch: { ...evidence, schemaErrors: err.errors || null },
    });
  }

  const changed = changedFiles(implementerDir, state.baseCommit);

  /* Проверка типов файлов до любого чтения: symlink внутрь/наружу, FIFO,
     device и socket в workspace — остановка, а не «прочитать что получится». */
  const unsafeFiles = [];
  const implementerRoot = safeRootDir(implementerDir);
  for (const item of changed) {
    try {
      if (item.status === 'deleted') {
        const parent = item.file.split('/').slice(0, -1).join('/');
        if (parent) assertSafeParents(implementerRoot, parent);
        continue;
      }
      assertRegularFileWithin(implementerRoot, item.file);
    } catch (err) {
      unsafeFiles.push({ code: err.code || 'UNSAFE_FILE_TYPE', file: item.file, detail: err.message });
    }
  }
  for (const link of findSymlinks(implementerDir)) {
    if (!unsafeFiles.some((entry) => entry.file === link)) {
      unsafeFiles.push({ code: 'SYMLINK_ESCAPE', file: link, detail: 'symlink inside the implementer workspace' });
    }
  }
  if (unsafeFiles.length) {
    appendLog(logFile, { phase: 'file_safety', unsafeFiles });
    return store.markBlocked(task.taskId, {
      action: 'file_safety_check',
      actor: 'orchestrator',
      code: unsafeFiles[0].code,
      detail: `workspace contains paths that are not regular files inside it: ${unsafeFiles.map((v) => `${v.file} (${v.code})`).join(', ')}`,
      patch: { ...evidence, unsafeFiles },
    });
  }

  const violations = [
    ...scanEscape(wsRoot, [implementerDir, reviewerDir]),
    ...checkResult(task, { ...state, iteration }, modelResult, changed),
  ];
  const headCommit = revParse(implementerDir, 'HEAD');
  if (modelResult.resultCommit !== headCommit) {
    violations.push({ code: 'RESULT_COMMIT_MISMATCH', detail: `declared ${modelResult.resultCommit}, actual ${headCommit}` });
  }
  if (violations.length) {
    appendLog(logFile, { phase: 'policy', violations });
    return store.markBlocked(task.taskId, {
      action: 'authority_check', actor: 'orchestrator', code: 'authority_violation',
      detail: `implementer exceeded the task contract: ${violations.map((v) => v.code + (v.file ? `:${v.file}` : '')).join(', ')}`,
      patch: { ...evidence, violations },
    });
  }

  if (state.result && state.result.resultCommit === modelResult.resultCommit) {
    return store.markBlocked(task.taskId, {
      action: 'progress_check', actor: 'orchestrator', code: 'no_progress_no_changes',
      detail: 'implementer produced no new commit for a new iteration',
    });
  }

  let artifact;
  try {
    artifact = buildArtifact({
      root, taskId: task.taskId, iteration, baseCommit: state.baseCommit,
      resultCommit: modelResult.resultCommit, workspace: implementerDir, changes: changed,
    });
  } catch (err) {
    return store.markBlocked(task.taskId, {
      action: 'build_artifact',
      actor: 'orchestrator',
      code: err.code === 'SECRET_IN_ARTIFACT'
        ? 'secret_leak_in_artifact'
        : (err.code === 'SYMLINK_ESCAPE' || err.code === 'UNSAFE_FILE_TYPE' ? err.code : 'artifact_build_failed'),
      detail: String(err.message || err),
      patch: { ...evidence, secretFiles: err.names ? [err.file] : null },
    });
  }

  const result = {
    ...modelResult,
    artifactId: artifact.artifactId,
    artifactSha256: artifact.sha256,
    changedFiles: changed.map((c) => c.file),
    status: 'submitted',
  };
  if (!/^art-\d+-[a-f0-9]{16}$/.test(result.artifactId) || !/^[a-f0-9]{64}$/.test(result.artifactSha256)) {
    return store.markBlocked(task.taskId, {
      action: 'result_contract', actor: 'orchestrator', code: 'contract_violation',
      detail: 'artifact identifiers produced by the orchestrator have an invalid format', patch: evidence,
    });
  }

  const metaForState = {
    artifactId: artifact.artifactId, sha256: artifact.sha256, size: artifact.size, path: artifact.path,
    taskId: artifact.taskId, iteration, baseCommit: artifact.baseCommit, resultCommit: artifact.resultCommit,
    files: artifact.files, deletions: artifact.deletions, createdAt: artifact.createdAt,
  };

  return store.transition({
    taskId: task.taskId, to: 'ARTIFACT_SUBMITTED', action: 'submit_artifact', actor: state.implementer,
    payload: {
      iteration,
      patch: {
        ...evidence,
        result,
        artifacts: [...(state.artifacts || []), metaForState],
        reason: `artifact ${artifact.artifactId} (${artifact.sha256.slice(0, 12)}…) built from ${changed.length} changed file(s)`,
      },
    },
  });
}

async function runReviewer({ store, root, state }) {
  const task = state.task;
  const modeIssue = modeViolation(state);
  if (modeIssue) {
    return store.markBlocked(task.taskId, {
      action: 'agent_mode_check', actor: 'orchestrator', code: modeIssue.code, detail: modeIssue.detail,
    });
  }
  if (state.reviewer === state.implementer) {
    return store.markBlocked(task.taskId, {
      action: 'independence_check', actor: 'orchestrator', code: 'reviewer_not_independent',
      detail: 'reviewer adapter equals implementer adapter',
    });
  }
  const adapter = assertRole(state.reviewer, 'reviewer');
  const capability = { ...adapter.probe(), adapter: state.reviewer };
  if (capability.available === false || capability.programmatic === false || capability.authenticated === false) {
    return capabilityBlock(store, state, capability);
  }

  const stop = budgetStop(state, task, 'reviewer');
  if (stop) {
    return store.markBlocked(task.taskId, {
      action: 'budget_check', actor: 'orchestrator', code: stop.code, detail: stop.detail,
      patch: { budget: budgetSnapshot(state, task) },
    });
  }

  const meta = (state.artifacts || []).at(-1);
  if (!meta || !state.result) {
    return store.markBlocked(task.taskId, {
      action: 'artifact_lookup', actor: 'orchestrator', code: 'no_artifact', detail: 'nothing to review',
    });
  }

  if (state.state === 'ARTIFACT_SUBMITTED') {
    state = store.transition({
      taskId: task.taskId, to: 'REVIEWING', action: 'start_review', actor: state.reviewer,
      payload: { iteration: state.iteration, patch: { reason: `review of ${meta.artifactId}` } },
    });
  }

  const { implementerDir, reviewerDir } = workspacePaths(root, task.taskId);
  const zipPath = path.join(path.resolve(root), meta.path);
  const bytes = fs.readFileSync(zipPath);
  const verified = verifyArtifactFiles(meta, bytes);
  if (!verified.ok) {
    return store.markBlocked(task.taskId, {
      action: 'calculate_hash', actor: 'orchestrator', code: 'artifact_hash_mismatch',
      detail: 'artifact bytes on disk do not match the recorded sha256',
      patch: { artifactMismatch: verified },
    });
  }

  // Рабочее дерево проверяющего: чистая копия базы + применённый артефакт.
  // История исполнителя и его незакоммиченные файлы сюда не попадают.
  rmrf(reviewerDir);
  const baseDir = path.join(reviewerDir, 'base');
  const appliedDir = path.join(reviewerDir, 'applied');
  cloneAt(implementerDir, baseDir, state.baseCommit);
  cloneAt(implementerDir, appliedDir, state.baseCommit);
  applyArtifactTo(appliedDir, bytes);
  fs.copyFileSync(
    path.join(REVIEWER_CHECKS_DIR, 'reviewer.extra.test.mjs'),
    path.join(appliedDir, 'tests', 'reviewer.extra.test.mjs'),
  );
  const archivePath = path.join(appliedDir, '.review', 'artifact.zip');
  ensureDir(path.dirname(archivePath));
  fs.writeFileSync(archivePath, bytes);

  const logFile = path.join(root, 'logs', task.taskId, `review-${state.iteration}.log`);
  const codexLogDir = path.join(root, 'logs', task.taskId, 'codex');
  const logStem = `reviewer-${state.iteration}`;
  const transcriptPath = path.join(codexLogDir, `${logStem}.jsonl`);
  const promptPath = path.join(root, 'logs', task.taskId, 'prompts', `${logStem}.txt`);
  const outputPath = path.join(root, 'logs', task.taskId, `${logStem}.result.json`);
  const metaPath = path.join(codexLogDir, `${logStem}.meta.json`);
  const prompt = reviewerPrompt({
    task, baseCommit: state.baseCommit, resultCommit: state.result.resultCommit,
    artifactPath: archivePath, artifactSha256: meta.sha256, artifactBytes: bytes.length,
    appliedDir, baseDir,
  });
  const runCommand = commandRunner(appliedDir, task);
  const budgetMs = remainingBudgetMs(state, task, 'reviewer');
  const started = Date.now();

  let outcome;
  try {
    outcome = await adapter.run({
      task, workspace: appliedDir, archive: bytes, meta, result: state.result,
      findings: state.findings || [], baseCommit: state.baseCommit, resultCommit: state.result.resultCommit,
      implementerDir, reviewerChecksDir: REVIEWER_CHECKS_DIR, runCommand, logFile,
      prompt, schemaPath: REVIEW_SCHEMA, outputPath, promptPath, transcriptPath, metaPath,
      timeoutMs: budgetMs, sandbox: 'workspace-write',
    });
  } catch (err) {
    appendLog(logFile, { phase: 'reviewer', adapter: state.reviewer, error: String(err.message || err) });
    return store.markBlocked(task.taskId, {
      action: 'adapter_error', actor: state.reviewer, code: 'adapter_error', detail: String(err.message || err),
    });
  }
  const elapsedMs = Date.now() - started;
  const evidence = accounting({ root, state, role: 'reviewer', outcome, elapsedMs, iteration: state.iteration, kind: 'fresh' });
  appendLog(logFile, {
    phase: 'reviewer', adapter: state.reviewer, durationMs: elapsedMs,
    verdict: outcome.review ? outcome.review.verdict : null,
    threadId: evidence.lastSession.threadId, usage: evidence.lastSession.usage,
  });

  if (outcome.blocked) {
    return store.markBlocked(task.taskId, {
      action: 'adapter_blocked', actor: state.reviewer, code: outcome.blocked.code, detail: outcome.blocked.detail,
      patch: evidence,
    });
  }

  let review;
  try {
    review = assertValid(schemas.reviewResult, outcome.review, 'review-result');
  } catch (err) {
    return store.markBlocked(task.taskId, {
      action: 'review_contract', actor: state.reviewer, code: 'contract_violation',
      detail: err instanceof SchemaError ? err.message : String(err.message || err),
      patch: { ...evidence, schemaErrors: err.errors || null },
    });
  }

  const inconsistent = [];
  if (review.artifactSha256 !== meta.sha256) inconsistent.push('review_artifact_hash_mismatch');
  if (review.baseCommit !== state.baseCommit) inconsistent.push('review_base_commit_mismatch');
  if (review.resultCommit !== state.result.resultCommit) inconsistent.push('review_result_commit_mismatch');
  if (review.reviewer !== state.reviewer) inconsistent.push('review_reviewer_mismatch');
  if (review.simulated !== (adapter.simulated === true)) inconsistent.push('review_simulated_flag_mismatch');
  if (review.verdict !== 'BLOCKED' && !review.checks.some((c) => c.command && Number.isInteger(c.exitCode))) {
    inconsistent.push('review_no_executed_checks');
  }
  if (inconsistent.length) {
    return store.markBlocked(task.taskId, {
      action: 'review_cross_check', actor: 'orchestrator', code: 'review_inconsistent',
      detail: `reviewer report contradicts recorded facts: ${inconsistent.join(', ')}`,
      patch: { ...evidence, inconsistent },
    });
  }

  const failing = review.checks.filter((c) => !c.ok);
  let verdict = review.verdict;
  let downgraded = false;
  // Оркестратор не превращает провал в успех: несогласованный ACCEPTED понижается.
  if (verdict === 'ACCEPTED' && failing.length) {
    verdict = 'CHANGES_REQUESTED';
    downgraded = true;
  }
  const normalized = { ...review, verdict };

  if (verdict === 'BLOCKED') {
    return store.markBlocked(task.taskId, {
      action: 'submit_review', actor: state.reviewer, code: 'reviewer_blocked',
      detail: (review.findings || []).map((f) => f.code).join(', ') || 'reviewer returned BLOCKED',
      patch: { ...evidence, review: normalized },
    });
  }

  const signature = sha256(canonical((review.findings || []).map((f) => `${f.code}|${f.file || ''}|${f.detail}`).sort()));
  const signatures = [...(state.findingsSignatures || []), signature];

  if (verdict === 'ACCEPTED') {
    return store.transition({
      taskId: task.taskId, to: 'ACCEPTED', action: 'submit_review', actor: state.reviewer,
      payload: {
        iteration: state.iteration,
        patch: {
          ...evidence,
          review: normalized,
          findings: review.findings || [],
          findingsSignature: signature,
          findingsSignatures: signatures,
          acceptedArtifactId: meta.artifactId,
          acceptedArtifactSha256: meta.sha256,
          acceptedAt: nowIso(),
          simulatedReview: adapter.simulated === true,
          reviewDowngraded: downgraded,
          reason: `ACCEPTED by ${review.reviewer}${adapter.simulated ? ' (simulated)' : ''}`,
        },
      },
    });
  }

  return store.transition({
    taskId: task.taskId, to: 'CHANGES_REQUESTED', action: 'submit_review', actor: state.reviewer,
    payload: {
      iteration: state.iteration,
      patch: {
        ...evidence,
        review: normalized,
        findings: review.findings || [],
        findingsSignature: signature,
        findingsSignatures: signatures,
        simulatedReview: adapter.simulated === true,
        reviewDowngraded: downgraded,
        reason: `${normalized.findings.length} finding(s) from ${review.reviewer}`,
      },
    },
  });
}

function nextIteration({ store, root, state }) {
  const task = state.task;
  if (deadlinePassed(task)) {
    return store.markBlocked(task.taskId, {
      action: 'deadline_check', actor: 'orchestrator', code: 'deadline_exceeded', detail: `deadline ${task.deadline} passed`,
    });
  }
  const signatures = state.findingsSignatures || [];
  if (signatures.length >= 2 && signatures.at(-1) === signatures.at(-2)) {
    return store.markBlocked(task.taskId, {
      action: 'progress_check', actor: 'orchestrator', code: 'no_progress_repeated_finding',
      detail: 'the same set of findings repeated twice without progress',
      patch: { repeatedFindingSignature: signatures.at(-1) },
    });
  }
  if (state.iteration >= task.maxIterations) {
    return store.markBlocked(task.taskId, {
      action: 'iteration_limit', actor: 'orchestrator', code: 'max_iterations_exceeded',
      detail: `iteration ${state.iteration} reached maxIterations ${task.maxIterations}`,
    });
  }
  return store.transition({
    taskId: task.taskId, to: 'IMPLEMENTING', action: 'next_iteration', actor: 'orchestrator',
    payload: {
      iteration: state.iteration + 1,
      patch: { reason: `changes requested, starting iteration ${state.iteration + 1}` },
    },
  });
}

/* Критическая секция одного шага. Lock берётся до чтения состояния и
   снимается после записи снимка; параллельный процесс получает отказ
   TASK_BUSY и ничего не запускает. */
export async function step({ root, taskId }) {
  const lock = acquireLock(root, taskId, { action: 'step' });
  if (!lock.ok) {
    throw Object.assign(new Error(`task ${taskId} is locked: ${lock.code}`), {
      code: lock.code, lock: lock.lock, reason: lock.reason || null,
    });
  }
  try {
    return await stepLocked({ root, taskId, operationId: lock.operationId });
  } finally {
    lock.release();
  }
}

async function stepLocked({ root, taskId, operationId }) {
  const store = new Store(root, { operationId });
  const state = store.load(taskId);
  if (TERMINAL.has(state.state)) return state;
  try {
    switch (state.state) {
      case 'CREATED': return checkout({ store, root, state });
      case 'READY': return await runImplementer({ store, root, state });
      case 'IMPLEMENTING': return await runImplementer({ store, root, state });
      case 'ARTIFACT_SUBMITTED': return await runReviewer({ store, root, state });
      case 'REVIEWING': return await runReviewer({ store, root, state });
      case 'CHANGES_REQUESTED': return nextIteration({ store, root, state });
      default:
        throw Object.assign(new Error(`no step defined for ${state.state}`), { code: 'NO_SUCH_STEP' });
    }
  } catch (err) {
    if (err.code === 'ILLEGAL_TRANSITION' || err.code === 'JOURNAL_CORRUPT' || err.code === 'TASK_TAMPERED') throw err;
    store.markBlocked(taskId, {
      action: 'orchestrator_error', actor: 'orchestrator', code: 'orchestrator_error',
      detail: String(err.message || err),
    });
    throw err;
  }
}

export async function run({ root, taskId, stopAfter = null, maxSteps = 40 }) {
  const store = new Store(root, { readOnly: true });
  for (let i = 0; i < maxSteps; i++) {
    const state = store.load(taskId);
    if (TERMINAL.has(state.state)) return state;
    if (stopAfter && state.state === stopAfter) return state;
    await step({ root, taskId });
  }
  throw Object.assign(new Error('orchestrator exceeded maxSteps'), { code: 'MAX_STEPS' });
}

/* Подмена байта артефакта: приёмка отменяется, состояние возвращается
   в CHANGES_REQUESTED, событие остаётся в журнале. */
export function verifyArtifact({ root, taskId, file }) {
  const store = new Store(root);
  const state = store.load(taskId);
  const meta = (state.artifacts || []).at(-1);
  if (!meta) throw Object.assign(new Error('no artifact recorded for this task'), { code: 'NO_ARTIFACT' });
  const bytes = fs.readFileSync(file);
  const check = verifyArtifactFiles(meta, bytes);
  if (check.ok) return { ok: true, state: state.state, artifactId: meta.artifactId, ...check };

  if (state.state !== 'ACCEPTED') {
    return { ok: false, revoked: false, state: state.state, artifactId: meta.artifactId, ...check };
  }
  const next = store.transition({
    taskId,
    to: 'CHANGES_REQUESTED',
    action: 'revoke_acceptance',
    actor: 'orchestrator',
    reason: 'artifact bytes changed after acceptance',
    payload: {
      patch: {
        acceptedArtifactSha256: null,
        acceptanceRevoked: {
          at: nowIso(),
          acceptedArtifactId: state.acceptedArtifactId,
          expected: check.expected,
          actual: check.actual,
          expectedSize: check.expectedSize,
          actualSize: check.actualSize,
        },
        reason: 'artifact mutated: acceptance of the changed part revoked',
      },
    },
  });
  return { ok: false, revoked: true, state: next.state, artifactId: meta.artifactId, ...check };
}

const providerOf = (adapter) => (adapter.startsWith('codex') ? 'codex' : adapter.startsWith('fixture-') ? 'fixture' : adapter.startsWith('freebuff') ? 'freebuff' : adapter);

export function report({ root, taskId }) {
  const store = new Store(root, { readOnly: true });
  const state = store.load(taskId);
  const journal = store.verifyJournal(taskId);
  const summary = {
    taskId,
    taskSha256: state.taskSha256,
    state: state.state,
    iteration: state.iteration,
    implementer: state.implementer,
    reviewer: state.reviewer,
    simulatedAgents: { implementer: state.implementer.startsWith('fixture-'), reviewer: state.reviewer.startsWith('fixture-') },
    sameProvider: providerOf(state.implementer) === providerOf(state.reviewer),
    sessions: state.sessions || { implementer: [], reviewer: [] },
    threadIds: {
      implementer: [...new Set((state.sessions?.implementer || []).map((s) => s.threadId).filter(Boolean))],
      reviewer: [...new Set((state.sessions?.reviewer || []).map((s) => s.threadId).filter(Boolean))],
    },
    usage: state.usage || null,
    runtimeMs: { implementer: runtimeMsOf(state, 'implementer'), reviewer: runtimeMsOf(state, 'reviewer'), total: totalRuntimeMsOf(state) },
    budget: budgetSnapshot(state, state.task),
    baseCommit: state.baseCommit || null,
    resultCommit: state.result ? state.result.resultCommit : null,
    acceptedArtifactSha256: state.acceptedArtifactSha256 || null,
    artifacts: (state.artifacts || []).map((a) => ({ artifactId: a.artifactId, sha256: a.sha256, size: a.size, iteration: a.iteration })),
    findings: (state.findings || []).map((f) => f.code),
    reason: state.reason || null,
    blockedCode: state.blockedCode || null,
    transitions: (state.history || []).map((h) => `${h.from}->${h.to}`),
    journal: { events: journal.events.length, head: journal.head, verified: journal.ok },
  };
  const file = path.join(root, 'logs', taskId, 'report.json');
  writeJsonAtomic(file, summary);
  return { ...summary, reportPath: rel(root, file) };
}
