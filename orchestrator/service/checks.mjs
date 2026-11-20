#!/usr/bin/env node
/* Проверки реестра: доказательство расхождения, а не догадка.

   Каждая проверка — только чтение файлов внутри repositoryRoot. Запрет
   абсолютных путей и '..' недостаточен: внутри репозитория может лежать
   symlink (safe/path -> /home/operator/.ssh), поэтому путь проверяется
   по компонентам через lstat, а затем realpath обязан остаться внутри
   realpath(repositoryRoot). Чтение ограничено по размеру, не-regular файлы
   (каталоги, FIFO, устройства, сокеты) не читаются.

   Ошибка containment не превращается в задачу: проверка помечается skipped,
   потому что доказательства нет. Это важно — иначе symlink стал бы способом
   заставить планировщик читать что угодно. */

import fs from 'node:fs';
import path from 'node:path';

import { canonical, sha256 } from '../lib/fsx.mjs';

const DEFAULT_MAX_READ = 2 * 1024 * 1024;
const HARD_MAX_READ = 8 * 1024 * 1024;

const fail = (code, message) => Object.assign(new Error(message), { code });

function splitRelative(rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw fail('REGISTRY_UNSAFE_PATH', 'registry path is missing');
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw fail('REGISTRY_UNSAFE_PATH', `absolute paths are not allowed: ${rel}`);
  if (rel.includes('\0')) throw fail('REGISTRY_UNSAFE_PATH', 'NUL byte in registry path');
  const parts = rel.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (!parts.length) throw fail('REGISTRY_UNSAFE_PATH', 'registry path is empty');
  if (parts.includes('..')) throw fail('REGISTRY_ESCAPE', `parent traversal is not allowed: ${rel}`);
  return parts;
}

/* Возвращает {exists, path, rel, size} или бросает REGISTRY_*.
   exists=false означает «файла нет» — это законный результат проверки. */
export function resolveContained(repositoryRoot, rel, { maxBytes = DEFAULT_MAX_READ } = {}) {
  const parts = splitRelative(rel);
  const rootReal = fs.realpathSync(path.resolve(repositoryRoot));
  const limit = Math.min(Number(maxBytes) || DEFAULT_MAX_READ, HARD_MAX_READ);

  let current = rootReal;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err && err.code === 'ENOENT') return { exists: false, path: current, rel: parts.join('/') };
      throw err;
    }
    /* Symlink запрещён в любом компоненте: и в промежуточном каталоге, и в
       самом файле. Разрешать «только конечный» бессмысленно — каталог уже
       уводит чтение наружу. */
    if (stat.isSymbolicLink()) {
      throw fail('REGISTRY_SYMLINK', `registry path crosses a symlink: ${parts.slice(0, i + 1).join('/')}`);
    }
    if (i < parts.length - 1 && !stat.isDirectory()) {
      throw fail('REGISTRY_NOT_DIR', `registry path component is not a directory: ${parts.slice(0, i + 1).join('/')}`);
    }
  }

  const stat = fs.lstatSync(current);
  if (!stat.isFile()) throw fail('REGISTRY_NOT_FILE', 'registry target is not a regular file');
  if (stat.size > limit) throw fail('REGISTRY_TOO_LARGE', `file is ${stat.size} bytes, limit ${limit}`);

  /* Проверка после lstat: даже если между вызовами что-то подменили, realpath
     покажет фактическое место. */
  const real = fs.realpathSync(current);
  if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
    throw fail('REGISTRY_ESCAPE', `resolved path leaves the repository: ${parts.join('/')}`);
  }
  return { exists: true, path: real, rel: parts.join('/'), size: stat.size };
}

export function readContained(repositoryRoot, rel, opts = {}) {
  const resolved = resolveContained(repositoryRoot, rel, opts);
  if (!resolved.exists) return resolved;
  return { ...resolved, text: fs.readFileSync(resolved.path, 'utf8') };
}

function jsonField(value, dotted) {
  return String(dotted || '').split('.').filter(Boolean).reduce((acc, key) => (acc == null ? acc : acc[key]), value);
}

const skipSignature = (kind, error) => sha256(canonical({ kind, error }));

/* result: {ok, kind, observed, expected, evidence[], signature, error?} */
export function evaluateCheck(check, { repositoryRoot }) {
  const kind = check && check.kind;
  const maxBytes = check && check.maxReadBytes;
  try {
    if (kind === 'file_exists') {
      const target = resolveContained(repositoryRoot, check.path, { maxBytes });
      const ok = target.exists === true;
      return {
        ok, kind, expected: 'file exists', observed: ok ? 'present' : 'missing',
        evidence: [`${target.rel}: ${ok ? 'present' : 'missing'}`],
        signature: sha256(canonical({ kind, path: check.path, ok })),
      };
    }

    if (kind === 'file_includes' || kind === 'file_excludes') {
      const target = readContained(repositoryRoot, check.path, { maxBytes });
      if (!target.exists) {
        return {
          ok: false, kind, expected: check.needle, observed: 'file missing',
          evidence: [`${target.rel}: file missing, expected text "${check.needle}"`],
          signature: sha256(canonical({ kind, path: check.path, needle: check.needle, state: 'missing' })),
        };
      }
      const has = target.text.includes(check.needle);
      const ok = kind === 'file_includes' ? has : !has;
      return {
        ok, kind, expected: kind === 'file_includes' ? `includes "${check.needle}"` : `does not include "${check.needle}"`,
        observed: has ? 'text present' : 'text absent',
        evidence: [`${target.rel}: ${has ? 'contains' : 'does not contain'} "${check.needle}"`],
        signature: sha256(canonical({ kind, path: check.path, needle: check.needle, has })),
      };
    }

    if (kind === 'json_field_equals') {
      const target = readContained(repositoryRoot, check.path, { maxBytes });
      if (!target.exists) {
        return {
          ok: false, kind, expected: `field ${check.field} equals ${JSON.stringify(check.value)}`,
          observed: 'file missing',
          evidence: [`${target.rel}: file missing, cannot read ${check.field}`],
          signature: sha256(canonical({ kind, path: check.path, field: check.field, state: 'missing' })),
        };
      }
      const data = JSON.parse(target.text);
      const actual = jsonField(data, check.field);
      const ok = JSON.stringify(actual) === JSON.stringify(check.value);
      return {
        ok, kind, expected: `${check.field} = ${JSON.stringify(check.value)}`,
        observed: `${check.field} = ${JSON.stringify(actual)}`,
        evidence: [`${target.rel}: ${check.field} is ${JSON.stringify(actual)}`],
        signature: sha256(canonical({ kind, path: check.path, field: check.field, actual })),
      };
    }

    if (kind === 'manual') {
      /* Владелец сам утверждает расхождение с ссылкой на доказательство;
         такой пункт закрывается только правкой реестра владельцем. */
      return {
        ok: false, kind, expected: 'owner-registered gap', observed: 'registered',
        evidence: Array.isArray(check.evidence) ? check.evidence.slice(0, 5).map(String) : ['owner-registered gap'],
        signature: sha256(canonical({ kind, id: check.id || null, evidence: check.evidence || [] })),
      };
    }

    throw fail('REGISTRY_UNKNOWN_CHECK', `unsupported check kind: ${kind}`);
  } catch (err) {
    return {
      ok: true, kind, skipped: true, error: err.code || 'REGISTRY_ERROR',
      detail: String(err.message || err),
      evidence: [`check skipped: ${err.code || 'error'}`],
      signature: skipSignature(kind, err.code || 'error'),
    };
  }
}
