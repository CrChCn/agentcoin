#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/* Применение артефакта в чистый каталог. Путь проверяется ещё раз: архив
   приходит извне и не считается доверенным, даже если его хеш совпал. */
export function applyArtifactEntries(destDir, entries, deletions = []) {
  const root = path.resolve(destDir);
  for (const entry of entries) {
    if (entry.name === 'manifest.json') continue;
    const target = path.resolve(root, entry.name);
    if (!target.startsWith(root + path.sep)) throw new Error(`artifact: entry escapes workspace: ${entry.name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }
  for (const rel of deletions) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error(`artifact: deletion escapes workspace: ${rel}`);
    fs.rmSync(target, { force: true });
  }
  return entries.length;
}
