import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

import { apiKeyMode, buildEnv, codexEnv, gitEnv, runnerEnv, SECRET_NAME } from '../lib/envpolicy.mjs';
import { ISOLATED_RUNNER_UNAVAILABLE, sandboxRun } from '../lib/sandbox.mjs';

const CANARIES = {
  DATABASE_URL: 'postgres://user:canary-db@db.invalid/x',
  SESSION_COOKIE: 'canary-session-cookie',
  AUTH_HEADER: 'Bearer canary-auth',
  OPENAI_API_KEY: 'sk-canary-openai',
  CODEX_API_KEY: 'canary-codex-key',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  AWS_SECRET_ACCESS_KEY: 'canary-aws-secret',
  MNEMONIC: 'canary mnemonic phrase',
  WALLET_PRIVATE_KEY: 'canary-wallet-key',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/canary-user',
  LANG: 'C.UTF-8',
};

test('runner env is built from an allowlist, not inherited', () => {
  const env = runnerEnv({ source: CANARIES, platform: 'linux' });
  assert.equal(env.PATH, CANARIES.PATH);
  assert.equal(env.LANG, 'C.UTF-8');
  for (const name of ['HOME', 'DATABASE_URL', 'SESSION_COOKIE', 'AUTH_HEADER', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY', 'MNEMONIC', 'WALLET_PRIVATE_KEY']) {
    assert.equal(env[name], undefined, `${name} must not reach the runner`);
  }
});

test('a spawned command really receives none of the canaries', () => {
  const env = runnerEnv({ source: CANARIES, platform: process.platform });
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0);
  const seen = JSON.parse(result.stdout);
  for (const name of ['DATABASE_URL', 'SESSION_COOKIE', 'AUTH_HEADER', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY', 'MNEMONIC', 'WALLET_PRIVATE_KEY']) {
    assert.equal(seen[name], undefined, `${name} leaked into the child process`);
  }
});

test('codex env keeps HOME for the session but never provider keys', () => {
  const env = codexEnv({ source: { ...CANARIES, USERPROFILE: '/home/win' }, platform: 'linux' });
  assert.equal(env.HOME, '/home/canary-user');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test('git env uses an isolated HOME instead of the user profile', () => {
  const env = gitEnv({ source: CANARIES, platform: 'linux' });
  assert.ok(env.HOME);
  assert.notEqual(env.HOME, CANARIES.HOME);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
});

test('secret names cover the canary families the denylist missed', () => {
  for (const name of ['DATABASE_URL', 'SESSION_COOKIE', 'AUTH_HEADER', 'MNEMONIC', 'WALLET_PRIVATE_KEY', 'CONNECTION_STRING', 'AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'SSH_PRIVATE_KEY', 'NPM_TOKEN']) {
    assert.ok(SECRET_NAME.test(name), `${name} must be treated as a secret`);
  }
});

test('api key mode is detected and therefore blocked', () => {
  assert.equal(apiKeyMode({ OPENAI_API_KEY: 'sk-x' }).active, true);
  assert.deepEqual(apiKeyMode({ OPENAI_API_KEY: 'sk-x' }).names, ['OPENAI_API_KEY']);
  assert.equal(apiKeyMode({ PATH: '/usr/bin' }).active, false);
});

test('no backend means ISOLATED_RUNNER_UNAVAILABLE, not a silent local run', () => {
  const result = sandboxRun({
    workspace: process.cwd(),
    argv: ['node', '--test', 'nothing.test.mjs'],
    sandbox: { available: false, code: ISOLATED_RUNNER_UNAVAILABLE, detail: 'probe' },
  });
  assert.equal(result.exitCode, 126);
  assert.equal(result.policyCode, ISOLATED_RUNNER_UNAVAILABLE);
  assert.equal(result.sandboxed, false);
});

test('explicit extra values survive the allowlist', () => {
  const env = buildEnv({ source: CANARIES, platform: 'linux', extra: { NO_COLOR: '1', CUSTOM: 'value' } });
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.CUSTOM, 'value');
});
