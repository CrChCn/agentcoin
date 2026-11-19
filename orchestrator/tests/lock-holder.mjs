#!/usr/bin/env node
/* Держатель lock для штормового теста: пытается захватить, сообщает результат
   файлом и, если захватил, держит до появления release-файла. Так все 20
   процессов гарантированно попадают в окно занятости, а не в «уже свободно». */

import fs from 'node:fs';
import { acquireLock } from '../lib/lock.mjs';

const [root, taskId, releaseFile, resultFile] = process.argv.slice(2);
const lock = acquireLock(root, taskId, { action: 'holder' });

fs.writeFileSync(resultFile, JSON.stringify({
  ok: lock.ok,
  code: lock.code || null,
  operationId: lock.operationId || null,
  pid: process.pid,
}));

if (!lock.ok) process.exit(0);

const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 30000;
while (!fs.existsSync(releaseFile) && Date.now() < deadline) {
  Atomics.wait(wait, 0, 0, 20);
}
lock.release();
process.exit(0);
