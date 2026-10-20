#!/usr/bin/env node
// One-shot deep health/balance audit. Automatic recovery only targets an
// explicitly local service; liveness restarts remain the watchdog's job.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditBalances } from './audit-lib.mjs';
import { readTailnetBind } from './watchdog.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROSTER = {
  9335: { task: 'AGTNode9335', dir: 'data' },
  9341: { task: 'AGTNode9341', dir: 'data-node2' },
  9342: { task: 'AGTNode9342', dir: 'data-node3' },
  9336: { task: 'AGTNodeTs', dir: 'data-node-ts' },
};

export function resolveHealthConfig(argv = [], env = process.env, {
  root = ROOT, exists = fs.existsSync, read = fs.readFileSync, platform = process.platform,
} = {}) {
  const options = {};
  let positional;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-heal' || arg === '--local') { options[arg] = true; continue; }
    if (['--host', '--url', '--data-dir', '--timeout-ms', '--systemd-unit'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg] = argv[++i]; continue;
    }
    if (/^\d+$/.test(arg) && positional === undefined) { positional = arg; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  const explicitPort = positional ?? env.AGT_HEALTH_PORT;
  let port = Number(explicitPort ?? 9335);
  const configuredUrl = options['--url'] || env.AGT_NODE_URL;
  const explicitHost = options['--host'] || env.AGT_HEALTH_HOST;
  if (configuredUrl && explicitHost) throw new Error('Choose --host or AGT_NODE_URL/--url');
  const tailnet = readTailnetBind(env, (file, encoding) => read(path.join(root, 'data-agtx', path.basename(file)), encoding));
  let url;
  if (configuredUrl) {
    url = new URL(configuredUrl);
    const urlPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (explicitPort !== undefined && port !== urlPort) throw new Error('Port disagrees with AGT_NODE_URL/--url');
    port = urlPort;
  } else {
    const host = explicitHost || (port === 9336 ? tailnet : '127.0.0.1');
    if (!host) throw new Error('Port 9336 requires --host, AGT_NODE_URL, AGT_TS_BIND or data-agtx/ts-bind.txt');
    if (/[/?#@]/.test(host)) throw new Error('--host must be a hostname or IP without a URL path');
    url = new URL(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid node port');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Node URL must be an http(s) origin without credentials, query or path');
  }
  const roster = ROSTER[port];
  const explicitDir = options['--data-dir'] || env.AGT_DATA_DIR;
  const defaultDir = roster ? path.join(root, platform === 'linux' && port === 9335 && exists(path.join(root, 'data-vps')) ? 'data-vps' : roster.dir) : null;
  let dataDir;
  if (explicitDir) dataDir = path.resolve(root, explicitDir);
  else if (defaultDir) dataDir = defaultDir;
  else throw new Error('Unknown node port requires --data-dir or AGT_DATA_DIR');
  const timeoutMs = Number(options['--timeout-ms'] || env.AGT_HEALTH_TIMEOUT_MS || 8000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) throw new Error('Timeout must be 10..120000 ms');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isLocal = ['127.0.0.1', '::1', 'localhost'].includes(host)
    || (tailnet !== null && host === tailnet) || options['--local'] === true || env.AGT_HEALTH_LOCAL === '1';
  const explicitUnit = options['--systemd-unit'] || env.AGT_SYSTEMD_UNIT;
  const systemdUnit = explicitUnit || (port === 9335 ? 'agt-node.service' : null);
  if (systemdUnit && !/^[A-Za-z0-9_.@-]+\.service$/.test(systemdUnit)) throw new Error('Invalid systemd unit');
  const matchesTaskDir = roster && path.resolve(dataDir).toLowerCase() === path.resolve(root, roster.dir).toLowerCase();
  const matchesDefaultDir = defaultDir && path.resolve(dataDir) === path.resolve(defaultDir);
  const heal = options['--no-heal'] || env.AGT_HEALTH_NO_HEAL === '1' || !isLocal ? null
    : platform === 'win32' && matchesTaskDir ? { platform, task: roster.task }
      : platform === 'linux' && systemdUnit && (explicitUnit || matchesDefaultDir) ? { platform, unit: systemdUnit } : null;
  let adminToken = isLocal ? env.AGT_ADMIN_TOKEN || null : null;
  if (!adminToken && isLocal) { try { adminToken = read(path.join(root, 'data-agtx', 'admin-token.txt'), 'utf8').trim() || null; } catch {} }
  return { port, baseUrl: url.origin, dataDir, timeoutMs, adminToken, heal,
    auditTimeoutMs: 60_000, logFile: path.join(dataDir, 'autominer', 'health-check.log') };
}

export function createHealthApi(config, fetchFn = fetch) {
  return async (method, route, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (config.adminToken) headers['x-admin-token'] = config.adminToken;
    const response = await fetchFn(config.baseUrl + route, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs), redirect: 'error',
    });
    return { status: response.status, body: await response.json() };
  };
}

async function executeHeal(target) {
  const command = target.platform === 'win32' ? 'powershell' : 'systemctl';
  const args = target.platform === 'win32'
    ? ['-NoProfile', '-Command', `Start-ScheduledTask -TaskName '${target.task}'`]
    : ['restart', target.unit];
  await new Promise((resolve, reject) => execFile(command, args,
    { timeout: 20_000, windowsHide: true }, (err) => err ? reject(err) : resolve()));
}

export async function runHealthCheck(config, { api = createHealthApi(config), audit = auditBalances,
  heal = executeHeal, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {}, alert = async () => {} } = {}) {
  let life = null, lifeError = null, healed = false, healAttempted = false, auditResult = null;
  async function readLife() {
    const response = await api('GET', '/life');
    if (response.status !== 200 || typeof response.body?.chainValid !== 'boolean' || typeof response.body?.fresh !== 'boolean') {
      throw new Error(`invalid /life response HTTP ${response.status}`);
    }
    return response.body;
  }
  try { life = await readLife(); } catch (err) { lifeError = err.message; }
  if (!life && config.heal) {
    let responsive = false;
    try {
      const health = await api('GET', '/health');
      responsive = health.status === 200 || (health.status === 503
        && (health.body?.error === 'overloaded' || health.body?.overloaded === true));
    } catch {}
    if (!responsive) {
      try {
        healAttempted = true;
        await heal(config.heal);
        log(`self-heal requested: ${config.heal.task || config.heal.unit}`);
        await pause(15_000);
        life = await readLife();
        lifeError = null; healed = true;
      } catch (err) { lifeError = `recovery failed: ${err.message}`; }
    } else log('/health responds: no duplicate start for a slow /life');
  }
  // Derive findings from the final observation, never from a stale failed
  // observation captured before a successful recovery.
  const findings = [];
  if (!life) findings.push(`node unavailable: ${lifeError || 'unknown error'}`);
  else {
    if (life.chainValid !== true) findings.push(`chainValid=false (${life.chainIssue || '?'})`);
    if (life.fresh !== true) findings.push(`chain stale: tipAge=${life.tipAgeSec ?? '?'}s`);
    // Issuer/pin drift (AGIP-ротация): нода жива, но расхождeние issuer/пинов —
    // честный FAIL без self-heal (рестарт не чинит пин в cmd-файле).
    try {
      const meta = await api('GET', '/identity/meta');
      if (meta.status === 200 && meta.body && typeof meta.body === 'object') {
        const fp = meta.body.issuerFingerprint;
        if (typeof fp !== 'string') {
          // отсутствует поле (старый билд/мок) — не рассинхрон, проверка неприменима
        } else if (!/^sha256:[0-9a-f]{64}$/.test(fp)) {
          findings.push(`identity/meta: issuerFingerprint не sha256:64hex (${String(fp).slice(0, 32)}) — рассинхрон схемы issuer/пинов`);
        } else {
          // equality pin==issuer честен только для НЕ-реплик: у реплики локальный
          // issuer — свой, пин смотрит на издателя сети.
          const isReplica = meta.body.role === 'replica';
          const pin = meta.body.passportIssuerFingerprint;
          if (Array.isArray(meta.body.trustedIssuers) && meta.body.trustedIssuers.length > 0
            && !meta.body.trustedIssuers.includes(isReplica && typeof pin === 'string' ? pin : fp)) {
            findings.push(`identity/meta: ожидаемого издателя нет в trustedIssuers (${isReplica ? String(pin).slice(0, 32) : fp}) — пин отъехал от issuer`);
          }
          if (!isReplica && pin !== undefined && pin !== fp) {
            findings.push(`identity/meta: passportIssuerFingerprint (${String(pin).slice(0, 32)}) != issuerFingerprint — пин устарел, рестарт/обновление pin`);
          }
        }
      }
    } catch (err) { /* нет маршрута/таймаут meta пустости не делает ноду больной */ }
    try {
      auditResult = await audit({ dataDir: config.dataDir, baseUrl: config.baseUrl, adminToken: config.adminToken,
        timeoutMs: config.timeoutMs, signal: AbortSignal.timeout(config.auditTimeoutMs || 60_000) });
      for (const mismatch of auditResult.mismatches.slice(0, 4)) {
        findings.push(`balance ${mismatch.addr}: chain=${mismatch.expected} node=${mismatch.got ?? mismatch.error ?? 'absent'}`);
      }
      if (auditResult.transientSkipped > 0) findings.push(`audit incomplete: ${auditResult.transientSkipped} transient skips`);
    } catch (err) { findings.push(`audit incomplete: ${err.message}`); }
  }
  const status = findings.length ? `FAIL: ${findings.slice(0, 4).join('; ')}` : 'OK';
  log(`health-check: target=${config.baseUrl} blocks=${life?.blocks ?? '?'} recovered=${healed} audit=${auditResult?.checked ?? 0} → ${status}`);
  if (findings.length) { try { await alert(`🚨 AGTHealthCheck: ${status}`); } catch (err) { log(`alert failed: ${err.message}`); } }
  return { ok: findings.length === 0, status, findings, life, audit: auditResult, healed, healAttempted };
}

async function main() {
  const config = resolveHealthConfig(process.argv.slice(2));
  const api = createHealthApi(config);
  const log = (message) => {
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
    fs.appendFileSync(config.logFile, `[${new Date().toISOString()}] ${message}\n`);
  };
  const result = await runHealthCheck(config, { api, log, alert: async (text) => {
    let sender;
    try { sender = Object.keys(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'wallets.json'), 'utf8')))[0]; } catch {}
    if (sender) await api('POST', '/community/send', { sender, senderHandle: 'administrator', text });
  } });
  console.log(result.status);
  process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error('health-check ERROR: ' + err.message); process.exitCode = 2; });
}
