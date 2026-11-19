#!/usr/bin/env node
/* Детерминированный независимый проверяющий (simulated=true, не Codex).
   Он действительно выполняет проверку, а не «знает» ответ:
   - пересчитывает SHA256 архива;
   - распаковывает ZIP и сверяет каждый файл с коммитом результата;
   - применяет архив в свой чистый клон базового коммита;
   - запускает заявленные команды и собственные граничные тесты;
   - возвращает вердикт по фактическим результатам. */

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../lib/fsx.mjs';
import { blobBuffer, changedFiles as gitChangedFiles, commitFiles } from '../lib/git.mjs';
import { inspectArtifact, verifyArtifactFiles } from '../artifacts/store.mjs';
import { applyArtifactEntries } from '../artifacts/apply.mjs';
import { checkFile } from '../policies/policy.mjs';

export const id = 'fixture-reviewer';
export const roles = ['reviewer'];
export const simulated = true;

export function probe() {
  return {
    available: true,
    programmatic: true,
    authenticated: true,
    simulated: true,
    version: 'fixture/1',
    reason: 'детерминированный независимый проверяющий; не является запуском Codex',
    requiresHuman: null,
  };
}

function failedTests(output) {
  return [...String(output).matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
}

export async function run(ctx) {
  const {
    task, workspace, archive, meta, result, baseCommit, resultCommit,
    implementerDir, runCommand, reviewerChecksDir,
  } = ctx;

  const checks = [];
  const findings = [];
  const blockers = [];
  const now = new Date().toISOString();

  const verdictOf = (extra = {}) => ({
    verdict: blockers.length ? 'BLOCKED' : findings.length ? 'CHANGES_REQUESTED' : 'ACCEPTED',
    artifactSha256: meta.sha256,
    baseCommit,
    resultCommit,
    checks,
    findings,
    reviewer: id,
    simulated: true,
    reviewedAt: now,
    notes: [
      'проверка выполнена в отдельном клоне базового коммита',
      'собственные граничные проверки: tests/reviewer.extra.test.mjs',
      ...(extra.notes || []),
    ].join('; '),
    ...extra,
  });

  // 1. Хеш пересчитывается по байтам, которые получил проверяющий.
  const hash = verifyArtifactFiles(meta, archive);
  checks.push({
    name: 'artifact.sha256',
    command: '',
    exitCode: -1,
    ok: hash.ok,
    detail: `expected ${hash.expected} (${hash.expectedSize} B), actual ${hash.actual} (${hash.actualSize} B)`,
  });
  if (!hash.ok) {
    findings.push({
      code: 'ARTIFACT_HASH_MISMATCH',
      severity: 'blocker',
      detail: 'байты архива не соответствуют заявленному SHA256',
      file: '',
      evidence: `expected=${hash.expected} actual=${hash.actual}`,
    });
    blockers.push('ARTIFACT_HASH_MISMATCH');
    return { review: verdictOf() };
  }

  // 2. Распаковка и проверка манифеста (CRC каждого файла).
  let inspected;
  try {
    inspected = inspectArtifact(archive);
  } catch (err) {
    findings.push({ code: 'ARTIFACT_MALFORMED', severity: 'blocker', detail: err.message, file: '', evidence: '' });
    blockers.push('ARTIFACT_MALFORMED');
    return { review: verdictOf() };
  }
  checks.push({ name: 'artifact.unzip', command: '', exitCode: -1, ok: true, detail: `${inspected.files.length} файл(ов), CRC совпал` });

  // 3. Артефакт должен описывать ровно коммит результата.
  const declared = inspected.manifest.files.filter((f) => f.status !== 'deleted').map((f) => f.path).sort();
  const commitDiff = commitFiles(implementerDir, resultCommit, baseCommit).sort();
  const diffMatches = JSON.stringify(declared) === JSON.stringify(commitDiff);
  checks.push({
    name: 'commit.diff_matches_artifact',
    command: '',
    exitCode: -1,
    ok: diffMatches,
    detail: diffMatches ? commitDiff.join(', ') : `artifact=[${declared}] commit=[${commitDiff}]`,
  });
  if (!diffMatches) {
    findings.push({
      code: 'ARTIFACT_COMMIT_MISMATCH',
      severity: 'blocker',
      detail: 'состав архива не совпадает с diff базового и результирующего коммитов',
      file: '',
      evidence: `artifact=[${declared}] commit=[${commitDiff}]`,
    });
  }

  let blobMismatch = null;
  for (const entry of inspected.files) {
    const committed = blobBuffer(implementerDir, resultCommit, entry.name);
    if (!committed.equals(entry.data)) {
      blobMismatch = entry.name;
      break;
    }
  }
  checks.push({
    name: 'commit.blob_bytes',
    command: '',
    exitCode: -1,
    ok: !blobMismatch,
    detail: blobMismatch ? `содержимое ${blobMismatch} отличается от коммита` : 'все файлы побайтно совпадают с коммитом',
  });
  if (blobMismatch) {
    findings.push({
      code: 'ARTIFACT_COMMIT_BYTES',
      severity: 'blocker',
      detail: `файл ${blobMismatch} в архиве не совпадает с коммитом результата`,
      file: blobMismatch,
      evidence: '',
    });
  }

  // 4. Только разрешённые пути. Артефакт не может расширить scope задания.
  for (const file of declared) {
    const allowed = checkFile(task, file);
    if (!allowed.ok) {
      findings.push({ code: 'SCOPE_VIOLATION', severity: 'blocker', detail: `${allowed.code}: ${file}`, file, evidence: '' });
    }
  }
  const scopeOk = !findings.some((f) => f.code === 'SCOPE_VIOLATION');
  checks.push({ name: 'scope.allowed_paths', command: '', exitCode: -1, ok: scopeOk, detail: scopeOk ? 'все пути разрешены' : 'есть запрещённые пути' });

  if (findings.length) {
    // Повреждённый или выходящий за scope артефакт не запускаем: вердикт уже определён.
    return { review: verdictOf() };
  }

  // 5. Чистый клон базы + применение архива.
  applyArtifactEntries(workspace, inspected.entries, inspected.manifest.deletions);
  const appliedFiles = gitChangedFiles(workspace, baseCommit);
  checks.push({
    name: 'workspace.apply',
    command: '',
    exitCode: -1,
    ok: true,
    detail: `применено в чистый клон: ${appliedFiles.length} изменённых файлов`,
  });

  // 6. Собственные негативные и граничные проверки проверяющего.
  if (reviewerChecksDir && fs.existsSync(reviewerChecksDir)) {
    for (const file of fs.readdirSync(reviewerChecksDir)) {
      const target = path.join(workspace, 'tests', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(reviewerChecksDir, file), target);
    }
    checks.push({ name: 'reviewer.checks_installed', command: '', exitCode: -1, ok: true, detail: 'добавлены собственные тесты проверяющего' });
  }

  // 7. Заявленные команды и собственные тесты — фактические exit code.
  for (const command of task.commandsAllowed) {
    const outcome = runCommand(command);
    const failures = failedTests(`${outcome.stdout}\n${outcome.stderr}`);
    const ok = outcome.exitCode === 0;
    checks.push({
      name: `command:${command}`,
      ok,
      command,
      exitCode: outcome.exitCode,
      detail: ok ? 'ok' : `упали: ${failures.join('; ') || 'exit != 0'}`,
    });
    if (!ok) {
      findings.push({
        code: 'ACCEPTANCE_TEST_FAILED',
        severity: 'blocker',
        detail: `команда «${command}» завершилась с кодом ${outcome.exitCode}`,
        file: command.includes('acceptance') ? 'tests/acceptance.test.mjs' : command.replace(/^node --test /, ''),
        evidence: (failures.length ? `failed tests: ${failures.join('; ')}` : (outcome.stderr || outcome.stdout)).slice(0, 3900),
      });
    }
  }

  // 8. Результат исполнителя не должен противоречить фактам.
  if (result && result.resultCommit !== resultCommit) {
    findings.push({ code: 'RESULT_COMMIT_MISMATCH', severity: 'blocker', detail: 'result.resultCommit не совпадает с проверенным коммитом', file: '', evidence: '' });
  }

  return { review: verdictOf() };
}
