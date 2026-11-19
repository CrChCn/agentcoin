#!/usr/bin/env node
/* CLI оркестратора. Каждая команда — отдельный процесс, поэтому шаг,
   выполненный после перезапуска, доказывает восстановление из журнала. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  IMPLEMENTER_SCHEMA, ORCH_ROOT, REVIEW_SCHEMA, TERMINAL, initTask, loadTask, report, step, verifyArtifact,
} from './lib/engine.mjs';
import { Store } from './state/store.mjs';
import { getAdapter, listAdapters } from './adapters/resolver.mjs';
import { readJson } from './lib/fsx.mjs';
import { reconcileLock, lockStatus } from './lib/lock.mjs';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = ORCH_ROOT;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

const print = (value) => console.log(JSON.stringify(value, null, 2));
const rootOf = (opts) => path.resolve(opts.root || DEFAULT_ROOT);
const TERMINAL_STATES = new Set(['ACCEPTED', 'BLOCKED', 'FAILED', 'CANCELLED']);

/* Проверка точки запуска: CLI, вход, контракты, бюджеты, свежий root.
   Ничего не запускает и не меняет состояние. */
function preflight({ root, taskFile }) {
  const task = loadTask(taskFile);
  const roles = [
    { role: 'implementer', id: 'codex-implementer' },
    { role: 'reviewer', id: 'codex-reviewer' },
  ];
  const adapters = roles.map(({ role, id }) => {
    const adapter = getAdapter(id);
    return { role, id, simulated: adapter.simulated === true, ...adapter.probe() };
  });
  const schemas = [IMPLEMENTER_SCHEMA, REVIEW_SCHEMA].map((file) => ({
    file: path.relative(ORCH_ROOT, file).replace(/\\/g, '/'),
    present: fs.existsSync(file),
  }));

  const blockers = [];
  for (const adapter of adapters) {
    if (adapter.simulated) blockers.push({ role: adapter.role, code: 'SIMULATED_ADAPTER', detail: `${adapter.id} is a test double` });
    if (adapter.available === false) blockers.push({ role: adapter.role, code: 'agent_unavailable', detail: adapter.reason });
    else if (adapter.authenticated === false) {
      blockers.push({
        role: adapter.role, code: 'agent_unauthenticated',
        detail: `Run \`${adapter.requiresHuman || 'codex login'}\` once on this computer, then re-run preflight. Do not paste the key into chat or the repository.`,
      });
    }
  }
  for (const schema of schemas) {
    if (!schema.present) blockers.push({ code: 'SCHEMA_MISSING', detail: schema.file });
  }
  if (adapters[0].id === adapters[1].id) blockers.push({ code: 'SELF_REVIEW', detail: 'implementer and reviewer must be different adapters' });

  const store = new Store(root, { readOnly: true });
  if (store.exists(task.taskId)) {
    const existing = store.load(task.taskId);
    if (existing.implementer !== 'codex-implementer' || existing.reviewer !== 'codex-reviewer') {
      blockers.push({
        code: 'ROOT_NOT_FRESH',
        detail: `${root} already holds task ${task.taskId} with ${existing.implementer}/${existing.reviewer}; use a new --root for the real cycle`,
      });
    }
  }

  return {
    status: blockers.length ? 'BLOCKED' : 'READY',
    ready: blockers.length === 0,
    taskId: task.taskId,
    root: path.resolve(root),
    budgets: {
      maxIterations: task.maxIterations,
      maxRuntimePerAgentMinutes: task.maxRuntimePerAgentMinutes,
      maxTotalRuntimeMinutes: task.maxTotalRuntimeMinutes,
      maxTotalTokens: task.maxTotalTokens,
      monetaryLimit: null,
      note: 'CLI does not expose a hard monetary limit; the orchestrator counts recorded tokens and stops new iterations by local policy.',
    },
    adapters,
    schemas,
    blockers,
    nextCommand: blockers.length
      ? (blockers.every((b) => b.code === 'agent_unauthenticated') ? 'codex login' : blockers[0].code)
      : `node orchestrator.mjs real --task ${path.resolve(taskFile)} --root ${path.resolve(root)}`,
  };
}

function statusOf(state) {
  const artifact = (state.artifacts || []).at(-1) || null;
  return {
    taskId: state.taskId,
    state: state.state,
    iteration: state.iteration,
    implementer: state.implementer,
    reviewer: state.reviewer,
    baseCommit: state.baseCommit || null,
    resultCommit: state.result ? state.result.resultCommit : null,
    artifact: artifact ? { artifactId: artifact.artifactId, sha256: artifact.sha256, size: artifact.size } : null,
    findings: (state.findings || []).map((f) => f.code),
    blockedCode: state.blockedCode || null,
    reason: state.reason || null,
    mode: state.mode || null,
    realAgentsArmed: state.realAgentsArmed === true,
    journalEvents: state.seq,
  };
}

