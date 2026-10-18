// Installer acceptance: temporary data directories, loopback only, no agent keys
// or production process is used. Every started process is stopped by its handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  configureAgentNode, startAgentNode, statusAgentNode, portableLaunchers,
  checkoutGenesisHash, CHECKOUT_ROOT,
} from '../tools/agent-node-setup.mjs';
const exec = promisify(execFile);
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agt-node-setup-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await ended; } finally { clearTimeout(force); }
}
async function request(url, route) {
  const r = await fetch(url + route, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(r.status, 200); return r.json();
}

test('temporary node start/status/restart preserves data and never inherits operator settings', async t => {
  const dir = await temp(t), configPath = path.join(dir, 'setup.json');
  const configured = await configureAgentNode({ configPath, role: 'issuer', siteSync: false });
  assert.match(configured.nodeUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(config.port >= 1024, true); assert.equal(config.genesisHash, checkoutGenesisHash());
  assert.equal((await statusAgentNode({ configPath })).running, false);
  const inherited = { AGT_BIND: '100.64.0.8', AGT_DATA_DIR: path.join(dir, 'operator-data'), AGT_IDENTITY_ROLE: 'replica',
    AGT_ADMIN_TOKEN: 'operator-token-must-not-be-inherited', AGT_TRUSTED_ISSUERS_FILE: 'missing-operator-trust.json',
    AGT_BOOTSTRAP_FILE: 'missing-operator-bootstrap.json', NODE_OPTIONS: '--this-option-must-not-reach-child' };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]])); Object.assign(process.env, inherited);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const first = await startAgentNode({ configPath, healthDeadlineMs: 15000 }); t.after(() => stop(first.child));
  assert.equal(first.report.running, true); assert.equal(first.report.chainValid, true); assert.equal(first.report.localConnection, 'connected');
  assert.equal(first.report.genesisHash, configured.genesisHash);
  assert.deepEqual((await request(configured.nodeUrl, '/peers/bootstrap')).bootstrap, []);
  await assert.rejects(fs.stat(inherited.AGT_DATA_DIR), { code: 'ENOENT' });
  const status = await statusAgentNode({ configPath }); assert.equal(status.running, true); assert.equal(status.configuredIdentityMatches, true);
  const already = await startAgentNode({ configPath }); assert.equal(already.child, null); assert.equal(already.report.pid, first.child.pid);
  const issuerFile = path.join(config.dataDir, 'identity', 'identity-issuer.json');
  const issuerBefore = await fs.readFile(issuerFile, 'utf8');
  const chainBefore = await fs.readFile(path.join(config.dataDir, 'chain.json'), 'utf8');
  const cabinetBefore = await fs.readFile(config.cabinetConfigPath, 'utf8');
  await fs.writeFile(path.join(config.dataDir, 'preserved-marker.txt'), 'synthetic-existing-data');
  assert.equal(JSON.stringify(first.report).includes('operator-token'), false);
  assert.equal(JSON.stringify(first.report).includes(JSON.parse(await fs.readFile(config.adminTokenFile, 'utf8')).token), false);
  await stop(first.child); assert.equal((await statusAgentNode({ configPath })).running, false);
  const restarted = await startAgentNode({ configPath, healthDeadlineMs: 15000 }); t.after(() => stop(restarted.child));
  assert.equal(restarted.report.localConnection, 'preserved_existing_config');
  assert.equal(await fs.readFile(issuerFile, 'utf8'), issuerBefore);
  assert.equal(await fs.readFile(path.join(config.dataDir, 'chain.json'), 'utf8'), chainBefore);
  assert.equal(await fs.readFile(path.join(config.dataDir, 'preserved-marker.txt'), 'utf8'), 'synthetic-existing-data');
  assert.equal(await fs.readFile(config.cabinetConfigPath, 'utf8'), cabinetBefore);
  await assert.rejects(fs.stat(path.join(config.dataDir, 'wallets.json')), { code: 'ENOENT' });
  await assert.rejects(configureAgentNode({ configPath, role: 'issuer', siteSync: false }), /already_configured/);
  if (process.platform !== 'win32') {
    for (const file of [configPath, config.bootstrapFile, config.trustFile, config.monitorFile, config.adminTokenFile, config.cabinetConfigPath]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(config.dataDir)).mode & 0o777, 0o700);
  }
});

