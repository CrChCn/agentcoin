#!/usr/bin/env node
/* Идентичность процесса для lease и lock.

   Одного pid недостаточно: после перезагрузки ядро может выдать тот же pid
   другому процессу, и тогда «живой владелец блокировки» окажется чужим
   процессом. Поэтому lease/lock фиксируют hostId, bootId, pid и
   processStartTime, а решение «жив ли владелец» принимается по всей
   комбинации:

   - другой hostId      → чужой хост, владелец не наш;
   - другой bootId      → была перезагрузка, процесс гарантированно мёртв;
   - pid не существует  → мёртв;
   - startTime не совпал → pid переиспользован, владелец мёртв;
   - startTime неизвестен ни там, ни тут → weak-проверка (только pid).

   На Linux всё читается из /proc. На других платформах, где /proc нет,
   bootId и processStartTime остаются null, а решение помечается weak — это
   видно в журнале, а не замалчивается. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

/* pidAlive живёт здесь, а не в lock.mjs: lock и procinfo проверяют друг друга,
   и обратный импорт создавал бы цикл модулей. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readFirst(paths) {
  for (const file of paths) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {}
  }
  return null;
}

/* hostId — стабильный идентификатор машины. Не MAC и не username:
   только machine-id или хеш hostname, чтобы не утекала инфраструктура. */
export function hostId() {
  const machine = readFirst(['/etc/machine-id', '/var/lib/dbus/machine-id']);
  const base = machine || `hostname:${os.hostname()}`;
  return crypto.createHash('sha256').update(`agentcoin-ops:${base}`).digest('hex').slice(0, 32);
}

export function bootId() {
  return readFirst(['/proc/sys/kernel/random/boot_id']);
}

/* Поле 22 в /proc/<pid>/stat — время старта в тиках после загрузки.
   comm может содержать пробелы и скобки, поэтому режем после последней ')'. */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const start = Number(tail[19]);
    return Number.isFinite(start) ? start : null;
  } catch {
    return null;
  }
}

export function selfIdentity() {
  return {
    hostId: hostId(),
    bootId: bootId(),
    pid: process.pid,
    processStartTime: processStartTime(process.pid),
  };
}

/* Решение о владельце по всей комбинации. Возвращает {alive, reason, weak}. */
export function processVerdict(record, { pidAliveFn = pidAlive, current = null, startTimeFn = processStartTime } = {}) {
  if (!record || !Number.isInteger(record.pid)) {
    return { alive: false, reason: 'record has no pid', weak: false };
  }
  const now = current || { hostId: hostId(), bootId: bootId() };

  if (record.hostId && now.hostId && record.hostId !== now.hostId) {
    return { alive: false, reason: 'lease belongs to another host', weak: false };
  }
  if (record.bootId && now.bootId && record.bootId !== now.bootId) {
    return { alive: false, reason: 'process lived in a previous boot', weak: false };
  }
  if (!pidAliveFn(record.pid)) {
    return { alive: false, reason: `pid ${record.pid} is gone`, weak: false };
  }
  const currentStart = startTimeFn(record.pid);
  if (record.processStartTime != null && currentStart != null) {
    if (record.processStartTime !== currentStart) {
      return { alive: false, reason: `pid ${record.pid} was reused by another process`, weak: false };
    }
    return { alive: true, reason: 'same process (pid + start time)', weak: false };
  }
  return { alive: true, reason: 'pid alive; start time unavailable (weak check)', weak: true };
}
