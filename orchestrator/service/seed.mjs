#!/usr/bin/env node
/* Семя оркестратора: mission.json (что делать и в каких границах) и
   registry.json (какие расхождения доказаны). Сервис их только читает.

   Это не стилистическое предпочтение: если сервис сможет править семя, он
   сможет выписать себе мандат — добавить инвариант, чья проверка падает, и
   получить задачу на его «исправление». Поэтому владелец держит семя как
   root, а эта команда — ответ сервиса владельцу: что в семени цело, что
   устарело (проверка проходит — записи там нечего делать), что исполнять
   нельзя (неизвестная проверка, дубль id, битый JSON) и может ли сервис
   переписать семя сам. */

import fs from 'node:fs';

import { sha256 } from '../lib/fsx.mjs';
import { evaluateCheck } from './checks.mjs';

export const SEED_CHECK_KINDS = Object.freeze(['file_exists', 'file_includes', 'file_excludes', 'json_field_equals', 'manual']);

const KINDS = new Set(SEED_CHECK_KINDS);
const problem = (code, detail) => ({ code, detail });

function readSeedFile(file) {
  if (!fs.existsSync(file)) return { file, present: false };
  const text = fs.readFileSync(file, 'utf8');
  return { file, present: true, text, sha256: sha256(text) };
}

/* Владелец семени — root. Проверка идёт от лица сервиса: если сервис может
   записать файл (владелец-uid с write, группа-сервис с write или world-write),
   семя больше не контроль владельца, чем бы ни был uid. На Windows владение
   не проверяется — об этом честно сообщается, а не выдаётся за «ок». */
function provenanceOf(file, uid, gid) {
  const out = { file, verifiable: false, ownerControlled: null, owner: null, group: null, mode: null, problems: [] };
  if (uid === undefined || gid === undefined) {
    out.note = 'POSIX ownership is not available on this host';
    return out;
  }
  if (!fs.existsSync(file)) return out;
  out.verifiable = true;
  const stat = fs.statSync(file);
  out.owner = stat.uid;
  out.group = stat.gid;
  out.mode = (stat.mode & 0o777).toString(8).padStart(4, '0');
  const writable = (stat.uid === uid && (stat.mode & 0o200) !== 0)
    || (stat.gid === gid && (stat.mode & 0o020) !== 0)
    || (stat.mode & 0o002) !== 0;
  out.ownerControlled = !writable;
  if (writable) {
    out.problems.push(problem('SEED_SERVICE_WRITABLE', `${file}: сервис может переписать своё семя (режим ${out.mode}, uid ${stat.uid}, gid ${stat.gid})`));
  } else if (stat.uid !== 0) {
    out.problems.push(problem('SEED_NOT_ROOT_OWNED', `${file}: семя не принадлежит root (uid ${stat.uid})`));
  }
  return out;
}

function inspectEntry(entry, repositoryRoot) {
  const id = entry && entry.id ? String(entry.id) : null;
  const record = {
    id,
    enabled: !(entry && entry.enabled === false),
    priority: Number(entry && entry.priority) || 100,
    status: 'invalid',
    detail: null,
  };
  if (!entry || typeof entry !== 'object' || !id || !entry.check || !entry.task) {
    record.detail = 'entry needs id, check and task';
    return record;
  }
  if (!KINDS.has(entry.check.kind)) {
    record.detail = `unsupported check kind: ${entry.check.kind}`;
    return record;
  }
  if (!record.enabled) {
    record.status = 'disabled';
    return record;
  }
  const outcome = evaluateCheck(entry.check, { repositoryRoot });
  if (outcome.skipped) {
    record.status = 'skipped';
    record.detail = outcome.detail || outcome.error;
    return record;
  }
  /* ok=true — инвариант держится; записи в семени нечего делать, пока он снова
     не сломается. ok=false — доказанное расхождение, по нему ставится задача. */
  record.status = outcome.ok ? 'closed' : 'gap';
  record.evidence = (outcome.evidence || []).slice(0, 3);
  return record;
}

