#!/usr/bin/env node
/* Применение артефакта в чистый каталог.
   Архив приходит извне и не считается доверенным, даже если хеш совпал:
   каждый путь проверяется через lstat по компонентам, symlink запрещён и в
   цели, и в родителях. Запись — атомарная (временный файл + rename), поэтому
   частично применённый файл не остаётся. */

import { deleteRegularFileWithin, writeFileAtomicWithin, safeRootDir } from '../lib/safefs.mjs';

export function applyArtifactEntries(destDir, entries, deletions = []) {
  const rootReal = safeRootDir(destDir);
  let written = 0;
  for (const entry of entries) {
    if (entry.name === 'manifest.json') continue;
    writeFileAtomicWithin(rootReal, entry.name, entry.data);
    written += 1;
  }
  for (const rel of deletions) {
    deleteRegularFileWithin(rootReal, rel);
  }
  return written;
}
