#!/usr/bin/env node
/* Planner: читает состояние, выбирает следующую конечную задачу и кладёт её в
   очередь. Планировщик не пишет код и не меняет контракт задания.

   Правила:
   - пока в очереди есть незавершённые задания, новых не создаём (одна линия
     работы, никаких параллельных implementer'ов);
   - владелец может положить готовый контракт в queue/backlog/*.json — он имеет
     приоритет над шаблоном;
   - иначе берётся шаблон из mission.planner.template и клонируется с новым
     taskId; содержание контракта (scope/acceptance/limits) не меняется;
   - STOP-файл останавливает и планирование, и исполнение. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTask } from '../lib/engine.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { STATUS } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

export function loadMission(root, explicitFile = null) {
  const candidates = [explicitFile, path.join(path.resolve(root), 'queue', 'mission.json'), path.join(HERE, 'mission.json')].filter(Boolean);
  for (const file of candidates) {
    const mission = readJson(file, null);
    if (mission) return { mission, file };
  }
  throw Object.assign(new Error('mission.json not found'), { code: 'MISSION_MISSING' });
}

/* Задание из шаблона. Клонируется только идентичность; контракт остаётся
   дословным, иначе планировщик стал бы автором требований. */
export function taskFromTemplate({ templateFile, taskFile, taskId, titleSuffix = '' }) {
  const task = readJson(templateFile, null);
  if (!task) throw Object.assign(new Error(`template not found: ${templateFile}`), { code: 'TEMPLATE_MISSING' });
  const clone = { ...task, taskId, title: titleSuffix ? `${task.title} — ${titleSuffix}` : task.title };
  writeJsonAtomic(taskFile, clone);
  return path.resolve(taskFile);
}

/* Возвращает {action, taskId?, taskFile?, reason?}. Ничего не делает, если
   очередь занята. */
export function planNext(store, mission, { now = new Date() } = {}) {
  if (store.stopRequested()) return { action: 'stopped', reason: 'STOP file present' };

  const items = store.list();
  const active = items.filter((item) => item.status === STATUS.PENDING || item.status === STATUS.LEASED);
  if (active.length) {
    return { action: 'none', reason: 'queue not empty', active: active.map((item) => item.taskId) };
  }

  const planner = mission.planner || {};
  if (planner.enabled === false) return { action: 'none', reason: 'planner disabled by mission' };

  const openLimit = Number.isInteger(planner.maxOpenTasks) ? planner.maxOpenTasks : 1;
  if (items.filter((item) => item.status !== STATUS.DONE).length >= openLimit) {
    return { action: 'none', reason: `open task limit ${openLimit} reached` };
  }

  /* 1) Задания владельца. */
  const backlog = fs.existsSync(store.paths.backlogDir)
    ? fs.readdirSync(store.paths.backlogDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  for (const name of backlog) {
    const source = path.join(store.paths.backlogDir, name);
    let task;
    try {
      task = loadTask(source);
    } catch (err) {
      store.journal('planner.backlog_rejected', null, { file: name, error: String(err.message || err) });
      continue;
    }
    const target = path.join(store.paths.tasksDir, `${task.taskId}.json`);
    fs.renameSync(source, target);
    store.enqueue({ taskId: task.taskId, title: task.title, priority: 1, taskFile: target, origin: 'owner-backlog' });
    store.remember({ lesson: { kind: 'plan', task: task.taskId, note: 'owner backlog task accepted into queue' } });
    return { action: 'enqueued', taskId: task.taskId, taskFile: target, origin: 'owner-backlog' };
  }

  /* 2) Шаблон из mission: конечная задача с тем же контрактом. */
  if (!planner.template) return { action: 'none', reason: 'no backlog and no planner.template' };
  const templateFile = path.isAbsolute(planner.template)
    ? planner.template
    : path.resolve(HERE, '..', planner.template);
  if (!fs.existsSync(templateFile)) {
    return { action: 'none', reason: `planner.template missing: ${templateFile}` };
  }
  const prefix = planner.taskPrefix || 'plan';
  const taskId = `${prefix}-${stamp(now)}`;
  const taskFile = path.join(store.paths.tasksDir, `${taskId}.json`);
  taskFromTemplate({ templateFile, taskFile, taskId, titleSuffix: planner.titleSuffix || 'rehearsal' });
  store.enqueue({ taskId, title: loadTask(taskFile).title, priority: 50, taskFile, origin: 'planner' });
  store.remember({ lesson: { kind: 'plan', task: taskId, note: 'planner cloned the configured template contract' } });
  return { action: 'enqueued', taskId, taskFile, origin: 'planner' };
}
