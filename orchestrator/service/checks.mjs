#!/usr/bin/env node
/* Проверки реестра: доказательство расхождения, а не догадка.

   Каждая проверка — только чтение файлов внутри repositoryRoot. Абсолютные
   пути, '..' и выход за корень запрещены: планировщик не должен уметь читать
   что-либо вне репозитория. Результат обязан содержать evidence — строки,
   пригодные и для владельца, и для публичного статуса (относительные пути,
   без абсолютных путей, usernames и адресов). */

import fs from 'node:fs';
import path from 'node:path';

import { canonical, sha256 } from '../lib/fsx.mjs';

const MAX_READ = 2 * 1024 * 1024;

function safeResolve(repositoryRoot, rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes('..')) {
    throw Object.assign(new Error(`unsafe registry path: ${rel}`), { code: 'REGISTRY_UNSAFE_PATH' });
  }
  const root = path.resolve(repositoryRoot);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error(`registry path escapes the repository: ${rel}`), { code: 'REGISTRY_ESCAPE' });
  }
  return target;
}

function readText(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'REGISTRY_NOT_FILE' });
  if (stat.size > MAX_READ) throw Object.assign(new Error('file is too large to check'), { code: 'REGISTRY_TOO_LARGE' });
  return fs.readFileSync(file, 'utf8');
}

function jsonField(value, dotted) {
  return String(dotted || '').split('.').filter(Boolean).reduce((acc, key) => (acc == null ? acc : acc[key]), value);
}

/* result: {ok, kind, observed, expected, evidence[], signature} */
export function evaluateCheck(check, { repositoryRoot }) {
  const kind = check && check.kind;
  try {
    if (kind === 'file_exists') {
      const target = safeResolve(repositoryRoot, check.path);
      const ok = fs.existsSync(target) && fs.statSync(target).isFile();
      return {
        ok, kind, expected: 'file exists', observed: ok ? 'present' : 'missing',
        evidence: [`${check.path}: ${ok ? 'present' : 'missing'}`],
        signature: sha256(canonical({ kind, path: check.path, ok })),
      };
    }

    if (kind === 'file_includes' || kind === 'file_excludes') {
      const target = safeResolve(repositoryRoot, check.path);
      if (!fs.existsSync(target)) {
        return {
          ok: false, kind, expected: check.needle, observed: 'file missing',
          evidence: [`${check.path}: file missing, expected text "${check.needle}"`],
          signature: sha256(canonical({ kind, path: check.path, needle: check.needle, state: 'missing' })),
        };
      }
      const text = readText(target);
      const has = text.includes(check.needle);
      const ok = kind === 'file_includes' ? has : !has;
      return {
        ok, kind, expected: kind === 'file_includes' ? `includes "${check.needle}"` : `does not include "${check.needle}"`,
        observed: has ? 'text present' : 'text absent',
        evidence: [`${check.path}: ${has ? 'contains' : 'does not contain'} "${check.needle}"`],
        signature: sha256(canonical({ kind, path: check.path, needle: check.needle, has })),
      };
    }

    if (kind === 'json_field_equals') {
      const target = safeResolve(repositoryRoot, check.path);
      if (!fs.existsSync(target)) {
        return {
          ok: false, kind, expected: `field ${check.field} equals ${JSON.stringify(check.value)}`,
          observed: 'file missing',
          evidence: [`${check.path}: file missing, cannot read ${check.field}`],
          signature: sha256(canonical({ kind, path: check.path, field: check.field, state: 'missing' })),
        };
      }
      const data = JSON.parse(readText(target));
      const actual = jsonField(data, check.field);
      const ok = JSON.stringify(actual) === JSON.stringify(check.value);
      return {
        ok, kind, expected: `${check.field} = ${JSON.stringify(check.value)}`,
        observed: `${check.field} = ${JSON.stringify(actual)}`,
        evidence: [`${check.path}: ${check.field} is ${JSON.stringify(actual)}`],
        signature: sha256(canonical({ kind, path: check.path, field: check.field, actual })),
      };
    }

    if (kind === 'manual') {
      /* Владелец сам утверждает расхождение с ссылкой на доказательство;
         планировщик не превращает это в бесконечный цикл, потому что такой
         пункт закрывается только правкой реестра владельцем. */
      return {
        ok: false, kind, expected: 'owner-registered gap', observed: 'registered',
        evidence: Array.isArray(check.evidence) ? check.evidence.slice(0, 5).map(String) : ['owner-registered gap'],
        signature: sha256(canonical({ kind, id: check.id || null, evidence: check.evidence || [] })),
      };
    }

    throw Object.assign(new Error(`unsupported check kind: ${kind}`), { code: 'REGISTRY_UNKNOWN_CHECK' });
  } catch (err) {
    return {
      ok: true, kind, error: err.code || 'REGISTRY_ERROR', detail: String(err.message || err),
      evidence: [`check skipped: ${err.code || 'error'}`], signature: sha256(canonical({ kind, error: err.code || 'error' })),
    };
  }
}
