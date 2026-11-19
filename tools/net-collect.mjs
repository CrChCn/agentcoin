#!/usr/bin/env node
// net-collect.mjs — Этап 2: сбор фактического состояния, только чтение.
// Цели — ТОЛЬКО из config/unified-registry.json (поля routes + observe).
// Никакого второго списка серверов: хосты берутся из observe.ssh / observe.publicBase / routes.
// Только GET и read-only команды. POST /tx /mine /mainnet/* (кроме GET /mainnet/info) не опрашиваются.
// Тайм-ауты конечны, параллелизм ограничен, повторов нет.
// Статусы: ok | mismatch | unavailable | unknown | not_checked.
// Тайм-аут = unavailable (не «остановлена»). HTTP 200 с не-JSON = mismatch. Прокси ≠ локальное состояние.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HTTP_TIMEOUT_MS = 8000;
export const SSH_TIMEOUT_MS = 15000;
export const MAX_CONCURRENCY = 4;
export const MAX_BODY_BYTES = 65536;
// Блоки растут ~30с: допуск дрейфа высот при последовательном опросе.
export const BLOCK_INTERVAL_SEC = 30;

const READ_ONLY_SSH_PREFIXES = [
  'curl -sS -m 8 -i http://127.0.0.1:',
  'curl -sS -m 8 -i http://localhost:',
  'systemctl is-active ',
  'systemctl show ',
  'ps -eo ',
  'sha256sum /opt/',
  'ss -ltnp',
];

