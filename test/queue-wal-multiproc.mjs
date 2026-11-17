/* queue-wal-multiproc — п.1: два ОТДЕЛЬНЫХ процесса, одинаковый запрос → эффект один.
   Плюс падения до эффекта / после эффекта / до commit → повторов нет.
   Exit 0 = ok. */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionDigest, makeIdempotentExecutor } from '../queue-auth.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'helpers', 'wal-worker.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-walmp-'));
const T0 = Date.now() + 600000;

function runWorker(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// --- 1. два процесса одновременно, один nonce ---
{
  const file = path.join(dir, 'wal1.json');
  const counter = path.join(dir, 'c1.txt');
  fs.writeFileSync(counter, '0');
  const nonce = 'mp-same-1';
  const digest = actionDigest({ action: 'submit', body: { j: '1' }, nonce, expiry: T0 });
  const [r1, r2] = await Promise.all([
    runWorker([file, nonce, digest, String(T0), counter, 'normal']),
    runWorker([file, nonce, digest, String(T0), counter, 'normal']),
  ]);
  const n = Number(fs.readFileSync(counter, 'utf8'));
  eq(n, 1, 'п.1-mp: два процесса → эффект один (counter=1)');
  const codes = [r1.code, r2.code].sort().join(',');
  eq(codes, '0,2', 'п.1-mp: один committed(0), второй pending-retry(2), кодов=' + codes);
  // повтор после commit — replay без эффекта
  const ex = makeIdempotentExecutor(file);
  const b = ex.begin({ nonce, digest, expiry: T0 });
  eq(b.replay, true, 'п.1-mp: повтор — replay');
  eq(Number(fs.readFileSync(counter, 'utf8')), 1, 'п.1-mp: replay не трогает эффект');
  eq(b.operationId, nonce, 'п.1-mp: эффект связан с operationId');
}

// --- 2. падение ДО эффекта (crash-before-commit: reserve записан, эффект не исполнен) ---
{
  const file = path.join(dir, 'wal2.json');
  const counter = path.join(dir, 'c2.txt');
  fs.writeFileSync(counter, '0');
  const nonce = 'mp-crash-before';
  const digest = actionDigest({ action: 'submit', body: { j: '2' }, nonce, expiry: T0 });
  const r = await runWorker([file, nonce, digest, String(T0), counter, 'crash-before-commit']);
  eq(r.code !== 0, true, 'п.1-crash1: процесс убит до commit');
  eq(Number(fs.readFileSync(counter, 'utf8')), 0, 'п.1-crash1: эффекта не было');
  const ex = makeIdempotentExecutor(file);
  eq(ex.pendingList().includes(nonce), true, 'п.1-crash1: pending пережил рестарт (fsync+rename)');
  eq(ex.begin({ nonce, digest, expiry: T0 }).error, 'NONCE_PENDING_RETRY', 'п.1-crash1: повтор — не переисполнение');
  // сверка доказала: не исполнен → безопасное снятие
  eq(ex.resolvePending(nonce, { status: 'proven-not-executed' }).aborted, true, 'п.1-crash1: proven-not-executed → бронь снята');
  const b2 = ex.begin({ nonce, digest, expiry: T0 });
  eq(b2.reserved, true, 'п.1-crash1: после abort резерв возможен заново');
  ex.commit(nonce, { n: 1 });
  eq(Number(fs.readFileSync(counter, 'utf8')), 0, 'п.1-crash1: commit журнала сам эффект не создаёт');
}

// --- 3. падение ПОСЛЕ эффекта, ДО commit ---
{
  const file = path.join(dir, 'wal3.json');
  const counter = path.join(dir, 'c3.txt');
  fs.writeFileSync(counter, '0');
  const nonce = 'mp-crash-after';
  const digest = actionDigest({ action: 'submit', body: { j: '3' }, nonce, expiry: T0 });
  await runWorker([file, nonce, digest, String(T0), counter, 'crash-after-effect']);
  eq(Number(fs.readFileSync(counter, 'utf8')), 1, 'п.1-crash2: эффект успел один раз');
  const ex = makeIdempotentExecutor(file);
  eq(ex.pendingList().includes(nonce), true, 'п.1-crash2: pending пережил падение после эффекта');
  // сверка: эффект подтверждён очередью → восстановить результат, НЕ исполнять заново
  eq(ex.resolvePending(nonce, { status: 'effect-confirmed', result: { n: 1 } }).restored, true, 'п.1-crash2: effect-confirmed → результат восстановлен');
  const b = ex.begin({ nonce, digest, expiry: T0 });
  eq(b.replay, true, 'п.1-crash2: дальше только replay');
  // неопределённый исход на другом nonce — бронь НЕ снимается
  const n4 = 'mp-unknown';
  const d4 = actionDigest({ action: 'submit', body: { j: '4' }, nonce: n4, expiry: T0 });
  ex.begin({ nonce: n4, digest: d4, expiry: T0 });
  eq(ex.resolvePending(n4, { status: 'unknown' }).error, 'NEEDS_RECONCILE', 'п.1-crash2: unknown → остаётся на сверке');
  eq(ex.pendingList().includes(n4), true, 'п.1-crash2: unknown не снял бронь');
}

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('queue-wal-multiproc: ALL GREEN');
