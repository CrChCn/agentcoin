#!/usr/bin/env node
// issue-watch.mjs — демонстрация авто-пробуждения: ждёт до (after + waitMin),
// затем читает комментарии issue через GitHub API и пишет журнал.
// Токен нигде не хранится: берётся в рантайме из `git credential fill`
// (креды хоста оператора). Использование:
//   node tools/issue-watch/issue-watch.mjs --repo CrChCn/agentcoin --issue 1 \
//     --after 2026-11-09T15:50:00Z --wait-min 5 --out issue-watch-log.json
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) =>
  a.startsWith('--') ? [a.slice(2), (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : '1'] : []).filter(Boolean));
const repo = args.repo || 'CrChCn/agentcoin';
const issue = args.issue || '1';
const after = new Date(args.after || new Date().toISOString());
const waitMin = Number(args.waitMin || 5);
const outFile = args.out || 'issue-watch-log.json';
const stateFile = args.state || null; // dedup: хранит max comment id прошлого прохода
const lockFile = args.lock || null; // один процесс одновременно
if (Number.isNaN(after.getTime())) { console.error('bad --after'); process.exit(2); }

// Токен — только из окружения (caller добывает его шеллом: non-TTY вызов
// `git credential fill` из Node под Windows виснет в prompt'е GCM).
// Пример: GITHUB_TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p') node tools/issue-watch/issue-watch.mjs ...
let token = process.env.GITHUB_TOKEN || '';
if (!token) {
  try {
    token = execFileSync('git', ['credential', 'fill'],
      { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 15000 })
      .split('\n').map((l) => l.trim().split('='))
      .filter(([k]) => k === 'password').map(([, v]) => v).join('');
  } catch { token = ''; }
}
if (!token) { console.error('no github credential: set GITHUB_TOKEN from `git credential fill`'); process.exit(2); }

const api = async (path) => {
  const r = await fetch(`https://api.github.com/repos/${repo}/${path}`,
    { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'codebuff-issue-watch' } });
  if (!r.ok) throw new Error(`github ${r.status}`);
  return r.json();
};

const target = new Date(after.getTime() + waitMin * 60_000);
const now = new Date();
if (target > now) {
  const ms = target - now;
  console.log(`delivery: ${after.toISOString()} → wake at ${target.toISOString()} (sleep ${(ms / 1000).toFixed(0)}s)`);
  await new Promise((res) => setTimeout(res, ms));
}
const wake = new Date();
if (lockFile) {
  if (existsSync(lockFile)) { console.log('another pass is running, exit'); process.exit(3); }
  writeFileSync(lockFile, String(process.pid));
}
let comments;
try {
  comments = await api(`issues/${issue}/comments?per_page=100`);
} finally {
  if (lockFile) { try { (await import('node:fs')).unlinkSync(lockFile); } catch {} }
}
let since = 0;
if (stateFile && existsSync(stateFile)) {
  try { since = Number(JSON.parse(readFileSync(stateFile, 'utf8')).lastId || 0); } catch {}
}
const fresh = comments.filter((c) => c.id > since);
const tasks = fresh.filter((c) => /agt-task:/.test(c.body || ''))
  .map((c) => ({ id: c.id, task: (c.body.match(/agt-task:([A-Za-z0-9-]+)/) || [])[1] || '?' }));
const reviews = fresh.filter((c) => /agt-review:/.test(c.body || ''))
  .map((c) => ({ id: c.id, review: (c.body.match(/agt-review:([^\s>]+)/) || [])[1] || '?' }));
if (stateFile && comments.length) writeFileSync(stateFile, JSON.stringify({ lastId: Math.max(...comments.map((c) => c.id)) }));
const log = {
  repo, issue: Number(issue),
  deliveryTime: after.toISOString(),
  scheduledWake: target.toISOString(),
  actualWake: wake.toISOString(),
  lagSec: +((wake - target) / 1000).toFixed(1),
  comments: comments.length,
  newSinceLastRun: fresh.map((c) => c.id),
  newTasks: tasks,
  newReviews: reviews,
  agentLaunch: 'BLOCKED: no CLI/API entry to start a Codebuff pass from scheduler (see README); new tasks above await a chat message',
  latest: comments.slice(-3).map((c) => ({ id: c.id, user: c.user?.login, created_at: c.created_at, head: (c.body || '').slice(0, 120) })),
};
writeFileSync(outFile, JSON.stringify(log, null, 2));
console.log(`wake: ${wake.toISOString()} — issue #${issue}: ${comments.length} комментариев`);
console.log(`log → ${outFile}`);
