#!/usr/bin/env node
// PASSPORT-BACKUP: зашифрованный офлайн-бэкап паспорт-артефактов издателя.
// Диск D (Passport-Drive) недоступен — артефакты собираются из локальных
// авторитетных копий (data/identity, data-agtx). Формат: AES-256-GCM,
// ключ = scrypt(passphrase). Пароль НИКОГДА не попадает в чат/log: читается
// из stdin (без эха) или env AGT_BACKUP_PASS. Отчётное имя/схеш выводится, ключ нет.
//
// Использование:
//   node tools/passport-backup.mjs pack   <outfile> [--note "..."]
//   node tools/passport-backup.mjs list   <file>
//   node tools/passport-backup.mjs unpack <file> [outdir]
// Восстановление: распаковывать В живой data/ запрещено скриптом (suffix .restore).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Фиксированный белый список (пути от корня репо). Никаких произвольных путей.
const DEFAULT_FILES = [
  'data/identity/identity-issuer.json',                 // живой издатель (секрет!)
  'data/identity/identity-issuer.rotated-1792451118765.json', // старый издатель (forensic)
  'data/identity/identity-issuer.backup-20261019.json',
  'data/identity/agent-identities.json',                // живой реестр паспортов
  'data/identity/agent-identities.backup-20261019.json',
  'data-agtx/trusted-issuers.json',                     // публичные пины реплик
  'data-agtx/passport.json',                            // паспорт платформы
  'data-agtx/holder-wallet.json',                       // холдер-кошелёк
  'docs/KEY-COMPROMISE-2026-10-19.md',                  // компромисс исторических ключей
];
const MAGIC = Buffer.from('AGTBK1', 'ascii');

function readPassphrase() {
  if (process.env.AGT_BACKUP_PASS && process.env.AGT_BACKUP_PASS.length >= 8) return process.env.AGT_BACKUP_PASS;
  return new Promise((resolve) => {
    process.stdout.write('passphrase (min 8 chars): ');
    const chars = [];
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', (buf) => {
      for (const byte of buf) {
        if (byte === 0x03) { process.stdout.write('\n'); process.exit(1); } // Ctrl+C
        if (byte === 0x7f || byte === 0x08) { chars.pop(); continue; } // Backspace
        if (byte === 0x0d || byte === 0x0a) {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          const pass = Buffer.from(chars).toString('utf8');
          process.stdout.write('\n');
          resolve(pass);
          return;
        }
        chars.push(byte);
      }
    });
  });
}

function derive(pass, salt) {
  return crypto.scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 96 << 20 });
}

function encrypt(obj, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(pass, salt), iv);
  const plain = Buffer.from(JSON.stringify(obj, null, 1), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
}

function decrypt(buf, pass) {
  if (buf.length < MAGIC.length + 44 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) fail('не тот формат файла');
  const salt = buf.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = buf.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const tag = buf.subarray(MAGIC.length + 28, MAGIC.length + 44);
  const ciphertext = buf.subarray(MAGIC.length + 44);
  const decipher = crypto.createDecipheriv('aes-256-gcm', derive(pass, salt), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

function fail(msg) { console.error('passport-backup: ' + msg); process.exitCode = 1; }

function collectFiles() {
  const files = [], missing = [];
  for (const rel of DEFAULT_FILES) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) files.push({ rel, abs });
    else missing.push(rel);
  }
  return { files, missing };
}

