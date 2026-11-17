/* queue-lock-recover — восстановление mkdir-lock после аварии держателя (изолированно).
   Сценарий: процесс умирает, держа lock (lockDir с info.json остаётся) → следующий
   withFileLock после staleMs обязан снести протухший lock и исполнить эффект ровно один раз.
   Свежий lock (живой держатель) сносить запрещено → WAL_LOCK_TIMEOUT / LOCK_ACTIVE.
   Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withFileLock, recoverStaleLock, pidAlive, makeIdempotentExecutor, actionDigest } from '../queue-auth.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-lockrec-'));

// 1. Авария держателя: руками кладём протухший lock (pid мёртв, at старое)
{
  const file = path.join(dir, 'wal.json');
  fs.writeFileSync(file, '{}');
  const lockDir = file + '.lock';
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: 999999, at: Date.now() - 60000 }));
  // свежий взгляд: lock активен? нет — протухший восстанавливается
  const r = recoverStaleLock(file, { staleMs: 15000 });
  eq(r.recovered, true, 'lock-recover: протухший lock снесён вручную');
  eq(fs.existsSync(lockDir), false, 'lock-recover: lockDir удалён');
  // а теперь обычный путь: withFileLock сам сносит протухший и исполняет
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: 999999, at: Date.now() - 60000 }));
  const v = withFileLock(file, () => 42, { timeoutMs: 3000, staleMs: 15000 });
  eq(v, 42, 'lock-recover: withFileLock самовосстановился после аварии держателя');
  eq(fs.existsSync(lockDir), false, 'lock-recover: lock освобождён после исполнения');
}

// 2. Свежий lock сносить запрещено (живой держатель)
{
  const file = path.join(dir, 'wal2.json');
  fs.writeFileSync(file, '{}');
  const lockDir = file + '.lock';
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  const r = recoverStaleLock(file, { staleMs: 15000 });
  eq(r.error, 'LOCK_ACTIVE', 'lock-recover: свежий lock не сносится');
  let timed = false;
  try { withFileLock(file, () => 1, { timeoutMs: 200, staleMs: 60000 }); } catch (e) { timed = /WAL_LOCK_TIMEOUT/.test(String(e && e.message || e)); }
  eq(timed, true, 'lock-recover: живой lock даёт ожидание, а не кражу');
  // уборка
  try { fs.unlinkSync(path.join(lockDir, 'info.json')); } catch {}
  try { fs.rmdirSync(lockDir); } catch {}
}

// 3. Сквозной эффект: executor работает после восстановления lock
{
  const file = path.join(dir, 'wal3.json');
  const lockDir = file + '.lock';
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'info.json'), JSON.stringify({ pid: 999999, at: Date.now() - 60000 }));
  const ex = makeIdempotentExecutor(file);
  const d = actionDigest({ action: 'submit', body: { j: 'r1' }, nonce: 'rec-1', expiry: Date.now() + 600000 });
  const b = ex.begin({ nonce: 'rec-1', digest: d, expiry: Date.now() + 600000, scope: 'AGTaaa' });
  eq(b.reserved, true, 'lock-recover: reserve после восстановления — ок');
  ex.commit('rec-1', { n: 1 }, 'AGTaaa');
  eq(ex.get('rec-1', 'AGTaaa').state, 'done', 'lock-recover: commit после восстановления — done');
}

// 4. Реальный убитый процесс, державший lock: следующий процесс восстанавливается (мёртвый pid — сразу)
{
  const file = path.join(dir, 'wal4.json');
  fs.writeFileSync(file, '{}');
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'wal-worker.mjs');
  const dead = await new Promise((resolve) => {
    const p = spawn(process.execPath, [worker, file, 'x', 'y', '0', 'c', 'crash-holding-lock'], { stdio: 'ignore' });
    p.on('close', (code) => resolve({ code, pid: p.pid }));
  });
  eq(dead.code, 137, 'lock-recover: воркер убит, держа lock');
  eq(fs.existsSync(file + '.lock'), true, 'lock-recover: lock остался после kill -9 (авария)');
  eq(pidAlive(dead.pid), false, 'lock-recover: pid держателя мёртв');
  const ex = makeIdempotentExecutor(file);
  const d = actionDigest({ action: 'submit', body: { j: 'mp-rec' }, nonce: 'mp-rec', expiry: Date.now() + 600000 });
  const b = ex.begin({ nonce: 'mp-rec', digest: d, expiry: Date.now() + 600000 });
  eq(b.reserved, true, 'lock-recover: следующий процесс восстановил lock и зарезервировал (без ожидания staleMs)');
  ex.commit('mp-rec', { n: 1 });
  eq(ex.get('mp-rec').state, 'done', 'lock-recover: журнал цел после восстановления');
}

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('queue-lock-recover: ALL GREEN');
