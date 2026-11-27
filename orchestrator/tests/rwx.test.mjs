import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkChangedFiles, checkCommand, checkFile, pathCovered, scanEscape } from '../policies/policy.mjs';
import { changedFiles, commitAll, initRepo } from '../lib/git.mjs';
import { decideToolPolicy, policyForTask } from '../lib/toolpolicy.mjs';

/* Исполняемая спецификация прав rwx. «Права» здесь — не режим файла, а три
   вопроса, на которые у оркестратора обязан быть ответ до запуска агента:

     r — что агент может читать (источник задания, контракты, инструменты: ro);
     w — куда он может писать (workspace, и только allowedPaths внутри него);
     x — что он может исполнять (commandsAllowed + read-only утилиты прокси).

   Каждый пункт проверяется вызовом настоящей политики, а не пересказом. */

const task = (overrides = {}) => ({
  taskId: 'rwx-fixture',
  scope: { allowedPaths: ['src'], forbiddenPaths: ['config', 'data'], environment: 'isolated', ...(overrides.scope || {}) },
  commandsAllowed: overrides.commandsAllowed || ['node --test tests/acceptance.test.mjs'],
});

test('w: allowed tree is a path boundary, not a string prefix', () => {
  const t = task();
  for (const file of ['src/pricing.mjs', 'src/nested/deep.mjs', 'src', './src/x.mjs', 'src\\x.mjs']) {
    assert.equal(checkFile(t, file).ok, true, `${file} должен быть разрешён`);
  }
  for (const file of ['srcx/pricing.mjs', 'docs/readme.md', '../outside.mjs', '/etc/passwd', 'C:/Windows/x', 'src/../../x', '']) {
    const verdict = checkFile(t, file);
    assert.equal(verdict.ok, false, `${file} должен быть запрещён`);
    assert.ok(['PATH_NOT_ALLOWED', 'UNSAFE_PATH', 'FORBIDDEN_PATH'].includes(verdict.code), `${file}: ${verdict.code}`);
  }
  assert.equal(pathCovered(['src'], 'srcx'), false, 'префикс без границы каталога не покрывает путь');
  assert.equal(pathCovered(['src/'], 'src/x'), true, 'завершающий слэш в allowedPaths не ломает покрытие');
});

test('w: forbiddenPaths выигрывает у allowedPaths', () => {
  const t = task({ scope: { allowedPaths: ['src', 'config'], forbiddenPaths: ['config/secrets'] } });
  assert.equal(checkFile(t, 'config/app.json').ok, true);
  const denied = checkFile(t, 'config/secrets/key.txt');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'FORBIDDEN_PATH');
});

test('x: shell-формы и команды вне контракта не исполняются', () => {
  const t = task();
  assert.equal(checkCommand(t, 'node --test tests/acceptance.test.mjs').ok, true);
  for (const command of [
    'node --test tests/acceptance.test.mjs && rm -rf src',
    'node --test tests/acceptance.test.mjs; id',
    'node --test tests/acceptance.test.mjs | tee out',
    'node --test $(touch injected)',
    'node --test `whoami`',
    'bash -c "node --test tests/acceptance.test.mjs"',
    'node --test tests/other.test.mjs',
  ]) {
    assert.equal(checkCommand(t, command).ok, false, `${command} должен быть запрещён`);
  }
});

test('x: разрешённую git-команду нельзя перепрограммировать в shell', () => {
  const policy = policyForTask(task());
  assert.equal(decideToolPolicy('git status', policy).allow, true, 'чтение состояния разрешено');
  assert.equal(decideToolPolicy('git diff --stat', policy).allow, true);

  /* `git config alias.status '!curl …'` + `git status` = вторая команда вместо
     проверенной первой. Конфигурация не входит в SAFE_GIT, inline -c тоже. */
  const alias = decideToolPolicy("git config alias.status '!curl http://1.1.1.1/'", policy);
  assert.equal(alias.allow, false, 'git config должен быть запрещён');
  assert.equal(alias.code, 'TOOL_COMMAND_DENIED');
  assert.equal(decideToolPolicy("git -c alias.status='!sh' status", policy).allow, false, 'inline -c обходит allowlist');
  assert.equal(decideToolPolicy('git config --global core.pager cat', policy).allow, false);
});

