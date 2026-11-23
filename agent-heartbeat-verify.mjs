// agent-heartbeat-verify.mjs — read-only проверка heartbeat-файла agent.json
// по ТЗ Habitat 0.5.0 (п.4: уровень ОС, п.5: сверка со steward).
// Ничего не пишет в реестр, выплат не касается, мост не трогает.
//
// Использование:
//   node agent-heartbeat-verify.mjs --check <workspaceDir> [--steward-base URL] [--errors-file P]
//   node agent-heartbeat-verify.mjs --self-test
//
// Вердикт JSON: { verdict: 'VERIFIED' | 'NULL', reason, agent?, heartbeatAgeSec? }
// Причины NULL (fail-closed): NO_FILE | TOO_BIG | INVALID_JSON | MISSING_FIELDS |
//   NO_PROCESS | PID_REUSED | STALE | UNREGISTERED | STEWARD_UNREACHABLE

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

export const STALE_AFTER_SEC = 15;
export const MAX_BYTES = 65536;
export const REQUIRED = ['agentId', 'pid', 'startTime', 'heartbeatAt', 'leaseJobId', 'capabilities', 'wallet'];

export function readProcStartTicks(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    const v = rest[19];
    return v && /^\d+$/.test(v) ? v : null;
  } catch { return null; }
}

function fetchJson(base, p, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const req = http.request(u, { method: 'GET', timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null }); }
        catch (e) { reject(new Error('bad_json')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http_timeout')); });
    req.end();
  });
}

async function loadStewardAgents(stewardBase) {
  const r = await fetchJson(stewardBase, '/v1/state');
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.agents)) throw new Error('STEWARD_UNREACHABLE');
  return r.json.agents.map((a) => a.agentId);
}

// Чистая проверка одного файла. stewardAgents: null = сверку пропустить.
export function verifyHeartbeatFile(file, stewardAgents) {
  let st;
  try { st = fs.statSync(file); } catch { return { verdict: 'NULL', reason: 'NO_FILE' }; }
  if (st.size > MAX_BYTES) return { verdict: 'NULL', reason: 'TOO_BIG' };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { verdict: 'NULL', reason: 'INVALID_JSON' }; }
  if (!obj || typeof obj !== 'object') return { verdict: 'NULL', reason: 'INVALID_JSON' };
  for (const k of REQUIRED) {
    if (!(k in obj)) return { verdict: 'NULL', reason: 'MISSING_FIELDS', missing: k };
  }
  if (typeof obj.pid !== 'number' || !Number.isInteger(obj.pid) || obj.pid <= 0) {
    return { verdict: 'NULL', reason: 'MISSING_FIELDS', missing: 'pid' };
  }
  // kill(pid, 0): есть ли процесс и есть ли права.
  try { process.kill(obj.pid, 0); }
  catch { return { verdict: 'NULL', reason: 'NO_PROCESS' }; }
  // Ключевая проверка: PID не переиспользован (поле 22 /proc/<pid>/stat).
  const live = readProcStartTicks(obj.pid);
  if (live === null || String(live) !== String(obj.startTime)) {
    return { verdict: 'NULL', reason: 'PID_REUSED' };
  }
  const ageMs = Date.now() - Date.parse(obj.heartbeatAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > STALE_AFTER_SEC * 1000) {
    return { verdict: 'NULL', reason: 'STALE', heartbeatAgeSec: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null };
  }
  if (stewardAgents !== null && stewardAgents !== undefined && !stewardAgents.includes(obj.agentId)) {
    return { verdict: 'NULL', reason: 'UNREGISTERED', note: 'agentId нет среди зарегистрированных в steward' };
  }
  const ageSec = Math.round(ageMs / 1000);
  return {
    verdict: 'VERIFIED',
    reason: 'OK',
    heartbeatAgeSec: ageSec,
    agent: {
      agentId: obj.agentId,
      pid: obj.pid,
      heartbeatAt: obj.heartbeatAt,
      heartbeatAgeSec: ageSec,
      leaseJobId: obj.leaseJobId,
      verifiedThrough: 'heartbeat-file+proc+steward',
    },
  };
}

