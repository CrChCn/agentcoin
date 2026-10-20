#!/usr/bin/env node
// Визер паспорта-пакета на внешнем носителе: сверяет sha256 каждого файла манифеста.
// Использование: node tools/check-passport-drive.mjs [distDir=D:\Agentcoin-Prototype\passport]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = process.argv[2] || 'D:\\Agentcoin-Prototype\\passport';
const mf = path.join(dir, 'manifest.json');
if (!fs.existsSync(mf)) { console.error(`manifest не найден: ${mf}`); process.exit(2); }
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
let bad = 0; let total = 0;
for (const f of m.files || []) {
  const p = path.join(dir, f.to.replace(/^passport[\\/]/, ''));
  total++;
  if (!fs.existsSync(p)) { console.log(`MISSING ${f.to}`); bad++; continue; }
  const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (h !== f.sha256) { console.log(`HASH MISMATCH ${f.to}: manifest=${f.sha256.slice(0,12)} actual=${h.slice(0,12)}`); bad++; }
}
console.log(bad === 0
  ? `PASSPORT DRIVE OK: ${total} файлов, все sha256 совпадают (сеть ${m.network}, собрано ${m.created})`
  : `FAIL: ${bad}/${total} проблем`);
process.exit(bad === 0 ? 0 : 1);
