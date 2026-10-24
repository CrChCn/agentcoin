import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_DIR = path.join(os.homedir(), '.agentcoin', 'agent-wallet');
async function assertPrivateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await fsp.lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (process.platform !== 'win32' && ((s.mode & 0o077) || (typeof process.getuid === 'function' && s.uid !== process.getuid())))) throw Error('private_linux_state_dir_required');
  if (process.platform !== 'win32') {
    let current = path.resolve(dir);
    for (;;) {
      const entry = await fsp.lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('state_path_must_not_use_symlinks');
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
}
async function assertRealOutputDir(dir) {
  const s = await fsp.lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink()) throw Error('output_directory_invalid');
}
export async function withLock(file, work) {
  await assertPrivateDir(path.dirname(file));
  const lockPath = file + '.lock'; let lock;
  try { lock = await fsp.open(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw Error('state_writer_busy'); throw e; }
  try { await lock.writeFile(`${process.pid}\n`); await lock.sync(); return await work(); }
  finally { await lock.close(); await fsp.unlink(lockPath).catch(() => {}); }
}
export async function writeJsonAtomic(file, value) {
  await assertPrivateDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), '.wallet-' + crypto.randomBytes(12).toString('hex'));
  let h;
  try {
    h = await fsp.open(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    await h.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await h.sync(); await h.close(); h = null;
    await fsp.rename(tmp, file);
    if (process.platform !== 'win32') { const d = await fsp.open(path.dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); } }
  } finally { await h?.close().catch(() => {}); await fsp.unlink(tmp).catch(() => {}); }
}
export async function writeJsonExclusive(file, value) {
  await assertRealOutputDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), '.wallet-new-' + crypto.randomBytes(12).toString('hex'));
  let h;
  try {
    h = await fsp.open(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    await h.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await h.sync(); await h.close(); h = null;
    await fsp.link(tmp, file);
    if (process.platform !== 'win32') { const d = await fsp.open(path.dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); } }
  } finally { await h?.close().catch(() => {}); await fsp.unlink(tmp).catch(() => {}); }
}
export async function readJson(file, { privateFile = true } = {}) {
  const s = await fsp.lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1024 * 1024 || (privateFile && process.platform !== 'win32' && ((s.mode & 0o077) || (typeof process.getuid === 'function' && s.uid !== process.getuid())))) throw Error(privateFile ? 'state_file_invalid_or_not_private' : 'public_json_invalid');
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}
export const readPublicJson = file => readJson(file, { privateFile: false });
