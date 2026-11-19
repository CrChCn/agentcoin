#!/usr/bin/env node
// net-collect.mjs — Этап 2: сбор фактического состояния, только чтение.
// Цели — ТОЛЬКО из config/unified-registry.json (поля routes + observe).
// Никакого второго списка серверов: хосты берутся из observe.ssh / observe.publicBase / routes.
// Только GET и read-only команды. POST /tx /mine /mainnet/* (кроме GET /mainnet/info) не опрашиваются.
// Тайм-ауты конечны, параллелизм ограничен 4, повторов нет.
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
export const HEX64_RE = /^[0-9a-f]{64}$/i;
const DARK_MARKER_RE = /reserve node:\s*dark/i;

// Строго определённые read-only операции. Составные shell-конструкции запрещены:
// ';', '|', '&' вне одинарных кавычек curl, backtick, $(), переводы строк, редиректы.
// fix4: глобальный `ps -eo pid,user,args` и сырой `ss -ltnp` удалены — секреты
// чужих процессов не читаются и не сохраняются. Только точечный `ps -p <PID>`
// по числовому PID из systemctl show и `ss -ltn` без -p с фильтрацией.
const SSH_PATTERNS = [
  // curl к loopback, URL в одинарных кавычках, внутри только безопасные символы.
  /^curl -sS -m 8 -i 'http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9\/._?=&%-]*'$/,
  /^systemctl is-active [A-Za-z0-9_.@:-]+$/,
  /^systemctl show [A-Za-z0-9_.@:-]+ --property=(ActiveState|MainPID|User|ExecStart|ExecMainStartTimestamp)(,(ActiveState|MainPID|User|ExecStart|ExecMainStartTimestamp))*$/,
  /^ps -p \d+ -o pid=,user=,lstart=$/,
  /^sha256sum (\/opt\/[A-Za-z0-9_.\/-]+)( \/opt\/[A-Za-z0-9_.\/-]+)*$/,
  /^ss -ltn$/,
];

