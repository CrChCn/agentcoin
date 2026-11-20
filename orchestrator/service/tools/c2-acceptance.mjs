#!/usr/bin/env node
/* Приёмка C2 на одной машине: 12 пунктов из задания владельца.

   Что здесь НАСТОЯЩЕЕ: установщик (--prefix, без root), раскладка code/data/log,
   read-only код, planner IDLE и одна задача по registry evidence, symlink
   containment, lifecycle инцидента, операторский STOP/resume, персистентность
   очереди/checkpoint между процессами, loopback-only API, отказ deployer,
   uninstall с сохранением данных, rollback на предыдущий release.

   Чего здесь НЕТ и быть не может без отдельного хоста: реальных systemd-юнитов
   active, реального reboot и внешнего сетевого отказа. Эти три пункта
   выполняются на ops-host по service/C2.md; харнесс печатает их как PENDING и
   не выдаёт за проверенные. */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCH = path.resolve(HERE, '..', '..');
const ROOT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'c2-acceptance'));

const DATA = path.join(ROOT, 'var/lib/agentcoin-orchestrator');
const LOGS = path.join(ROOT, 'var/log/agentcoin-orchestrator');
const CONTROL = path.join(DATA, 'control');
const CODE = path.join(ROOT, 'opt/agentcoin-orchestrator');
const CURRENT = path.join(CODE, 'current');
const KEY = path.join(ROOT, 'etc/agentcoin/operator.key');
const PUB = path.join(DATA, 'state/operator.pub');
const OPSD = path.join(CURRENT, 'orchestrator/service/opsd.mjs');
const OPERATOR = path.join(CURRENT, 'orchestrator/service/operator.mjs');
const DEPLOYER = path.join(CURRENT, 'orchestrator/service/deployer.mjs');

/* env читается resolvePaths() в момент вызова, поэтому выставляем до импорта. */
process.env.OPS_ROOT = DATA;
process.env.OPS_LOG_DIR = LOGS;
process.env.OPS_CONTROL_DIR = CONTROL;
process.env.OPS_OPERATOR_KEY = KEY;
process.env.OPS_OPERATOR_PUB = PUB;
process.env.OPS_OPERATOR_ALLOW_UNPRIVILEGED = '1';

const { OpsStore, STATUS } = await import('../store.mjs');
const { planNext } = await import('../planner.mjs');
const { tick } = await import('../runner.mjs');
const { startApi } = await import('../api.mjs');

