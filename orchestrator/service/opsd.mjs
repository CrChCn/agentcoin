#!/usr/bin/env node
/* Единая точка входа сервиса. Роли разделены командами, чтобы каждый процесс
   был отдельным systemd-юнитом: loop (оркестратор), plan (таймер), api,
   watchdog. Команды только читают/пишут OPS_ROOT; сети, SSH, деплоя и денег
   здесь нет. */

import fs from 'node:fs';
import path from 'node:path';

import { OpsStore, resolvePaths } from './store.mjs';
import { loadMission, planNext } from './planner.mjs';
import { loop, tick, realAgentsGate } from './runner.mjs';
import { checkWatchdog } from './watchdog.mjs';
import { startApi } from './api.mjs';

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
const rootOf = (opts) => path.resolve(opts.root || process.env.OPS_ROOT || '/srv/agentcoin-ops');

function ensureLayout(root) {
  const paths = resolvePaths(root);
  for (const dir of [paths.tasksDir, paths.backlogDir, path.dirname(paths.memoryFile), path.dirname(paths.heartbeatFile), paths.runsDir, paths.artifactsDir, paths.logsDir, paths.workspacesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

function usage() {
  return [
    'usage: node service/opsd.mjs <command> [--root dir] [--mission file]',
    '',
    '  status                     состояние сервиса, очередь, checkpoint, память',
    '  plan                       один проход планировщика (таймер)',
    '  tick                       один цикл: восстановление → план → шаги задания',
    '  loop [--once] [--until-idle]  постоянный цикл оркестратора',
    '  api [--host 127.0.0.1] [--port 8799]   read-only Ops API',
    '  watchdog                   проверка зависания; код 2 при проблемах',
    '  queue [--add <taskFile>] [--list] [--limit N]',
    '  memory [--show] [--lesson <text>]',
    '  stop [--reason text]       STOP-файл: цикл завершает текущий шаг и встаёт',
    '  resume                     снять STOP-файл',
  ].join('\n');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const root = rootOf(opts);
  if (!command) { console.error(usage()); return 64; }

  if (command === 'status') {
    const store = new OpsStore(root, { readOnly: true });
    const mission = (() => { try { return loadMission(root, opts.mission || null).mission; } catch { return null; } })();
    print({
      root,
      mission: mission ? { text: mission.mission, continuous: mission.continuous, priorities: mission.priorities, adapters: mission.adapters, allowRealAgents: mission.allowRealAgents } : null,
      heartbeat: store.readHeartbeat(),
      heartbeatAgeSec: store.heartbeatAgeSec(),
      checkpoint: store.readCheckpoint(),
      queue: store.counts(),
      stopRequested: store.stopRequested(),
      lastWatchdog: store.readWatchdog(),
      gate: mission ? realAgentsGate(mission) : null,
      memory: (() => { const memory = store.memory(); return { facts: memory.facts, decisions: (memory.decisions || []).length, lessons: (memory.lessons || []).length }; })(),
    });
    return 0;
  }

  if (command === 'plan') {
    const store = new OpsStore(root);
    ensureLayout(root);
    const { mission } = loadMission(root, opts.mission || null);
    print(planNext(store, mission));
    return 0;
  }

  if (command === 'tick') {
    ensureLayout(root);
    const { mission } = loadMission(root, opts.mission || null);
    print(await tick({ root, mission }));
    return 0;
  }

  if (command === 'loop') {
    ensureLayout(root);
    const { mission } = loadMission(root, opts.mission || null);
    const store = new OpsStore(root);
    store.heartbeat({ state: 'starting', adapters: mission.adapters });
    store.remember({ decision: { kind: 'service.start', adapters: mission.adapters, allowRealAgents: mission.allowRealAgents === true } });
    const result = await loop({ root, mission, once: Boolean(opts.once), untilIdle: Boolean(opts['until-idle']) });
    print({ root, ticks: result.ticks, last: result.results.at(-1) || null });
    return 0;
  }

  if (command === 'api') {
    ensureLayout(root);
    const port = Number(opts.port || process.env.OPS_API_PORT || 8799);
    const hosts = String(opts.hosts || process.env.OPS_API_HOSTS || '127.0.0.1,::1')
      .split(',').map((host) => host.trim()).filter(Boolean);
    let mission = null;
    try { mission = loadMission(root, opts.mission || null).mission; } catch { mission = null; }
    const started = await startApi({ root, mission, hosts, port });
    print({ listening: started.addresses, readonly: true, allowlist: 'contracts/public-status.schema.json' });
    const shutdown = () => { started.close().then(() => process.exit(0)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return new Promise(() => {});
  }

  if (command === 'watchdog') {
    const record = checkWatchdog({ root });
    print(record);
    return record.problems.length ? 2 : 0;
  }

  if (command === 'queue') {
    const store = new OpsStore(root);
    if (opts.add) {
      ensureLayout(root);
      const file = path.resolve(String(opts.add));
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
      const target = path.join(store.paths.tasksDir, `${task.taskId}.json`);
      if (file !== target) fs.copyFileSync(file, target);
      print(store.enqueue({ taskId: task.taskId, title: task.title, taskFile: target, priority: Number(opts.priority || 1), origin: 'owner' }));
      return 0;
    }
    const limit = Math.min(Number(opts.limit || 50), 200);
    print({ counts: store.counts(), items: store.list().slice(-limit) });
    return 0;
  }

  if (command === 'memory') {
    const store = new OpsStore(root);
    if (opts.lesson) {
      const memory = store.remember({ lesson: { kind: 'owner-note', note: String(opts.lesson) } });
      print({ lessons: memory.lessons.length });
      return 0;
    }
    print(store.memory());
    return 0;
  }

  if (command === 'stop') {
    const store = new OpsStore(root);
    const stopFile = store.requestStop(String(opts.reason || 'owner stop'));
    const event = store.signedJournal('service.stop_signed', null, { reason: String(opts.reason || 'owner stop') });
    const beat = store.heartbeat({ state: 'stopping', reason: 'owner stop' });
    print({ stopFile, stopEvent: { seq: event.seq, keyId: event.keyId, sig: event.sig }, heartbeat: beat.state });
    return 0;
  }

  if (command === 'resume') {
    const store = new OpsStore(root);
    store.clearStop();
    const event = store.signedJournal('service.resume_signed', null, { by: 'owner' });
    print({ stopRequested: store.stopRequested(), resumeEvent: { seq: event.seq, keyId: event.keyId, sig: event.sig } });
    return 0;
  }

  console.error(usage());
  return 64;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`${err.code || 'ERROR'}: ${err.message}`);
  if (err.errors) console.error(JSON.stringify(err.errors, null, 2));
  process.exitCode = 1;
});
