// agentcoin-agent.mjs — минимальный исполнитель Habitat/Steward на локальной ollama.
//
// Цикл: wallet (свой ed25519-ключ, приватный ключ машину не покидает) →
// register в steward → poll OPEN-работ → claim → exec (ollama) →
// submit sha256 артефакта. Деньги движет только settlement-адаптер и только
// при совпадении хеша: неверный артефакт деньгами не грозит (REJECTED_HASH_MISMATCH).
//
// Ключ агента: $HOME/.config/agentcoin-agent/<agentId>-wallet.json (0600),
// ВНЕ репозитория — не коммитить, не копировать в чат. В репозитории только
// cursor (jobId→hash) и файлы артефактов.
//
// Env:
//   STEWARD_BASE=http://127.0.0.1:9555  OLLAMA_BASE=http://127.0.0.1:11434
//   OLLAMA_MODEL=qwen3:0.6b  OLLAMA_TIMEOUT_SEC=90
//   AGENT_ID=first-agent  AGENT_WALLET=AGT... (пусто = сгенерировать свой)
//   WALLET_FILE=...  CAPABILITIES=exec,ollama
//   CURSOR_FILE=data-agents/agent-<id>.cursor.json
//   ARTIFACT_DIR=data-agents/agent-artifacts
//   POLL_INTERVAL_SEC=0 (0 = один проход; >0 = цикл демоном)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createWallet, isCanonicalAddress } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ID = process.env.AGENT_ID || 'first-agent';
const CFG = {
  steward: process.env.STEWARD_BASE || 'http://127.0.0.1:9555',
  ollama: process.env.OLLAMA_BASE || 'http://127.0.0.1:11434',
  model: process.env.OLLAMA_MODEL || 'qwen3:0.6b',
  ollamaTimeoutSec: Number(process.env.OLLAMA_TIMEOUT_SEC || 90),
  agentId: AGENT_ID,
  walletOverride: process.env.AGENT_WALLET || '',
  walletFile: process.env.WALLET_FILE || path.join(os.homedir(), '.config', 'agentcoin-agent', `${AGENT_ID}-wallet.json`),
  capabilities: process.env.CAPABILITIES || 'exec,ollama',
  cursor: process.env.CURSOR_FILE || path.join(HERE, 'data-agents', `agent-${AGENT_ID}.cursor.json`),
  artifacts: process.env.ARTIFACT_DIR || path.join(HERE, 'data-agents', 'agent-artifacts'),
  intervalSec: Number(process.env.POLL_INTERVAL_SEC || 0),
  heartbeatSec: Number(process.env.AGENT_HEARTBEAT_SEC || 5),
  claimPerPoll: Number(process.env.CLAIM_PER_POLL || 0), // 0 = без лимита (как раньше); 1 = честная дележка между агентами
};

const log = (level, msg, extra) => console.log(JSON.stringify({ ts: new Date().toISOString(), agent: CFG.agentId, level, msg, ...(extra || {}) }));
const alert = (msg, extra) => log('ALERT', msg, extra);