/* Lock-отказы не меняют состояние задания: это ответ «занято», а не BLOCKED. */
function reportLockFailure(err, taskId) {
  if (err.code !== 'TASK_BUSY' && err.code !== 'NEEDS_RECONCILE') throw err;
  print({
    taskId,
    blockedCode: err.code,
    lock: err.lock || null,
    reason: err.reason || err.message,
    note: err.code === 'TASK_BUSY'
      ? 'another process holds the task lock; this process ran nothing'
      : `inspect the lock, then run: node orchestrator.mjs reconcile --task ${taskId} --force`,
  });
  return err.code === 'TASK_BUSY' ? 75 : 76;
}

function usage() {
  return [
    'usage: node orchestrator.mjs <command> [options]',
    '',
    '  capabilities                        показать официальные интерфейсы адаптеров',
    '  preflight [--task <file>] [--root dir] [--codex-bin <path>]  проверить точку запуска',
    '  real --task <file> --root <dir> --confirm-real-agents <taskId>   настоящий цикл (требует явного подтверждения)',
    '  init --task <file> [--implementer id] [--reviewer id] [--confirm-real-agents taskId] [--root dir]',
    '  step --task <taskId>                выполнить один типизированный переход',
    '  reconcile --task <taskId> [--force] снять мёртвый lock после разбора журнала',
    '  run  --task <taskId> [--stop-after STATE]',
    '  status --task <taskId>',
    '  verify --task <taskId> --artifact <file>   проверить байты и отозвать приёмку',
    '  report --task <taskId>',
    '  demo [--root dir]                   сквозной прогон в отдельном процессе на шаг',
  ].join('\n');
}