// fix4: маскирование секретов перед сохранением evidence. 64-hex хэши цепи
// (tipHash/genesis/sha256sum) НЕ трогаем — маскируем только значения с
// ключевыми словами token/password/secret/api-key/bearer и PEM-ключи.
export function scrubSecrets(text) {
  let s = String(text || '');
  s = s.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED-PRIVATE-KEY]');
  s = s.replace(/(--(?:token|password|passwd|secret|api[-_]?key)\s+)\S+/gi, '$1[REDACTED]');
  s = s.replace(/((?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?)[^'"\s;,]+/gi, '$1[REDACTED]');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]{8,}/g, '$1[REDACTED]');
  return s;
}

export function isReadOnlySshCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  if (/[\n\r`$()]/.test(cmd)) return false;
  const c = cmd.trim();
  // Грубые составные операторы вне кавычек curl запрещены.
  // Для curl разрешён & только внутри одинарных кавычек (query ?from=&limit=).
  let stripped = c;
  if (stripped.startsWith('curl ')) {
    const m = stripped.match(/'(http:\/\/127\.0\.0\.1:\d+\/[^']*)'$/);
    if (!m) return false;
    stripped = stripped.slice(0, stripped.indexOf("'")) + 'URL';
  }
  if (/[;|&<>]/.test(stripped)) return false;
  if (/(^|\s)(env|export|cat|less|more|head|tail|grep|awk|sed|xargs|tee|sudo|su|chmod|chown|rm|mv|cp|dd|sh|bash)(\s|$)/.test(stripped)) return false;
  if (/\.env|settlement-policy|mainnet-settlements|id_rsa|id_ed25519|\/root\/\.ssh\/|sha256sum\s+\/etc\//.test(c)) return false;
  return SSH_PATTERNS.some((re) => re.test(c));
}

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';
}

function queryFix(p) {
  if (p === '/blocks') return '/blocks?n=1';
  if (p === '/headers') return '/headers?from=0&limit=1';
  return p;
}

function sshCurl(loop, p) {
  return `curl -sS -m 8 -i '${loop}${queryFix(p)}'`;
}

// План строится ТОЛЬКО из реестра. Пустой план при отсутствии observe/routes — честный, не ошибка.
export function buildPlan(reg) {
  const checks = [];
  const comps = Array.isArray(reg?.components) ? reg.components : [];
  for (const c of comps) {
    if (!c || typeof c !== 'object' || typeof c.componentId !== 'string') continue;
    const id = c.componentId;
    const ob = c.observe && typeof c.observe === 'object' ? c.observe : null;

    // --- локальные проверки ноды через SSH (read-only, строго по одной операции) ---
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
          command: sshCurl(loop, ep),
          sourceEndpoint: `loopback ${loop}${queryFix(ep)} via ssh`,
          expectJson: true, endpoint: ep, kind: 'loopback-http',
        });
      }
      const units = Array.isArray(ob.units) ? ob.units.filter((u) => typeof u === 'string' && u) : [];
      if (units.length) {
        const unit = units[0];
        checks.push({
          componentId: id, checkId: `${id}:proc-unit-show`,
          via: 'ssh', ssh: ob.ssh,
          command: `systemctl show ${unit} --property=ActiveState,MainPID,User,ExecStart,ExecMainStartTimestamp`,
          sourceEndpoint: `systemctl show ${unit} via ssh`, expectJson: false, kind: 'unit-show',
          expectedUnit: unit,
        });
        checks.push({
          componentId: id, checkId: `${id}:proc-unit-active`,
          via: 'ssh', ssh: ob.ssh,
          command: `systemctl is-active ${unit}`,
          sourceEndpoint: `systemctl is-active ${unit} via ssh`, expectJson: false, kind: 'unit-active',
          expectedUnit: unit,
        });
      }
      // fix4: глобального ps нет. Точечная проверка PID добавляется динамически
      // в collect() после unit-show (только числовой MainPID, без args чужих процессов).
      const files = Array.isArray(ob.files) ? ob.files.filter((f) => typeof f === 'string' && f.startsWith('/')) : [];
      if (files.length) {
        checks.push({
          componentId: id, checkId: `${id}:files-sha`,
          via: 'ssh', ssh: ob.ssh,
          command: `sha256sum ${files.join(' ')}`,
          sourceEndpoint: `sha256sum ${files.length} file(s) via ssh`, expectJson: false, kind: 'sha',
          expectedFiles: files.slice(),
        });
      }
      const ports = Array.isArray(ob.listenPorts) ? ob.listenPorts.filter(Number.isInteger) : [];
      checks.push({
        componentId: id, checkId: `${id}:listen`,
        via: 'ssh', ssh: ob.ssh,
        command: 'ss -ltn',
        sourceEndpoint: 'ss -ltn via ssh (filtered to expected ports)', expectJson: false, kind: 'ss',
        expectedPorts: ports.slice(),
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
        envScope: c.env, endpoint: r.path, kind: 'public',
      });
    }

    // --- capabilities: сверка рекламируемого с доступным ---
    if (id === 'mainnet-node-1') {
      const base = (ob && ob.publicBase) || 'https://agentcoin.work';
      checks.push({
        componentId: id, checkId: `${id}:caps`,
        via: 'https', url: `${base}/capabilities`,
        sourceEndpoint: `${base}/capabilities`, expectJson: true, isCaps: true,
        endpoint: '/capabilities', kind: 'caps',
      });
    }
    // --- публичный монитор (для сравнения с локальными) ---
    if (id === 'node-monitor') {
      const base = (ob && ob.publicBase) || 'https://agentcoin.work';
      checks.push({
        componentId: id, checkId: 'node-monitor:pub-nodes',
        via: 'https', url: `${base}/network/nodes`,
        sourceEndpoint: `${base}/network/nodes`, expectJson: true, isMonitor: true,
        endpoint: '/network/nodes', kind: 'monitor',
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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function getAdvertisedLists(v) {
  if (!isPlainObject(v)) return [];
  const out = [];
  for (const k of ['get', 'availableReads', 'reads']) {
    if (Array.isArray(v[k])) {
      for (const p of v[k]) if (typeof p === 'string') out.push(p);
    }
  }
  return [...new Set(out)];
}

export function isParamPath(p) {
  return /:[a-zA-Z_]|[{}\[\]*<>]/.test(String(p || ''));
}

export function tipHeightFromBlocks(blocks) {
  if (!Number.isSafeInteger(blocks) || blocks < 1) return null;
  return blocks - 1;
}

export function commonTipHeight(blocksArr) {
  if (!Array.isArray(blocksArr) || !blocksArr.length) return null;
  for (const b of blocksArr) {
    if (!Number.isSafeInteger(b) || b < 1) return null;
  }
  return Math.min(...blocksArr.map((b) => b - 1));
}

// fix5: единое локальное представление ноды. blocks — только из local-info
// (число блоков, не высота); tipHeight = blocks - 1; tipHash — только из
// local-health, иначе local-ws-status, иначе local-life; молча не подставляем —
// источник каждого поля фиксируется в sources.
export function unifyLocalState(allObservations, componentId) {
  const list = Array.isArray(allObservations)
    ? allObservations.filter((o) => o && o.componentId === componentId)
    : [];
  const findOk = (re) => list.find((o) => o && re.test(o.checkId || '') && o.status === 'ok' && o.observedValue);
  const info = findOk(/:local-info$/);
  const health = findOk(/:local-health$/);
  const ws = findOk(/:local-ws-status$/);
  const life = findOk(/:local-life$/);
  const sources = {};
  let blocks = null;
  if (info && Number.isSafeInteger(info.observedValue.blocks) && info.observedValue.blocks >= 1) {
    blocks = info.observedValue.blocks;
    sources.blocks = info.checkId;
  }
  const tipHeight = tipHeightFromBlocks(blocks);
  if (tipHeight !== null) sources.tipHeight = `${sources.blocks || 'local-info'}: blocks-1`;
  let tipHash = null;
  let tipSrc = null;
  for (const cand of [health, ws, life]) {
    const h = cand && cand.observedValue && cand.observedValue.tipHash;
    if (typeof h === 'string' && HEX64_RE.test(h.trim())) {
      tipHash = h.trim();
      tipSrc = cand.checkId;
      break;
    }
  }
  if (tipHash) sources.tipHash = tipSrc;
  let chainId = null;
  let chainSrc = null;
  for (const cand of [info, health, ws]) {
    const v = cand && cand.observedValue && (cand.observedValue.chainId || cand.observedValue.network);
    if (typeof v === 'string' && v) { chainId = v; chainSrc = cand.checkId; break; }
  }
  if (chainId) sources.chainId = chainSrc;
  let genesis = null;
  let genSrc = null;
  for (const cand of [info, ws, health]) {
    const v = cand && cand.observedValue && (cand.observedValue.genesisHash || cand.observedValue.genesis);
    if (typeof v === 'string' && HEX64_RE.test(v.trim())) { genesis = v.trim(); genSrc = cand.checkId; break; }
  }
  if (genesis) sources.genesis = genSrc;
  let tipAgeSec = null;
  for (const cand of [health, ws, life, info]) {
    const v = cand && cand.observedValue && cand.observedValue.tipAgeSec;
    if (Number.isSafeInteger(v)) { tipAgeSec = v; break; }
  }
  return { blocks, tipHeight, tipHash, chainId, genesis, tipAgeSec, sources };
}

export function extractCommonBlock(body, wantHeight) {
  const j = tryJson(body);
  if (!j.ok || !isPlainObject(j.value)) return { ok: false, error: 'no_valid_hash' };
  const v = j.value;
  let cand = null;
  if (Array.isArray(v.blocks) && v.blocks.length) cand = v.blocks[0];
  else if (Array.isArray(v.headers) && v.headers.length) cand = v.headers[0];
  else if (isPlainObject(v.block)) cand = v.block;
  if (!isPlainObject(cand)) return { ok: false, error: 'no_valid_hash' };
  const h = Number(cand.height);
  const hash = cand.hash || cand.tipHash;
  if (!Number.isSafeInteger(h) || typeof hash !== 'string' || !HEX64_RE.test(hash.trim())) {
    return { ok: false, error: 'no_valid_hash' };
  }
  if (Number.isSafeInteger(wantHeight) && h !== wantHeight) {
    return { ok: false, error: `height_mismatch: got ${h} want ${wantHeight}`, height: h, hash: hash.trim() };
  }
  return { ok: true, height: h, hash: hash.trim() };
}

function withTimeout(promise, ms, label) {
  let t;
  const gate = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); });
  return Promise.race([promise, gate]).finally(() => clearTimeout(t));
}

// Чтение тела с ограничением потока: прекращаем при превышении лимита, фиксируем усечение.
export async function readLimitedBody(response, limit = MAX_BODY_BYTES) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    return { text: buf.slice(0, limit).toString('utf8'), truncated: buf.length > limit, size: buf.length };
  }
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      size += chunk.length;
      if (size > limit) {
        truncated = true;
        const over = size - limit;
        if (over < chunk.length) chunks.push(chunk.slice(0, chunk.length - over));
        size = limit;
        try { await reader.cancel(); } catch { /* ignore */ }
        // Дочитывать остаток нельзя: фиксируем усечение и выходим.
        // Пытаемся слить то, что уже прочитали.
        // Оставшийся размер неизвестен — помечаем truncated.
        // Для точного size продолжаем считать невозможным без полного чтения.
        break;
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated, size: truncated ? limit + 1 : size };
}

async function defaultFetchFn(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('http_timeout')), HTTP_TIMEOUT_MS);
  try {
    // redirect manual: 3xx фиксируем как mismatch с location, а не unavailable.
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    const ct = r.headers.get('content-type');
    const loc = r.headers.get('location');
    const { text, truncated } = await readLimitedBody(r, MAX_BODY_BYTES);
    return { httpStatus: r.status, contentType: ct, body: text, truncated, location: loc };
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

function isJsonContentType(ct) {
  return /application\/json/i.test(String(ct || '')) || /\+json/i.test(String(ct || ''));
}

function classifyHttp({ httpStatus, contentType, body, expectJson, expectDark, chainPin, endpoint }) {
  const observedValue = { httpStatus, contentType, size: String(body || '').length };
  // Тёмный резерв: требуется документированный статус 403 И маркер ответа.
  if (expectDark) {
    if (httpStatus === 403 && DARK_MARKER_RE.test(String(body || ''))) {
      observedValue.dark = true;
      observedValue.darkMarker = true;
      return { status: 'ok', observedValue, error: null };
    }
    if (httpStatus === 403) {
      observedValue.dark = true;
      observedValue.darkMarker = false;
      return { status: 'mismatch', observedValue, error: 'dark_marker_missing: 403 without reserve marker' };
    }
    if (httpStatus === 404) {
      return { status: 'mismatch', observedValue, error: 'http_404_not_dark: unknown 404, expected dark 403 with marker' };
    }
    if (httpStatus === null || httpStatus === undefined) {
      return { status: 'unavailable', observedValue, error: 'no_http_status' };
    }
    if (httpStatus >= 500) {
      return { status: 'unavailable', observedValue, error: `http_${httpStatus}` };
    }
    if (httpStatus === 200) {
      // Неожиданный 200 на тёмном маршруте (возможен прокси) — проверяем как обычный JSON,
      // но требуем явной пометки; без неё это находка, а не ok.
      // Падаем ниже в обычную валидацию с флагом darkUnexpected.
      observedValue.darkUnexpected200 = true;
    } else if (httpStatus !== 200) {
      return { status: 'mismatch', observedValue, error: `http_${httpStatus}_on_dark_route` };
    }
  }
  if (httpStatus === null || httpStatus === undefined) {
    return { status: 'unavailable', observedValue, error: 'no_http_status' };
  }
  if (httpStatus >= 500) {
    return { status: 'unavailable', observedValue, error: `http_${httpStatus}` };
  }
  if (!expectDark && (httpStatus === 403 || httpStatus === 404)) {
    return { status: 'mismatch', observedValue, error: `http_${httpStatus}_on_advertised_route` };
  }
  if (httpStatus >= 300 && httpStatus < 400) {
    observedValue.location = null;
    return { status: 'mismatch', observedValue, error: `http_${httpStatus}_redirect` };
  }
  if (httpStatus !== 200) {
    return { status: 'mismatch', observedValue, error: `http_${httpStatus}` };
  }
  // 200: проверяем структуру, а не только код.
  const looksHtml = /^\s*</.test(String(body || '')) || String(contentType || '').includes('text/html');
  if (expectJson) {
    if (!isJsonContentType(contentType)) {
      observedValue.bodyHead = String(body || '').slice(0, 200);
      return { status: 'mismatch', observedValue, error: `content_type_mismatch: ${String(contentType || 'none').slice(0, 80)}` };
    }
    const j = tryJson(body);
    if (!j.ok) {
      observedValue.bodyHead = String(body || '').slice(0, 200);
      return { status: 'mismatch', observedValue, error: `json_invalid: ${j.error}` };
    }
    const v = j.value;
    if (!isPlainObject(v)) {
      observedValue.bodyHead = String(body || '').slice(0, 200);
      return { status: 'mismatch', observedValue, error: 'json_shape_invalid: expected object' };
    }
    const need = (cond, err) => { if (!cond) return err; return null; };
    const ep = String(endpoint || '');
    const fail = (err) => ({ status: 'mismatch', observedValue, error: err });
    // По-эндпоинтная структура.
    if (ep === '/info') {
      const gotId = v.chainId || v.network;
      const gotGen = v.genesisHash || v.genesis;
      const blocks = v.blocks ?? v.height;
      let e = need(typeof gotId === 'string' && gotId, 'structure_missing: chainId');
      if (e) return fail(e);
      e = need(typeof gotGen === 'string' && HEX64_RE.test(String(gotGen)), 'structure_missing: genesisHash');
      if (e) return fail(e);
      e = need(Number.isSafeInteger(blocks) && blocks >= 0, 'structure_missing: blocks');
      if (e) return fail(e);
      observedValue.chainId = gotId;
      observedValue.genesisHash = gotGen;
      observedValue.blocks = blocks;
      if (chainPin) {
        if (gotId !== chainPin.chainId) return fail(`chain_pin_mismatch: chainId ${gotId} != ${chainPin.chainId}`);
        if (String(gotGen).toLowerCase() !== String(chainPin.genesis).toLowerCase()) return fail('chain_pin_mismatch: genesis != registry pin');
      }
      for (const k of ['tipHash', 'tipAgeSec', 'mempool']) if (v[k] !== undefined) observedValue[k] = v[k];
    } else if (ep === '/health') {
      let e = need(v.ok === true, 'structure_missing: ok:true');
      if (e) return fail(e);
      e = need(v.service === 'agt-node', 'structure_missing: service');
      if (e) return fail(e);
      e = need(Number.isSafeInteger(v.blocks), 'structure_missing: blocks');
      if (e) return fail(e);
      e = need(typeof v.tipHash === 'string' && HEX64_RE.test(v.tipHash), 'structure_missing: tipHash');
      if (e) return fail(e);
      observedValue.blocks = v.blocks;
      observedValue.tipHash = v.tipHash;
      observedValue.chainId = v.chainId || undefined;
      for (const k of ['tipAgeSec', 'chainValid', 'overloaded']) if (v[k] !== undefined) observedValue[k] = v[k];
      if (chainPin && v.chainId && v.chainId !== chainPin.chainId) return fail(`chain_pin_mismatch: chainId ${v.chainId} != ${chainPin.chainId}`);
    } else if (ep === '/life') {
      let e = need(typeof v.alive === 'boolean', 'structure_missing: alive');
      if (e) return fail(e);
      e = need(Number.isSafeInteger(v.blocks), 'structure_missing: blocks');
      if (e) return fail(e);
      e = need(typeof v.tipHash === 'string' && HEX64_RE.test(v.tipHash), 'structure_missing: tipHash');
      if (e) return fail(e);
      observedValue.blocks = v.blocks;
      observedValue.tipHash = v.tipHash;
      for (const k of ['tipAgeSec', 'fresh', 'chainValid', 'chainIssue']) if (v[k] !== undefined) observedValue[k] = v[k];
    } else if (ep === '/blocks' || ep.startsWith('/blocks')) {
      let e = need(Array.isArray(v.blocks) && v.blocks.length > 0, 'structure_missing: blocks[]');
      if (e) return fail(e);
      const b0 = v.blocks[0];
      e = need(isPlainObject(b0) && Number.isSafeInteger(b0.height) && typeof b0.hash === 'string' && HEX64_RE.test(b0.hash), 'structure_missing: blocks[0].height/hash');
      if (e) return fail(e);
      observedValue.blocks = v.blocks.map((b) => ({ height: b.height, hash: b.hash })).slice(0, 4);
      if (typeof v.height === 'number') observedValue.height = v.height;
    } else if (ep === '/headers' || ep.startsWith('/headers')) {
      let e = need(Array.isArray(v.headers) && v.headers.length > 0, 'structure_missing: headers[]');
      if (e) return fail(e);
      const h0 = v.headers[0];
      e = need(isPlainObject(h0) && Number.isSafeInteger(h0.height) && typeof h0.hash === 'string' && HEX64_RE.test(h0.hash), 'structure_missing: headers[0].height/hash');
      if (e) return fail(e);
      observedValue.headers = v.headers.map((h) => ({ height: h.height, hash: h.hash })).slice(0, 4);
      if (typeof v.height === 'number') observedValue.height = v.height;
    } else if (ep === '/capabilities') {
      const adv = getAdvertisedLists(v);
      let e = need(v.ok === true, 'structure_missing: ok:true');
      if (e) return fail(e);
      e = need(adv.length > 0 && adv.every((p) => p.startsWith('/')), 'structure_missing: get[]');
      if (e) return fail(e);
      observedValue.advertisedReads = adv.slice();
      observedValue.advertisedCount = adv.length;
    } else if (ep === '/network/nodes') {
      let e = need(v.ok === true && Array.isArray(v.nodes) && v.nodes.length > 0, 'structure_missing: nodes[]');
      if (e) return fail(e);
      observedValue.nodes = v.nodes.map((n) => ({
        name: n.name, reachable: n.reachable, blocks: n.blocks, tipHash: n.tipHash, status: n.status,
      })).slice(0, 8);
      observedValue.maxObservedBlocks = v.maxObservedBlocks ?? null;
    } else if (ep === '/ws/status') {
      let e = need(Number.isSafeInteger(v.blocks), 'structure_missing: blocks');
      if (e) return fail(e);
      e = need(typeof v.tipHash === 'string' && v.tipHash, 'structure_missing: tipHash');
      if (e) return fail(e);
      observedValue.blocks = v.blocks;
      observedValue.tipHash = v.tipHash;
      for (const k of ['chainId', 'genesisHash', 'genesis', 'tipAgeSec', 'chainValid']) if (v[k] !== undefined) observedValue[k] = v[k];
      if (chainPin) {
        const gotId = v.chainId;
        const gotGen = v.genesisHash || v.genesis;
        if (gotId && gotId !== chainPin.chainId) return fail(`chain_pin_mismatch: chainId ${gotId} != ${chainPin.chainId}`);
        if (gotGen && String(gotGen).toLowerCase() !== String(chainPin.genesis).toLowerCase()) return fail('chain_pin_mismatch: genesis != registry pin');
      }
    } else {
      // Прочие JSON-эндпоинты: требуем объект; копируем известные поля; пин проверяем только при наличии.
      for (const k of ['chainId', 'genesisHash', 'genesis', 'blocks', 'tipHash', 'height', 'tipAgeSec']) {
        if (v[k] !== undefined) observedValue[k] = v[k];
      }
      if (chainPin) {
        const gotId = v.chainId || v.network;
        const gotGen = v.genesisHash || v.genesis;
        // Отсутствующий пин на цепных путях — mismatch, а не совпадение.
        if ((ep === '/info' || ep === '/health' || ep === '/life') && (!gotId || !gotGen)) {
          return fail('chain_pin_missing: expected chain identifiers absent');
        }
        if (gotId && gotId !== chainPin.chainId) return fail(`chain_pin_mismatch: chainId ${gotId} != ${chainPin.chainId}`);
        if (gotGen && String(gotGen).toLowerCase() !== String(chainPin.genesis).toLowerCase()) return fail('chain_pin_mismatch: genesis != registry pin');
      }
      const adv = getAdvertisedLists(v);
      if (adv.length) { observedValue.advertisedReads = adv.slice(); observedValue.advertisedCount = adv.length; }
      if (Array.isArray(v.nodes)) observedValue.nodes = v.nodes.slice(0, 8);
    }
    if (observedValue.darkUnexpected200) {
      return { status: 'mismatch', observedValue, error: 'dark_expected_403_got_200' };
    }
    return { status: 'ok', observedValue, error: null };
  }
  // HTML-страницы (статика) и lenient caps-пробы: 200 + непустое тело — доступность.
  // Если content-type заявляет JSON, требуем валидный JSON даже в lenient-режиме.
  if (looksHtml) {
    if (!String(body || '').trim()) return { status: 'mismatch', observedValue, error: 'empty_body' };
    observedValue.html = true;
    return { status: 'ok', observedValue, error: null };
  }
  const bodyTrim = String(body || '').trim();
  if (!bodyTrim) return { status: 'mismatch', observedValue, error: 'empty_body' };
  if (isJsonContentType(contentType)) {
    const j = tryJson(body);
    if (!j.ok) {
      observedValue.bodyHead = String(body || '').slice(0, 200);
      return { status: 'mismatch', observedValue, error: `json_invalid: ${j.error}` };
    }
    if (!isPlainObject(j.value) && !Array.isArray(j.value)) {
      return { status: 'mismatch', observedValue, error: 'json_shape_invalid: expected object' };
    }
    if (isPlainObject(j.value)) {
      for (const k of ['chainId', 'genesisHash', 'blocks', 'tipHash']) {
        if (j.value[k] !== undefined) observedValue[k] = j.value[k];
      }
    }
    return { status: 'ok', observedValue, error: null };
  }
  const j = tryJson(body);
  if (j.ok && isPlainObject(j.value)) {
    for (const k of ['chainId', 'genesisHash', 'blocks', 'tipHash']) {
      if (j.value[k] !== undefined) observedValue[k] = j.value[k];
    }
  }
  return { status: 'ok', observedValue, error: null };
}

function parseSystemctlShow(out) {
  const res = {};
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.*)\s*$/);
    if (m) res[m[1]] = m[2];
  }
  // Форма --value (три строки без ключей) — не принимаем как доказанную: требуем ключи.
  return res;
}

// fix4: точечная проверка одного PID (без args чужих процессов).
// Команда: ps -p <PID> -o pid=,user=,lstart=  (без заголовка, одна строка).
export function parsePidCheck(out, wantPid) {
  const line = String(out || '').split('\n').map((l) => l.trim()).find((l) => l);
  if (!line) return { ok: false, error: 'empty_ps_output' };
  const m = line.match(/^(\d+)\s+(\S+)\s+(.+)$/);
  if (!m) return { ok: false, error: 'ps_parse_failed' };
  const pid = Number(m[1]);
  if (!Number.isSafeInteger(pid) || pid !== Number(wantPid)) {
    return { ok: false, error: `pid_mismatch: got ${m[1]} want ${wantPid}` };
  }
  return { ok: true, pid, user: m[2], lstart: m[3].slice(0, 120) };
}

function parseSs(out) {
  const ports = new Set();
  for (const m of String(out || '').matchAll(/:(\d+)\b/g)) {
    const p = Number(m[1]);
    if (Number.isInteger(p) && p > 0 && p < 65536) ports.add(p);
  }
  return [...ports].sort((a, b) => a - b);
}

// fix4: только строки ожидаемых портов, без сырого полного вывода.
export function filterSsLines(out, expectedPorts) {
  const lines = String(out || '').split('\n');
  const want = new Set((expectedPorts || []).map(Number));
  const kept = [];
  for (const line of lines) {
    const m = line.match(/:(\d+)\b/);
    if (m && want.has(Number(m[1]))) kept.push(scrubSecrets(line.trim()).slice(0, 300));
  }
  return kept.slice(0, 32);
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
      fs.writeFileSync(path.join(ctx.evidenceDir, safe), scrubSecrets(String(data ?? '')));
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
        const stderrHead = scrubSecrets(String(raw.stderr || '')).slice(0, 300);
        const exitCode = raw.exitCode;
        // fix4: для ss сырой вывод не сохраняем (см. ветку ss ниже); остальное — со scrub.
        if (check.kind !== 'ss') rec.evidenceFile = saveEvidence('txt', scrubSecrets(out).slice(0, MAX_BODY_BYTES));
        if (check.kind === 'loopback-http' || check.command.startsWith('curl ')) {
          if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
            rec.status = 'unavailable';
            rec.error = `ssh_curl_exit_${exitCode}: ${stderrHead}`;
            rec.observedValue = { exitCode, stderr: stderrHead };
            throw { done: true };
          }
          const { httpStatus, contentType, body } = parseCurlDashI(out);
          // common-block: строгая проверка запрошенной высоты и валидного хэша.
          const cm = /common-block-(\d+)/.exec(check.checkId);
          if (cm) {
            const want = Number(cm[1]);
            const ex = extractCommonBlock(body, want);
            rec.evidenceFile = saveEvidence('json', body.slice(0, MAX_BODY_BYTES));
            if (ex.ok) {
              rec.status = 'ok';
              rec.observedValue = { requestedHeight: want, height: ex.height, hash: ex.hash, httpStatus, exitCode };
              rec.error = null;
            } else {
              rec.status = 'unknown';
              rec.observedValue = { requestedHeight: want, httpStatus, exitCode, bodyHead: body.slice(0, 200) };
              rec.error = ex.error || 'no_valid_hash';
            }
          } else {
            rec.evidenceFile = saveEvidence('json', body.slice(0, MAX_BODY_BYTES));
            const r = classifyHttp({ httpStatus, contentType, body, expectJson: check.expectJson, chainPin: ctx.chainPin, endpoint: check.endpoint });
            r.observedValue.exitCode = exitCode;
            rec.status = r.status; rec.observedValue = r.observedValue; rec.error = r.error;
          }
        } else if (check.kind === 'sha' || check.command.startsWith('sha256sum')) {
          const rows = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
          const files = {};
          for (const row of rows) {
            const m = row.match(/^([0-9a-f]{64})\s+(.+)$/);
            if (m) files[m[2]] = m[1].toLowerCase();
          }
          const expected = Array.isArray(check.expectedFiles) ? check.expectedFiles : [];
          const missing = expected.filter((f) => !files[f] || !HEX64_RE.test(files[f]));
          rec.observedValue = { files, count: rows.length, expectedFiles: expected, exitCode, stderr: stderrHead };
          if (exitCode !== 0 && !out.trim()) {
            rec.status = 'unavailable';
            rec.error = `ssh_exit_${exitCode}: ${stderrHead}`;
          } else if (missing.length) {
            rec.status = 'mismatch';
            rec.error = `sha_missing: ${missing.join(', ').slice(0, 200)}`;
          } else if (!rows.length) {
            rec.status = 'mismatch';
            rec.error = 'sha_empty';
          } else {
            rec.status = 'ok';
            rec.error = null;
          }
        } else if (check.kind === 'unit-show') {
          const parsed = parseSystemctlShow(out);
          // fix4: ExecStart может содержать секреты в аргументах — маскируем перед сохранением.
          for (const k of Object.keys(parsed)) parsed[k] = scrubSecrets(parsed[k]).slice(0, 500);
          rec.observedValue = { ...parsed, exitCode, stderr: stderrHead };
          if (exitCode !== 0 && !out.trim()) {
            rec.status = 'unavailable';
            rec.error = `ssh_exit_${exitCode}: ${stderrHead}`;
          } else if (!parsed.ActiveState) {
            rec.status = 'unknown';
            rec.error = 'unit_state_unknown: ActiveState absent';
          } else if (parsed.ActiveState !== 'active') {
            rec.status = 'mismatch';
            rec.error = `unit_inactive: ${parsed.ActiveState}`;
          } else {
            rec.status = 'ok';
            rec.error = null;
          }
        } else if (check.kind === 'unit-active') {
          const state = out.trim().split('\n')[0].trim();
          rec.observedValue = { state, exitCode, stderr: stderrHead };
          // is-active возвращает ненулевой код при inactive — это mismatch, а не недоступность.
          if (state === 'active' && exitCode === 0) {
            rec.status = 'ok';
            rec.error = null;
          } else if (!state) {
            rec.status = 'unavailable';
            rec.error = `ssh_exit_${exitCode}: ${stderrHead || 'empty'}`;
          } else {
            rec.status = 'mismatch';
            rec.error = `unit_not_active: ${state}`;
          }
        } else if (check.kind === 'pid-check') {
          // fix4: только предварительно проверенный числовой PID, без args посторонних.
          const want = Number(check.expectedPid);
          if (!Number.isSafeInteger(want) || want <= 0) {
            rec.status = 'unknown';
            rec.error = 'pid_check_no_valid_pid';
            rec.observedValue = { exitCode, stderr: stderrHead };
          } else if (exitCode !== 0 && !out.trim()) {
            rec.status = 'unavailable';
            rec.error = `ssh_exit_${exitCode}: ${stderrHead}`;
            rec.observedValue = { expectedPid: want, exitCode, stderr: stderrHead };
          } else {
            const parsed = parsePidCheck(out, want);
            if (parsed.ok) {
              rec.status = 'ok';
              rec.error = null;
              // В evidence — только подтверждение целевого PID, без чужих строк.
              rec.observedValue = { pid: parsed.pid, user: parsed.user, lstart: parsed.lstart, exitCode, stderr: stderrHead };
              rec.evidenceFile = saveEvidence('json', JSON.stringify({ pid: parsed.pid, user: parsed.user, lstart: parsed.lstart }, null, 1));
            } else {
              rec.status = 'mismatch';
              rec.error = `process_not_confirmed: ${parsed.error}`;
              rec.observedValue = { expectedPid: want, exitCode, stderr: stderrHead };
              rec.evidenceFile = saveEvidence('json', JSON.stringify({ expectedPid: want, error: parsed.error }, null, 1));
            }
          }
        } else if (check.kind === 'ss') {
          if (exitCode !== 0 && !out.trim()) {
            rec.status = 'unavailable';
            rec.error = `ssh_exit_${exitCode}: ${stderrHead}`;
            rec.observedValue = { exitCode, stderr: stderrHead };
          } else {
            const observedPorts = parseSs(out);
            const expected = Array.isArray(check.expectedPorts) ? check.expectedPorts : [];
            const missing = expected.filter((p) => !observedPorts.includes(p));
            const matchedLines = filterSsLines(out, expected);
            rec.observedValue = { observedPorts, expectedPorts: expected, exitCode, stderr: stderrHead };
            // fix4: сырой полный ss не храним — только структурированный отфильтрованный результат.
            rec.evidenceFile = saveEvidence('json', JSON.stringify({ expectedPorts: expected, observedPorts, matchedLines }, null, 1));
            if (missing.length) {
              rec.status = 'mismatch';
              rec.error = `missing_ports: ${missing.join(',')}`;
            } else {
              rec.status = 'ok';
              rec.error = null;
            }
          }
        } else {
          rec.observedValue = { head: out.slice(0, 2000), exitCode, stderr: stderrHead };
          if (exitCode !== 0 && !out.trim()) {
            rec.status = 'unavailable';
            rec.error = `ssh_exit_${exitCode}: ${stderrHead}`;
          } else {
            rec.status = out.trim() ? 'ok' : 'unknown';
            if (!out.trim()) rec.error = 'empty_output';
          }
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
      // Параметризованные пути capabilities/CAPS-проб: явный пропуск, без бессмысленного запроса.
      if (check.skipReason) {
        rec.status = 'not_checked';
        rec.error = check.skipReason;
        rec.observedValue = { skipped: check.sourceEndpoint || check.endpoint };
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
      // 3xx на caps-пробах (/index → /): маршрут обработан (redirect), а не отсутствует.
      // Для реестровых owner-маршрутов редирект остаётся mismatch (см. classify).
      if (res.httpStatus >= 300 && res.httpStatus < 400 && check.kind === 'caps-probe' && res.location) {
        rec.status = 'ok';
        rec.observedValue = { httpStatus: res.httpStatus, location: String(res.location).slice(0, 200), redirect: true, contentType: res.contentType, size: body.length };
        if (typeof res.truncated === 'boolean') rec.observedValue.truncated = res.truncated;
        rec.error = null;
        rec.completedAt = new Date(ctx.now()).toISOString();
        return rec;
      }
      const r = classifyHttp({
        httpStatus: res.httpStatus, contentType: res.contentType, body,
        expectJson: check.expectJson, expectDark: check.expectDark, chainPin: ctx.chainPin,
        endpoint: check.endpoint,
      });
      if (typeof res.truncated === 'boolean') r.observedValue.truncated = res.truncated;
      rec.status = r.status; rec.observedValue = r.observedValue; rec.error = r.error;
      // envScope вне прод (staging-only/offline-pilot): 404 на проде согласуется с ожиданием «не опубликовано».
      if (rec.status === 'mismatch' && res.httpStatus === 404 && /staging|offline|pilot/i.test(String(check.envScope || ''))) {
        rec.status = 'ok';
        rec.error = null;
        rec.observedValue.scopeConsistent = `404 consistent with envScope ${check.envScope} (not published on prod)`;
      }
      // capabilities: рекламируемое фиксируем; сами пробы — фазой 1b ниже (все, без среза 12).
      if (check.isCaps && rec.status === 'ok') {
        const j = tryJson(body);
        const adv = j.ok ? getAdvertisedLists(j.value) : [];
        rec.observedValue.advertisedReads = adv.slice();
        rec.observedValue.advertisedCount = adv.length;
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
    concurrency: Math.max(1, Math.min(opts.concurrency || MAX_CONCURRENCY, MAX_CONCURRENCY)),
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

  // Фаза 1c (fix4): точечная проверка PID из unit-show — без глобального ps.
  // Только числовой MainPID из успешного unit-show; без args чужих процессов.
  try {
    if (!ctx.publicOnly) {
      const pidExtra = [];
      const sshByComp = new Map();
      for (const c of (reg.components || [])) {
        if (c && c.observe && c.observe.ssh) sshByComp.set(c.componentId, c.observe.ssh);
      }
      for (const o of observations) {
        if (!o || !/:proc-unit-show$/.test(o.checkId || '') || o.status !== 'ok') continue;
        const pid = Number(o.observedValue && o.observedValue.MainPID);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        const ssh = sshByComp.get(o.componentId);
        if (!ssh) continue;
        const cmd = `ps -p ${pid} -o pid=,user=,lstart=`;
        if (!isReadOnlySshCommand(cmd)) continue;
        if (observations.some((x) => x && x.checkId === `${o.componentId}:proc-pid-${pid}`)) continue;
        pidExtra.push({
          componentId: o.componentId, checkId: `${o.componentId}:proc-pid-${pid}`,
          via: 'ssh', ssh, command: cmd,
          sourceEndpoint: `ps -p ${pid} via ssh (target PID only)`,
          expectJson: false, kind: 'pid-check', expectedPid: pid,
        });
      }
      let cur = 0;
      const runPid = async () => {
        while (cur < pidExtra.length) {
          const i = cur++;
          observations.push(await runOne(pidExtra[i], ctx));
        }
      };
      if (pidExtra.length) {
        await Promise.all(Array.from({ length: Math.min(ctx.concurrency, pidExtra.length) }, runPid));
      }
    }
  } catch { /* необязательно: частичный сбой не уничтожает фазу 1 */ }

  // Фаза 1b: capabilities рекламирует — проверяем доступность рекламируемого (только GET, только чтение).
  // Без молчаливого среза: каждому объявленному маршруту — проба либо явный пропуск.
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
      for (const p of adv) {
        if (typeof p !== 'string' || !p.startsWith('/')) {
          capsExtra.push({
            componentId: 'mainnet-node-1', checkId: `mainnet-node-1:caps-skip-${slug(String(p))}`,
            via: 'https', url: `${base}/`, sourceEndpoint: `${base}${String(p)}`,
            expectJson: false, skipReason: `caps_invalid_path: ${String(p).slice(0, 80)}`, endpoint: String(p),
          });
          continue;
        }
        if (/^(POST|PUT|DELETE|PATCH)\s/i.test(p)) {
          capsExtra.push({
            componentId: 'mainnet-node-1', checkId: `mainnet-node-1:caps-skip-${slug(p)}`,
            via: 'https', url: `${base}/`, sourceEndpoint: `${base}${p}`,
            expectJson: false, skipReason: `caps_not_get: ${p.slice(0, 80)}`, endpoint: p,
          });
          continue;
        }
        const clean = p.replace(/\s.*$/, '');
        if (isParamPath(clean)) {
          capsExtra.push({
            componentId: 'mainnet-node-1', checkId: `mainnet-node-1:caps-skip-${slug(clean)}`,
            via: 'https', url: `${base}${clean}`,
            sourceEndpoint: `${base}${clean}`,
            expectJson: false, skipReason: `param_needs_value: ${clean} (no бессмысленный bare-запрос)`, endpoint: clean,
          });
          continue;
        }
        if (observations.some((x) => x && x.sourceEndpoint === `${base}${queryFix(clean)}`)) continue;
        if (capsExtra.some((x) => x && x.sourceEndpoint === `${base}${queryFix(clean)}`)) continue;
        capsExtra.push({
          componentId: 'mainnet-node-1', checkId: `mainnet-node-1:caps-probe-${slug(clean)}`,
          via: 'https', url: `${base}${queryFix(clean)}`,
          sourceEndpoint: `${base}${queryFix(clean)}`,
          // Наличие, а не строгая JSON-схема: HTML-дашборды (/stats, /dashboard) — тоже ok;
          // JSON с битым телом — mismatch (см. classify lenient-ветку).
          expectJson: false, endpoint: clean, kind: 'caps-probe',
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
    if (capsExtra.length) {
      await Promise.all(Array.from({ length: Math.min(ctx.concurrency, capsExtra.length) }, runCaps));
    }
  } catch { /* необязательно: частичный сбой не уничтожает фазу 1 */ }

  // Фаза 2 fix5: /info.blocks — число блоков, tip-высота = blocks - 1.
  // Общий блок — min(blocks - 1) по локальным info (только blocks >= 1).
  // Запрашиваем один блок на commonHeight, принимаем только returned.height === commonHeight + valid 64-hex.
  try {
    const heights = [];
    for (const o of observations) {
      if (!o || o.status !== 'ok' || !o.observedValue) continue;
      if (!/:(local-info)$/.test(o.checkId)) continue;
      const b = o.observedValue.blocks;
      if (Number.isSafeInteger(b) && b >= 1) heights.push({ checkId: o.checkId, componentId: o.componentId, blocks: b });
    }
    if (heights.length >= 2 && !ctx.publicOnly) {
      const minH = commonTipHeight(heights.map((h) => h.blocks));
      if (minH === null) throw { done: true };
      const tipNote = heights.map((h) => `${h.componentId}=blocks${h.blocks}/tip${h.blocks - 1}`).join(', ');
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
          command: `curl -sS -m 8 -i 'http://127.0.0.1:9335/blocks?from=${minH}&limit=1'`,
          sourceEndpoint: `loopback /blocks?from=${minH}&limit=1 via ssh (common tipHeight; ${tipNote})`,
          expectJson: true, kind: 'common-block', endpoint: '/blocks', wantHeight: minH,
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