test('replica requires an explicit trusted operator and connects only the chosen peer', async t => {
  const dir = await temp(t), issuerConfig = path.join(dir, 'issuer', 'setup.json');
  await configureAgentNode({ configPath: issuerConfig, role: 'issuer', siteSync: false });
  const issuer = await startAgentNode({ configPath: issuerConfig, healthDeadlineMs: 15000 }); t.after(() => stop(issuer.child));
  const meta = await request(issuer.report.nodeUrl, '/identity/meta');
  const trustFile = path.join(dir, 'operator-public-keys.json'); await fs.writeFile(trustFile, JSON.stringify([meta.issuerPub]));
  const configPath = path.join(dir, 'replica', 'setup.json');
  await assert.rejects(configureAgentNode({ configPath, siteSync: false }), /requires_trusted_issuer/);
  await assert.rejects(configureAgentNode({ configPath, trustFile, operatorIssuerFingerprint: 'sha256:' + 'f'.repeat(64), siteSync: false }), /pin_not_in_trust_file/);
  await configureAgentNode({ configPath, trustFile, operatorIssuerFingerprint: meta.issuerFingerprint, peerUrl: issuer.report.nodeUrl, siteSync: false });
  const replica = await startAgentNode({ configPath, healthDeadlineMs: 15000 }); t.after(() => stop(replica.child));
  const replicaMeta = await request(replica.report.nodeUrl, '/identity/meta');
  assert.equal(replicaMeta.role, 'replica'); assert.equal(replicaMeta.enrollmentEnabled, false);
  assert.equal(replicaMeta.passportIssuerFingerprint, meta.issuerFingerprint);
  assert.notEqual(replicaMeta.issuerFingerprint, meta.issuerFingerprint);
  assert.deepEqual((await request(replica.report.nodeUrl, '/peers/bootstrap')).bootstrap, [issuer.report.nodeUrl]);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const cabinet = JSON.parse(await fs.readFile(config.cabinetConfigPath, 'utf8'));
  assert.equal(cabinet.nodeUrl, replica.report.nodeUrl); assert.equal(cabinet.passportIssuerFingerprint, meta.issuerFingerprint);
});

test('invalid settings and an occupied port fail without killing or rewriting anything', async t => {
  const dir = await temp(t), configPath = path.join(dir, 'setup.json');
  for (const bad of [{ port: -1 }, { port: 80 }, { port: 65536 }, { port: '9335' }, { bind: '0.0.0.0' },
    { bind: '100.64.0.8' }, { role: 'operator' }, { expectedGenesisHash: '0'.repeat(64) },
    { expectedCheckoutSha: '0'.repeat(40) }, { peerUrl: 'http://user:pass@localhost:9335' }, { peerUrl: 'http://localhost:9335/path' }]) {
    await assert.rejects(configureAgentNode({ configPath, role: 'issuer', siteSync: false, ...bad }));
  }
  await assert.rejects(configureAgentNode({ configPath: path.join(CHECKOUT_ROOT, 'forbidden-setup.json'), role: 'issuer' }), /outside_checkout/);
  await assert.rejects(fs.stat(configPath), { code: 'ENOENT' });
  const occupied = net.createServer(); await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  await assert.rejects(configureAgentNode({ configPath, role: 'issuer', port: occupied.address().port, siteSync: false }));
  assert.equal(occupied.listening, true);
  await configureAgentNode({ configPath, role: 'issuer', siteSync: false });
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const portOwner = net.createServer(socket => socket.destroy()); await new Promise(resolve => portOwner.listen(config.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => portOwner.close(resolve)));
  const bytes = await fs.readFile(configPath, 'utf8');
  await assert.rejects(startAgentNode({ configPath, healthDeadlineMs: 1000 }));
  assert.equal(portOwner.listening, true); assert.equal(await fs.readFile(configPath, 'utf8'), bytes);
});

test('portable launcher quoting keeps special paths literal', async t => {
  const dir = await temp(t), probe = path.join(dir, 'argv-probe.mjs');
  await fs.writeFile(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const configPath = path.join(dir, "agent 'quoted' 100% & ; echo unsafe", 'setup.json');
  const launcher = portableLaunchers(configPath, { executable: process.execPath, script: probe });
  assert.match(launcher.cmd, /DisableDelayedExpansion/); assert.match(launcher.cmd, /100%%/);
  if (process.platform !== 'win32') {
    const script = path.join(dir, 'launcher.sh'); await fs.writeFile(script, launcher.sh, { mode: 0o700 });
    const result = await exec('sh', [script], { timeout: 5000 }); assert.deepEqual(JSON.parse(result.stdout), ['start', configPath]);
  }
  await assert.rejects(configureAgentNode({ configPath: path.join(dir, 'bad\npath', 'setup.json'), role: 'issuer' }), /invalid_setup_path/);
});
