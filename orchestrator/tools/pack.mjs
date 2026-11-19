#!/usr/bin/env node
/* Сборка сдаточного ZIP. Список файлов не пишется руками: он выводится из
   графа импортов (lib/package.mjs). После сборки архив распаковывается в
   пустой каталог, прогоняется и, если evidence изменился, пересобирается.
   Так архив не может «запускаться только в рабочем дереве». */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ORCH_ROOT, buildShipList, describeMissing } from '../lib/package.mjs';
import { createZip } from '../lib/zip.mjs';
import { runCleanRoom, writeEvidence, countArchiveFiles } from '../lib/cleanroom.mjs';

const PREFIX = 'orchestrator/';
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function buildArchive({ root = ORCH_ROOT, include = [] } = {}) {
  const ship = buildShipList({ root, include });
  if (ship.missing.length) {
    throw Object.assign(new Error(`package closure is broken:\n${describeMissing(ship.missing)}`), {
      code: 'PACKAGE_CLOSURE_BROKEN',
      missing: ship.missing,
    });
  }

  const entries = [];
  const sums = [];
  const listing = [];

  for (const rel of ship.files) {
    const data = fs.readFileSync(path.join(root, rel));
    const digest = sha256(data);
    entries.push({ name: `${PREFIX}${rel}`, data });
    sums.push(`${digest}  ${rel}`);
    listing.push(`${digest}  ${String(data.length).padStart(8, ' ')}  ${rel}`);
  }

  /* Порядок важен: SHA256SUMS покрывает FILELIST.txt, поэтому список
     файлов собирается первым. Себя SHA256SUMS не хеширует — иначе
     получилась бы неразрешимая ссылка. */
  const fileList = Buffer.from(`${listing.join('\n')}\n`);
  entries.push({ name: `${PREFIX}FILELIST.txt`, data: fileList });
  sums.push(`${sha256(fileList)}  FILELIST.txt`);

  const sumsData = Buffer.from(`${sums.join('\n')}\n`);
  entries.push({ name: `${PREFIX}SHA256SUMS`, data: sumsData });

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const zip = createZip(entries);
  return { zip, files: ship.files.length + 2, entries: entries.map((entry) => entry.name) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = String(args.name || 'agentcoin-orchestrator-stage-a-fix1-20261119.zip');
  const outDir = path.resolve(String(args.dir || path.join(ORCH_ROOT, '..')));
  const outPath = path.join(outDir, name);
  const codexBin = args['codex-bin'] ? path.resolve(String(args['codex-bin'])) : (process.env.CLEAN_CODEX_BIN || null);
  const maxAttempts = args['no-clean'] ? 1 : 4;

  let previousSignature = null;
  let delivered = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const built = buildArchive();
    if (args['no-clean']) {
      delivered = { built, attempts: attempt, verified: false, clean: null };
      break;
    }
    const clean = runCleanRoom(built.zip, { archiveName: name, codexBin });
    const signature = JSON.stringify(clean.signature);
    if (previousSignature && signature === previousSignature && clean.ok) {
      /* Архив, собранный на этом шаге, уже содержал evidence предыдущего
         прогона, а его собственная проверка дала тот же результат. */
      delivered = { built, attempts: attempt, verified: true, clean };
      break;
    }
    if (!clean.ok) {
      writeEvidence(clean, ORCH_ROOT);
      process.stderr.write(`${clean.log}\n`);
      throw Object.assign(new Error('clean-room verification failed'), { code: 'CLEAN_ROOM_FAILED', signature: clean.signature });
    }
    writeEvidence(clean, ORCH_ROOT);
    previousSignature = signature;
    process.stderr.write(`attempt ${attempt}: evidence refreshed from clean room, repacking\n`);
  }

  if (!delivered) throw Object.assign(new Error('package did not stabilise'), { code: 'PACKAGE_UNSTABLE' });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, delivered.built.zip);
  const digest = sha256(delivered.built.zip);
  fs.writeFileSync(`${outPath.replace(/\.zip$/, '')}.sha256`, `${digest}  ${name}\n`);

  const summary = {
    zip: outPath,
    name,
    bytes: delivered.built.zip.length,
    sha256: digest,
    files: countArchiveFiles(delivered.built.zip),
    attempts: delivered.attempts,
    cleanRoomVerified: delivered.verified,
    signature: delivered.clean ? delivered.clean.signature : null,
  };
  console.log(JSON.stringify(summary, null, 2));
}

const SELF = fileURLToPath(import.meta.url);
const invokedDirectly = Boolean(process.argv[1]) && (() => {
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`${err.code || 'ERROR'}: ${err.message}`);
    process.exitCode = 1;
  });
}

export { main as packMain };