async function pack(outfile, note) {
  if (fs.existsSync(outfile)) { fail('файл уже существует — не перезаписываю'); return; }
  let pass = await readPassphrase();
  if (typeof pass !== 'string' || pass.length < 8) { fail('пароль короче 8 символов'); return; }
  const { files, missing } = collectFiles();
  if (!files.length) { fail('не найдено ни одного файла из списка'); return; }
  const payload = {
    format: 'AGT-PASSPORT-BACKUP-1',
    createdAt: new Date().toISOString(),
    note: String(note || ''),
    hostedNote: 'Passport-Drive (D:) на момент сбора недоступен; состав — локальные авторитетные копии',
    files: files.map((f) => {
      const bytes = fs.readFileSync(f.abs);
      return { path: f.rel, bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        data: bytes.toString('base64') };
    }),
    missing,
  };
  const blob = encrypt(payload, pass);
  fs.writeFileSync(outfile, blob, { mode: 0o600 });
  const digest = crypto.createHash('sha256').update(blob).digest('hex');
  console.log(`Архив создан: ${outfile}`);
  console.log(`Размер: ${blob.length} байт; sha256(архива): ${digest}`);
  console.log(`Включено файлов: ${files.length}${missing.length ? `; отсутствовали (пропущены): ${missing.length}` : ''}`);
  for (const f of files) console.log(`  + ${f.rel} (${fs.statSync(f.abs).size} байт)`);
  for (const rel of missing) console.log(`  - отсутствует: ${rel}`);
  // (строку pass в JS полностью вычистить нельзя; она не попала ни в чат, ни в лог)
}

function loadBackup(file, pass) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { fail('не найден архив: ' + file); return null; }
  try { return decrypt(buf, pass); } catch (e) {
    if (/Decrypt|auth|^c/.test(e.message)) fail('Неверный пароль или испорченный архив (GCM integrity)');
    else fail('ошибка чтения: ' + e.message);
    return null;
  }
}

async function list(file) {
  const pass = await readPassphrase();
  const payload = loadBackup(file, pass);
  if (!payload) return;
  if (payload.format !== 'AGT-PASSPORT-BACKUP-1') { fail('неизвестный format: ' + payload.format); return; }
  console.log(`Архив: ${file} (создан ${payload.createdAt}, заметка: ${payload.note || '—'})`);
  for (const f of payload.files) console.log(`  + ${f.path} (${f.bytes} байт)`);
  for (const rel of payload.missing) console.log(`  - отсутствовал: ${rel}`);
}

async function unpack(file, outdir) {
  const pass = await readPassphrase();
  const payload = loadBackup(file, pass);
  if (!payload) return;
  if (payload.format !== 'AGT-PASSPORT-BACKUP-1') { fail('неизвестный format: ' + payload.format); return; }
  const target = path.resolve(outdir || path.join(ROOT, 'restore-' + Date.now()));
  if (target === path.resolve(ROOT, 'data') || target === path.resolve(ROOT, 'data-agtx')) {
    fail('в живые каталоги data/ и data-agtx/ распаковка запрещена — восстановление вручную, по чек-листу');
    return;
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  let bad = 0;
  for (const f of payload.files) {
    const bytes = Buffer.from(f.data, 'base64');
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== f.sha256) { bad++; console.log(`  × sha256 не совпал: ${f.path}`); continue; }
    const abs = path.join(target, f.path);
    if (fs.existsSync(abs)) { console.log(`  = существует, не перезаписан: ${abs}`); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    fs.writeFileSync(abs, bytes, { mode: 0o600 });
    console.log(`  → ${abs}`);
  }
  console.log(`Распаковка: ${target}${bad ? `; битых записей: ${bad}` : ''}`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const noteIdx = argv.indexOf('--note');
const noteArg = noteIdx >= 0 ? argv.slice(noteIdx + 1).join(' ').replace(/^"|"$/g, '') : '';
const positional = argv.slice(1).filter((a, i) => a !== '--note' && argv[1 + i + (noteIdx - 1 > 0 ? 0 : 0)] !== undefined);
// позиционные: всё после cmd, кроме значения note
const posClean = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--note') { i++; continue; }
  posClean.push(argv[i]);
}
const [arg1, arg2] = posClean;
if (cmd === 'pack' && arg1) pack(arg1, noteArg);
else if (cmd === 'list' && arg1) list(arg1);
else if (cmd === 'unpack' && arg1) unpack(arg1, arg2);
else {
  console.error('usage: passport-backup.mjs pack|list|unpack … (passphrase через stdin или AGT_BACKUP_PASS)');
  process.exitCode = 2;
}