async function demo(root) {
  const demoRoot = path.join(root === DEFAULT_ROOT ? os.tmpdir() : root, 'agentcoin-orchestrator-demo');
  fs.rmSync(demoRoot, { recursive: true, force: true });
  const taskFile = path.join(ORCH_ROOT, 'fixtures', 'tasks', 'lesson-01.json');
  const task = readJson(taskFile, null);

  const cli = (argv) => {
    const result = spawnSync(process.execPath, [SELF, ...argv, '--root', demoRoot], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`command failed: ${argv.join(' ')}\n${result.stdout}\n${result.stderr}`);
    }
    return JSON.parse(result.stdout);
  };

  const started = Date.now();
  cli(['init', '--task', taskFile]);
  let status = cli(['status', '--task', task.taskId]);
  let processes = 2;
  const trail = [{ state: status.state, iteration: status.iteration }];
  while (!TERMINAL_STATES.has(status.state) && processes < 20) {
    status = cli(['step', '--task', task.taskId]);
    processes++;
    trail.push({ state: status.state, iteration: status.iteration, findings: status.findings, artifact: status.artifact && status.artifact.artifactId });
  }
  const final = cli(['report', '--task', task.taskId]);

  const lines = [
    'Agentcoin Autonomous Engineering Loop — stage A demo',
    `task: ${task.taskId} | implementer: ${final.implementer} (SIMULATED) | reviewer: ${final.reviewer} (SIMULATED)`,
    `separate OS processes: ${processes} | iterations: ${final.iteration} | elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`,
    '',
    'trail:',
    ...trail.map((t) => `  ${t.state}${t.iteration ? ` (iteration ${t.iteration})` : ''}${t.findings ? ` findings=${t.findings.join(',')}` : ''}`),
    '',
    `final: ${final.state}`,
    `base commit: ${final.baseCommit}`,
    `result commit: ${final.resultCommit}`,
    `accepted artifact: ${final.acceptedArtifactSha256 || '(none)'}`,
    `journal: ${final.journal.events} events, head ${final.journal.head}, chain verified=${final.journal.verified}`,
    `report: ${final.reportPath}`,
    '',
    'NOTE: оба агента — детерминированные дублёры, а не Codex. Настоящий цикл',
    'запускается командой `real` и требует `codex login` на этой машине.',
  ];
  console.log(lines.join('\n'));
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const root = rootOf(opts);
  if (!command) { console.error(usage()); return 64; }

  switch (command) {
    case 'capabilities':
      print({ orchestrator: 'stage-a/1', adapters: listAdapters() });
      return 0;
    case 'preflight': {
      if (opts['codex-bin']) process.env.CODEX_BIN = path.resolve(String(opts['codex-bin']));
      const taskFile = path.resolve(String(opts.task || path.join(ORCH_ROOT, 'fixtures', 'tasks', 'lesson-01.json')));
      const result = preflight({ root, taskFile });
      print(result);
      return result.ready ? 0 : 3;
    }
    case 'real': {
      if (!opts.task || !opts.root) { console.error('real requires --task <file> and --root <dir>'); return 64; }
      if (opts['codex-bin']) process.env.CODEX_BIN = path.resolve(String(opts['codex-bin']));
      const taskFile = path.resolve(String(opts.task));
      const task = loadTask(taskFile);

      /* Реальные адаптеры не запускаются без явного подтверждения именно
         этого задания: ни preflight, ни init, ни один агент. */
      if (String(opts['confirm-real-agents'] || '') !== task.taskId) {
        print({
          status: 'BLOCKED',
          blockedCode: 'REAL_AGENT_NOT_ARMED',
          taskId: task.taskId,
          required: `--confirm-real-agents ${task.taskId}`,
          note: 'no preflight, no agent run and no state change were performed',
        });
        return 3;
      }

      const check = preflight({ root, taskFile });
      if (!check.ready) {
        print(check);
        return 3;
      }
      initTask({
        root, taskFile, implementer: 'codex-implementer', reviewer: 'codex-reviewer', confirmRealAgents: task.taskId,
      });
      const trail = [];
      let state = new Store(root, { readOnly: true }).load(task.taskId);
      try {
        for (let i = 0; i < 40 && !TERMINAL.has(state.state); i++) {
          state = await step({ root, taskId: task.taskId });
          trail.push(statusOf(state));
        }
      } catch (err) {
        return reportLockFailure(err, task.taskId);
      }
      const final = report({ root, taskId: task.taskId });
      print({ preflight: check, trail, final });
      return final.state === 'ACCEPTED' ? 0 : 4;
    }
    case 'init': {
      if (!opts.task) { console.error('init requires --task <file>'); return 64; }
      let result;
      try {
        result = initTask({
          root,
          taskFile: opts.task,
          implementer: opts.implementer || 'fixture-implementer',
          reviewer: opts.reviewer || 'fixture-reviewer',
          confirmRealAgents: opts['confirm-real-agents'] ? String(opts['confirm-real-agents']) : null,
        });
      } catch (err) {
        if (err.code === 'REAL_AGENT_NOT_ARMED') {
          print({
            status: 'BLOCKED',
            blockedCode: err.code,
            taskId: err.taskId,
            required: `--confirm-real-agents ${err.taskId}`,
            note: 'nothing was created',
          });
          return 3;
        }
        throw err;
      }
      print({ created: result.created, ...statusOf(result.state) });
      return 0;
    }
    case 'step': {
      if (!opts.task) { console.error('step requires --task <taskId>'); return 64; }
      try {
        print(statusOf(await step({ root, taskId: opts.task })));
        return 0;
      } catch (err) {
        return reportLockFailure(err, opts.task);
      }
    }
    case 'run': {
      if (!opts.task) { console.error('run requires --task <taskId>'); return 64; }
      try {
        print(statusOf(await run({ root, taskId: opts.task, stopAfter: opts['stop-after'] || null })));
        return 0;
      } catch (err) {
        return reportLockFailure(err, opts.task);
      }
    }
    case 'status': {
      const view = statusOf(new Store(root, { readOnly: true }).load(opts.task));
      print({ ...view, lock: lockStatus(root, opts.task) });
      return 0;
    }
    case 'reconcile': {
      if (!opts.task) { console.error('reconcile requires --task <taskId>'); return 64; }
      const store = new Store(root, { readOnly: true });
      let journal = null;
      try {
        journal = store.verifyJournal(opts.task);
      } catch {
        journal = null;
      }
      if (journal && !journal.ok) {
        print({ ok: false, code: 'JOURNAL_CORRUPT', errors: journal.errors });
        return 2;
      }
      const result = reconcileLock(root, opts.task, { force: Boolean(opts.force) });
      print(result);
      if (result.ok) return 0;
      return result.code === 'TASK_BUSY' ? 75 : 76;
    }
    case 'verify': {
      if (!opts.task || !opts.artifact) { console.error('verify requires --task and --artifact'); return 64; }
      const result = verifyArtifact({ root, taskId: opts.task, file: opts.artifact });
      print(result);
      return result.ok ? 0 : 2;
    }
    case 'report': {
      print(report({ root, taskId: opts.task }));
      return 0;
    }
    case 'demo':
      return demo(root);
    default:
      console.error(usage());
      return 64;
  }
}

/* Модуль можно импортировать (проверка комплектности пакета), не запуская
   CLI: побочный эффект появляется только при прямом запуске файла. */
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`${err.code || 'ERROR'}: ${err.message}`);
    if (err.errors) console.error(JSON.stringify(err.errors, null, 2));
    process.exitCode = 1;
  });
}
