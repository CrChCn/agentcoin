#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function canonical(value) {
  // Стабильная сериализация: ключи сортируются, поэтому хеш не зависит от порядка полей.
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return file;
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
  return value;
}

export function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

export function walk(dir, { skip = ['.git'] } = {}) {
  const out = [];
  const visit = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) visit(abs, relPath);
      else if (entry.isFile()) out.push({ rel: relPath.replace(/\\/g, '/'), abs });
    }
  };
  visit(dir, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

export function copyTree(src, dest) {
  ensureDir(dest);
  for (const item of walk(src)) {
    const target = path.join(dest, item.rel);
    ensureDir(path.dirname(target));
    fs.copyFileSync(item.abs, target);
  }
}
