#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IDENTITY = [
  '-c', 'user.name=Agentcoin Orchestrator',
  '-c', 'user.email=orchestrator@agentcoin.invalid',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
];
// Фиксированные даты делают baseCommit воспроизводимым: тот же шаблон фикстуры
// даёт тот же хеш в любом запуске и на любой машине.
const FIXED_ENV = {
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(cwd, args, { env = {}, allowFail = false } = {}) {
  try {
    return execFileSync('git', [...IDENTITY, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...FIXED_ENV, ...env },
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    if (allowFail) return { error: stderr || String(err), status: err?.status ?? null };
    throw new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`);
  }
}

export function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base: fixture template']);
  return revParse(dir, 'HEAD');
}

export function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  const status = git(dir, ['status', '--porcelain']);
  if (status) {
    git(dir, ['commit', '-q', '-m', message]);
  }
  return revParse(dir, 'HEAD');
}

export function revParse(dir, ref) {
  return git(dir, ['rev-parse', ref]);
}

export function isRepo(dir) {
  try {
    git(dir, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export function changedFiles(dir, baseCommit) {
  // Отслеживаемые изменения относительно базы + новые файлы.
  const tracked = git(dir, ['diff', '--name-status', baseCommit, '--']).split('\n').filter(Boolean);
  const files = new Map();
  for (const line of tracked) {
    const [status, ...rest] = line.split('\t');
    const file = rest.join('\t');
    files.set(file.replace(/\\/g, '/'), status.startsWith('D') ? 'deleted' : status.startsWith('A') ? 'added' : 'modified');
  }
  for (const file of git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    files.set(file.replace(/\\/g, '/'), 'added');
  }
  return [...files.entries()].map(([file, status]) => ({ file, status })).sort((a, b) => a.file.localeCompare(b.file));
}

export function commitFiles(dir, commit, baseCommit) {
  return git(dir, ['diff', '--name-only', baseCommit, commit, '--']).split('\n').filter(Boolean)
    .map((f) => f.replace(/\\/g, '/')).sort();
}

export function blobAt(dir, commit, file) {
  return git(dir, ['show', `${commit}:${file}`]);
}

/* Байтовое чтение blob: строковый git() обрезает пробелы и ломает сверку
   содержимого артефакта с коммитом. */
export function blobBuffer(dir, commit, file) {
  return execFileSync('git', [...IDENTITY, 'show', `${commit}:${file}`], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...FIXED_ENV },
  });
}

export function cloneAt(source, dest, commit) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  git(path.dirname(dest), ['clone', '-q', '--no-hardlinks', source, dest]);
  git(dest, ['checkout', '-q', commit]);
  // Проверяющий работает с копией базы, а не с рабочим деревом исполнителя:
  // remote удаляется, чтобы исключить неявное «подтягивание» чужих коммитов.
  git(dest, ['remote', 'remove', 'origin'], { allowFail: true });
  return revParse(dest, 'HEAD');
}

export function treeStatus(dir) {
  return git(dir, ['status', '--porcelain']);
}
