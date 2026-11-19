#!/usr/bin/env node
/* Артефакт — детерминированный ZIP + SHA256 по содержимому. В архив попадают
   только изменённые файлы и манифест; метка времени в ZIP не пишется, поэтому
   одинаковое содержимое даёт одинаковый хеш. Метаданные (кто, когда, commit)
   лежат рядом в .meta.json и не влияют на адресацию по содержимому. */

import fs from 'node:fs';
import path from 'node:path';
import { canonical, ensureDir, readJson, sha256, writeJsonAtomic } from '../lib/fsx.mjs';
import { createZip, readZip } from '../lib/zip.mjs';
import { findSecrets } from '../lib/secrets.mjs';
import { readRegularFileWithin } from '../lib/safefs.mjs';
import { applyArtifactEntries } from './apply.mjs';

export const ARTIFACT_FORMAT = 'agentcoin-orchestrator-artifact/1';

export function buildArtifact({ root, taskId, iteration, baseCommit, resultCommit, workspace, changes }) {
  const entries = [];
  const manifestFiles = [];
  const deletions = [];

  for (const change of [...changes].sort((a, b) => a.file.localeCompare(b.file))) {
    if (change.status === 'deleted') {
      deletions.push(change.file);
      manifestFiles.push({ path: change.file, status: 'deleted' });
      continue;
    }
    /* Чтение только обычного файла внутри workspace: symlink, FIFO, device и
       выход realpath за пределы дерева отклоняются до чтения байтов. */
    const { bytes: data } = readRegularFileWithin(workspace, change.file);
    /* Артефакт не должен разносить секреты окружения: если агент записал
       ключ в файл, архив не собирается вовсе. Имя значения не печатается. */
    const leaked = findSecrets(data.toString('utf8'));
    if (leaked.length) {
      throw Object.assign(
        new Error(`artifact: ${change.file} contains a value of ${leaked.join(', ')} from the environment; refusing to package it`),
        { code: 'SECRET_IN_ARTIFACT', file: change.file, names: leaked },
      );
    }
    entries.push({ name: change.file, data });
    manifestFiles.push({ path: change.file, status: change.status, sha256: sha256(data), bytes: data.length });
  }

  if (!entries.length && !deletions.length) throw new Error('artifact: nothing to archive');

  const manifest = {
    format: ARTIFACT_FORMAT,
    taskId,
    iteration,
    baseCommit,
    resultCommit,
    files: manifestFiles,
    deletions,
  };
  const zip = createZip([{ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }, ...entries]);
  const digest = sha256(zip);
  const dir = path.join(root, 'artifacts', taskId, String(iteration));
  ensureDir(dir);
  const zipPath = path.join(dir, `${digest}.zip`);
  fs.writeFileSync(zipPath, zip);
  const artifactId = `art-${iteration}-${digest.slice(0, 16)}`;
  const meta = {
    artifactId,
    sha256: digest,
    size: zip.length,
    path: path.relative(root, zipPath).replace(/\\/g, '/'),
    taskId,
    iteration,
    baseCommit,
    resultCommit,
    files: manifestFiles,
    deletions,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(dir, `${digest}.meta.json`), meta);
  return { ...meta, zipPath, manifest };
}

export function readArtifactMeta(root, artifactId, taskId) {
  const dir = path.join(root, 'artifacts', taskId);
  if (!fs.existsSync(dir)) return null;
  for (const iteration of fs.readdirSync(dir)) {
    const sub = path.join(dir, iteration);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const file of fs.readdirSync(sub)) {
      if (!file.endsWith('.meta.json')) continue;
      const meta = readJson(path.join(sub, file), null);
      if (meta && (meta.artifactId === artifactId || meta.sha256 === artifactId)) {
        return { ...meta, zipPath: path.join(root, meta.path) };
      }
    }
  }
  return null;
}

export function verifyArtifactFiles(meta, bytes) {
  const actual = sha256(bytes);
  const ok = bytes.length === meta.size && actual === meta.sha256;
  return { ok, expected: meta.sha256, actual, expectedSize: meta.size, actualSize: bytes.length };
}

export function verifyArtifactPath(meta) {
  const bytes = fs.readFileSync(meta.zipPath);
  const result = verifyArtifactFiles(meta, bytes);
  return { ...result, bytes };
}

export function inspectArtifact(bytes) {
  const entries = readZip(bytes);
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error('artifact: manifest.json missing');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  if (manifest.format !== ARTIFACT_FORMAT) throw new Error(`artifact: unsupported format ${manifest.format}`);
  const files = entries.filter((e) => e.name !== 'manifest.json');
  for (const file of files) {
    const declared = manifest.files.find((f) => f.path === file.name);
    if (!declared) throw new Error(`artifact: undeclared entry ${file.name}`);
    if (declared.sha256 !== sha256(file.data)) throw new Error(`artifact: entry hash mismatch ${file.name}`);
  }
  for (const declared of manifest.files.filter((f) => f.status !== 'deleted')) {
    if (!files.some((f) => f.name === declared.path)) throw new Error(`artifact: declared file missing ${declared.path}`);
  }
  return { manifest, entries, files };
}

export function applyArtifactTo(dir, bytes) {
  const inspected = inspectArtifact(bytes);
  applyArtifactEntries(dir, inspected.entries, inspected.manifest.deletions);
  return inspected;
}

export { canonical };
