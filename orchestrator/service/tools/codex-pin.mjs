#!/usr/bin/env node
/* Pinned runtime для Codex: установка только из готового каталога в постоянное
   место, root-owned, read-only, с манифестом SHA256 и без автообновления.

     node service/tools/codex-pin.mjs pin --from /path/to/codex-dir --version 0.171.0
     node service/tools/codex-pin.mjs verify [--root /opt/agentcoin-ops/runtime/codex-0.171.0]

   /tmp и домашние каталоги отвергаются: временный путь после перезагрузки
   исчезает, и «настоящие агенты» снова окажутся без runtime. */

import fs from 'node:fs';
import path from 'node:path';

import { copyTree, sha256File } from '../../lib/fsx.mjs';
import { isPermanentRoot, verifyRuntime } from '../runtime.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

const print = (value) => console.log(JSON.stringify(value, null, 2));

function pin(opts) {
  const version = String(opts.version || '');
  const from = opts.from ? path.resolve(String(opts.from)) : null;
  if (!version || !from) {
    console.error('usage: codex-pin.mjs pin --from <dir> --version <x.y.z> [--base /opt/agentcoin-ops/runtime]');
    return 64;
  }
  if (!fs.existsSync(from)) {
    console.error(`source runtime not found: ${from}`);
    return 66;
  }
  const base = path.resolve(String(opts.base || '/opt/agentcoin-ops/runtime'));
  if (!isPermanentRoot(base)) {
    console.error(`refusing: ${base} is temporary or user-owned; pinned runtime must survive reboot`);
    return 65;
  }
  const root = path.join(base, `codex-${version}`);
  if (fs.existsSync(root)) {
    console.error(`refusing: ${root} already exists; pinned runtime is immutable (remove it deliberately)`);
    return 73;
  }
  copyTree(from, root);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const stat = fs.statSync(full);
      /* Runtime не должен быть writable: иначе автообновление и подмена бинаря
         возможны без ведома владельца. */
      if ((stat.mode & 0o022) !== 0) fs.chmodSync(full, stat.mode & ~0o022);
      files.push({ path: path.relative(root, full), sha256: sha256File(full), bytes: stat.size, mode: (fs.statSync(full).mode & 0o777).toString(8) });
    }
  };
  walk(root);
  if (!files.length) {
    console.error('refusing: source runtime is empty');
    return 66;
  }
  const manifest = { name: 'codex', version, pinnedAt: new Date().toISOString(), autoUpdate: false, files };
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
  chmodTree(root);
  print({ root, version, files: files.length, manifest: path.join(root, 'manifest.json') });
  console.log('  now verify: node service/tools/codex-pin.mjs verify --root ' + root);
  return 0;
}

/* root-owned и read-only: на ops-host запускается от root, поэтому chown
   выполняется здесь, а не в node-коде с привилегиями. */
function chmodTree(root) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); fs.chmodSync(full, 0o555); }
      else fs.chmodSync(full, fs.statSync(full).mode & 0o555);
    }
  };
  walk(root);
  fs.chmodSync(root, 0o555);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (command === 'pin') return pin(opts);
  if (command === 'verify') {
    const root = path.resolve(String(opts.root || '/opt/agentcoin-ops/runtime/codex-0.171.0'));
    const verdict = verifyRuntime({ version: String(opts.version || path.basename(root).replace(/^codex-/, '')), root, manifest: 'manifest.json', bin: path.join(root, 'bin', 'codex') }, { runBin: Boolean(opts['check-binary']) });
    print(verdict);
    return verdict.ok ? 0 : 2;
  }
  console.error('usage: codex-pin.mjs <pin|verify> [--from DIR] [--version X] [--root DIR]');
  return 64;
}

process.exitCode = main();
