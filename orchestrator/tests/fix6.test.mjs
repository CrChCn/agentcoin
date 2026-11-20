import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ORCH_ROOT, maskNonCode } from '../lib/package.mjs';
import { buildAgentPlan, discardCodexHome, prepareCodexHome } from '../lib/agentsandbox.mjs';
import { detectSandbox } from '../lib/sandbox.mjs';
import { DENY_ATTACKS, SCRIPT_CANARY, attackSpecs } from '../lib/attackmatrix.mjs';
import { parseShellArgs, requestFor, SCRIPT_MODE_DENIED } from '../tools/tool-proxy.mjs';

/* Регрессии fix6. Каждый тест соответствует пункту обязательного ТЗ:
   script-mode (п.1–2), гарантированное удаление (п.3), атаки (п.2). */

test('the proxy accepts only -c/-lc and refuses every script mode', () => {
  assert.deepEqual(parseShellArgs(['-c', 'id']), { mode: 'command', command: 'id' });
  assert.deepEqual(parseShellArgs(['-lc', 'id']), { mode: 'command', command: 'id' });
  assert.deepEqual(parseShellArgs(['-l', '-c', 'id']), { mode: 'command', command: 'id' });
  assert.equal(parseShellArgs(['/run/credentials/codex/auth.json']).mode, 'script');
  assert.equal(parseShellArgs(['--', 'script.sh']).mode, 'script');
  assert.equal(parseShellArgs(['-s']).mode, 'script');
  assert.equal(parseShellArgs([]).mode, 'empty');

  for (const argv of [
    ['/run/credentials/codex/auth.json'],
    ['../outside-script.sh'],
    ['./probes/outside-link.sh'],
    ['--', 'script.sh'],
    ['-s'],
  ]) {
    const request = requestFor(argv);
    assert.equal(request.refuse && request.refuse.code, SCRIPT_MODE_DENIED, `${argv.join(' ')} must be refused`);
    assert.equal(request.command, undefined);
  }
  assert.equal(requestFor(['-c', 'id']).command, 'id');
  assert.equal(requestFor(['-c']).refuse.code, 'EMPTY_COMMAND');
});

/* Прокси не должен читать ни один пользовательский файл: именно readFileSync
   в namespace Codex отдавал содержимое auth.json до политики broker'а. */
test('the proxy module has no filesystem access at all', () => {
  const source = fs.readFileSync(path.join(ORCH_ROOT, 'tools', 'tool-proxy.mjs'), 'utf8');
  /* Комментарии объясняют, что fs тут нет, поэтому проверяется только код. */
  const code = maskNonCode(source);
  assert.equal(/readFileSync|readFile\s*\(|openSync|createReadStream/.test(code), false);
  assert.equal(/from\s+['"]node:fs['"]/.test(code), false);
  assert.equal(/import\s+fs\s+from/.test(code), false);
});

test('the mandatory matrix contains the script-mode attacks', () => {
  for (const id of ['tool-script-auth-json', 'tool-script-auth-json-sh', 'tool-script-parent', 'tool-script-symlink']) {
    assert.equal(DENY_ATTACKS.includes(id), true, `${id} must be mandatory`);
  }
  const specs = attackSpecs({
    authJson: '/run/credentials/codex/auth.json',
    outsideScript: '../outside-script.sh',
    symlinkScript: './probes/outside-link.sh',
  });
  assert.deepEqual(specs['tool-script-auth-json'].argv, ['/bin/bash', '/run/credentials/codex/auth.json']);
  assert.deepEqual(specs['tool-script-auth-json-sh'].argv, ['/bin/sh', '/run/credentials/codex/auth.json']);
  assert.deepEqual(specs['tool-script-parent'].argv, ['/bin/bash', '../outside-script.sh']);
  assert.equal(specs['tool-script-symlink'].expect, 'deny');
  assert.match(SCRIPT_CANARY, /CANARY/);
});

test('the temporary CODEX_HOME with auth.json is removed', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-source-'));
  fs.writeFileSync(path.join(source, 'auth.json'), JSON.stringify({ token: 'fix6-canary-token-value' }));
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('orch-codex-home-')));
  const home = prepareCodexHome({ source });
  assert.equal(home.ok, true);
  assert.equal(fs.existsSync(path.join(home.dir, 'auth.json')), true);

  const removed = discardCodexHome(home.dir);
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(home.dir), false);

  const left = fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('orch-codex-home-'))
    .filter((name) => !before.has(name));
  assert.deepEqual(left, []);
  fs.rmSync(source, { recursive: true, force: true });
});

const sandbox = detectSandbox();
const smokeTested = Boolean(sandbox.available && sandbox.levels && sandbox.levels.smokeTested === true);

test(
  'plan.cleanup removes credentials, scratch, IPC and the broker socket',
  { skip: smokeTested ? false : `no smoke-tested isolation backend: ${sandbox.detail}` },
  () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fix6-plan-'));
    const workspace = path.join(base, 'workspace');
    const credentials = path.join(base, 'orch-codex-home-test');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(credentials, { recursive: true });
    fs.writeFileSync(path.join(credentials, 'auth.json'), JSON.stringify({ token: 'fix6-plan-canary-value' }));

    const plan = buildAgentPlan({
      sandbox,
      workspace,
      logDir: path.join(base, 'logs'),
      credentialsDir: credentials,
      task: { commandsAllowed: [] },
    });
    assert.equal(plan.ok, true, plan.detail);
    const scratch = plan.scratch;
    const ipc = plan.ipcDir;
    assert.equal(fs.existsSync(credentials), true);

    const report = plan.cleanup();
    assert.equal(report.ok, true, JSON.stringify(report.failed));
    assert.equal(report.authCopyRemoved, true);
    assert.equal(fs.existsSync(credentials), false);
    assert.equal(fs.existsSync(scratch), false);
    assert.equal(fs.existsSync(ipc), false);
    assert.equal(fs.existsSync(path.join(ipc, 'broker.sock')), false);

    /* Идемпотентность: повторный вызов не меняет отчёт. */
    assert.deepEqual(plan.cleanup(), report);
    fs.rmSync(base, { recursive: true, force: true });
  },
);