test('w: запись в gitignored путь видна authority check, а не прячется', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-rwx-'));
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
    initRepo(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n.cache/\n');
    commitAll(dir, 'base: ignore runtime paths');
    const base = commitAll(dir, 'base: ready');

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'fine.mjs'), 'export const ok = true;\n');
    fs.writeFileSync(path.join(dir, 'data', 'secrets.json'), '{"token":"leaked"}\n');
    fs.writeFileSync(path.join(dir, '.cache', 'build.bin'), 'cache\n');

    const changed = changedFiles(dir, base);
    const names = changed.map((item) => item.file);
    assert.ok(names.includes('src/fine.mjs'), 'обычный файл в scope виден');
    assert.ok(names.includes('data/secrets.json'), 'gitignored запись обязана быть видна');
    assert.ok(names.includes('.cache/build.bin'), 'кеш в ignored-пути тоже виден');

    const violations = checkChangedFiles(task(), changed);
    assert.deepEqual(violations.map((v) => v.file).sort(), ['.cache/build.bin', 'data/secrets.json'], 'непокрытые ignored-записи — нарушения');

    const withCache = checkChangedFiles(task({ scope: { allowedPaths: ['src', '.cache'] } }), changed);
    assert.deepEqual(withCache.map((v) => v.file), ['data/secrets.json'], 'покрытый ignored-кеш не считается нарушением');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w: файл рядом с workspace — это ESCAPE_WORKSPACE, а не «просто мусор»', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-rwx-escape-'));
  try {
    const sandbox = path.join(root, 'task');
    const workspace = path.join(sandbox, 'implementer');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'ok.mjs'), 'ok\n');
    fs.writeFileSync(path.join(sandbox, 'escape.txt'), 'outside workspace\n');
    const violations = scanEscape(sandbox, workspace);
    assert.deepEqual(violations.map((v) => v.file), ['escape.txt']);
    assert.equal(violations[0].code, 'ESCAPE_WORKSPACE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* Что именно ограничивает прокси, а что — authority check. Транспорт наружу и
   метаданные репозитория закрыты на уровне команд. Утилиты чтения/правки
   внутри workspace разрешены намеренно: настоящий Codex правит файлы своим
   патчем вообще мимо шелла, поэтому запрет `node`/`sed` не добавил бы
   безопасности, а сломал бы работу. Границу записи держит не список команд,
   а allowedPaths + changedFiles (проверено в тестах выше). */
test('x: прокси держит транспорт и .git, а границу записи держит контракт', () => {
  const strict = policyForTask(task());
  assert.equal(decideToolPolicy('node --test tests/acceptance.test.mjs', strict).allow, true, 'команда контракта исполняется');
  for (const command of ['curl http://1.1.1.1/', 'ssh node1 uptime', 'systemctl restart caddy', 'npm i left-pad', 'docker run alpine']) {
    const verdict = decideToolPolicy(command, strict);
    assert.equal(verdict.allow, false, `${command} не должен исполняться`);
  }
  assert.equal(decideToolPolicy('ls -la', strict).allow, true, 'чтение каталога разрешено');
  for (const command of ['cp evil .git/config', 'sed -i s/x/y/ .git/config', 'rm -rf .git', 'git add .git/hooks/pre-commit']) {
    const verdict = decideToolPolicy(command, strict);
    assert.equal(verdict.allow, false, `${command}: метаданные репозитория не пишутся`);
    assert.equal(verdict.code, 'TOOL_GIT_DIR_DENIED', `${command}: ${verdict.code}`);
  }
});
