'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [], seeds: [], indexers: [], releaseKeys: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    i++;
    if (key === 'seed') out.seeds.push(next);
    else if (key === 'indexer') out.indexers.push(next);
    else if (key === 'releaseKey') out.releaseKeys.push(fs.readFileSync(next, 'utf8'));
    else out[key] = next;
  }
  return out;
}

export function defaultDataDir(name) {
  return path.join(ROOT, '.data', name);
}

export function int(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(v) {
  return v === true || v === '1' || v === 'true' || v === 'yes';
}
