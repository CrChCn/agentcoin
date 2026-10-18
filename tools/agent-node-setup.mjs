#!/usr/bin/env node
// Installer for an already trusted checkout. No downloads, npm, sudo or shell.
// Agent wallets are deliberately not created here; the encrypted profile CLI
// receives its password separately through stdin.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Blockchain, CHAIN_ID, computeBlockHash } from '../core.mjs';
import { canonicalAgentPublicKey, issuerFingerprint } from '../agent-identity.mjs';
import { connectCabinet } from '../agt-skill/cabinet-client.mjs';

const exec = promisify(execFile);
export const CHECKOUT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_SETUP_PATH = path.join(os.homedir(), '.agentcoin', 'nodes', 'default', 'setup.json');
const MAX_FILE = 128 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code) { throw new Error(code); }
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function sameOrBelow(parent, candidate) { const rel = path.relative(parent, candidate); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
function nodeVersion() { if (Number(process.versions.node.split('.')[0]) < 24) fail('node_24_or_newer_required'); }
function fp(v) { return typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v); }
function safePath(value) {
  if (typeof value !== 'string' || !value || /[\r\n\u0000"]/.test(value)) fail('invalid_setup_path');
  return path.resolve(value);
}
async function realAncestors(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try { const st = await fsp.lstat(current); if (!st.isDirectory() || st.isSymbolicLink()) fail('setup_directory_must_be_real'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const next = path.dirname(current); if (next === current) return; current = next;
  }
}
async function privateDir(dir) {
  await realAncestors(dir); await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fsp.lstat(dir);
  if (!st.isDirectory() || (process.platform !== 'win32' && (st.mode & 0o077))) fail('setup_directory_must_be_0700');
}
async function writePrivate(file, value, { overwrite = false, executable = false, raw = false } = {}) {
  file = safePath(file); const dir = path.dirname(file); await privateDir(dir);
  const temp = path.join(dir, '.agent-node-' + crypto.randomBytes(10).toString('hex'));
  let h;
  try {
    h = await fsp.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), executable ? 0o700 : 0o600);
    await h.writeFile(raw ? value : JSON.stringify(value, null, 2) + '\n'); await h.sync(); await h.close(); h = null;
    if (overwrite) {
      try { const st = await fsp.lstat(file); if (!st.isFile() || st.isSymbolicLink()) fail('setup_file_must_be_regular'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fsp.rename(temp, file);
    } else await fsp.link(temp, file);
    if (process.platform !== 'win32') { const d = await fsp.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } }
  } catch (e) { if (e.code === 'EEXIST') fail('setup_file_already_exists'); throw e; }
  finally { await h?.close().catch(() => {}); await fsp.unlink(temp).catch(() => {}); }
}
async function readJSON(file, { privateFile = true } = {}) {
  file = safePath(file); await realAncestors(path.dirname(file));
  const st = await fsp.lstat(file);
  if (!st.isFile() || st.isSymbolicLink()) fail('setup_file_must_be_regular');
  const h = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await h.stat();
    if (!opened.isFile() || opened.size > MAX_FILE || (privateFile && process.platform !== 'win32' && (opened.mode & 0o077))) fail('invalid_setup_file_permissions_or_size');
    const buf = Buffer.alloc(MAX_FILE + 1); const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_FILE) fail('setup_file_too_large');
    return JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
  } finally { await h.close(); }
}
function peerOrigin(value) {
  let u; try { u = new URL(value); } catch { fail('invalid_peer_url'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) fail('invalid_peer_url');
  return u.origin;
}
async function choosePort(port = 0) {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) fail('invalid_node_port');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const selected = server.address().port; await new Promise(resolve => server.close(resolve)); return selected;
}
export function checkoutGenesisHash() {
  // Reuse the trusted checkout's exact deterministic genesis implementation in
  // memory, without constructing Blockchain (which would create data files).
  const memory = { chain: [], save() {} };
  Blockchain.prototype.createGenesis.call(memory);
  return computeBlockHash(memory.genesisHeader);
}
async function checkoutSHA() {
  try { const r = await exec('git', ['rev-parse', 'HEAD'], { cwd: CHECKOUT_ROOT, timeout: 5000, windowsHide: true }); return r.stdout.trim(); }
  catch { return null; }
}
function shQuote(value) { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
function cmdQuote(value) { if (/["\r\n\u0000]/.test(value)) fail('invalid_launcher_path'); return '"' + value.replaceAll('%', '%%') + '"'; }
export function portableLaunchers(configPath, { executable = process.execPath, script = fileURLToPath(import.meta.url) } = {}) {
  for (const value of [configPath, executable, script]) safePath(value);
  return {
    sh: '#!/bin/sh\nexec ' + [executable, script, 'start', configPath].map(shQuote).join(' ') + '\n',
    cmd: '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' + [executable, script, 'start', configPath].map(cmdQuote).join(' ') + '\r\nexit /b %errorlevel%\r\n',
  };
}
async function trustKeys(trustFile, pin) {
  if (!trustFile || !fp(pin)) fail('replica_requires_trusted_issuer_file_and_pin');
  const keys = await readJSON(trustFile, { privateFile: false });
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 100) fail('invalid_trusted_issuer_file');
  const normalized = keys.map(canonicalAgentPublicKey);
  if (!normalized.some(pub => issuerFingerprint(pub) === pin)) fail('operator_issuer_pin_not_in_trust_file');
  return [...new Set(normalized)];
}
function validateConfig(c, configPath) {
  if (!object(c) || c.version !== 1 || c.checkoutDir !== path.resolve(CHECKOUT_ROOT) ||
      c.installDir !== path.dirname(safePath(configPath)) || c.dataDir !== path.join(c.installDir, 'node-data') ||
      c.bind !== '127.0.0.1' || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535 ||
      c.network !== CHAIN_ID || !/^[a-f0-9]{64}$/.test(c.genesisHash) || !['issuer', 'replica'].includes(c.role) ||
      typeof c.siteSync !== 'boolean' || c.nodeUrl !== `http://127.0.0.1:${c.port}` ||
      c.trustFile !== path.join(c.installDir, 'trusted-issuers.json') || c.bootstrapFile !== path.join(c.installDir, 'bootstrap.json') ||
      c.monitorFile !== path.join(c.installDir, 'monitor-targets.json') || c.adminTokenFile !== path.join(c.installDir, 'admin-service.json') ||
      c.cabinetConfigPath !== path.join(c.installDir, 'cabinet-node.json') || !Array.isArray(c.peers) || c.peers.length > 1) fail('invalid_node_setup');
  if (sameOrBelow(path.resolve(CHECKOUT_ROOT), c.installDir)) fail('node_state_must_be_outside_checkout');
  if (c.peers.some(peer => peerOrigin(peer) !== peer || peer === c.nodeUrl)) fail('invalid_setup_peer');
  if (c.role === 'replica' && !fp(c.operatorIssuerFingerprint)) fail('replica_requires_operator_pin');
  if (c.expectedCheckoutSha !== null && !/^[a-f0-9]{40}$/.test(c.expectedCheckoutSha)) fail('invalid_checkout_pin');
  return c;
}

export async function configureAgentNode({ configPath = DEFAULT_SETUP_PATH, port = 0, bind = '127.0.0.1', role = 'replica',
  trustFile, operatorIssuerFingerprint, peerUrl, expectedGenesisHash, expectedCheckoutSha = null, siteSync = true } = {}) {
  nodeVersion(); configPath = safePath(configPath); const installDir = path.dirname(configPath);
  if (sameOrBelow(path.resolve(CHECKOUT_ROOT), installDir)) fail('node_state_must_be_outside_checkout');
  if (bind !== '127.0.0.1') fail('installer_supports_loopback_bind_only');
  if (!['issuer', 'replica'].includes(role)) fail('invalid_identity_role');
  if (typeof siteSync !== 'boolean') fail('invalid_site_sync');
  if (role === 'issuer' && (trustFile !== undefined || operatorIssuerFingerprint !== undefined)) fail('self_operator_role_uses_its_own_issuer');
  const keys = role === 'replica' ? await trustKeys(trustFile, operatorIssuerFingerprint) : [];
  const sourceSHA = await checkoutSHA();
  if (expectedCheckoutSha !== null && (!/^[a-f0-9]{40}$/.test(expectedCheckoutSha) || expectedCheckoutSha !== sourceSHA)) fail('checkout_version_mismatch');
  const genesisHash = checkoutGenesisHash();
  if (expectedGenesisHash !== undefined && expectedGenesisHash !== genesisHash) fail('checkout_genesis_mismatch');
  const selected = await choosePort(port);
  const nodeUrl = `http://127.0.0.1:${selected}`;
  const peers = peerUrl === undefined ? [] : [peerOrigin(peerUrl)];
  if (peers.includes(nodeUrl)) fail('peer_cannot_be_self');
  await privateDir(installDir);
  try { await fsp.lstat(configPath); fail('node_already_configured'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const c = { version: 1, checkoutDir: path.resolve(CHECKOUT_ROOT), checkoutSha: sourceSHA, expectedCheckoutSha,
    installDir, dataDir: path.join(installDir, 'node-data'), bind, port: selected, nodeUrl, network: CHAIN_ID,
    genesisHash, role, operatorIssuerFingerprint: role === 'replica' ? operatorIssuerFingerprint : null, siteSync, peers,
    trustFile: path.join(installDir, 'trusted-issuers.json'), bootstrapFile: path.join(installDir, 'bootstrap.json'),
    monitorFile: path.join(installDir, 'monitor-targets.json'), adminTokenFile: path.join(installDir, 'admin-service.json'),
    cabinetConfigPath: path.join(installDir, 'cabinet-node.json') };
  await privateDir(c.dataDir);
  await writePrivate(c.trustFile, keys);
  await writePrivate(c.bootstrapFile, { bootstrap: peers, note: 'Only explicitly configured peers for this agent node.' });
  await writePrivate(c.monitorFile, peers.map(url => ({ name: 'Configured peer', url })));
  await writePrivate(c.adminTokenFile, { version: 1, token: crypto.randomBytes(32).toString('hex') });
  const launchers = portableLaunchers(configPath);
  await writePrivate(path.join(installDir, 'start-node.sh'), launchers.sh, { raw: true, executable: true });
  await writePrivate(path.join(installDir, 'start-node.cmd'), launchers.cmd, { raw: true });
  await writePrivate(configPath, c);
  return { ok: true, configured: true, configPath, nodeUrl, role, genesisHash, checkoutSha: sourceSHA,
    preferredCabinetConfig: c.cabinetConfigPath, next: 'start; then create/unlock your own encrypted agent profile and enroll at the pinned issuer' };
}
async function jsonGET(url, timeout = 2000) {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!r.ok) fail('node_probe_rejected');
  const text = await r.text(); if (text.length > MAX_FILE) fail('node_probe_too_large');
  return JSON.parse(text);
}
async function verifiedNode(c) {
  const info = await jsonGET(c.nodeUrl + '/info');
  if (info.chainId !== c.network || info.genesisHash !== c.genesisHash) fail('running_node_network_or_genesis_mismatch');
  const health = await jsonGET(c.nodeUrl + '/health');
  if (health.ok !== true || health.service !== 'agt-node') fail('invalid_node_health');
  const meta = await jsonGET(c.nodeUrl + '/identity/meta');
  if (meta.network !== c.network || meta.issuerFingerprint !== issuerFingerprint(meta.issuerPub) || meta.role !== c.role) fail('running_node_identity_mismatch');
  if (c.role === 'replica' && (meta.enrollmentEnabled !== false || meta.passportIssuerFingerprint !== c.operatorIssuerFingerprint || !meta.trustedIssuers?.includes(c.operatorIssuerFingerprint))) fail('running_node_operator_pin_mismatch');
  return { info, health, meta };
}
async function readConfig(configPath) {
  nodeVersion(); return validateConfig(await readJSON(configPath), configPath);
}
export async function statusAgentNode({ configPath = DEFAULT_SETUP_PATH } = {}) {
  configPath = safePath(configPath); const c = await readConfig(configPath);
  let runtime; try { runtime = await readJSON(path.join(c.installDir, 'runtime.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try {
    const probe = await verifiedNode(c);
    return { ok: true, running: true, nodeUrl: c.nodeUrl, role: c.role, health: probe.health,
      genesisHash: probe.info.genesisHash, pid: runtime?.pid ?? null,
      configuredIdentityMatches: Boolean(runtime && runtime.nodeIssuerFingerprint === probe.meta.issuerFingerprint),
      preferredCabinetConfig: c.cabinetConfigPath };
  } catch { return { ok: true, running: false, nodeUrl: c.nodeUrl, reason: 'unreachable_or_identity_mismatch' }; }
}
function isolatedEnv(c, token) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGT_') || ['NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
  return { ...env, AGT_DATA_DIR: c.dataDir, AGT_BIND: c.bind, AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: token,
    AGT_IDENTITY_ROLE: c.role, AGT_IDENTITY_AUDIENCE: `agentcoin-local-node:${c.port}`,
    AGT_TRUSTED_ISSUERS_FILE: c.trustFile, ...(c.role === 'replica' ? { AGT_PASSPORT_ISSUER_FINGERPRINT: c.operatorIssuerFingerprint } : {}),
    AGT_BOOTSTRAP_FILE: c.bootstrapFile, AGT_MONITOR_TARGETS_FILE: c.monitorFile,
    AGT_PEER_DISCOVERY: '1', AGT_SITE_SYNC: c.siteSync ? '1' : '0', AGT_SPORE: '0' };
}
async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await ended; } finally { clearTimeout(force); }
}
export async function startAgentNode({ configPath = DEFAULT_SETUP_PATH, detached = false, healthDeadlineMs = 30000 } = {}) {
  configPath = safePath(configPath); const c = await readConfig(configPath);
  if (!Number.isInteger(healthDeadlineMs) || healthDeadlineMs < 1000 || healthDeadlineMs > 90000) fail('invalid_health_deadline');
  if (c.expectedCheckoutSha && await checkoutSHA() !== c.expectedCheckoutSha) fail('checkout_version_mismatch');
  if (checkoutGenesisHash() !== c.genesisHash) fail('checkout_genesis_changed');
  const keys = await readJSON(c.trustFile);
  if (c.role === 'replica' && (!Array.isArray(keys) || !keys.some(key => issuerFingerprint(key) === c.operatorIssuerFingerprint))) fail('operator_issuer_pin_not_in_trust_file');
  const admin = await readJSON(c.adminTokenFile);
  if (admin.version !== 1 || typeof admin.token !== 'string' || !/^[a-f0-9]{64}$/.test(admin.token)) fail('invalid_admin_service_credential');
  const existing = await statusAgentNode({ configPath });
  if (existing.running && existing.configuredIdentityMatches) return { child: null, report: { ...existing, alreadyRunning: true } };
  // Refuse a busy port instead of adopting or killing an unrelated process.
  await choosePort(c.port);
  const lockPath = path.join(c.installDir, 'start.lock');
  let lock;
  try { lock = await fsp.open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
  catch (e) { if (e.code === 'EEXIST') fail('node_start_in_progress'); throw e; }
  let child, log;
  try {
    log = await fsp.open(path.join(c.installDir, 'node.log'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
    child = spawn(process.execPath, [path.join(CHECKOUT_ROOT, 'node.mjs'), String(c.port)], {
      cwd: CHECKOUT_ROOT, env: isolatedEnv(c, admin.token), detached, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    let spawnError; child.on('error', error => { spawnError = error; });
    await log.close(); log = null;
    let probe;
    const deadline = Date.now() + healthDeadlineMs;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) fail('node_exited_before_health');
      try { probe = await verifiedNode(c); break; } catch { await sleep(100); }
    }
    if (!probe) fail('node_health_deadline_exceeded');
    const validation = await jsonGET(c.nodeUrl + '/validate?strict=1', Math.max(1000, deadline - Date.now()));
    if (validation.ok !== true) fail('node_chain_validation_failed');
    const runtime = { version: 1, pid: child.pid, startedAt: Date.now(), nodeIssuerFingerprint: probe.meta.issuerFingerprint };
    await writePrivate(path.join(c.installDir, 'runtime.json'), runtime, { overwrite: true });
    let localConnection = 'preserved_existing_config';
    try {
      const previous = await readJSON(c.cabinetConfigPath);
      if (previous.nodeUrl !== c.nodeUrl || previous.network !== c.network || previous.genesisHash !== c.genesisHash ||
          previous.passportIssuerFingerprint !== (c.operatorIssuerFingerprint ?? probe.meta.issuerFingerprint) || previous.nodeIssuerFingerprint !== probe.meta.issuerFingerprint) localConnection = 'existing_config_not_overwritten';
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await connectCabinet({ configPath: c.cabinetConfigPath, nodeUrl: c.nodeUrl, expectedNetwork: c.network,
        expectedGenesisHash: c.genesisHash, expectedIssuerFingerprint: c.operatorIssuerFingerprint ?? probe.meta.issuerFingerprint });
      localConnection = 'connected';
    }
    if (detached) child.unref();
    return { child, report: { ok: true, running: true, pid: child.pid, nodeUrl: c.nodeUrl, health: probe.health,
      chainValid: true, genesisHash: c.genesisHash, role: c.role, preferredCabinetConfig: c.cabinetConfigPath, localConnection,
      next: 'create/unlock your own encrypted profile; enroll at the pinned issuer, then login using this cabinet config' } };
  } catch (error) { if (child?.pid) await stopOwnedChild(child); throw error; }
  finally { await log?.close().catch(() => {}); await lock?.close().catch(() => {}); await fsp.unlink(lockPath).catch(() => {}); }
}
async function stdinOptions() {
  if (process.stdin.isTTY) fail('configure_json_stdin_required');
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > MAX_FILE) fail('setup_input_too_large'); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!object(input)) fail('setup_json_object_required'); return input;
}
export async function runNodeSetupCLI(args = process.argv.slice(2)) {
  const [command, configPath = DEFAULT_SETUP_PATH, ...extra] = args;
  if (extra.length || !['configure', 'start', 'status'].includes(command)) fail('usage_agent_node_setup_configure_start_status_config_path');
  let result;
  if (command === 'configure') result = await configureAgentNode({ ...await stdinOptions(), configPath });
  if (command === 'status') result = await statusAgentNode({ configPath });
  if (command === 'start') result = (await startAgentNode({ configPath, detached: true })).report;
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNodeSetupCLI().catch(error => { const code = /^[a-z][a-z0-9_]{1,100}$/.test(error?.message || '') ? error.message : 'agent_node_setup_failed';
    process.stderr.write(code + '\n'); process.exitCode = 1; });
}