export function isReadOnlySshCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const c = cmd.trim();
  if (!READ_ONLY_SSH_PREFIXES.some((p) => c.startsWith(p))) return false;
  // Запрет секретов и мутаций даже внутри разрешённых префиксов.
  if (/(\.env|settlement-policy|mainnet-settlements|id_rsa|id_ed25519|\benv\b|\bexport\b|sha256sum\s+\/etc\/|\/root\/\.ssh\/|;|\|\||&&|`|\$\()/.test(c)) return false;
  return true;
}

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';
}

function queryFix(p) {
  if (p === '/blocks') return '/blocks?n=1';
  if (p === '/headers') return '/headers?from=0&limit=1';
  return p;
}

// План строится ТОЛЬКО из реестра. Пустой план при отсутствии observe/routes — честный, не ошибка.
export function buildPlan(reg) {
  const checks = [];
  const comps = Array.isArray(reg?.components) ? reg.components : [];
  for (const c of comps) {
    if (!c || typeof c !== 'object' || typeof c.componentId !== 'string') continue;
    const id = c.componentId;
    const ob = c.observe && typeof c.observe === 'object' ? c.observe : null;

    // --- локальные проверки ноды через SSH (read-only) ---
    if (ob && ob.ssh && typeof ob.ssh.host === 'string' && ob.ssh.host) {
      const base = typeof ob.localBase === 'string' && ob.localBase ? ob.localBase : 'http://127.0.0.1:9335';
      const m = base.match(/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
      const port = m && m[2] ? m[2].slice(1) : '9335';
      const loop = `http://127.0.0.1:${port}`;
      for (const ep of (Array.isArray(ob.localEndpoints) ? ob.localEndpoints : [])) {
        if (typeof ep !== 'string' || !ep.startsWith('/')) continue;
        checks.push({
          componentId: id, checkId: `${id}:local-${slug(ep)}`,
          via: 'ssh', ssh: ob.ssh,
          command: `curl -sS -m 8 -i ${loop}${queryFix(ep)}`,
          sourceEndpoint: `loopback ${loop}${queryFix(ep)} via ssh`,
          expectJson: true,
        });
      }
      const units = Array.isArray(ob.units) ? ob.units.filter((u) => typeof u === 'string' && u) : [];
      if (units.length) {
        checks.push({
          componentId: id, checkId: `${id}:proc-unit`,
          via: 'ssh', ssh: ob.ssh,
          command: `systemctl show ${units[0]} --property=ActiveState,ExecStart,MainPID,MemoryCurrent --value; systemctl is-active ${units[0]}`,
          sourceEndpoint: `systemctl ${units[0]} via ssh`, expectJson: false,
        });
      }
      checks.push({
        componentId: id, checkId: `${id}:proc-ps`,
        via: 'ssh', ssh: ob.ssh,
        command: 'ps -eo pid,lstart,user,args | head -n 30',
        sourceEndpoint: 'ps via ssh', expectJson: false,
      });
      const files = Array.isArray(ob.files) ? ob.files.filter((f) => typeof f === 'string' && f.startsWith('/')) : [];
      if (files.length) {
        checks.push({
          componentId: id, checkId: `${id}:files-sha`,
          via: 'ssh', ssh: ob.ssh,
          command: `sha256sum ${files.join(' ')}`,
          sourceEndpoint: `sha256sum ${files.length} file(s) via ssh`, expectJson: false,
        });
      }
      const ports = Array.isArray(ob.listenPorts) ? ob.listenPorts.filter(Number.isInteger) : [];
      checks.push({
        componentId: id, checkId: `${id}:listen`,
        via: 'ssh', ssh: ob.ssh,
        command: ports.length
          ? `ss -ltnp | grep -E ':(${ports.join('|')}) ' || ss -ltnp | head -n 20`
          : 'ss -ltnp | head -n 20',
        sourceEndpoint: 'ss -ltnp via ssh', expectJson: false,
      });
    }

    // --- публичные проверки owner-маршрутов (только безопасные GET) ---
    const routes = Array.isArray(c.routes) ? c.routes : [];
    const pubBase = ob && typeof ob.publicBase === 'string' && ob.publicBase
      ? ob.publicBase.replace(/\/$/, '')
      : null;
    for (const r of routes) {
      if (!r || typeof r !== 'object' || r.owner !== true || r.aliasOf) continue;
      const method = String(r.method || 'GET').toUpperCase();
      if (method !== 'GET') continue; // POST/мутации не опрашиваем
      if (typeof r.host !== 'string' || typeof r.path !== 'string') continue;
      if (r.host.startsWith('127.0.0.1') || r.host.startsWith('localhost')) continue; // локальные — только через SSH
      const base = pubBase || `https://${r.host}`;
      const expectDark = /403|dark|т[её]мн/i.test(String(r.note || ''));
      // Реестр сам документирует, что голый путь без параметра 404 (напр. /api/v1/txproof без :txid):
      // такой зонд заведомо нерелевантен — помечаем not_checked, а не mismatch.
      const bareParam = /:[a-z_]+.*404|голый.*404|без :[a-z_]+/i.test(String(r.note || ''));
      const expectJson = c.kind === 'blockchain-node' || c.kind === 'gateway' || c.kind === 'monitor'
        || r.path.startsWith('/api/') || r.path.startsWith('/network/') || r.path.startsWith('/queue/')
        || ['/info', '/health', '/life', '/capabilities', '/ws/status', '/peers/meta', '/agent-state'].includes(r.path);
      checks.push({
        componentId: id, checkId: `${id}:pub-${slug(r.path)}`,
        via: 'https', url: `${base}${queryFix(r.path)}`,
        sourceEndpoint: `${base}${queryFix(r.path)}`,
        expectJson, expectDark, bareParam,
        envScope: c.env,
      });
    }

    // --- capabilities: сверка рекламируемого с доступным ---
    if (id === 'mainnet-node-1') {
      const base = (ob && ob.publicBase) || 'https://agentcoin.work';
      checks.push({
        componentId: id, checkId: `${id}:caps`,
        via: 'https', url: `${base}/capabilities`,
        sourceEndpoint: `${base}/capabilities`, expectJson: true, isCaps: true,
      });
    }
    // --- публичный монитор (для сравнения с локальными) ---
    if (id === 'node-monitor') {
      const base = (ob && ob.publicBase) || 'https://agentcoin.work';
      checks.push({
        componentId: id, checkId: 'node-monitor:pub-nodes',
        via: 'https', url: `${base}/network/nodes`,
        sourceEndpoint: `${base}/network/nodes`, expectJson: true, isMonitor: true,
      });
    }
  }
  return checks;
}

function parseCurlDashI(stdout) {
  const text = String(stdout || '');
  const sep = text.indexOf('\r\n\r\n');
  const cut = sep >= 0 ? sep : text.indexOf('\n\n');
  const head = cut >= 0 ? text.slice(0, cut) : text;
  const body = cut >= 0 ? text.slice(cut + (sep >= 0 ? 4 : 2)) : '';
  const lines = head.split(/\r?\n/);
  const m = (lines[0] || '').match(/^HTTP\/\S+\s+(\d{3})/);
  const httpStatus = m ? Number(m[1]) : null;
  let contentType = null;
  for (const l of lines.slice(1)) {
    const mm = l.match(/^content-type:\s*(.+)$/i);
    if (mm) contentType = mm[1].trim();
  }
  return { httpStatus, contentType, body };
}

