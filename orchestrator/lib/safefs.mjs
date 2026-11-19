#!/usr/bin/env node
/* Безопасная работа с путями внутри рабочего дерева.
   Строковая проверка пути недостаточна: symlink внутри workspace позволяет
   прочитать или записать файл снаружи. Поэтому каждый компонент проверяется
   через lstat, а итоговый realpath обязан остаться внутри корня.
   Обычный файл — единственный разрешённый тип; symlink, каталог, device,
   FIFO и socket отклоняются. */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class UnsafePathError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UnsafePathError';
    this.code = code;
    Object.assign(this, details);
  }
}

export const UNSAFE_FILE_TYPE = 'UNSAFE_FILE_TYPE';
export const SYMLINK_ESCAPE = 'SYMLINK_ESCAPE';

const toPosix = (value) => String(value).replace(/\\/g, '/');

export function isSafeRelativePath(relPath) {
  const p = toPosix(relPath);
  return Boolean(p) && !p.startsWith('/') && !/^[a-zA-Z]:/.test(p)
    && !p.split('/').some((part) => part === '' || part === '.' || part === '..');
}

export function isInside(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

/* Корень обязан существовать, быть каталогом и не быть symlink. */
export function safeRootDir(dir) {
  const abs = path.resolve(dir);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) throw new UnsafePathError(SYMLINK_ESCAPE, `root is a symlink: ${abs}`);
  if (!st.isDirectory()) throw new UnsafePathError(UNSAFE_FILE_TYPE, `root is not a directory: ${abs}`);
  return fs.realpathSync(abs);
}

function componentsOf(rootReal, relPath) {
  if (!isSafeRelativePath(relPath)) {
    throw new UnsafePathError(UNSAFE_FILE_TYPE, `not a safe relative path: ${relPath}`, { rel: relPath });
  }
  const rel = toPosix(relPath);
  const abs = path.resolve(rootReal, rel);
  if (!isInside(rootReal, abs)) {
    throw new UnsafePathError(SYMLINK_ESCAPE, `path escapes the root: ${relPath}`, { rel });
  }
  return { rel, abs, parts: rel.split('/') };
}

/* Проверяет все существующие родительские каталоги. */
export function assertSafeParents(rootReal, relDir, { create = false } = {}) {
  if (!relDir || relDir === '.') return;
  const { parts } = componentsOf(rootReal, relDir);
  let current = rootReal;
  for (const part of parts) {
    current = path.join(current, part);
    let st = null;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (!create) throw new UnsafePathError(UNSAFE_FILE_TYPE, `missing parent directory: ${part}`, { rel: relDir });
      fs.mkdirSync(current);
      continue;
    }
    if (st.isSymbolicLink()) {
      throw new UnsafePathError(SYMLINK_ESCAPE, `parent component is a symlink: ${part}`, { rel: relDir });
    }
    if (!st.isDirectory()) {
      throw new UnsafePathError(UNSAFE_FILE_TYPE, `parent component is not a directory: ${part}`, { rel: relDir });
    }
  }
}

/* Разрешён только обычный файл: symlink, каталог, FIFO, device и socket — нет. */
export function assertRegularFileWithin(rootReal, relPath) {
  const { rel, abs, parts } = componentsOf(rootReal, relPath);
  let current = rootReal;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let st;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new UnsafePathError(UNSAFE_FILE_TYPE, `missing path component: ${parts[i]}`, { rel });
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new UnsafePathError(SYMLINK_ESCAPE, `symlink in path: ${parts.slice(0, i + 1).join('/')}`, { rel });
    }
    const last = i === parts.length - 1;
    if (last && !st.isFile()) {
      throw new UnsafePathError(UNSAFE_FILE_TYPE, `not a regular file: ${rel}`, { rel });
    }
    if (!last && !st.isDirectory()) {
      throw new UnsafePathError(UNSAFE_FILE_TYPE, `not a directory: ${parts[i]}`, { rel });
    }
  }
  const real = fs.realpathSync(abs);
  if (!isInside(rootReal, real)) {
    throw new UnsafePathError(SYMLINK_ESCAPE, `realpath escapes the root: ${rel}`, { rel, real });
  }
  return { rel, abs, real };
}

export function readRegularFileWithin(root, relPath) {
  const rootReal = safeRootDir(root);
  const resolved = assertRegularFileWithin(rootReal, relPath);
  return { ...resolved, bytes: fs.readFileSync(resolved.abs) };
}

/* Удаление: родители без symlink, цель — не symlink и не каталог. */
export function deleteRegularFileWithin(root, relPath) {
  const rootReal = safeRootDir(root);
  const { rel, abs, parts } = componentsOf(rootReal, relPath);
  if (parts.length > 1) assertSafeParents(rootReal, parts.slice(0, -1).join('/'));
  let st = null;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT') return { rel, removed: false };
    throw err;
  }
  if (st.isSymbolicLink()) throw new UnsafePathError(SYMLINK_ESCAPE, `refusing to delete through a symlink: ${rel}`, { rel });
  if (st.isDirectory()) throw new UnsafePathError(UNSAFE_FILE_TYPE, `refusing to delete a directory: ${rel}`, { rel });
  fs.rmSync(abs, { force: true });
  return { rel, removed: true };
}

/* Атомарная замена файла: запись во временный файл в том же каталоге и
   rename поверх цели. rename не следует по symlink — заменяется сама ссылка,
   но такой случай отклоняется раньше. */
export function writeFileAtomicWithin(root, relPath, data) {
  const rootReal = safeRootDir(root);
  const { rel, abs, parts } = componentsOf(rootReal, relPath);
  if (parts.length > 1) assertSafeParents(rootReal, parts.slice(0, -1).join('/'), { create: true });
  let existing = null;
  try {
    existing = fs.lstatSync(abs);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing && existing.isSymbolicLink()) {
    throw new UnsafePathError(SYMLINK_ESCAPE, `refusing to overwrite a symlink: ${rel}`, { rel });
  }
  if (existing && !existing.isFile()) {
    throw new UnsafePathError(UNSAFE_FILE_TYPE, `refusing to overwrite a non-file: ${rel}`, { rel });
  }
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { rel, abs };
}

/* Полный обход с обнаружением symlink: walk() в fsx их не видит. */
export function findSymlinks(dir, { skip = ['.git'] } = {}) {
  const found = [];
  const visit = (current, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.includes(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        found.push(childRel);
        continue;
      }
      if (entry.isDirectory()) visit(path.join(current, entry.name), childRel);
    }
  };
  if (fs.existsSync(dir)) visit(path.resolve(dir), '');
  return found.sort();
}
