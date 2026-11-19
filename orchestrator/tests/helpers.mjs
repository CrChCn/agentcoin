import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ORCH, 'orchestrator.mjs');
export const TASKS = path.join(ORCH, 'fixtures', 'tasks');
export const TERMINAL = new Set(['ACCEPTED', 'BLOCKED', 'FAILED', 'CANCELLED']);

export function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agt-orch-${label}-`));
}

export function cli(root, ...args) {
  const out = execFileSync(process.execPath, [CLI, ...args, '--root', root], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

export function cliRaw(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
}

export function runLoop(root, taskId, maxSteps = 20) {
  const trail = [cli(root, 'status', '--task', taskId)];
  while (!TERMINAL.has(trail.at(-1).state) && trail.length < maxSteps) {
    trail.push(cli(root, 'step', '--task', taskId));
  }
  return trail;
}
