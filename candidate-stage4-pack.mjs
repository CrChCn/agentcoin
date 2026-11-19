// Packs candidate-stage4 into ../agentcoin-stage4-candidate-20261119.zip + .sha256 sidecar.
// Run from repo root: node ./candidate-stage4-pack.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = path.join(process.cwd(), 'candidate-stage4');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
})(root);
files.sort();
const own = new Set(['PACK-FILES.txt', 'SHA256SUMS']);
const rel = files.map((f) => path.relative(root, f).split(path.sep).join('/')).filter((f) => !own.has(f));
fs.writeFileSync(path.join(root, 'PACK-FILES.txt'), rel.join('\n') + '\n');
const withPack = [...rel, 'PACK-FILES.txt'];
const sums = withPack.map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex') + '  ' + f).join('\n') + '\n';
fs.writeFileSync(path.join(root, 'SHA256SUMS'), sums);
console.log('files: ' + rel.length + ' (+PACK-FILES in sums: ' + withPack.length + ')');
execFileSync('powershell', ['-NoProfile', '-Command', 'Compress-Archive -Path candidate-stage4 -DestinationPath ../agentcoin-stage4-candidate-20261119.zip -Force'], { stdio: 'inherit', cwd: process.cwd() });
const z = path.join(process.cwd(), '..', 'agentcoin-stage4-candidate-20261119.zip');
const h = crypto.createHash('sha256').update(fs.readFileSync(z)).digest('hex');
const s = fs.statSync(z);
fs.writeFileSync(z + '.sha256', h + '  ' + s.size + ' bytes\n');
console.log('ZIP bytes=' + s.size + ' sha256=' + h);
