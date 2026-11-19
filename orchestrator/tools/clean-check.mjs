#!/usr/bin/env node
/* Проверка готового архива без пересборки: распаковать в пустой каталог,
   прогнать тесты, capabilities, preflight и sha256sum -c, напечатать лог.
   Используется и сдачей, и ревьюером: архив проверяется как чужой файл. */

import fs from 'node:fs';
import path from 'node:path';

import { runCleanRoom } from '../lib/cleanroom.mjs';

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith('--'));
const archive = positional[0];
if (!archive) {
  console.error('usage: node tools/clean-check.mjs <archive.zip> [--codex-bin <path>] [--json]');
  process.exit(64);
}

const codexIndex = args.indexOf('--codex-bin');
const codexBin = codexIndex >= 0 ? path.resolve(args[codexIndex + 1]) : (process.env.CLEAN_CODEX_BIN || null);

const bytes = fs.readFileSync(path.resolve(archive));
const clean = runCleanRoom(bytes, { archiveName: path.basename(archive), codexBin });

if (args.includes('--json')) {
  console.log(JSON.stringify({
    ok: clean.ok,
    signature: clean.signature,
    commands: clean.commands,
    preflight: clean.preflightJson,
  }, null, 2));
} else {
  process.stdout.write(clean.log);
}

process.exitCode = clean.ok ? 0 : 1;