function tryJson(body) {
  try {
    const t = String(body || '').trim();
    if (!t) return { ok: false };
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

function withTimeout(promise, ms, label) {
  let t;
  const gate = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); });
  return Promise.race([promise, gate]).finally(() => clearTimeout(t));
}

async function defaultFetchFn(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('http_timeout')), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'error' });
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      httpStatus: r.status,
      contentType: r.headers.get('content-type'),
      body: buf.slice(0, MAX_BODY_BYTES).toString('utf8'),
      truncated: buf.length > MAX_BODY_BYTES,
    };
  } finally {
    clearTimeout(t);
  }
}

async function defaultSshFn({ host, user, port }, command) {
  if (!isReadOnlySshCommand(command)) throw new Error('ssh_command_not_allowlisted');
  const args = [
    '-i', `${process.env.HOME || process.env.USERPROFILE || '~'}/.ssh/agentcoin-deploy`,
    '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.round(SSH_TIMEOUT_MS / 1000)}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(port || 22),
    `${user || 'root'}@${host}`, '--', command,
  ];
  const r = spawnSync('ssh', args, { encoding: 'utf8', timeout: SSH_TIMEOUT_MS });
  if (r.error) throw r.error;
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status };
}

function classifyHttp({ httpStatus, contentType, body, expectJson, expectDark, chainPin }) {
  const observedValue = { httpStatus, contentType, size: String(body || '').length };
  // Тёмный резерв: 403 с маркером — ожидаемо, это ok данного маршрута.
  if (expectDark && (httpStatus === 403 || httpStatus === 404)) {
    observedValue.dark = true;
    if (/reserve node: dark/i.test(String(body || ''))) observedValue.darkMarker = true;
    return { status: 'ok', observedValue, error: null };
  }
  if (httpStatus === null || httpStatus === undefined) {
    return { status: 'unavailable', observedValue, error: 'no_http_status' };
  }
  if (httpStatus >= 500) {
    return { status: 'unavailable', observedValue, error: `http_${httpStatus}` };
  }
  if (httpStatus === 403 || httpStatus === 404) {
    return { status: 'mismatch', observedValue, error: `http_${httpStatus}_on_advertised_route` };
  }
  if (httpStatus !== 200) {
    return { status: 'mismatch', observedValue, error: `http_${httpStatus}` };
  }
  // 200: проверяем структуру, а не только код.
  const looksHtml = /^\s*</.test(String(body || '')) || String(contentType || '').includes('text/html');
  if (expectJson) {
    const j = tryJson(body);
    if (!j.ok) {
      observedValue.bodyHead = String(body || '').slice(0, 200);
      return { status: 'mismatch', observedValue, error: `json_invalid: ${j.error}` };
    }
    const v = j.value;
    if (v && typeof v === 'object') {
      for (const k of ['chainId', 'genesisHash', 'genesis', 'blocks', 'tipHash', 'height', 'tipAgeSec']) {
        if (v[k] !== undefined) observedValue[k] = v[k];
      }
      if (chainPin) {
        const gotId = v.chainId || v.network;
        const gotGen = v.genesisHash || v.genesis;
        if (gotId && gotId !== chainPin.chainId) {
          return { status: 'mismatch', observedValue, error: `chain_pin_mismatch: chainId ${gotId} != ${chainPin.chainId}` };
        }
        if (gotGen && String(gotGen).toLowerCase() !== String(chainPin.genesis).toLowerCase()) {
          return { status: 'mismatch', observedValue, error: 'chain_pin_mismatch: genesis != registry pin' };
        }
      }
      // capabilities: фиксируем рекламируемый набор, сами пробы — отдельными наблюдениями.
      if (Array.isArray(v.availableReads)) observedValue.advertisedReads = v.availableReads.slice(0, 40);
      if (Array.isArray(v.reads)) observedValue.advertisedReads = v.reads.slice(0, 40);
    }
    return { status: 'ok', observedValue, error: null };
  }
  // HTML-страницы (статика): 200 + тело — достаточно для доступности; структура — в net-diff по маркерам.
  if (looksHtml) observedValue.html = true;
  else {
    const j = tryJson(body);
    if (j.ok && j.value && typeof j.value === 'object') {
      for (const k of ['chainId', 'genesisHash', 'blocks', 'tipHash']) {
        if (j.value[k] !== undefined) observedValue[k] = j.value[k];
      }
    }
  }
  return { status: 'ok', observedValue, error: null };
}

