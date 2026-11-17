/* repro-stand — п.4: весь стенд одной командой (кроме hardhat EVM, он отдельно).
   Порядок = RUNBOOK: lock→mint→burn→release, повтор/рестарт, конкуренция+WAL,
   реорг+стоп, сверка по КТ. Exit 0 = всё зелено. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  ['queue-v2-isolated', ['test/queue-v2-isolated.mjs']],
  ['queue-v2-clarify', ['test/queue-v2-clarify.mjs']],
  ['queue-atomic-auth', ['test/queue-atomic-auth.mjs']],
  ['queue-wal-multiproc', ['test/queue-wal-multiproc.mjs']],
  ['queue-http-auth', ['test/queue-http-auth.mjs']],
  ['bridge-proto', ['bridge/test-proto.mjs']],
  ['bridge-reconcile', ['bridge/test-reconcile.mjs']],
  ['bridge-vault-2of3', ['test/bridge-vault-2of3.mjs']],
  ['bridge-policy-divergence', ['test/bridge-policy-divergence.mjs']],
  ['bridge-local-e2e', ['test/bridge-local-e2e.mjs']],
  ['bridge-halt-stop', ['test/bridge-halt-stop.mjs']],
];
let fail = 0;
for (const [name, args] of steps) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | ');
  if (r.status === 0) console.log(`ok: ${name} :: ${tail}`);
  else { fail++; console.log(`FAIL: ${name} (exit ${r.status}) :: ${tail}`); }
}
if (fail) { console.error(`repro-stand: ${fail} FAILED`); process.exit(1); }
console.log('repro-stand: ALL GREEN (non-EVM). EVM отдельно: cd bridge && hardhat test (9 passing)');
