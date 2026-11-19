#!/usr/bin/env node
// zip-pack.mjs — детерминированная упаковка пакета, переносимая на Linux/macOS.
// Требования fix6 (приёмка этапа 2):
//   - разделитель путей '/' (никогда '\');
//   - каталоги — отдельные directory entries с правами 0755;
//   - обычные файлы — 0644, исполняемые (*.sh) — 0755;
//   - никакого chmod после распаковки не требуется.
// ZIP пишется вручную (local headers + central directory + EOCD), потому что
// встроенные средства на Windows кладут '\' и обнуляют unix-атрибуты.
//
// Использование:
//   node tools/zip-pack.mjs --list pack-files.txt --out ../pkg.zip --prefix agentcoin
//   node tools/zip-pack.mjs --list pack-files.txt --out ../pkg.zip --prefix agentcoin --verify
// Файл списка: по одному пути на строку, пути относительны --root (по умолчанию
// каталог репозитория agentcoin), пустые строки и '#' игнорируются.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DIR_MODE = 0o040755;
export const FILE_MODE = 0o100644;
export const EXEC_MODE = 0o100755;
// Фиксированная отметка времени: пакет воспроизводим (одинаковый SHA256 при том же составе).
export const FIXED_DOS_TIME = { time: 0, date: (46 << 9) | (11 << 5) | 19 }; // 2026-11-19 00:00:00

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// mode — unix-режим файла (0o100644/0o100755) или каталога (0o040755).
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = e.mode === DIR_MODE || e.name.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : Buffer.from(e.data);
    const crc = crc32(data);
    const method = isDir || data.length === 0 ? 0 : 8;
    const comp = method === 8 ? zlib.deflateRawSync(data, { level: 9 }) : data;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(FIXED_DOS_TIME.time, 10);
    lh.writeUInt16LE(FIXED_DOS_TIME.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, spec 2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(FIXED_DOS_TIME.time, 12);
    ch.writeUInt16LE(FIXED_DOS_TIME.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE((((e.mode << 16) >>> 0) | (isDir ? 0x10 : 0)) >>> 0, 38); // external attrs (unix mode)
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return { buffer: Buffer.concat([...locals, cd, eocd]), files: entries.filter((e) => e.mode !== DIR_MODE).length, dirs: entries.filter((e) => e.mode === DIR_MODE).length };
}

// Разбор готового ZIP: имена, типы, режимы — проверка переносимости без распаковки.
export function inspectZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`zip: bad central signature at ${n}`);
    const madeBy = buf.readUInt16LE(off + 4);
    const extAttr = buf.readUInt32LE(off + 38);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const comLen = buf.readUInt16LE(off + 32);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    out.push({
      name,
      unix: (madeBy >> 8) === 3,
      mode: (extAttr >>> 16) & 0o7777,
      isDir: (extAttr & 0x10) !== 0 || name.endsWith('/'),
    });
    off += 46 + nameLen + extraLen + comLen;
  }
  return out;
}

export function buildEntries(root, listPath, prefix) {
  const raw = fs.readFileSync(listPath, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const files = [...new Set(raw)].sort();
  // Никаких обратных слешей и выходов за корень.
  for (const f of files) {
    if (f.includes('\\')) throw new Error(`zip-pack: backslash in manifest path: ${f}`);
    if (f.startsWith('/') || f.split('/').includes('..')) throw new Error(`zip-pack: unsafe manifest path: ${f}`);
  }
  // Каталоги: все родительские пути, с завершающим '/'.
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  const entries = [];
  if (prefix && prefix.trim() && prefix !== '.') entries.push({ name: `${prefix}/`, mode: DIR_MODE, data: Buffer.alloc(0) });
  for (const d of [...dirs].sort()) {
    entries.push({ name: `${prefix ? prefix + '/' : ''}${d}`, mode: DIR_MODE, data: Buffer.alloc(0) });
  }
  for (const f of files) {
    const abs = path.join(root, f);
    const data = fs.readFileSync(abs);
    const mode = /\.sh$/i.test(f) ? EXEC_MODE : FILE_MODE;
    entries.push({ name: `${prefix ? prefix + '/' : ''}${f}`, mode, data });
  }
  return entries;
}

function parseArgs(argv) {
  const a = { root: null, list: null, out: null, prefix: 'agentcoin', verify: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root') a.root = argv[++i];
    else if (argv[i] === '--list') a.list = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--prefix') a.prefix = argv[++i];
    else if (argv[i] === '--verify') a.verify = true;
  }
  return a;
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href; } catch { return false; } })();
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const args = parseArgs(process.argv);
  const root = args.root ? path.resolve(args.root) : path.resolve(here, '..');
  if (!args.list || !args.out) {
    console.error('usage: node tools/zip-pack.mjs --list <files.txt> --out <pkg.zip> [--root <dir>] [--prefix agentcoin] [--verify]');
    process.exit(2);
  }
  const entries = buildEntries(root, path.resolve(args.list), args.prefix);
  const { buffer, files, dirs } = buildZip(entries);
  fs.writeFileSync(path.resolve(args.out), buffer);
  console.log(`ZIP OK out=${path.resolve(args.out)} bytes=${buffer.length} files=${files} dirEntries=${dirs} entries=${files + dirs}`);
  if (args.verify) {
    const listed = inspectZip(fs.readFileSync(path.resolve(args.out)));
    const badSlash = listed.filter((e) => e.name.includes('\\'));
    const badUnix = listed.filter((e) => !e.unix);
    const badMode = listed.filter((e) => !(e.isDir ? e.mode === 0o755 : (e.mode === 0o644 || e.mode === 0o755)));
    const dirAsFile = listed.filter((e) => e.name.endsWith('/') && !e.isDir);
    const fileAsDir = listed.filter((e) => !e.name.endsWith('/') && e.isDir);
    console.log(`VERIFY entries=${listed.length} backslash=${badSlash.length} nonUnix=${badUnix.length} badMode=${badMode.length} dirFlat=${dirAsFile.length + fileAsDir.length}`);
    if (badSlash.length || badUnix.length || badMode.length || dirAsFile.length || fileAsDir.length) {
      console.error('VERIFY FAIL: ' + JSON.stringify({ badSlash: badSlash.slice(0, 3), badUnix: badUnix.slice(0, 3), badMode: badMode.slice(0, 3) }));
      process.exit(1);
    }
  }
}