export function inspectSeed({
  missionFile,
  mission,
  registryFile,
  repositoryRoot,
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  gid = typeof process.getgid === 'function' ? process.getgid() : undefined,
}) {
  const problems = [];

  const missionSeed = readSeedFile(missionFile);
  if (!missionSeed.present) problems.push(problem('SEED_MISSION_MISSING', `${missionFile}: миссии нет, планировщик не сможет работать`));
  let missionTitle = null;
  if (missionSeed.present) {
    let parsed = null;
    try {
      parsed = JSON.parse(missionSeed.text);
    } catch {
      problems.push(problem('SEED_MISSION_INVALID_JSON', `${missionFile}: миссия не разбирается как JSON`));
    }
    if (parsed) missionTitle = typeof parsed.mission === 'string' ? parsed.mission : null;
    if (mission && typeof mission !== 'object') problems.push(problem('SEED_MISSION_INVALID', `${missionFile}: миссия должна быть объектом`));
  }

  const registrySeed = readSeedFile(registryFile);
  const entries = [];
  let registryVersion = null;
  if (registrySeed.present) {
    let parsed = null;
    try {
      parsed = JSON.parse(registrySeed.text);
    } catch {
      problems.push(problem('SEED_INVALID_JSON', `${registryFile}: реестр не разбирается как JSON; планировщик не станет IDLE молча, он упадёт`));
    }
    if (parsed && typeof parsed === 'object') {
      registryVersion = parsed.version === undefined ? null : parsed.version;
      const list = Array.isArray(parsed.entries) ? parsed.entries : null;
      if (!list) {
        problems.push(problem('SEED_REGISTRY_INVALID', `${registryFile}: entries должен быть массивом`));
      } else {
        const seen = new Set();
        for (const entry of list) {
          const record = inspectEntry(entry, repositoryRoot);
          if (record.id) {
            if (seen.has(record.id)) problems.push(problem('SEED_DUPLICATE_ID', `${registryFile}: id "${record.id}" повторяется`));
            seen.add(record.id);
          }
          if (record.status === 'invalid') {
            problems.push(problem('SEED_ENTRY_INVALID', `${registryFile}: ${record.id || 'entry'} — ${record.detail}`));
          }
          entries.push(record);
        }
      }
    } else if (parsed !== null) {
      problems.push(problem('SEED_REGISTRY_INVALID', `${registryFile}: реестр должен быть объектом`));
    }
  }

  const provenance = {
    mission: provenanceOf(missionFile, uid, gid),
    registry: registrySeed.present ? provenanceOf(registryFile, uid, gid) : { file: registryFile, verifiable: false, ownerControlled: null, problems: [] },
  };
  problems.push(...provenance.mission.problems, ...provenance.registry.problems);

  const enabled = entries.filter((entry) => entry.enabled);
  const statuses = { gap: 0, closed: 0, skipped: 0, disabled: 0, invalid: 0 };
  for (const entry of entries) statuses[entry.status] += 1;
  /* skipped — это отсутствие доказательства (нет repositoryRoot, путь вне
     границ), а не «инвариант держится». Смешивать их значит врать в
     собственном отчёте. */
  let state = 'closed';
  if (problems.length) state = 'invalid';
  else if (!enabled.length) state = 'empty';
  else if (statuses.gap) state = 'gap';
  else if (!statuses.closed) state = 'unknown';

  const hint = {
    empty: 'планировщик IDLE: доказывать нечего — владелец ещё не зарегистрировал расхождение',
    gap: 'есть доказанное расхождение: планировщик поставит по нему задачу',
    closed: 'включённые инварианты держатся: семя можно сузить до тех, что действительно нужны',
    unknown: 'проверки не дали доказательства: нет repositoryRoot или путь вне границ — это не «инварианты держатся»',
    invalid: 'семя исполнять нельзя: сначала правка владельцем',
  }[state];

  return {
    schema: 'agentcoin/seed-report@1',
    mission: {
      file: missionFile,
      present: missionSeed.present,
      sha256: missionSeed.sha256 || null,
      title: missionTitle,
    },
    registry: {
      file: registryFile,
      present: registrySeed.present,
      sha256: registrySeed.sha256 || null,
      version: registryVersion,
      entries: entries.length,
      enabled: enabled.length,
      statuses,
    },
    repositoryRoot: { path: repositoryRoot, present: fs.existsSync(repositoryRoot) },
    provenance,
    entries,
    problems,
    state,
    hint,
  };
}