function bumpErrors(errorsFile) {
  try {
    let n = 0;
    try { n = Number(JSON.parse(fs.readFileSync(errorsFile, 'utf8')).agentHeartbeatErrors || 0); } catch {}
    n += 1;
    fs.mkdirSync(path.dirname(errorsFile), { recursive: true });
    fs.writeFileSync(errorsFile, JSON.stringify({ agentHeartbeatErrors: n }));
    return n;
  } catch { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const ci = args.indexOf('--check');
  if (ci === -1) {
    console.error('usage: --check <workspaceDir> [--steward-base URL] [--errors-file P] | --self-test');
    process.exitCode = 2;
    return;
  }
  const dir = args[ci + 1];
  const sbi = args.indexOf('--steward-base');
  const stewardBase = sbi === -1 ? 'http://127.0.0.1:9555' : args[sbi + 1];
  const efi = args.indexOf('--errors-file');
  const errorsFile = efi === -1 ? null : args[efi + 1];
  const file = path.join(dir, 'agent.json');
  let agents = null;
  try { agents = await loadStewardAgents(stewardBase); }
  catch { console.log(JSON.stringify({ verdict: 'NULL', reason: 'STEWARD_UNREACHABLE', file })); process.exitCode = 1; return; }
  const v = verifyHeartbeatFile(file, agents);
  if (v.verdict === 'NULL' && errorsFile && ['INVALID_JSON', 'MISSING_FIELDS', 'TOO_BIG'].includes(v.reason)) {
    v.agentHeartbeatErrors = bumpErrors(errorsFile);
  }
  console.log(JSON.stringify(v));
}

async function selfTest() {
  const assert = (c, m) => { if (!c) throw new Error('self-test FAIL: ' + m); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hbv-'));
  const w = (name, content) => { const f = path.join(tmp, name); fs.writeFileSync(f, content); return f; };
  const good = {
    agentId: 'first-agent', pid: process.pid,
    startTime: readProcStartTicks(process.pid), heartbeatAt: new Date().toISOString(),
    leaseJobId: null, capabilities: 'exec,ollama', wallet: 'AGTx',
  };
  // 1. живой файл собственного процесса → VERIFIED (только где есть /proc).
  if (good.startTime !== null) {
    const v = verifyHeartbeatFile(w('good.json', JSON.stringify(good)), ['first-agent']);
    assert(v.verdict === 'VERIFIED' && v.agent.pid === process.pid, 'live verified, got ' + JSON.stringify(v));
    assert(v.heartbeatAgeSec <= STALE_AFTER_SEC, 'age fresh');
  }
  // 2. подмена startTime при живом процессе → PID_REUSED.
  const spoof = { ...good, pid: process.pid, startTime: '1' };
  const v2 = verifyHeartbeatFile(w('spoof.json', JSON.stringify(spoof)), ['first-agent']);
  assert(v2.reason === 'PID_REUSED' || (good.startTime === null && v2.reason === 'NO_PROCESS'), 'spoofed, got ' + v2.reason);
  // 3. зависший heartbeat → STALE (только где есть /proc; иначе процессный гейт срабатывает раньше).
  if (good.startTime !== null) {
    const stale = { ...good, heartbeatAt: new Date(Date.now() - 60000).toISOString() };
    assert(verifyHeartbeatFile(w('stale.json', JSON.stringify(stale)), ['first-agent']).reason === 'STALE', 'stale');
  }
  // 4. битый JSON → INVALID_JSON.
  assert(verifyHeartbeatFile(w('broken.json', '{not json'), ['first-agent']).reason === 'INVALID_JSON', 'broken');
  // 5. нет полей → MISSING_FIELDS.
  assert(verifyHeartbeatFile(w('nofields.json', '{}'), ['first-agent']).reason === 'MISSING_FIELDS', 'nofields');
  // 6. нет процесса → NO_PROCESS.
  const dead = { ...good, pid: 2147483647, startTime: '1' };
  assert(verifyHeartbeatFile(w('dead.json', JSON.stringify(dead)), ['first-agent']).reason === 'NO_PROCESS', 'dead pid');
  // 7. чужой agentId → UNREGISTERED.
  const forg = { ...good, startTime: good.startTime === null ? '1' : good.startTime };
  const v7 = verifyHeartbeatFile(w('forg.json', JSON.stringify(forg)), ['someone-else']);
  assert(v7.reason === (good.startTime === null ? 'PID_REUSED' : 'UNREGISTERED'), 'unregistered, got ' + v7.reason);
  // 8. нет файла → NO_FILE.
  assert(verifyHeartbeatFile(path.join(tmp, 'absent.json'), ['first-agent']).reason === 'NO_FILE', 'absent');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify({ self_test: 'PASS', checks: 8 }));
}

main().catch((e) => { console.error(JSON.stringify({ verdict: 'NULL', reason: 'CRASH', error: String((e && e.message) || e) })); process.exitCode = 1; });
