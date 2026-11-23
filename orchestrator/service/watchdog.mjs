#!/usr/bin/env node
/* Watchdog: обнаруживает зависание, а не «лечит» его. Он ничего не убивает и
   не перезапускает сам: пишет verdict в state/watchdog.json и выходит с кодом
   2, чтобы systemd (OnFailure/таймер) и владелец увидели проблему.

   Признаки проблемы:
   - heartbeat старше OPS_STALE_AFTER_SEC (по умолчанию 900 с);
   - задание висит в leased, а pid арендатора мёртв;
   - lock задания принадлежит мёртвому pid.

   Отдельно: ровно один живой экземпляр оркестратора. Если heartbeat
   принадлежит живому pid, а наш pid другой — это не зависание, а второй
   экземпляр; он попадает в отчёт как duplicate-instance. */

import { OpsStore, STATUS } from './store.mjs';
import { lockStatus, pidAlive } from '../lib/lock.mjs';

/* standalone — вызов из отдельного процесса (systemd-юнит watchdog). Тогда
   heartbeat.pid обязан отличаться от нашего: это нормальная работа, а не
   второй экземпляр. Проверку дубликата имеет смысл делать только внутри
   самого оркестратора. */
export function checkWatchdog({ root, staleAfterSec = Number(process.env.OPS_STALE_AFTER_SEC || 900), now = new Date(), standalone = false } = {}) {
  const store = new OpsStore(root, { readOnly: false });
  const beat = store.readHeartbeat();
  const age = store.heartbeatAgeSec(now);
  const problems = [];

  if (age == null) problems.push({ code: 'NEVER_STARTED', detail: 'no heartbeat recorded' });
  else if (age > staleAfterSec) problems.push({ code: 'HEARTBEAT_STALE', detail: `heartbeat is ${age}s old (limit ${staleAfterSec}s)` });

  const leased = store.list().filter((item) => item.status === STATUS.LEASED);
  for (const item of leased) {
    const lease = item.lease || {};
    if (lease.host === store.host && !pidAlive(lease.pid)) {
      problems.push({ code: 'LEASE_OWNER_DEAD', taskId: item.taskId, detail: `pid ${lease.pid} is gone; next tick returns it to pending` });
    }
    const status = lockStatus(store.paths.base, item.taskId);
    if (status.locked && status.lock && !pidAlive(status.lock.pid)) {
      problems.push({ code: 'LOCK_OWNER_DEAD', taskId: item.taskId, detail: `lock pid ${status.lock.pid} is gone` });
    }
  }

  const duplicateInstance = Boolean(!standalone && beat.pid && beat.pid !== process.pid && pidAlive(beat.pid) && age != null && age <= staleAfterSec);
  if (duplicateInstance) problems.push({ code: 'DUPLICATE_INSTANCE', detail: `heartbeat belongs to live pid ${beat.pid}` });

  const record = {
    at: now.toISOString(),
    verdict: problems.length ? 'attention' : 'alive',
    heartbeatAgeSec: age,
    staleAfterSec,
    orchestratorPid: beat.pid || null,
    leases: leased.map((item) => item.taskId),
    problems,
    action: problems.length ? 'owner notification only; watchdog never kills or restarts' : 'none',
  };
  try {
    store.watchdogRecord(record);
  } catch {}
  return record;
}