async function runOne(check, ctx) {
  const startedAt = new Date(ctx.now()).toISOString();
  const rec = {
    componentId: check.componentId, checkId: check.checkId,
    sourceHost: check.via === 'ssh' ? String(check.ssh.host) : (() => { try { return new URL(check.url).host; } catch { return check.url; } })(),
    sourceEndpoint: check.via === 'ssh' ? check.command : check.sourceEndpoint,
    startedAt, completedAt: null, status: 'unknown', observedValue: null, evidenceFile: null, error: null,
  };
  const saveEvidence = (ext, data) => {
    if (!ctx.evidenceDir) return null;
    try {
      fs.mkdirSync(ctx.evidenceDir, { recursive: true });
      // Портативные имена: ':' в checkId на Windows уходит в NTFS ADS и теряется в архивах.
      const safe = `${check.checkId}.${ext}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
      fs.writeFileSync(path.join(ctx.evidenceDir, safe), data);
      return `evidence/${safe}`;
    } catch { return null; }
  };
  try {
    if (check.via === 'ssh') {
      if (ctx.publicOnly) {
        rec.status = 'not_checked'; rec.error = 'ssh_skipped_public_only';
      } else {
        let raw;
        try {
          raw = await withTimeout(ctx.sshFn(check.ssh, check.command), ctx.sshTimeoutMs, 'ssh_timeout');
        } catch (e) {
          rec.status = 'unavailable';
          rec.error = /timeout/i.test(String(e && e.message)) ? 'ssh_timeout' : `ssh_unavailable: ${String((e && e.message) || e).slice(0, 200)}`;
          throw { done: true };
        }
        const out = String(raw.stdout || '');
        rec.evidenceFile = saveEvidence('txt', out.slice(0, MAX_BODY_BYTES));
        if (raw.exitCode !== 0 && !out.trim()) {
          rec.status = 'unavailable';
          rec.error = `ssh_exit_${raw.exitCode}: ${String(raw.stderr || '').slice(0, 200)}`;
          throw { done: true };
        }
        if (check.command.startsWith('curl ')) {
          const { httpStatus, contentType, body } = parseCurlDashI(out);
          rec.evidenceFile = saveEvidence('json', body.slice(0, MAX_BODY_BYTES));
          const r = classifyHttp({ httpStatus, contentType, body, expectJson: check.expectJson, chainPin: ctx.chainPin });
          rec.status = r.status; rec.observedValue = r.observedValue; rec.error = r.error;
        } else if (check.command.startsWith('sha256sum')) {
          const rows = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
          const files = {};
          for (const row of rows) {
            const m = row.match(/^([0-9a-f]{64})\s+(.+)$/);
            if (m) files[m[2]] = m[1];
          }
          rec.observedValue = { files, count: rows.length };
          rec.status = rows.length ? 'ok' : 'mismatch';
          if (!rows.length) rec.error = 'sha_empty';
        } else {
          rec.observedValue = { head: out.slice(0, 2000) };
          rec.status = out.trim() ? 'ok' : 'unknown';
          if (!out.trim()) rec.error = 'empty_output';
        }
      }
    } else {
      if (check.bareParam) {
        rec.status = 'not_checked';
        rec.error = 'bare_path_needs_parameter (registry note documents bare 404 as expected)';
        rec.observedValue = { skipped: check.sourceEndpoint };
        rec.completedAt = new Date(ctx.now()).toISOString();
        return rec;
      }
      let res;
      try {
        res = await withTimeout(ctx.fetchFn(check.url), ctx.httpTimeoutMs, 'http_timeout');
      } catch (e) {
        rec.status = 'unavailable';
        rec.error = /timeout/i.test(String(e && e.message)) ? 'http_timeout' : `http_unavailable: ${String((e && e.message) || e).slice(0, 200)}`;
        throw { done: true };
      }
      const body = String(res.body || '');
      rec.evidenceFile = saveEvidence(/json/i.test(String(res.contentType || '')) || /^\s*[{[]/.test(body) ? 'json' : 'txt', body.slice(0, MAX_BODY_BYTES));
      const r = classifyHttp({
        httpStatus: res.httpStatus, contentType: res.contentType, body,
        expectJson: check.expectJson, expectDark: check.expectDark, chainPin: ctx.chainPin,
      });
      rec.status = r.status; rec.observedValue = r.observedValue; rec.error = r.error;
      // envScope вне прод (staging-only/offline-pilot): 404 на проде согласуется с ожиданием «не опубликовано».
      if (rec.status === 'mismatch' && res.httpStatus === 404 && /staging|offline|pilot/i.test(String(check.envScope || ''))) {
        rec.status = 'ok';
        rec.error = null;
        rec.observedValue.scopeConsistent = `404 consistent with envScope ${check.envScope} (not published on prod)`;
      }
      // capabilities: разворачиваем рекламируемые GET-пути в отдельные пробы (только чтение).
      if (check.isCaps && rec.status === 'ok') {
        const j = tryJson(body);
        const adv = j.ok && j.value ? (j.value.availableReads || j.value.reads || []) : [];
        rec.observedValue.advertisedReads = Array.isArray(adv) ? adv.slice(0, 40) : [];
      }
    }
  } catch (e) {
    if (!e || !e.done) {
      rec.status = 'unavailable';
      rec.error = `collector_error: ${String((e && e.message) || e).slice(0, 200)}`;
    }
  }
  rec.completedAt = new Date(ctx.now()).toISOString();
  return rec;
}

export async function collect(reg, opts = {}) {
  const ctx = {
    fetchFn: opts.fetchFn || defaultFetchFn,
    sshFn: opts.sshFn || defaultSshFn,
    now: opts.now || Date.now,
    httpTimeoutMs: opts.httpTimeoutMs || HTTP_TIMEOUT_MS,
    sshTimeoutMs: opts.sshTimeoutMs || SSH_TIMEOUT_MS,
    concurrency: Math.max(1, Math.min(opts.concurrency || MAX_CONCURRENCY, 8)),
    evidenceDir: opts.evidenceDir || null,
    publicOnly: !!opts.publicOnly,
    chainPin: reg && reg.chain ? { chainId: reg.chain.network, genesis: reg.chain.genesis } : null,
  };
  const plan = buildPlan(reg);
  const observations = new Array(plan.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(ctx.concurrency, Math.max(plan.length, 1)) }, async () => {
    while (cursor < plan.length) {
      const i = cursor++;
      observations[i] = await runOne(plan[i], ctx);
    }
  });
  await Promise.all(workers);

  // Фаза 1b: capabilities рекламирует — проверяем доступность рекламируемого (только GET, только чтение).
  // Недоступный рекламируемый маршрут = mismatch его пробы, а не молчаливое доверие списку.
  try {
    const capsExtra = [];
    const pubBaseByComp = new Map();
    for (const c of (reg.components || [])) {
      if (c && c.observe && typeof c.observe.publicBase === 'string') pubBaseByComp.set(c.componentId, c.observe.publicBase.replace(/\/$/, ''));
    }
    for (const o of observations) {
      if (!o || o.checkId !== 'mainnet-node-1:caps' || o.status !== 'ok') continue;
      const adv = (o.observedValue && o.observedValue.advertisedReads) || [];
      const base = pubBaseByComp.get('mainnet-node-1') || 'https://agentcoin.work';
      for (const p of adv.slice(0, 12)) {
        if (typeof p !== 'string' || !p.startsWith('/')) continue;
        if (/^(POST|PUT|DELETE)\s/i.test(p)) continue;
        const clean = p.replace(/\s.*$/, '');
        if (observations.some((x) => x && x.sourceEndpoint === `${base}${queryFix(clean)}`)) continue;
        capsExtra.push({
          componentId: 'mainnet-node-1', checkId: `mainnet-node-1:caps-probe-${slug(clean)}`,
          via: 'https', url: `${base}${queryFix(clean)}`,
          sourceEndpoint: `${base}${queryFix(clean)}`,
          expectJson: true,
        });
      }
    }
    let cur = 0;
    const runCaps = async () => {
      while (cur < capsExtra.length) {
        const i = cur++;
        observations.push(await runOne(capsExtra[i], ctx));
      }
    };
    await Promise.all(Array.from({ length: Math.min(ctx.concurrency, Math.max(capsExtra.length, 1)) }, runCaps));
  } catch { /* необязательно: частичный сбой не уничтожает фазу 1 */ }

  // Фаза 2: общий номер блока — минимальная ok-высота по локальным info, сверка хэша одного блока.
  // Разные tipHash на последовательно опрошенных растущих вершинах сами по себе — не форк.
  try {
    const heights = [];
    for (const o of observations) {
      if (!o || o.status !== 'ok' || !o.observedValue) continue;
      if (!/:(local-info|pub-info)$/.test(o.checkId)) continue;
      const b = o.observedValue.blocks;
      if (Number.isSafeInteger(b)) heights.push({ checkId: o.checkId, componentId: o.componentId, blocks: b });
    }
    if (heights.length >= 2 && !ctx.publicOnly) {
      const minH = Math.min(...heights.map((h) => h.blocks));
      const comps = [...new Set(heights.map((h) => h.componentId))];
      const byComp = new Map();
      for (const c of (reg.components || [])) {
        if (c && c.observe && c.observe.ssh) byComp.set(c.componentId, c.observe.ssh);
      }
      const extra = [];
      for (const cid of comps) {
        const ssh = byComp.get(cid);
        if (!ssh) continue;
        extra.push({
          componentId: cid, checkId: `${cid}:common-block-${minH}`,
          via: 'ssh', ssh,
          command: `curl -sS -m 8 -i http://127.0.0.1:9335/blocks?from=${minH}&limit=1`,
          sourceEndpoint: `loopback /blocks?from=${minH}&limit=1 via ssh`,
          expectJson: true,
        });
      }
      for (const e of extra) {
        observations.push(await runOne(e, ctx));
      }
    }
  } catch { /* фаза 2 необязательна: частичный сбой не уничтожает фазу 1 */ }

  const summary = { total: observations.length };
  for (const o of observations) summary[o.status] = (summary[o.status] || 0) + 1;
  return { observations, summary, planSize: plan.length };
}