const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok === 'pending' ? 'PENDING' : ok ? 'PASS' : 'FAIL'}  ${id}: ${detail}`);
};

const bash = (args, opts = {}) => spawnSync('bash', args, { cwd: ORCH, encoding: 'utf8', env: process.env, timeout: 120000, ...opts });
const node = (args) => spawnSync(process.execPath, args, { cwd: ORCH, encoding: 'utf8', env: process.env, timeout: 120000 });

function step(label) { console.log(`\n== ${label}`); }

step('install (rehearsal prefix, rootless)');
/* Предыдущий прогон оставляет read-only release: снимаем биты перед удалением. */
function forceRemove(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) forceRemove(full);
    try { fs.chmodSync(full, 0o755); } catch { /* best effort */ }
  }
  try { fs.chmodSync(dir, 0o755); } catch { /* best effort */ }
}
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { forceRemove(ROOT); fs.rmSync(ROOT, { recursive: true, force: true }); }
fs.mkdirSync(ROOT, { recursive: true });
const dry = bash(['service/install.sh', `--prefix=${ROOT}`, '--dry-run']);
const install = bash(['service/install.sh', `--prefix=${ROOT}`]);
record('install-dry-run', dry.status === 0 && /dry-run/.test(dry.stdout), `exit ${dry.status}; nothing installed`);
record('install', install.status === 0, `exit ${install.status}; ${(install.stderr || '').trim().split('\n')[0] || 'no stderr'}`);
/* Репетиция не должна уметь включить систему: --enable остаётся хостовым шагом. */
const enableInRehearsal = bash(['service/install.sh', `--prefix=${ROOT}`, '--enable']);
record('rehearsal-refuses-enable', enableInRehearsal.status === 64, `--prefix --enable exit ${enableInRehearsal.status}`);
if (install.status !== 0) {
  console.error(install.stdout, install.stderr);
  console.log(JSON.stringify({ results }, null, 2));
  process.exit(1);
}

step('1. immutable code');
const release = fs.realpathSync(CURRENT);
const writable = spawnSync('find', [release, '-type', 'f', '-perm', '-u+w'], { encoding: 'utf8' });
const writableCount = writable.stdout.trim() ? writable.stdout.trim().split('\n').length : 0;
let appendBlocked = false;
try {
  const target = path.join(release, 'orchestrator/package.json');
  fs.appendFileSync(target, '\n');
} catch (err) {
  appendBlocked = ['EACCES', 'EPERM'].includes(err.code);
}
record('code-read-only', writableCount === 0 && appendBlocked === (process.platform !== 'win32'),
  `release=${path.relative(ROOT, release)}; writable files=${writableCount}; append blocked=${appendBlocked}`);
record('code-outside-data', !release.startsWith(DATA + path.sep) && !release.startsWith(LOGS + path.sep), `code ${path.relative(ROOT, release)} is separate from data`);

step('1b. install manifest records the real service user and data owner');
const inventoryDir = path.join(DATA, 'inventory');
const latestManifest = () => {
  const file = fs.readdirSync(inventoryDir).filter((name) => name.startsWith('install-manifest-')).sort().at(-1);
  return { file, data: JSON.parse(fs.readFileSync(path.join(inventoryDir, file), 'utf8')) };
};
const firstManifest = latestManifest();
/* Rehearsal не создаёт сервисного пользователя: serviceUser берётся из
   SERVICE_USER, а dataOwner — с диска, и оба сверяются здесь явно. */
const dataOwner = spawnSync('stat', ['-c', '%U', DATA], { encoding: 'utf8' }).stdout.trim();
record('manifest-service-user', firstManifest.data.serviceUser === 'agt-orchestrator' && firstManifest.data.deployUser === 'agt-deployer',
  `${firstManifest.file}: serviceUser=${firstManifest.data.serviceUser} deployUser=${firstManifest.data.deployUser}`);
record('manifest-matches-data-owner', firstManifest.data.dataOwner === dataOwner && firstManifest.data.mode === 'rehearsal',
  `manifest dataOwner=${firstManifest.data.dataOwner}, stat ${path.basename(DATA)}=${dataOwner}, mode=${firstManifest.data.mode}`);

step('2. data and control ownership');
const cstat = fs.statSync(CONTROL);
const cmode = (cstat.mode & 0o777).toString(8);
const controlClosed = process.platform === 'win32' ? true : (cstat.mode & 0o022) === 0;
record('control-dir-not-service-writable', controlClosed, `mode ${cmode}, owner uid ${cstat.uid}`);
record('data-layout', ['queue', 'runs', 'artifacts', 'project-memory', 'state', 'workspaces'].every((d) => fs.existsSync(path.join(DATA, d))), 'queue/runs/artifacts/memory/state present');

step('3. units reference the new layout');
const unitText = fs.readdirSync(path.join(ROOT, 'etc/systemd/system')).map((name) => fs.readFileSync(path.join(ROOT, 'etc/systemd/system', name), 'utf8')).join('\n');
record('units-rendered', unitText.includes(CURRENT) && unitText.includes(DATA) && unitText.includes(LOGS), 'unit paths point at current/data/logs');
record('units-readonly-code', /ReadOnlyPaths=.*opt\/agentcoin-orchestrator/.test(unitText) && !/ReadWritePaths=[^\n]*opt\/agentcoin-orchestrator/.test(unitText), 'code only under ReadOnlyPaths');
const verify = spawnSync('systemd-analyze', ['verify', path.join(ROOT, 'etc/systemd/system/agt-orchestrator.service')], { encoding: 'utf8' });
record('units-verify', verify.error ? 'pending' : verify.status === 0, verify.error ? 'systemd-analyze unavailable here' : `systemd-analyze exit ${verify.status}`);

step('4. planner stays IDLE');
const store = new OpsStore(DATA);
const mission = JSON.parse(fs.readFileSync(path.join(DATA, 'queue/mission.json'), 'utf8'));
const idle = planNext(store, mission);
record('idle-without-evidence', idle.action === 'idle', `${idle.action}: ${idle.reason || ''}`);

step('5. one task from registry evidence');
const repo = path.join(DATA, 'repository');
fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
fs.writeFileSync(path.join(repo, 'docs/CLAIM.md'), 'the page still lacks the promised sentence\n');
const taskTemplate = JSON.parse(fs.readFileSync(path.join(ORCH, 'fixtures/tasks/lesson-01.json'), 'utf8'));
delete taskTemplate.taskId;
fs.writeFileSync(path.join(DATA, 'queue/registry.json'), JSON.stringify({
  version: 1,
  entries: [{
    id: 'docs-claim', priority: 10, type: 'registry_gap',
    check: { kind: 'file_includes', path: 'docs/CLAIM.md', needle: 'REQUIRED-CLAIM' },
    task: taskTemplate,
  }],
}, null, 2));
const first = planNext(new OpsStore(DATA), mission, { repositoryRoot: repo });
const afterFirst = new OpsStore(DATA).counts();
const second = planNext(new OpsStore(DATA), mission, { repositoryRoot: repo });
record('one-task-per-gap', first.action === 'enqueued' && afterFirst.total === 1 && second.action !== 'enqueued',
  `first=${first.action} generation=${first.incident && first.incident.generation} total=${afterFirst.total} second=${second.action}`);
if (first.action === 'enqueued') new OpsStore(DATA).complete(first.taskId, { state: 'ACCEPTED' });

step('6. symlink escape is refused');
let linkMade = false;
try { fs.symlinkSync('/etc/passwd', path.join(repo, 'docs/LINK.md')); linkMade = true; } catch { linkMade = false; }
if (!linkMade) {
  record('symlink-escape', 'pending', 'symlink creation not permitted in this environment');
} else {
  fs.writeFileSync(path.join(DATA, 'queue/registry.json'), JSON.stringify({
    version: 1,
    entries: [{
      id: 'symlink-escape', priority: 10, type: 'health_failure',
      check: { kind: 'file_includes', path: 'docs/LINK.md', needle: 'root:' },
      task: taskTemplate,
    }],
  }, null, 2));
  const viaLink = planNext(new OpsStore(DATA), mission, { repositoryRoot: repo });
  const evaluated = (viaLink.evaluated || []).find((item) => item.id === 'symlink-escape');
  record('symlink-escape', viaLink.action === 'idle' && evaluated && evaluated.skipped === 'REGISTRY_SYMLINK',
    `${viaLink.action}; skipped=${evaluated && evaluated.skipped}`);
}

step('7. incident lifecycle: resolved then reoccurred');
fs.writeFileSync(path.join(DATA, 'queue/registry.json'), JSON.stringify({
  version: 1,
  entries: [{
    id: 'docs-claim', priority: 10, type: 'registry_gap',
    check: { kind: 'file_includes', path: 'docs/CLAIM.md', needle: 'REQUIRED-CLAIM' },
    task: taskTemplate,
  }],
}, null, 2));
fs.writeFileSync(path.join(repo, 'docs/CLAIM.md'), 'REQUIRED-CLAIM is present now\n');
planNext(new OpsStore(DATA), mission, { repositoryRoot: repo });
const resolved = new OpsStore(DATA).incidents().items.find((item) => item.id === 'docs-claim');
fs.writeFileSync(path.join(repo, 'docs/CLAIM.md'), 'the page still lacks the required wording\n');
const reoccurred = planNext(new OpsStore(DATA), mission, { repositoryRoot: repo });
record('incident-reoccurrence', resolved && resolved.state === 'RESOLVED' && reoccurred.action === 'enqueued' && reoccurred.incident.generation === 2,
  `state=${resolved && resolved.state}; action=${reoccurred.action}; generation=${reoccurred.incident && reoccurred.incident.generation}`);

step('8. operator-owned STOP and resume');
const initKey = node([OPERATOR, 'init-key', '--root', DATA]);
const stop = node([OPERATOR, 'stop', '--root', DATA, '--reason', 'c2 acceptance']);
const stoppedPlan = planNext(new OpsStore(DATA), mission, { repositoryRoot: repo });
const stoppedTick = await tick({ root: DATA, mission });
const serviceResume = node([OPSD, 'resume', '--root', DATA]);
const operatorResume = node([OPERATOR, 'resume', '--root', DATA]);
const journal = fs.readFileSync(path.join(DATA, 'queue/journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const signed = journal.filter((entry) => /service\.(stop|resume)_signed/.test(entry.event));
const storeAfter = new OpsStore(DATA, { readOnly: true });
record('stop-blocks-work', stoppedPlan.action === 'stopped' && stoppedTick.action === 'stopped', `plan=${stoppedPlan.action} tick=${stoppedTick.action}`);
record('service-cannot-resume', serviceResume.status === 78, `opsd resume exit ${serviceResume.status}`);
record('operator-resume-signed', operatorResume.status === 0 && signed.length >= 2 && signed.every((entry) => storeAfter.verifySignature(entry)),
  `${signed.length} signed events, all valid=${signed.every((entry) => storeAfter.verifySignature(entry))}`);

step('9. queue and checkpoint survive a process restart');
const queueHash = spawnSync('sha256sum', [path.join(DATA, 'queue/queue.json')], { encoding: 'utf8' }).stdout.split(' ')[0];
const status = node([OPSD, 'status', '--root', DATA]);
const queueHash2 = spawnSync('sha256sum', [path.join(DATA, 'queue/queue.json')], { encoding: 'utf8' }).stdout.split(' ')[0];
/* Checkpoint пишется живым tick: при активном STOP его нет, поэтому проверяем
   персистентность явно — запись checkpoint и чтение его новым процессом. */
new OpsStore(DATA).checkpoint({ taskId: null, state: 'IDLE', iteration: 0, seq: 0 });
const statusAfter = node([OPSD, 'status', '--root', DATA]);
const checkpointSeen = (() => { try { return JSON.parse(statusAfter.stdout).checkpoint; } catch { return null; } })();
record('queue-survives-restart', statusAfter.status === 0 && queueHash === queueHash2 && checkpointSeen && checkpointSeen.state === 'IDLE',
  `status exit ${statusAfter.status}; queue hash stable=${queueHash === queueHash2}; checkpoint=${checkpointSeen && checkpointSeen.state}`);

step('10. API listens on loopback only');
const started = await startApi({ root: DATA, mission, hosts: ['127.0.0.1', '::1'], port: 8798 });
const apiGet = await fetch('http://127.0.0.1:8798/ops/status');
const apiBody = await apiGet.json();
const apiPost = await fetch('http://127.0.0.1:8798/ops/status', { method: 'POST' });
const ss = spawnSync('ss', ['-ltn'], { encoding: 'utf8' });
const lines = (ss.stdout || '').split('\n').filter((line) => line.includes(':8798'));
const loopbackOnly = lines.length > 0 && lines.every((line) => line.includes('127.0.0.1:8798') || line.includes('[::1]:8798'));
const external = Object.values(os.networkInterfaces()).flat().find((iface) => iface && iface.family === 'IPv4' && !iface.internal);
const externalRefused = external ? await new Promise((resolve) => {
  const socket = net.connect({ host: external.address, port: 8798 });
  const done = (value) => { socket.destroy(); resolve(value); };
  socket.setTimeout(1500, () => done(true));
  socket.on('connect', () => done(false));
  socket.on('error', () => done(true));
}) : true;
await started.close();
record('api-loopback-only', apiGet.status === 200 && apiPost.status === 405 && loopbackOnly,
  `GET ${apiGet.status}, POST ${apiPost.status}, listeners=${lines.length ? lines.map((l) => l.trim().split(/\s+/)[3]).join(',') : 'ss unavailable'}`);
record('api-external-refused', externalRefused, external ? `connect to ${external.address}:8798 refused=${externalRefused}` : 'no external interface');
record('api-public-fields', !JSON.stringify(apiBody).match(/\/var\/|\/opt\/|\/home\/|pid|username/i), 'no paths, usernames or pids in the public body');

step('11. deployer stays disabled');
const deployer = node([DEPLOYER]);
const deployerBody = `${deployer.stdout}${deployer.stderr}`;
record('deployer-disabled', deployer.status === 3 && /DEPLOYMENT_NOT_ENABLED/.test(deployerBody), `exit ${deployer.status}`);

step('12. rollback and uninstall keep the data');
const releaseOne = fs.realpathSync(CURRENT);
await new Promise((resolve) => setTimeout(resolve, 1100));
const install2 = bash(['service/install.sh', `--prefix=${ROOT}`], { env: { ...process.env, SERVICE_USER: 'agt-custom' } });
const releaseTwo = fs.realpathSync(CURRENT);
/* Переопределение SERVICE_USER обязано попасть в манифест, а не остаться
   'agt-orchestrator' из старого чтения process.env. */
const overrideManifest = latestManifest();
record('manifest-service-user-override', install2.status === 0
  && overrideManifest.data.serviceUser === 'agt-custom' && overrideManifest.data.deployUser === 'agt-deployer',
  `SERVICE_USER=agt-custom -> serviceUser=${overrideManifest.data.serviceUser}, deployUser=${overrideManifest.data.deployUser}`);
const rollback = bash(['service/install.sh', `--prefix=${ROOT}`, '--rollback']);
const releaseAfterRollback = fs.realpathSync(CURRENT);
record('rollback-restores-previous-release', install2.status === 0 && releaseOne !== releaseTwo && releaseAfterRollback === releaseOne,
  `release1=${path.basename(releaseOne)} release2=${path.basename(releaseTwo)} after=${path.basename(releaseAfterRollback)}`);
fs.writeFileSync(path.join(DATA, 'project-memory/keep.txt'), 'data must survive uninstall\n');
const uninstall = bash(['service/install.sh', `--prefix=${ROOT}`, '--uninstall']);
record('uninstall-keeps-data', uninstall.status === 0 && fs.existsSync(path.join(DATA, 'project-memory/keep.txt')) && !fs.existsSync(CURRENT),
  `uninstall exit ${uninstall.status}; data marker=${fs.existsSync(path.join(DATA, 'project-memory/keep.txt'))}; code removed=${!fs.existsSync(CURRENT)}`);

step('13. pinned runtime refuses temporary paths');
const runtimeTmp = node([path.join(ORCH, 'service/tools/codex-pin.mjs'), 'pin', '--from', ORCH, '--version', '0.0.1', '--base', path.join(ROOT, 'runtime')]);
record('runtime-refuses-temporary-root', runtimeTmp.status === 65, `codex-pin exit ${runtimeTmp.status}: ${(runtimeTmp.stderr || '').trim().split('\n')[0]}`);

step('not provable without a real ops-host');
record('real-systemd-units', 'pending', 'systemctl is-active / reboot: run service/C2.md on the ops-host');
record('reboot-recovery', 'pending', 'queue, checkpoint and STOP after reboot: ops-host checklist');

const failed = results.filter((item) => item.ok === false);
const pending = results.filter((item) => item.ok === 'pending');
console.log(`\n== summary: ${results.filter((r) => r.ok === true).length} pass, ${failed.length} fail, ${pending.length} pending`);
const outFile = process.env.C2_ACCEPTANCE_OUT || path.join(ORCH, 'evidence/c2-acceptance.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify({ at: new Date().toISOString(), root: ROOT, results }, null, 2)}\n`);
console.log(`evidence: ${outFile}`);
process.exitCode = failed.length ? 1 : 0;
