#!/usr/bin/env node
/* Промпты двух ролей. Строятся только из контракта задания и записанных
   оркестратором фактов. Скрытые рассуждения одного агента другому не
   передаются: исполнитель видит замечания проверяющего как findings, а
   проверяющий — артефакт, коммиты и исходное ТЗ, но не историю исполнителя. */

const bullet = (list) => list.map((item) => `- ${item}`).join('\n');

export function implementerPrompt({ task, iteration, baseCommit, findings, workspace, resume }) {
  const previous = (findings || []).length
    ? `The independent reviewer rejected the previous iteration with these findings:\n${bullet((findings || []).map((f) => `${f.code} (${f.severity}): ${f.detail}${f.file ? ` [${f.file}]` : ''}`))}\n\nFix exactly these findings. Do not change anything outside the allowed paths.`
    : 'This is the first iteration: there are no reviewer findings yet.';

  return [
    `You are the implementer agent for task ${task.taskId}. Work only inside the current working directory: ${workspace}.`,
    'You are one isolated process. A different, independent process will review your work; you cannot review or accept it yourself.',
    '',
    'Objective:',
    task.objective,
    '',
    'Acceptance criteria:',
    bullet(task.acceptance),
    '',
    `Allowed paths (write only here): ${task.scope.allowedPaths.join(', ')}`,
    `Forbidden paths (never read or write): ${task.scope.forbiddenPaths.join(', ')}`,
    '',
    `Rules:
- Do not touch production, deployment configuration, secrets, network services or money.
- Do not run shell commands other than the allowed test commands listed below.
- Do not modify tests/acceptance.test.mjs or any reviewer test: the acceptance suite is the contract.
- Commit your change in this repository (git add -A && git commit) and report the resulting 40-hex HEAD.`,
    '',
    `Allowed commands: ${task.commandsAllowed.join(' | ')}`,
    '',
    `Base commit: ${baseCommit}`,
    `Iteration: ${iteration}`,
    previous,
    resume ? 'This session continues your own previous implementation session; only your own earlier work is in context.' : '',
    '',
    'Run the tests you are allowed to run. Be honest about failures in "tests" and "knownLimitations".',
    'Finish with a single JSON object matching the provided output schema and nothing else. All fields are required.',
    'The artifact archive and its SHA256 are computed by the orchestrator, not by you: do not invent them.',
  ].filter(Boolean).join('\n');
}

export function reviewerPrompt({ task, baseCommit, resultCommit, artifactPath, artifactSha256, artifactBytes, appliedDir, baseDir }) {
  return [
    `You are the independent reviewer for task ${task.taskId}. You did not write this code and you must not trust the implementer's claims.`,
    'You are a separate process with a separate workspace. Do not look for or read the implementer workspace, its conversation or its notes.',
    '',
    'Original objective (unchanged):',
    task.objective,
    '',
    'Acceptance criteria (the contract):',
    bullet(task.acceptance),
    '',
    'Evidence you may use:',
    `- artifact archive: ${artifactPath} (${artifactBytes} bytes, sha256 ${artifactSha256})`,
    `- applied result tree: ${appliedDir}`,
    `- clean base tree: ${baseDir}`,
    `- base commit: ${baseCommit}`,
    `- result commit declared by the implementer: ${resultCommit}`,
    '',
    `Rules:
- Write only inside your own workspace (${appliedDir} and temporary files below it).
- No network, no production, no deployment, no money operations.
- Run the acceptance suite yourself: ${task.commandsAllowed.join(' | ')}.
- Every check you report must name the exact command and its real exit code. Do not report a check you did not execute.
- Verify sha256 of the archive yourself before testing.
- ACCEPTED requires every acceptance criterion to pass and no blocker/major findings. Otherwise CHANGES_REQUESTED with concrete findings.
- Report the exact artifact sha256 and both commits; the orchestrator cross-checks them against its own records and blocks the task on any mismatch.`,
    '',
    'Finish with a single JSON object matching the provided output schema and nothing else. All fields are required.',
    `"reviewer" must be exactly "codex-reviewer" and "simulated" must be false.`,
    'Set "notes" to an empty string when there is nothing else to add.',
  ].join('\n');
}