function httpJson(method, base, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(u, {
      method,
      headers: { 'Content-Type': 'application/json', Connection: 'close', ...(data ? { 'Content-Length': data.length } : {}) },
      timeout: timeoutMs || 10000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, json, raw: raw.slice(0, 2000) });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http_timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// ---- чистая логика (покрыта --self-test) ----
export function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
export function buildPrompt(job) {
  const title = (job && job.title) || '(без названия)';
  return `Task ${job.jobId} (reward ${job.rewardMilliAgt ?? job.amountMilliAgt} milliAGT): ${title}\n` +
    `Produce the final artifact text. Output ONLY the artifact, no explanations.`;
}
export function isOpenJob(j) { return !!j && (j.state === 'OPEN' || j.state === 'open'); }

// ---- heartbeat 0.5.0 (ТЗ: heartbeat-файл agent.json, п.3/п.9) ----
// Путь по умолчанию: /var/lib/habitat-cloud/workspaces/<agentId>/agent.json
// (рядом с runtime.json). Переопределение: AGENT_HEARTBEAT_FILE.
// Период: AGENT_HEARTBEAT_SEC (по ТЗ 5). Пишет атомарно: tmp + rename.
export const HEARTBEAT_REQUIRED = ['agentId', 'pid', 'startTime', 'heartbeatAt', 'leaseJobId', 'capabilities', 'wallet'];
export function defaultHeartbeatFile(agentId) {
  return process.env.AGENT_HEARTBEAT_FILE || `/var/lib/habitat-cloud/workspaces/${agentId}/agent.json`;
}
// Поле 22 (starttime, в тиках) из /proc/<pid>/stat, как есть, без конвертации.
export function readStartTicks(pid) {
  try {
    const s = fs.readFileSync(pid ? `/proc/${pid}/stat` : '/proc/self/stat', 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    const v = rest[19];
    return v && /^\d+$/.test(v) ? v : null;
  } catch { return null; }
}
export function buildHeartbeat({ agentId, pid, startTime, leaseJobId, capabilities, wallet, now }) {
  return {
    agentId, pid, startTime,
    heartbeatAt: (now || new Date()).toISOString(),
    leaseJobId: leaseJobId === undefined ? null : leaseJobId,
    capabilities, wallet,
  };
}
export function writeHeartbeatAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
let hbTimer = null, hbWarned = false, currentLease = null, hbFile = null, hbWallet = null;
function heartbeatOnce() {
  try {
    const startTime = readStartTicks();
    if (startTime === null) {
      if (!hbWarned) { hbWarned = true; log('warn', 'heartbeat_unavailable', { note: 'no /proc/self/stat (открытая проблема ТЗ-0.5.0 п.9: не-WSL хост)' }); }
      return;
    }
    writeHeartbeatAtomic(hbFile, buildHeartbeat({
      agentId: CFG.agentId, pid: process.pid, startTime,
      leaseJobId: currentLease, capabilities: CFG.capabilities, wallet: hbWallet,
    }));
  } catch (e) { log('warn', 'heartbeat_write_failed', { error: String((e && e.message) || e) }); }
}
function heartbeatRefresh() { if (hbTimer) heartbeatOnce(); }
function startHeartbeat(wallet) {
  hbFile = defaultHeartbeatFile(CFG.agentId);
  hbWallet = wallet;
  if (hbTimer || process.env.AGENT_HEARTBEAT_SEC === '0') return;
  heartbeatOnce();
  hbTimer = setInterval(heartbeatOnce, Math.max(1, CFG.heartbeatSec) * 1000);
  if (hbTimer.unref) hbTimer.unref();
  const cleanup = () => {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    try { if (hbFile && fs.existsSync(hbFile)) fs.unlinkSync(hbFile); } catch {}
  };
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  process.once('SIGINT', () => { cleanup(); process.exit(0); });
  process.once('exit', () => { try { if (hbFile && fs.existsSync(hbFile)) fs.unlinkSync(hbFile); } catch {} });
}

function loadCursor() {
  try { return JSON.parse(fs.readFileSync(CFG.cursor, 'utf8')); }
  catch { return { done: {} }; }
}
function saveCursor(c) {
  fs.mkdirSync(path.dirname(CFG.cursor), { recursive: true });
  fs.writeFileSync(CFG.cursor, JSON.stringify(c, null, 1));
}

function ensureWallet() {
  if (CFG.walletOverride) {
    if (!isCanonicalAddress(CFG.walletOverride)) throw new Error('AGENT_WALLET_not_canonical');
    return { address: CFG.walletOverride, fresh: false };
  }
  try {
    const saved = JSON.parse(fs.readFileSync(CFG.walletFile, 'utf8'));
    if (saved && isCanonicalAddress(saved.address) && typeof saved.privKey === 'string') {
      return { address: saved.address, fresh: false };
    }
    throw new Error('wallet_file_invalid');
  } catch (e) {
    if (e && e.code !== 'ENOENT' && e.message !== 'wallet_file_invalid') throw e;
    const w = createWallet(`agent-${CFG.agentId}`);
    if (!isCanonicalAddress(w.address)) throw new Error('generated_wallet_not_canonical');
    fs.mkdirSync(path.dirname(CFG.walletFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CFG.walletFile, JSON.stringify({ address: w.address, privKey: w.privKey, pub: w.pub, createdAt: w.createdAt }, null, 1), { mode: 0o600 });
    try { fs.chmodSync(CFG.walletFile, 0o600); } catch {}
    return { address: w.address, fresh: true };
  }
}

async function execOllama(prompt) {
  const r = await httpJson('POST', CFG.ollama, '/api/generate', {
    model: CFG.model, prompt, stream: false, think: false, options: { num_predict: 512 },
  }, CFG.ollamaTimeoutSec * 1000);
  const text = r.json && typeof r.json.response === 'string' ? r.json.response.trim() : '';
  if (r.status !== 200 || !text) throw new Error('ollama_empty_response status=' + r.status);
  return text;
}

async function runOnce(execFn) {
  const exec = execFn || execOllama;
  const wallet = ensureWallet();
  log('info', 'wallet_ready', { address: wallet.address, fresh: wallet.fresh });

  const reg = await httpJson('POST', CFG.steward, '/v1/agents/register',
    { agentId: CFG.agentId, wallet: wallet.address, capabilities: CFG.capabilities });
  if (!(reg.json && (reg.json.ok || reg.json.error === 'agent_exists'))) {
    alert('register_failed', { status: reg.status, body: reg.json || reg.raw });
    process.exitCode = 1;
    return;
  }
  log('info', 'registered', { state: (reg.json && (reg.json.state || 'READY')) || 'READY' });
  startHeartbeat(wallet.address);

  const st = await httpJson('GET', CFG.steward, '/v1/state');
  const jobs = (st.json && Array.isArray(st.json.jobs)) ? st.json.jobs : [];
  const open = jobs.filter(isOpenJob);
  log('info', 'poll', { jobs: jobs.length, open: open.length });
  if (!open.length) return;

  const cursor = loadCursor();
  let claimed = 0;
  for (const job of open) {
    if (cursor.done[job.jobId]) continue;
    if (CFG.claimPerPoll > 0 && claimed >= CFG.claimPerPoll) { log('info', 'claim_cap', { cap: CFG.claimPerPoll }); break; }
    log('info', 'claim', { jobId: job.jobId });
    const claim = await httpJson('POST', CFG.steward, '/v1/jobs/claim', { jobId: job.jobId, agentId: CFG.agentId });
    if (!(claim.json && claim.json.ok)) {
      log('warn', 'claim_rejected', { jobId: job.jobId, body: claim.json || claim.raw });
      continue;
    }
    currentLease = job.jobId; claimed++; heartbeatRefresh();
    let artifact;
    try {
      artifact = await exec(buildPrompt(job));
    } catch (e) {
      alert('exec_failed_no_submit', { jobId: job.jobId, error: String((e && e.message) || e), note: 'работа claimed, артефакт НЕ отправлен — разбирать вручную' });
      process.exitCode = 1;
      return;
    }
    const digest = sha256hex(artifact);
    fs.mkdirSync(CFG.artifacts, { recursive: true });
    fs.writeFileSync(path.join(CFG.artifacts, `${String(job.jobId).replace(/[^A-Za-z0-9_-]/g, '')}.txt`), artifact);
    const sub = await httpJson('POST', CFG.steward, '/v1/jobs/submit',
      { jobId: job.jobId, agentId: CFG.agentId, artifactSha256: digest });
    cursor.done[job.jobId] = { artifactSha256: digest, submittedAt: new Date().toISOString(), verification: (sub.json && (sub.json.verification || sub.json.state)) || null };
    saveCursor(cursor);
    currentLease = null; heartbeatRefresh();
    log('info', 'submitted', { jobId: job.jobId, artifactSha256: digest.slice(0, 16) + '…', state: (sub.json && sub.json.state) || null, verification: (sub.json && sub.json.verification) || null });
  }
}

// ---- --self-test: чистая логика + сквозной прогон через стабы ----
async function selfTest() {
  const assert = (c, m) => { if (!c) throw new Error('self-test FAIL: ' + m); };
  // 1. sha256: 64-hex, детерминирован.
  const h1 = sha256hex('hello'), h2 = sha256hex('hello');
  assert(/^[0-9a-f]{64}$/.test(h1) && h1 === h2, 'sha256hex');
  assert(sha256hex('a') !== sha256hex('b'), 'sha256 sensitive');
  // 2. Свой ключ: канонический адрес, проходит гейт выплат.
  const w = createWallet('selftest');
  assert(isCanonicalAddress(w.address), 'own wallet canonical: ' + w.address);
  assert(typeof w.privKey === 'string' && w.privKey.includes('PRIVATE KEY'), 'privkey present');
  // 3. Промпт содержит id/награду/заголовок.
  const p = buildPrompt({ jobId: 'j9', rewardMilliAgt: 1500, title: 'demo' });
  assert(p.includes('j9') && p.includes('1500') && p.includes('demo'), 'prompt');
  assert(isOpenJob({ state: 'OPEN' }) && !isOpenJob({ state: 'RUNNING' }), 'open filter');

  // 4. Сквозной прогон: стаб-steward + стаб-ollama.
  const CANNED = 'stub artifact text';
  const EXPECTED = sha256hex(CANNED);
  const jobs = [{ jobId: 'stub-42', title: 'stub task', rewardMilliAgt: 1000, expectedSha256: EXPECTED, state: 'OPEN', agentId: null }];
  const seen = { submits: [] };
  const stub = http.createServer((req, res) => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const o = b ? JSON.parse(b) : {};
      if (req.url === '/v1/agents/register') return send(201, { ok: true, state: 'READY' });
      if (req.url === '/v1/state') return send(200, { agents: [], jobs });
      if (req.url === '/v1/jobs/claim') {
        const j = jobs.find((x) => x.jobId === o.jobId);
        if (!j || j.state !== 'OPEN') return send(404, { ok: false, error: 'job_or_agent_not_found' });
        j.state = 'RUNNING'; j.agentId = o.agentId;
        return send(200, { ok: true, type: 'job.claimed', jobId: j.jobId });
      }
      if (req.url === '/v1/jobs/submit') {
        seen.submits.push(o);
        const j = jobs.find((x) => x.jobId === o.jobId);
        if (!j || j.agentId !== o.agentId) return send(404, { ok: false, error: 'job_or_agent_not_found' });
        if (o.artifactSha256 === j.expectedSha256) {
          j.state = 'PAYMENT_PENDING';
          return send(200, { ok: true, state: 'PAYMENT_PENDING', paymentId: 'pay-stub' });
        }
        j.state = 'SUBMITTED';
        return send(200, { ok: true, state: 'SUBMITTED', verification: 'REJECTED_HASH_MISMATCH' });
      }
      send(404, {});
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const realCfg = { ...CFG };
  const realHbSec = process.env.AGENT_HEARTBEAT_SEC;
  process.env.AGENT_HEARTBEAT_SEC = '0'; // self-test: heartbeat-файл живого воркспейса не трогаем
  const tmpRoot = fs.mkdtempSync(path.join(process.cwd(), 'tmp-agent-'));
  CFG.steward = `http://127.0.0.1:${stub.address().port}`;
  CFG.walletFile = path.join(tmpRoot, 'w.json');
  CFG.cursor = path.join(tmpRoot, 'c.json');
  CFG.artifacts = path.join(tmpRoot, 'art');
  CFG.walletOverride = '';
  try {
    await runOnce(async () => CANNED);
    assert(seen.submits.length === 1, 'one submit');
    assert(seen.submits[0].artifactSha256 === EXPECTED, 'submit carries correct hash');
    assert(fs.existsSync(path.join(tmpRoot, 'art', 'stub-42.txt')), 'artifact saved');
    if (process.platform !== 'win32') {
      const st = fs.statSync(CFG.walletFile);
      assert((st.mode & 0o777) === 0o600, 'wallet file 0600, got ' + (st.mode & 0o777).toString(8));
    }
        // Повтор: работа уже не OPEN — второй claim запрещён.
    await runOnce(async () => 'other text');
    assert(seen.submits.length === 1, 'no resubmit');
    // 5. Heartbeat: обязательные ключи схемы ТЗ-0.5.0 п.3, lease по умолчанию null.
    const hb = buildHeartbeat({ agentId: 'first-agent', pid: 1234, startTime: '999', leaseJobId: null, capabilities: 'exec,ollama', wallet: 'AGTx' });
    for (const k of HEARTBEAT_REQUIRED) assert(k in hb, 'hb key ' + k);
    assert(hb.leaseJobId === null, 'hb lease null');
    // 6. Атомарная запись + чтение roundtrip.
    const hbTmp = path.join(tmpRoot, 'ws', 'agent.json');
    writeHeartbeatAtomic(hbTmp, hb);
    assert(JSON.parse(fs.readFileSync(hbTmp, 'utf8')).pid === 1234, 'hb roundtrip');
    // 7. Живой парсинг starttime — только где есть /proc (WSL/linux).
    if (readStartTicks() !== null) assert(/^\d+$/.test(readStartTicks()), 'live starttime');
    else log('info', 'heartbeat_skipped_no_proc', {});
  } finally {
    Object.assign(CFG, realCfg);
    if (realHbSec === undefined) delete process.env.AGENT_HEARTBEAT_SEC; else process.env.AGENT_HEARTBEAT_SEC = realHbSec;
    await new Promise((r) => stub.close(r));
    if (typeof stub.closeAllConnections === 'function') stub.closeAllConnections();
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ self_test: 'PASS', checks: 7 }));
}

const args = new Set(process.argv.slice(2));
if (args.has('--self-test')) {
  selfTest().catch((e) => { console.error(JSON.stringify({ self_test: 'FAIL', error: String((e && e.message) || e) })); process.exitCode = 1; });
} else if (CFG.intervalSec > 0 && !args.has('--once')) {
  log('info', 'daemon_loop', { everySec: CFG.intervalSec });
  const tick = () => runOnce().catch((e) => alert('cycle_crash', { error: String((e && e.message) || e) })).finally(() => setTimeout(tick, CFG.intervalSec * 1000));
  tick();
} else {
  runOnce().catch((e) => { alert('cycle_crash', { error: String((e && e.message) || e) }); process.exitCode = 1; });
}