function parseArgs(argv) {
  const a = { registry: null, out: null, publicOnly: false, concurrency: MAX_CONCURRENCY };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--registry') a.registry = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--public-only') a.publicOnly = true;
    else if (argv[i] === '--concurrency') a.concurrency = Number(argv[++i]);
  }
  return a;
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href; } catch { return false; } })();
if (isMain) {
  const args = parseArgs(process.argv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const regFile = args.registry || path.resolve(here, '..', 'config', 'unified-registry.json');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = args.out || path.resolve(here, '..', 'reports', `stage2-${stamp}`);
  const evidenceDir = path.join(outDir, 'evidence');
  const { observations, summary } = await collect(reg, {
    evidenceDir, publicOnly: args.publicOnly, concurrency: args.concurrency,
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'observations.json'), JSON.stringify({ collectedAt: new Date().toISOString(), publicOnly: args.publicOnly, summary, observations }, null, 1));
  const byStatus = {};
  for (const o of observations) {
    byStatus[o.status] = byStatus[o.status] || [];
    byStatus[o.status].push(`${o.checkId} [${o.componentId}] err=${o.error || '-'} src=${o.sourceEndpoint}`);
  }
  let md = `# Этап 2 — сбор фактического состояния (только чтение)\n\n- collectedAt=${new Date().toISOString()} publicOnly=${args.publicOnly}\n- summary: ${JSON.stringify(summary)}\n`;
  for (const [st, rows] of Object.entries(byStatus)) {
    md += `\n## ${st} (${rows.length})\n`;
    for (const r of rows) md += `- ${r}\n`;
  }
  md += `\nСтарые evidence (E01–E25) за новый опрос не выдаются: доказательства — только evidence/ этого сбора.\n`;
  fs.writeFileSync(path.join(outDir, 'COLLECT.md'), md);
  console.log(`COLLECT OK total=${summary.total} ` + Object.entries(summary).filter(([k]) => k !== 'total').map(([k, v]) => `${k}=${v}`).join(' '));
  console.log(`out=${outDir}`);
}
