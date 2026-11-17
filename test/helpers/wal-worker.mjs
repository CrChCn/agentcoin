/* worker: одна попытка reserve→effect→commit. modes: normal | crash-before-commit | crash-after-effect | crash-holding-lock */
import fs from 'node:fs';
import path from 'node:path';
import { makeIdempotentExecutor } from '../../queue-auth.mjs';
const _mode = process.argv[7];
if (_mode === 'crash-holding-lock') {
  // Симуляция kill -9 ВНУТРИ критической секции: голый mkdir lock + info, затем смерть без уборки.
  const _file = process.argv[2];
  const _lockDir = String(_file) + '.lock';
  try { fs.mkdirSync(_lockDir); } catch {}
  try { fs.writeFileSync(path.join(_lockDir, 'info.json'), JSON.stringify({ pid: process.pid, at: Date.now() })); } catch {}
  process.exit(137);
}
const [file, nonce, digest, expiryS, counterFile, mode] = process.argv.slice(2);
const expiry = Number(expiryS);
const ex = makeIdempotentExecutor(file);
let b;
try { b = ex.begin({ nonce, digest, expiry }); }
catch (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); process.exit(4); }
if (!b.ok) { console.log(JSON.stringify(b)); process.exit(b.replay ? 3 : 2); }
// эффект: счётчик файловый (read-modify-write) — без lock был бы race
if (mode === 'crash-before-commit') { process.exit(137); }
let n = 0;
try { n = Number(fs.readFileSync(counterFile, 'utf8') || '0'); } catch { n = 0; }
await new Promise((r) => setTimeout(r, 80));
fs.writeFileSync(counterFile, String(n + 1));
if (mode === 'crash-after-effect') { process.exit(137); }
ex.commit(nonce, { n: n + 1, operationId: String(nonce) });
console.log(JSON.stringify({ committed: true, n: n + 1 }));
