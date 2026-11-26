// Offline: scripts/rollout-node-update.sh целиком, с заглушками systemctl/curl/
// journalctl в PATH. Проверяем защиту базы, манифест раскатки и откат.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'rollout-node-update.sh');
const md5 = text => crypto.createHash('md5').update(text).digest('hex');
const posix = p => p.split(path.sep).join('/');

// bash ищется по PATH РОДИТЕЛЯ один раз: внутри тестов PATH ограничен заглушками,
// и спавн по имени там уже не разрешится (Windows: где лежит bash.exe).
const BASH = (() => {
  const probe = process.platform === 'win32'
    ? spawnSync('where', ['bash'], { encoding: 'utf8' }).stdout.split(/\r?\n/).find(Boolean)
    : spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  return (probe || 'bash').trim();
})();

const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

// Изолированный стенд: свой src, свой INSTALL_DIR, свой порт и заглушки команд.
function sandbox({ src = {}, stage = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-rollout-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const install = path.join(dir, 'node');
  const srcDir = path.join(install, 'src');
  const stageDir = path.join(dir, 'stage');
  const state = path.join(dir, 'state');
  for (const d of [bin, srcDir, stageDir, state, path.join(install, 'data'), path.join(dir, 'backups')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // pick_node ищет node в ${INSTALL_DIR}/runtime/*/bin/node — подсовываем шим на настоящий node
  const shimDir = path.join(install, 'runtime', 'v-test', 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  stub(shimDir, 'node', `#!/usr/bin/env bash\nexec "${posix(process.execPath)}" "$@"\n`);

  const stateDir = posix(state);
  stub(bin, 'systemctl', `#!/usr/bin/env bash
STATE="${stateDir}/pid"
case "$1" in
  show) cat "$STATE" 2>/dev/null || echo 100 ;;
  restart) n=$(( $(cat "$STATE" 2>/dev/null || echo 100) + 1 )); echo "$n" > "$STATE" ;;
  is-active) echo active ;;
esac
exit 0
`);
  stub(bin, 'curl', `#!/usr/bin/env bash
echo '{"blocks":1,"tipHash":"0000abcd","tipAgeSec":5,"fresh":true,"chainValid":true}'
`);
  stub(bin, 'journalctl', '#!/usr/bin/env bash\nexit 0\n');

  for (const [name, body] of Object.entries(src)) fs.writeFileSync(path.join(srcDir, name), body);
  for (const [name, body] of Object.entries(stage)) fs.writeFileSync(path.join(stageDir, name), body);

  const env = {
    ...process.env,
    PATH: `${posix(bin)}:/usr/bin:/bin:/usr/local/bin`,
    AGT_SRC: posix(srcDir),
    AGT_INSTALL_DIR: posix(install),
    AGT_UNIT: 'agt-test',
    AGT_PORT: '9555',
    AGT_BACKUP_DIR: posix(path.join(dir, 'backups')),
    // Windows: GNU tar иначе читает «C:/…» как хост:путь. На Linux-раннере флаг безвреден.
    TAR_OPTIONS: '--force-local',
  };
  const run = (args, extra = {}) =>
    spawnSync(BASH, [posix(script), posix(stageDir), ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const rollback = () => spawnSync(BASH, [posix(script)], { encoding: 'utf8', env: { ...env, ROLLBACK: '1' } });
  return { dir, srcDir, stageDir, install, state, run, rollback };
}

const NODE_SRC = '// escrow/payout\nexport const version = 1;\n';
const NODE_NEW = "// escrow/payout\nimport './extra.mjs';\nexport const version = 2;\n";
const EXTRA = "export const extra = true;\n";

function deployed() {
  const box = sandbox({ src: { 'node.mjs': NODE_SRC }, stage: { 'node.mjs': NODE_NEW, 'extra.mjs': EXTRA } });
  const result = box.run([`node.mjs=${md5(NODE_SRC)}`, 'extra.mjs=absent']);
  assert.equal(result.status, 0, result.stderr);
  return box;
}

test('база не совпала: отказ, нода не тронута', () => {
  const box = sandbox({ src: { 'node.mjs': NODE_SRC }, stage: { 'node.mjs': NODE_NEW } });
  const result = box.run([`node.mjs=${md5('что-то другое')}`]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /хост менялся/);
  assert.equal(fs.readFileSync(path.join(box.srcDir, 'node.mjs'), 'utf8'), NODE_SRC);
  assert.deepEqual(fs.readdirSync(box.srcDir), ['node.mjs']);
});

test('absent при существующем файле: отказ', () => {
  const box = sandbox({ src: { 'node.mjs': NODE_SRC }, stage: { 'node.mjs': NODE_NEW } });
  const result = box.run(['node.mjs=absent']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /на хосте уже есть, а база указана как absent/);
  assert.equal(fs.readFileSync(path.join(box.srcDir, 'node.mjs'), 'utf8'), NODE_SRC);
});

test('раскатка: манифест, бэкап и установленные файлы', () => {
  const box = deployed();
  assert.equal(fs.readFileSync(path.join(box.srcDir, 'node.mjs'), 'utf8'), NODE_NEW);
  assert.equal(fs.readFileSync(path.join(box.srcDir, 'extra.mjs'), 'utf8'), EXTRA);

  const manifestName = fs.readdirSync(box.srcDir).find(n => n.startsWith('.rollout-') && n.endsWith('.manifest'));
  assert.ok(manifestName, 'манифест раскатки не создан');
  const lines = fs.readFileSync(path.join(box.srcDir, manifestName), 'utf8').trim().split('\n');
  assert.deepEqual(lines, [`kept node.mjs ${md5(NODE_SRC)}`, 'new extra.mjs']);

  const stamp = manifestName.replace('.rollout-', '').replace('.manifest', '');
  const backup = path.join(box.srcDir, `node.mjs.bak-${stamp}`);
  assert.equal(fs.readFileSync(backup, 'utf8'), NODE_SRC);
  assert.ok(!fs.existsSync(path.join(box.srcDir, `extra.mjs.bak-${stamp}`)), 'для нового файла бэкап не нужен');
  assert.ok(fs.existsSync(path.join(box.dir, 'backups', `agentcoin-update-data-${stamp}.tgz`)), 'нет архива данных');
});

test('откат: возвращает прежний код и убирает новые файлы', () => {
  const box = deployed();
  const result = box.rollback();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /вернул node.mjs/);
  assert.match(result.stdout, /убрал новый extra\.mjs/);
  assert.equal(fs.readFileSync(path.join(box.srcDir, 'node.mjs'), 'utf8'), NODE_SRC);
  assert.ok(!fs.existsSync(path.join(box.srcDir, 'extra.mjs')));
  assert.match(result.stdout, /ОТКАТ ГОТОВ/);
});

test('откат на повреждённом бэкапе: отказ, файлы не меняются', () => {
  const box = deployed();
  const manifestName = fs.readdirSync(box.srcDir).find(n => n.startsWith('.rollout-'));
  const stamp = manifestName.replace('.rollout-', '').replace('.manifest', '');
  fs.writeFileSync(path.join(box.srcDir, `node.mjs.bak-${stamp}`), 'truncated');

  const result = box.rollback();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /бэкап .*повреждён/);
  assert.equal(fs.readFileSync(path.join(box.srcDir, 'node.mjs'), 'utf8'), NODE_NEW, 'нода не должна откатиться на битый бэкап');
  assert.ok(fs.existsSync(path.join(box.srcDir, 'extra.mjs')));
});
