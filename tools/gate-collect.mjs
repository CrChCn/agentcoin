#!/usr/bin/env node
// gate-collect.mjs — Этап 3: read-only сбор для Truth Gate.
// Цели — только из config/unified-registry.json (observe) и config/truth-gate-policy.json.
// Ничего не исправляет, не рестартует, не деплоит, не отправляет транзакции.
// Все SSH-команды — типизированные шаблоны из белого списка; значения env читаются
// только для разрешённых имён (DATA_DIR/PORT/CHAIN_ID/NETWORK/NETWORK_ID/NODE_ENV).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collect as collectBaseline, scrubSecrets, HEX64_RE } from './net-collect.mjs';

export const SSH_TIMEOUT_MS = 15000;
export const MAX_BODY_BYTES = 262144;
const SHOW_PROPS = [
  'ActiveState', 'MainPID', 'User', 'Group', 'ExecStart', 'ExecMainStartTimestamp',
  'WorkingDirectory', 'EnvironmentFiles', 'FragmentPath', 'Requires', 'After',
  'ProtectSystem', 'ReadWritePaths',
];
const SSH_PATTERNS = [
  /^systemctl show [A-Za-z0-9_.@:-]+ --property=[A-Za-z,]+$/,
  /^systemctl is-active [A-Za-z0-9_.@:-]+$/,
  /^systemctl list-units --type=service --state=running --no-legend --no-pager$/,
  /^systemctl list-timers --all --no-legend --no-pager$/,
  /^crontab -l$/,
  /^ls -1 \/etc\/cron\.d$/,
  /^ls -1 \/srv\/agentcoin-empire\/current$/,
  /^readlink -f \/proc\/\d+\/cwd$/,
  /^stat -c "%U %G %a %n" (?:\/[A-Za-z0-9_.\/-]+)(?: \/[A-Za-z0-9_.\/-]+)*$/,
  /^sed -n "\d+,\d+p" \/etc\/caddy\/Caddyfile$/,
  /^cut -d= -f1 \/etc\/[A-Za-z0-9_.-]+\.env$/,
  /^grep -E '(?:\^[A-Z_]+=\|?)+' \/etc\/[A-Za-z0-9_.-]+\.env$/,
  /^curl -sS -m 8 -i 'http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9\/._?=&%-]*'$/,
  /^sha256sum (?:\/(?:opt|srv)\/[A-Za-z0-9_.\/-]+)(?: \/(?:opt|srv)\/[A-Za-z0-9_.\/-]+)*$/,
  /^caddy adapt --config \/etc\/caddy\/Caddyfile --adapter caddyfile --pretty$/,
];

export function isGateSshCommand(cmd) {
  if (typeof cmd !== 'string' || /[\n\r`$()]/.test(cmd)) return false;
  return SSH_PATTERNS.some((re) => re.test(cmd.trim()));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function tryJson(text) {
  try {
    const t = String(text || '').trim();
    if (!t) return { ok: false };
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

function withTimeout(promise, ms, label) {
  let t;
  const gate = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); });
  return Promise.race([promise, gate]).finally(() => clearTimeout(t));
}

function parseShow(out) {
  const res = {};
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/);
    if (m) res[m[1]] = m[2];
  }
  return res;
}

function execStartParts(execStart) {
  const s = String(execStart || '');
  const argv = s.match(/argv\[\]=(.*?)\s*;\s*ignore_errors/s);
  const p = s.match(/path=([^\s;]+)/);
  const argvArr = argv ? argv[1].trim().split(/\s+/).filter(Boolean) : [];
  return { execPath: p ? p[1] : null, argv: argvArr };
}

function parseCurlDashI(stdout) {
  const text = String(stdout || '');
  const sep = text.indexOf('\r\n\r\n');
  const cut = sep >= 0 ? sep : text.indexOf('\n\n');
  const head = cut >= 0 ? text.slice(0, cut) : text;
  const body = cut >= 0 ? text.slice(cut + (sep >= 0 ? 4 : 2)) : '';
  const lines = head.split(/\r?\n/);
  const m = (lines[0] || '').match(/^HTTP\/\S+\s+(\d{3})/);
  let contentType = null;
  for (const l of lines.slice(1)) {
    const mm = l.match(/^content-type:\s*(.+)$/i);
    if (mm) contentType = mm[1].trim();
  }
  return { httpStatus: m ? Number(m[1]) : null, contentType, body };
}

// ---------- Caddyfile parser (read-only карта) ----------
function stripComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    if (c === '#' && !inQuote) return line.slice(0, i);
  }
  return line;
}

function splitWords(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// Разбирает Caddyfile в сайты с handler-записями: host → matcher → handler → upstream.
export function parseCaddyfile(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sites = [];
  let site = null;
  let depth = 0;
  const stack = []; // {type, name?, startDepth, entry?, paths?}
  let siteSeq = 0;

  const curSite = () => (depth >= 1 ? site : null);
  const nearestHandler = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].type === 'handler' && stack[i].entry) return stack[i].entry;
    return null;
  };
  const parentHandler = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].type === 'handler') return stack[i];
    return null;
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const trimmed = stripComment(raw).trim();
    if (!trimmed) continue;
    const lineNo = li + 1;

    // Открытие сайта на нулевой глубине.
    if (depth === 0 && trimmed.endsWith('{') && !/^(handle|route|@|\{)/.test(trimmed)) {
      const hosts = splitWords(trimmed.slice(0, -1).trim())
        .join(' ').split(',').map((h) => h.trim()).filter(Boolean);
      site = { hosts, entries: [], matchers: {}, seq: siteSeq++, line: lineNo };
      sites.push(site);
      depth = 1;
      stack.push({ type: 'site', startDepth: 1 });
      continue;
    }
    if (!site) { depth += (trimmed.match(/{/g) || []).length - (trimmed.match(/}/g) || []).length; continue; }

    const opens = trimmed.endsWith('{');
    const closeOnly = /^}+$/.test(trimmed);

    if (opens) {
      const head = trimmed.slice(0, -1).trim();
      if (head.startsWith('@')) {
        const name = head.split(/\s+/)[0];
        const matcher = { name, method: [], path: [], remoteIp: [], header: [], line: lineNo };
        site.matchers[name] = matcher;
        stack.push({ type: 'matcher', name, startDepth: depth + 1, matcher });
      } else if (/^handle(_path)?\b/.test(head)) {
        const parts = splitWords(head);
        const kind = parts[0];
        const expr = parts.slice(1).join(' ');
        const parent = parentHandler();
        const inherited = parent && parent.entry ? parent.entry : null;
        const m = expr && site.matchers[expr] ? site.matchers[expr] : null;
        const entry = {
          host: site.hosts.slice(), siteSeq: site.seq, line: lineNo,
          matcher: expr || '(catch-all)', methods: m ? m.method.slice() : [],
          paths: m ? m.path.slice() : (expr && expr.startsWith('/') ? [expr.split(/\s+/)[0]] : []),
          remoteIps: m ? m.remoteIp.slice() : [], headerRules: m ? m.header.slice() : [],
          kind: kind === 'handle_path' ? 'handle_path' : 'handle',
          stripPrefix: kind === 'handle_path' ? (expr || null) : null,
          upstream: null, root: null, rewrite: null, code: null,
          inheritedPaths: inherited ? inherited.paths.concat(inherited.inheritedPaths || []) : [],
          nestedIn: inherited ? inherited.matcher : null,
          inRoute: stack.some((c) => c.type === 'route'),
        };
        site.entries.push(entry);
        stack.push({ type: 'handler', startDepth: depth + 1, entry });
      } else if (head === 'route') {
        stack.push({ type: 'route', startDepth: depth + 1 });
      } else if (/^(reverse_proxy|root|rewrite|respond|redir|header|request_body|transport|tls|log|encode|try_files)\b/.test(head)) {
        // Директива с блоком: свойства относятся к текущему handler, а блок только меняет глубину.
        const h = nearestHandler();
        const w2 = splitWords(head);
        if (h) {
          if (w2[0] === 'reverse_proxy') h.upstream = w2.slice(1).find((w) => !/^\{/.test(w)) || null;
          else if (w2[0] === 'root') h.root = w2[2] || null;
          else if (w2[0] === 'rewrite') h.rewrite = w2[2] || null;
          else if (w2[0] === 'respond') {
            h.kind = 'respond';
            h.code = w2.find((w) => /^\d{3}$/.test(w)) || null;
            h.respondBody = w2[1] || null;
          }
        }
        stack.push({ type: 'other', startDepth: depth + 1 });
      } else {
        stack.push({ type: 'other', startDepth: depth + 1 });
      }
      depth++;
      continue;
    }

    if (closeOnly) {
      const n = (trimmed.match(/}/g) || []).length;
      for (let k = 0; k < n; k++) {
        stack.pop();
        depth = Math.max(0, depth - 1);
        if (!stack.length) { site = null; depth = 0; break; }
      }
      continue;
    }

    // Директивы внутри сайта.
    const ctxMatcher = [...stack].reverse().find((c) => c.type === 'matcher');
    const handler = nearestHandler();
    const words = splitWords(trimmed);
    const d = words[0];

    if (ctxMatcher && ctxMatcher.matcher) {
      const mt = ctxMatcher.matcher;
      if (d === 'method') mt.method.push(...words.slice(1).map((x) => x.toUpperCase()));
      else if (d === 'path') mt.path.push(...words.slice(1));
      else if (d === 'remote_ip') mt.remoteIp.push(...words.slice(1));
      else if (d === 'header') mt.header.push(words.slice(1).join(' '));
      continue;
    }
    if (!handler) {
      // site-level директивы
      if (d === 'reverse_proxy') {
        site.entries.push({
          host: site.hosts.slice(), siteSeq: site.seq, line: lineNo, matcher: '(site catch-all)',
          methods: [], paths: [], remoteIps: [], headerRules: [], kind: 'site-proxy',
          upstream: words[1] || null, root: null, rewrite: null, code: null, inheritedPaths: [], nestedIn: null,
        });
      } else if (d === 'redir') {
        site.entries.push({
          host: site.hosts.slice(), siteSeq: site.seq, line: lineNo, matcher: words[1] || '(redir)',
          methods: [], paths: [words[1] || ''], remoteIps: [], headerRules: [], kind: 'redirect',
          upstream: null, redirectTo: words[2] || null, code: words[3] || null,
          root: null, rewrite: null, inheritedPaths: [], nestedIn: null,
        });
      }
      continue;
    }
    if (d === 'reverse_proxy') handler.upstream = words.slice(1).find((w) => !/^\{/.test(w)) || null;
    else if (d === 'root') handler.root = words[2] || null;
    else if (d === 'rewrite') handler.rewrite = words[2] || null;
    else if (d === 'uri' && words[1] === 'strip_prefix') handler.stripPrefix = words[2] || null;
    else if (d === 'respond') {
      handler.kind = handler.kind === 'handle' ? 'respond' : handler.kind;
      handler.code = words.find((w) => /^\d{3}$/.test(w)) || null;
      handler.respondBody = words[1] || null;
    } else if (d === 'file_server') {
      if (!handler.kind || handler.kind === 'handle') handler.kind = 'static';
    } else if (d === 'try_files') {
      handler.tryFiles = words.slice(1);
      if (!handler.kind || handler.kind === 'handle') handler.kind = 'static';
    }
  }

  // Производные признаки: catch-all static/proxy на сайте.
  for (const s of sites) {
    s.hasCatchAllStatic = s.entries.some((e) => e.matcher === '(catch-all)' && (e.kind === 'static' || (e.tryFiles && e.tryFiles.length)));
    s.catchAllLine = (s.entries.find((e) => e.matcher === '(catch-all)') || {}).line || null;
  }
  return { sites };
}

// Владелец маршрута по upstream/root (policy), иначе null.
function normalizeTarget(s) {
  return String(s || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

export function routeOwner(entry, policy) {
  const byUp = (policy.caddy && policy.caddy.ownerByUpstream) || {};
  const byRoot = (policy.caddy && policy.caddy.ownerByRoot) || {};
  if (entry.upstream) {
    const up = normalizeTarget(entry.upstream);
    for (const [k, v] of Object.entries(byUp)) {
      const key = normalizeTarget(k);
      if (up === key || up.startsWith(key)) return v;
    }
  }
  if (entry.root) {
    for (const [k, v] of Object.entries(byRoot)) if (entry.root === k || entry.root.startsWith(k)) return v;
  }
  if (entry.kind === 'redirect' || entry.kind === 'respond') return 'caddy-h1';
  return null;
}

// Карта strip-префиксов сайта: matcher -> prefix (uri strip_prefix /working).
// Нужна, чтобы отличать внешний публичный путь от внутреннего после strip.
export function namespaceStripMap(site) {
  const m = new Map();
  for (const e of site.entries) {
    if (!e.stripPrefix) continue;
    const name = String(e.matcher || '');
    if (name.startsWith('@') && !m.has(name)) m.set(name, e.stripPrefix);
  }
  return m;
}

// Внешние публичные пути записи: namespace-префикс + внутренний путь.
export function publicPathsFor(entry, stripMap) {
  const paths = entry.paths || [];
  const holder = String(entry.nestedIn || '');
  const prefix = holder && stripMap && stripMap.get(holder);
  if (!prefix) return paths.slice();
  const clean = String(prefix).replace(/\/$/, '');
  return paths.map((p) => (p === '/' ? clean || '/' : clean + p));
}

// Пересечения деклараций: один host+path(+methods) заявлен несколькими handler.
// Различаем ROUTE_PATTERN_OVERLAP (порядок Caddy однозначен: сначала более
// специфичный path, при равной специфичности — меньшая строка конфига) и
// ROUTE_OWNER_CONFLICT (порядок неоднозначен: смесь handle внутри route-блоков
// и обычных сортированных handle). Одинаковый owner+target — не находка.
export function buildOverlapGroups(map, policy) {
  const seen = new Map();
  const groups = [];
  const dual = new Set((policy.caddy && policy.caddy.allowedDualPaths) || []);
  const spec = (p) => String(p || '').length;
  for (const s of map.sites) {
    const stripMap = namespaceStripMap(s);
    for (const e of s.entries) {
      // Без явного path-matcher сравнение невозможно: это не маршрут, а контейнер.
      if (!e.paths.length) continue;
      // Пара «ограниченный по remote_ip вариант + deny-fallback» — одна защита, не конфликт.
      if ((e.remoteIps || []).length) continue;
      if (e.kind === 'respond' && /40[13]/.test(String(e.code || ''))) continue;
      const publicPaths = publicPathsFor(e, stripMap);
      for (let pi = 0; pi < e.paths.length; pi++) {
        const p = e.paths[pi];
        if (!p || dual.has(p)) continue;
        const publicPath = publicPaths[pi] || p;
        for (const h of e.host) {
          const key = `${h}|${publicPath}|${(e.methods || []).slice().sort().join(',')}`;
          const owner = routeOwner(e, policy) || 'unknown';
          const target = e.upstream || e.root || e.redirectTo || e.kind;
          const decl = {
            owner, target, line: e.line, matcher: e.matcher, kind: e.kind,
            inRoute: !!e.inRoute, internalPath: p, specificity: spec(publicPath),
          };
          const prev = seen.get(key);
          if (!prev) { seen.set(key, { host: h, publicPath, internalPath: p, methods: e.methods || [], decls: [decl] }); continue; }
          prev.decls.push(decl);
        }
      }
    }
  }
  for (const g of seen.values()) {
    if (g.decls.length < 2) continue;
    const pairs = new Set(g.decls.map((d) => `${d.owner}|${d.target}`));
    if (pairs.size < 2) continue;
    const ordered = g.decls.slice().sort((a, b) => (b.specificity - a.specificity) || (a.line - b.line));
    const mixedRoute = g.decls.some((d) => d.inRoute) && g.decls.some((d) => !d.inRoute);
    groups.push({
      host: g.host, publicPath: g.publicPath, internalPath: g.internalPath, methods: g.methods,
      matchingHandlers: ordered.map((d) => ({
        owner: d.owner, target: d.target, line: d.line, matcher: d.matcher, kind: d.kind, inRoute: d.inRoute,
      })),
      handlerOrder: ordered.map((d) => d.line),
      effectiveOwner: ordered[0].owner, effectiveTarget: ordered[0].target,
      fallbackOwner: ordered[1] ? ordered[1].owner : null, fallbackTarget: ordered[1] ? ordered[1].target : null,
      ambiguous: mixedRoute,
      reason: mixedRoute ? 'mixed route-block and sorted handle: execution order not provable from file order'
        : `Caddy executes most specific first, ties by file order: line ${ordered[0].line} wins`,
    });
  }
  groups.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : a.publicPath < b.publicPath ? -1 : 1));
  return groups;
}

// Сканирование mutation-маршрутов: защита наблюдаема или нет.
// registryRoutes — [{componentId, routes:[{host,path,note}]}] из реестра;
// по умолчанию берётся policy.__registryComponents (ставит collectStage3).
export function scanMutationGuards(map, policy, registryRoutes = null) {
  const mutRe = new RegExp((policy.caddy && policy.caddy.sensitiveMutationPattern) || '(cabinet|wallet|admin|tx|submit|send)', 'i');
  const testHostRe = new RegExp((policy.caddy && policy.caddy.testHostPattern) || '(^|\\.)(staging|test)\\.', 'i');
  const mainnetRe = new RegExp((policy.caddy && policy.caddy.mainnetUpstreamPattern) || '9335');
  const findings = [];
  const documented = (hosts, paths) => {
    const notes = [];
    for (const c of (registryRoutes || policy.__registryComponents || [])) {
      for (const rt of (c.routes || [])) {
        if (!hosts.includes(String(rt.host || ''))) continue;
        if (!paths.includes(String(rt.path || ''))) continue;
        notes.push(String(rt.note || ''));
      }
    }
    return notes.some((n) => /подпис|sign|token|auth|admin|pow|закрыт|protected|approve/i.test(n));
  };
  for (const s of map.sites) {
    const stripMap = namespaceStripMap(s);
    for (const e of s.entries) {
      const mutating = (e.methods || []).some((m) => /^(POST|PUT|PATCH|DELETE)$/.test(m));
      const sensitive = mutRe.test((e.paths || []).join(' ')) || mutRe.test(e.matcher || '');
      if (!mutating && !sensitive) continue;
      if (!mutating && !['proxy', 'site-proxy'].includes(String(e.kind))) continue;
      const guard = [];
      if ((e.remoteIps || []).length) guard.push('remote_ip');
      if ((e.headerRules || []).length) guard.push('header');
      if (/basicauth|basic_auth|forward_auth/i.test(String(e.upstream || ''))) guard.push('basicauth');
      if (documented(e.host || [], e.paths || [])) guard.push('documented-requirement');
      const toMainnet = mainnetRe.test(String(e.upstream || ''));
      const testHost = (e.host || []).some((h) => testHostRe.test(h));
      let severity = null;
      let code = null;
      // Тестовый публичный хост, пишущий в mainnet, — блокер независимо от наличия auth
      // на уровне приложения: изоляция сред нарушена на уровне маршрута.
      if (testHost && toMainnet && mutating) { severity = 'BLOCKED'; code = 'TEST_MUTATION_TO_MAINNET'; }
      else if (sensitive && mutating && !guard.length) {
        const blockingRe = new RegExp((policy.caddy && policy.caddy.blockingMutationPattern) || '(cabinet|wallet|payout|treasury)', 'i');
        const blocking = blockingRe.test((e.paths || []).join(' ')) || blockingRe.test(e.matcher || '');
        severity = blocking ? 'BLOCKED' : 'WARN';
        code = 'UNPROVEN_MUTATION_ROUTE';
      }
      const publicPaths = publicPathsFor(e, stripMap);
      const owner = routeOwner(e, policy) || 'unknown';
      const hostEnv = (policy.caddy && policy.caddy.publicHostEnvironment) || {};
      const ownerEnv = (policy.caddy && policy.caddy.ownerEnvironment) || {};
      // Честное заявление про auth: обработчики backend не читаются (значения
      // env/журналов запрещены), поэтому auth прикладного уровня всегда UNKNOWN.
      // Блокировка staging→mainnet идёт по факту связи сред, а не по отсутствию auth.
      findings.push({
        host: e.host, publicHost: e.host[0] || null, matcher: e.matcher, methods: e.methods || [],
        paths: e.paths || [], publicPaths,
        internalPath: (e.paths || [])[0] || null, publicPath: publicPaths[0] || null,
        upstream: e.upstream || null, line: e.line, guard, severity, code, testHost, toMainnet,
        effectiveOwner: owner,
        environmentFrom: testHost ? 'staging' : (hostEnv[e.host[0]] || null),
        environmentTo: ownerEnv[owner] || null,
        applicationAuth: 'UNKNOWN',
        policyVerdict: severity === 'BLOCKED' ? 'BLOCKED' : (severity === 'WARN' ? 'WARN' : null),
      });
    }
  }
  return findings;
}

function extractHtmlFacts(body) {
  const t = String(body || '');
  const title = (t.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || null;
  const h1raw = (t.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || null;
  const clean = (x) => (x ? x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : null);
  const navMatch = t.match(/<nav[\s\S]*?<\/nav>/i);
  const navLinks = navMatch ? (navMatch[0].match(/href=/g) || []).length : 0;
  const release = (t.match(/site-v[0-9a-z.-]{4,}/i) || t.match(/release["'\s:=]+([0-9a-z._-]{4,})/i) || [])[0] || null;
  const h1s = [...t.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => clean(m[1])).filter(Boolean);
  const scripts = [...new Set([...t.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => String(m[1]).split('?')[0]).filter(Boolean))].sort();
  const stylesheets = [...new Set([...t.matchAll(/<link[^>]*href=["']([^"']+\.css[^"']*)["']/gi)].map((m) => String(m[1]).split('?')[0]).filter(Boolean))].sort();
  const canonical = (t.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || t.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i) || [])[1] || null;
  return {
    title: clean(title), h1: clean(h1raw), h1s: h1s.slice(0, 5),
    navHash: navMatch ? sha256(navMatch[0]).slice(0, 16) : null, navLinks,
    releaseMarker: release ? String(release).slice(0, 80) : null,
    htmlLang: (t.match(/<html[^>]*lang=["']([^"']+)["']/i) || [])[1] || null,
    shellScript: scripts,
    stylesheet: stylesheets,
    canonical,
    networkIdentityRefs: (t.match(/node1\.agentcoin\.work|chain-status|tipHash|tip-hash|blockHeight|block-height/gi) || []).length,
    agentRoomEntry: /href=["'][^"']*agent-room/i.test(t),
    apiErrorDisplay: /api-error|error-display|data-error/i.test(t),
    languageSwitch: /\?lang=|data-lang|empire-i18n/i.test(t),
  };
}

async function defaultFetchPage(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('http_timeout')), opts.timeoutMs || 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'agentcoin-truth-gate/1 (read-only)' } });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.slice(0, MAX_BODY_BYTES).toString('utf8');
    return {
      httpStatus: r.status, finalUrl: r.url || url, contentType: r.headers.get('content-type'),
      body: text, bytes: buf.length, truncated: buf.length > MAX_BODY_BYTES, sha256: sha256(buf),
    };
  } finally { clearTimeout(t); }
}

function defaultSshFn(ssh, command) {
  if (!isGateSshCommand(command)) throw new Error('ssh_command_not_allowlisted');
  const args = [
    '-i', `${process.env.HOME || process.env.USERPROFILE || '~'}/.ssh/agentcoin-deploy`,
    '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.round(SSH_TIMEOUT_MS / 1000)}`,
    '-o', 'StrictHostKeyChecking=accept-new', '-p', String(ssh.port || 22),
    `${ssh.user || 'root'}@${ssh.host}`, '--', command,
  ];
  const r = spawnSync('ssh', args, { encoding: 'utf8', timeout: SSH_TIMEOUT_MS });
  if (r.error) throw r.error;
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status };
}

// Рекурсивная редакция значений чувствительных ключей в adapted JSON.
// Имена заголовков (например, X-Admin-Token в delete-списках match/header)
// не трогаем: секрет — значение ключа password/secret/token, а не имя поля
// в списке удаляемых заголовков или статическом теле 404-ответа.
// Сводка adapted-конфига: плоский порядок (match, dial) по всем уровням
// вложенности — пересекающиеся маршруты лежат во вложенных subroute.
export function summarizeAdaptedJson(adapted) {
  const servers = (adapted && adapted.apps && adapted.apps.http && adapted.apps.http.servers) || {};
  const orderedRoutes = [];
  const dialsOf = (handles) => {
    const out = [];
    const walk = (hs) => {
      for (const h of (hs || [])) {
        if (!h || typeof h !== 'object') continue;
        if (h.handler === 'reverse_proxy' && Array.isArray(h.upstreams)) {
          for (const u of h.upstreams) if (u && u.dial) out.push(String(u.dial));
        }
        if (Array.isArray(h.routes)) for (const r of h.routes) walk(r.handle);
      }
    };
    walk(handles);
    return out;
  };
  const walkRoutes = (routes, srvName) => {
    for (const r of (routes || [])) {
      const matches = [];
      for (const m of (r.match || [])) {
        if (m.method) matches.push(`method=${m.method.join(',')}`);
        if (m.path) for (const p of m.path) matches.push(p);
      }
      orderedRoutes.push({ server: srvName, match: matches, dials: dialsOf(r.handle) });
      for (const h of (r.handle || [])) {
        if (h && typeof h === 'object' && Array.isArray(h.routes)) walkRoutes(h.routes, srvName);
      }
    }
  };
  for (const [srvName, srv] of Object.entries(servers)) walkRoutes(srv.routes, srvName);
  return { servers: Object.keys(servers), routeCount: orderedRoutes.length, orderedRoutes };
}

const SENSITIVE_KEY_RE = /^(password|passwd|pwd|secret|api[_-]?key|token)$/i;
export function redactSensitiveJson(value) {
  let redactedKeys = 0;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (SENSITIVE_KEY_RE.test(k) && typeof val === 'string') { redactedKeys++; out[k] = '[REDACTED]'; }
        else out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return { redacted: walk(value), redactedKeys };
}

// ---------- Сбор ----------
export async function collectStage3(reg, policy, opts = {}) {
  const ctx = {
    sshFn: opts.sshFn || defaultSshFn,
    fetchPage: opts.fetchPage || defaultFetchPage,
    now: opts.now || Date.now,
    evidenceDir: opts.evidenceDir || null,
    publicOnly: !!opts.publicOnly,
    localRoot: opts.localRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    observations: [...(Array.isArray(opts.baseObservations) ? opts.baseObservations : [])],
  };
  const stageStart = ctx.observations.length;
  const byId = new Map((reg.components || []).map((c) => [c.componentId, c]));
  const chainPin = { chainId: reg.chain.network, genesis: String(reg.chain.genesis).toLowerCase() };
  // Реестр передаётся в guard-scan только для чтения заметок (без второго списка целей).
  policy.__registryComponents = (reg.components || []).map((c) => ({ componentId: c.componentId, routes: c.routes || [] }));

  const saveEvidence = (checkId, ext, data) => {
    if (!ctx.evidenceDir) return null;
    try {
      fs.mkdirSync(ctx.evidenceDir, { recursive: true });
      const safe = `${checkId}.${ext}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
      fs.writeFileSync(path.join(ctx.evidenceDir, safe), scrubSecrets(String(data ?? '')));
      return `evidence/${safe}`;
    } catch { return null; }
  };

  async function add(componentId, checkId, sourceHost, sourceEndpoint, fn) {
    const rec = {
      componentId, checkId, sourceHost, sourceEndpoint,
      startedAt: new Date(ctx.now()).toISOString(), completedAt: null,
      status: 'unknown', observedValue: null, evidenceFile: null, error: null,
    };
    try {
      const r = await fn();
      if (r && typeof r === 'object') {
        rec.status = r.status || 'ok';
        rec.observedValue = r.observedValue === undefined ? null : r.observedValue;
        rec.error = r.error || null;
        rec.evidenceFile = r.evidenceFile || null;
      }
    } catch (e) {
      rec.status = 'unavailable';
      rec.error = `gate_collector_error: ${String((e && e.message) || e).slice(0, 200)}`;
    }
    rec.completedAt = new Date(ctx.now()).toISOString();
    ctx.observations.push(rec);
    return rec;
  }

  async function ssh(hostRef, command) {
    return withTimeout(ctx.sshFn(hostRef, command), SSH_TIMEOUT_MS + 5000, 'ssh_timeout');
  }

  // --- 1. Caddy: конфиг + карта (node1, node2, node3) ---
  const caddyConf = policy.caddy || {};
  const configPath = caddyConf.configPath || '/etc/caddy/Caddyfile';
  const maps = []; // {host, map, configSha}
  const caddyTargets = [];
  const h1Obs = (byId.get('caddy-h1') || {}).observe || null;
  const rObs = (byId.get('caddy-reserve') || {}).observe || null;
  if (h1Obs && h1Obs.ssh) caddyTargets.push({ componentId: 'caddy-h1', ssh: h1Obs.ssh, label: 'node1' });
  if (rObs && rObs.ssh) caddyTargets.push({ componentId: 'caddy-reserve', ssh: rObs.ssh, label: 'node2' });
  for (const t of (rObs && Array.isArray(rObs.sshTargets) ? rObs.sshTargets : [])) {
    caddyTargets.push({ componentId: 'caddy-reserve', ssh: t, label: t.host === '64.225.104.125' ? 'node3' : String(t.host) });
  }

  for (const t of caddyTargets) {
    const label = t.label;
    const rec = await add(t.componentId, `${t.componentId}:config-${label}`, String(t.ssh.host), `sed ${configPath} via ssh (read-only)`, async () => {
      if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped', observedValue: { skipped: true } };
      let raw;
      try { raw = await ssh(t.ssh, `sed -n "1,800p" ${configPath}`); }
      catch (e) {
        const msg = String((e && e.message) || e);
        return { status: 'unavailable', error: /timeout/i.test(msg) ? 'ssh_timeout' : `ssh_unavailable: ${msg.slice(0, 160)}` };
      }
      const text = scrubSecrets(String(raw.stdout || ''));
      if (raw.exitCode !== 0 && !text.trim()) return { status: 'unavailable', error: `ssh_exit_${raw.exitCode}: ${scrubSecrets(String(raw.stderr || '')).slice(0, 160)}` };
      const parsed = parseCaddyfile(text);
      const entries = parsed.sites.flatMap((s) => s.entries);
      const ev = saveEvidence(`${t.componentId}-config-${label}`, 'txt', text);
      maps.push({ host: String(t.ssh.host), label, map: parsed, configSha: sha256(text), entries: entries.length });
      return {
        status: 'ok',
        observedValue: {
          host: t.ssh.host, label, path: configPath, sha256: sha256(text), lines: text.split('\n').length,
          sites: parsed.sites.map((s) => ({ hosts: s.hosts, entries: s.entries.length, catchAll: s.hasCatchAllStatic, catchAllLine: s.catchAllLine })),
          entries: entries.length,
        },
        evidenceFile: ev,
      };
    });
    if (rec.status === 'unavailable') rec.observedValue = { host: t.ssh.host, label };
  }

  // Карта node1 отдельно (host → matcher → handler → upstream → owner) + конфликты + guard scan.
  const primary = maps.find((m) => m.label === 'node1') || maps[0] || null;
  if (primary) {
    const mapCheckId = 'caddy-h1:map';
    const routes = primary.map.sites.flatMap((s) => {
      const stripMap = namespaceStripMap(s);
      return s.entries.map((e) => ({
        hosts: e.host, site: s.seq, line: e.line, matcher: e.matcher, methods: e.methods, paths: e.paths,
        publicPaths: publicPathsFor(e, stripMap), stripPrefix: e.stripPrefix || null, inRoute: !!e.inRoute,
        remoteIps: e.remoteIps, kind: e.kind, upstream: e.upstream, root: e.root, rewrite: e.rewrite,
        code: e.code, owner: routeOwner(e, policy), nestedIn: e.nestedIn,
      }));
    });
    const overlapGroups = buildOverlapGroups(primary.map, policy);
    const ambiguous = overlapGroups.filter((g) => g.ambiguous);
    await add('caddy-h1', mapCheckId, String(primary.host), 'derived from Caddyfile (no writes)', async () => {
      const ev = saveEvidence(mapCheckId, 'json', JSON.stringify({ host: primary.host, sha256: primary.configSha, routes, overlapGroups }, null, 1));
      return {
        status: ambiguous.length ? 'mismatch' : 'ok',
        observedValue: {
          host: primary.host, configSha: primary.configSha, routeCount: routes.length,
          routes, overlapGroups, ambiguousCount: ambiguous.length,
          catchAll: primary.map.sites.map((s) => ({ hosts: s.hosts, catchAllLine: s.catchAllLine, entries: s.entries.length })),
        },
        error: ambiguous.length ? `route_owner_conflict: ${ambiguous.length}` : null,
        evidenceFile: ev,
      };
    });

    const allFindings = [];
    const registryRoutes = (reg.components || []).map((c) => ({ componentId: c.componentId, routes: c.routes || [] }));
    for (const m of maps) for (const f of scanMutationGuards(m.map, policy, registryRoutes)) allFindings.push({ host: m.host, ...f });
    await add('caddy-h1', 'caddy-h1:guard-scan', String(primary.host), 'derived: mutation guard scan (no mutation called)', async () => {
      const blockers = allFindings.filter((f) => f.severity === 'BLOCKED');
      const warns = allFindings.filter((f) => f.severity === 'WARN');
      const ev = saveEvidence('caddy-h1-guard-scan', 'json', JSON.stringify(allFindings, null, 1));
      return {
        status: blockers.length ? 'mismatch' : 'ok',
        observedValue: { findings: allFindings, blockerCount: blockers.length, warnCount: warns.length },
        error: blockers.length ? blockers.map((b) => `${b.code}: ${b.host.join(',')}${((b.publicPaths && b.publicPaths.length ? b.publicPaths : b.paths) || []).join('|')} -> ${b.upstream}`).join('; ').slice(0, 400) : null,
        evidenceFile: ev,
      };
    });

    // Порядок static/Next/proxy: catch-all не должен стоять раньше адресных модулей.
    await add('caddy-h1', 'caddy-h1:order', String(primary.host), 'derived: catch-all safety', async () => {
      // Caddy сортирует handle-блоки по специфичности path-матчера, поэтому
      // catch-all ниже адресного модуля сам по себе не перекрывает модуль.
      // Опасны только: >1 catch-all на сайт и catch-all-proxy (перехват API).
      const issues = [];
      for (const s of primary.map.sites) {
        // Сравниваем только catch-all одного уровня вложенности: вложенный fallback
        // (например, respond 404 внутри namespace) не конкурирует с site-level.
        const byLevel = new Map();
        for (const e of s.entries) {
          if (e.matcher !== '(catch-all)') continue;
          const level = e.nestedIn || '(site)';
          if (!byLevel.has(level)) byLevel.set(level, []);
          byLevel.get(level).push(e);
        }
        for (const [level, list] of byLevel) {
          if (list.length > 1) issues.push({ host: s.hosts, reason: 'multiple_catch_all', level, lines: list.map((e) => e.line) });
        }
      }
      const observedValue = { catchAllIssues: issues, sites: primary.map.sites.length, orderModel: 'Caddy sorts handle blocks by path specificity; explicit module paths win over catch-all' };
      return {
        status: issues.length ? 'mismatch' : 'ok',
        observedValue,
        error: issues.length ? `catch_all_shadows_module: ${JSON.stringify(issues).slice(0, 300)}` : null,
        evidenceFile: saveEvidence('caddy-h1-order', 'json', JSON.stringify(observedValue, null, 1)),
      };
    });

    // Адаптированная конфигурация Caddy: порядок исполнения handler как его
    // видит сам Caddy. Только чтение (caddy adapt ничего не меняет).
    const node1Target = caddyTargets.find((t) => t.label === 'node1') || caddyTargets[0] || null;
    await add('caddy-h1', 'caddy-h1:adapted', String(primary.host), 'caddy adapt --config (read-only, redacted)', async () => {
      if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
      if (!node1Target) return { status: 'unavailable', error: 'no_ssh_target' };
      let raw;
      try { raw = await ssh(node1Target.ssh, `caddy adapt --config ${caddyConf.configPath} --adapter caddyfile --pretty`); }
      catch (e) {
        const msg = String((e && e.message) || e);
        return { status: 'unavailable', error: /timeout/i.test(msg) ? 'ssh_timeout' : `adapt_unavailable: ${msg.slice(0, 160)}` };
      }
      const text = String(raw.stdout || '');
      if (raw.exitCode !== 0 || !text.trim()) return { status: 'unavailable', error: `adapt_exit_${raw.exitCode}` };
      const parsed = tryJson(text);
      if (!parsed.ok) return { status: 'mismatch', error: 'adapt_json_invalid' };
      const { redacted, redactedKeys } = redactSensitiveJson(parsed.value);
      const { servers, routeCount, orderedRoutes } = summarizeAdaptedJson(redacted);
      // Порядок исполнения для пересекающихся путей: какие dial идут первыми.
      const norm = (p) => String(p || '').replace(/\*+$/, '').replace(/\/$/, '') || '/';
      const overlapOrder = overlapGroups.map((g) => {
        const want = norm(g.internalPath);
        const hits = orderedRoutes.filter((r) => r.match.some((m) => norm(m) === want || norm(m).endsWith(want)));
        return { publicPath: g.publicPath, internalPath: g.internalPath, orderedDials: hits.flatMap((h) => h.dials) };
      });
      const observedValue = {
        sha256: sha256(text), bytes: text.length,
        servers: Object.keys(servers), routeCount: orderedRoutes.length,
        overlapOrder, redactedKeys,
      };
      return {
        status: 'ok',
        observedValue,
        evidenceFile: saveEvidence('caddy-h1-adapted', 'json', JSON.stringify({ sha256: observedValue.sha256, servers: observedValue.servers, routeCount: orderedRoutes.length, overlapOrder, redacted: redactedKeys, config: redacted }, null, 1)),
      };
    });

    // Публичные маршруты окружений из карты (route → env component).
    for (const envId of Object.keys(policy.environments || {})) {
      const envComp = policy.environments[envId];
      if (!envComp || envComp.role === 'mainnet') continue;
      await add(envId, `${envId}:env-route`, String(primary.host), 'derived from Caddy map', async () => {
        const hits = [];
        for (const m of maps) {
          for (const s of m.map.sites) {
            const stripMap = namespaceStripMap(s);
            for (const e of s.entries) {
              const owner = routeOwner(e, policy);
              if (owner !== envId) continue;
              hits.push({ host: e.host, paths: e.paths, publicPaths: publicPathsFor(e, stripMap), methods: e.methods, matcher: e.matcher, upstream: e.upstream, line: e.line, mapHost: m.host });
            }
          }
        }
        const mutations = hits.filter((h) => (h.methods || []).some((x) => /^(POST|PUT|PATCH|DELETE)$/.test(x)));
        const observedValue = { publicRoutes: hits, mutationRoutes: mutations, count: hits.length };
        return {
          status: 'ok',
          observedValue,
          evidenceFile: saveEvidence(`${envId}-env-route`, 'json', JSON.stringify(observedValue, null, 1)),
        };
      });
    }
  } else {
    await add('caddy-h1', 'caddy-h1:map', 'n/a', 'no Caddyfile read', async () => ({ status: ctx.publicOnly ? 'not_checked' : 'unavailable', error: ctx.publicOnly ? 'public_only_ssh_skipped' : 'no_config' }));
  }

  // --- 2. Майнинг ---
  const minerObs = (byId.get('miner-stack') || {}).observe || null;
  if (minerObs && minerObs.ssh) {
    const ms = minerObs.ssh;
    const host = String(ms.host);
    await add('miner-stack', 'miner-stack:units', host, 'systemctl list-units --type=service --state=running via ssh', async () => {
      if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
      const r = await ssh(ms, 'systemctl list-units --type=service --state=running --no-legend --no-pager');
      if (r.exitCode !== 0 && !r.stdout.trim()) return { status: 'unavailable', error: `ssh_exit_${r.exitCode}` };
      const units = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
      const minerLike = units.filter((u) => /min|mine|watchdog|agentcoin|agt/i.test(u));
      const ev = saveEvidence('miner-stack-units', 'json', JSON.stringify({ units, minerLike }, null, 1));
      return { status: 'ok', observedValue: { unitCount: units.length, units, minerLike }, evidenceFile: ev };
    });
    await add('miner-stack', 'miner-stack:timers', host, 'systemctl list-timers --all via ssh', async () => {
      if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
      const r = await ssh(ms, 'systemctl list-timers --all --no-legend --no-pager');
      if (r.exitCode !== 0 && !r.stdout.trim()) return { status: 'unavailable', error: `ssh_exit_${r.exitCode}` };
      const timers = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/([A-Za-z0-9_.@:-]+\.timer)\s+([A-Za-z0-9_.@:-]+\.service)/);
        return m ? { unit: m[1], activates: m[2], raw: l.slice(0, 200) } : { raw: l.slice(0, 200) };
      });
      const ev = saveEvidence('miner-stack-timers', 'json', JSON.stringify(timers, null, 1));
      return { status: 'ok', observedValue: { timers, heartbeat: timers.some((t) => /heartbeat/.test(t.unit || '')) }, evidenceFile: ev };
    });
    await add('miner-stack', 'miner-stack:cron', host, 'crontab -l via ssh (scrubbed)', async () => {
      if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
      const r = await ssh(ms, 'crontab -l');
      const text = scrubSecrets(String(r.stdout || ''));
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const minerJobs = lines.filter((l) => /mine|miner/i.test(l));
      const watchdogJobs = lines.filter((l) => /watchdog/i.test(l));
      const ev = saveEvidence('miner-stack-cron', 'txt', text.slice(0, 20000));
      if (r.exitCode !== 0 && !lines.length) return { status: 'unavailable', error: `ssh_exit_${r.exitCode}`, observedValue: { lines: [] } };
      return { status: 'ok', observedValue: { lineCount: lines.length, minerJobs, watchdogJobs, lines }, evidenceFile: ev };
    });
    await add('miner-stack', 'miner-stack:cron-d', host, 'ls -1 /etc/cron.d via ssh', async () => {
      if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
      const r = await ssh(ms, 'ls -1 /etc/cron.d');
      const files = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      return { status: 'ok', observedValue: { files }, evidenceFile: saveEvidence('miner-stack-cron-d', 'json', JSON.stringify({ files }, null, 1)) };
    });
    for (const unit of ['agentcoin-miner.service', 'agentcoin-watchdog.service']) {
      const cid = unit === 'agentcoin-miner.service' ? 'miner-stack:miner-unit' : 'miner-stack:watchdog-unit';
      await add('miner-stack', cid, host, `systemctl show ${unit} via ssh`, async () => {
        if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
        const r = await ssh(ms, `systemctl show ${unit} --property=${SHOW_PROPS.join(',')}`);
        const p = parseShow(r.stdout);
        if (!p.ActiveState) return { status: 'unavailable', error: 'unit_state_absent' };
        const ex = execStartParts(p.ExecStart);
        const ev = saveEvidence(cid, 'json', JSON.stringify({ unit, ...p, argv: ex.argv }, null, 1));
        const obs = {
          unit, activeState: p.ActiveState, mainPid: p.MainPID ? Number(p.MainPID) : null,
          user: p.User || 'root', startTime: p.ExecMainStartTimestamp || null,
          execPath: ex.execPath, argv: ex.argv,
          addresses: ex.argv.filter((a) => /^AGT[0-9a-f]{40}$/i.test(a)),
          intervalSec: (() => {
            const nums = ex.argv.filter((a) => /^\d+$/.test(a));
            return nums.length >= 2 ? Number(nums[nums.length - 1]) : null;
          })(),
          watchTarget: ex.argv.find((a) => /\.mjs$/.test(a)) || null,
        };
        return {
          status: p.ActiveState === 'active' ? 'ok' : 'mismatch',
          observedValue: obs,
          error: p.ActiveState === 'active' ? null : `unit_inactive: ${p.ActiveState}`,
          evidenceFile: ev,
        };
      });
    }
    // Последние N блоков: кто произвёл (coinbase/miner).
    await add('miner-stack', 'miner-stack:recent-blocks', host, `GET /blocks (last ${policy.mining?.sampleBlocks || 20}) via loopback ssh`, async () => {
      if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
      const base = (minerObs.localBase || 'http://127.0.0.1:9335').replace(/\/$/, '');
      const port = (base.match(/:(\d+)$/) || [])[1] || '9335';
      const info = await ssh(ms, `curl -sS -m 8 -i 'http://127.0.0.1:${port}/info'`);
      const infoBody = parseCurlDashI(info.stdout).body;
      const j = tryJson(infoBody);
      const blocks = j.ok && Number.isSafeInteger(j.value.blocks) ? j.value.blocks : null;
      if (!blocks) return { status: 'unknown', error: 'no_local_blocks' };
      const n = policy.mining?.sampleBlocks || 20;
      const from = Math.max(0, blocks - n);
      const r = await ssh(ms, `curl -sS -m 8 -i 'http://127.0.0.1:${port}/blocks?from=${from}&limit=${n}'`);
      const body = parseCurlDashI(r.stdout).body;
      const parsed = tryJson(body);
      if (!parsed.ok || !Array.isArray(parsed.value.blocks)) return { status: 'mismatch', error: 'blocks_json_invalid' };
      const list = parsed.value.blocks.filter((b) => isPlainObject(b) && Number.isSafeInteger(b.height)).slice(0, n);
      const producers = list.map((b) => {
        const cb = (b.txs || []).find((t) => t && String(t.from || '').toUpperCase() === 'COINBASE');
        return { height: b.height, miner: b.miner || null, coinbaseTo: cb ? cb.to : null, minedAt: b.minedAt || null };
      });
      const uniq = [...new Set(producers.map((p) => p.miner || p.coinbaseTo).filter(Boolean))];
      const ev = saveEvidence('miner-stack-recent-blocks', 'json', JSON.stringify({ from, blocks, producers }, null, 1));
      return {
        status: producers.length ? 'ok' : 'unknown',
        observedValue: { from, to: from + producers.length - 1, count: producers.length, producers, uniqueProducers: uniq, uniqueCount: uniq.length },
        error: producers.length ? null : 'no_blocks_in_response',
        evidenceFile: ev,
      };
    });
    // Расписание реестра vs наблюдение.
    await add('miner-stack', 'miner-stack:schedule', host, 'derived: registry schedule vs cron/units/timers', async () => {
      const comp = byId.get('miner-stack') || {};
      const expected = String((comp.expected && comp.expected.schedule) || comp.process || '');
      const get = (id) => ctx.observations.find((o) => o.checkId === id);
      const cron = get('miner-stack:cron');
      const units = get('miner-stack:units');
      const timers = get('miner-stack:timers');
      const minerUnit = get('miner-stack:miner-unit');
      const wdUnit = get('miner-stack:watchdog-unit');
      const observed = {
        cronMine: !!(cron && cron.status === 'ok' && cron.observedValue.minerJobs.length),
        cronWatchdog: !!(cron && cron.status === 'ok' && cron.observedValue.watchdogJobs.length),
        minerUnitActive: !!(minerUnit && minerUnit.status === 'ok' && minerUnit.observedValue.activeState === 'active'),
        watchdogUnitActive: !!(wdUnit && wdUnit.status === 'ok' && wdUnit.observedValue.activeState === 'active'),
        heartbeatTimer: !!(timers && timers.status === 'ok' && timers.observedValue.heartbeat),
        autoMiner60s: !!(minerUnit && minerUnit.status === 'ok' && minerUnit.observedValue.intervalSec === 60),
        cronEvery10m: !!(cron && cron.status === 'ok' && cron.observedValue.minerJobs.some((l) => /^\*\/10\b/.test(l))),
        watchTarget: (wdUnit && wdUnit.observedValue && wdUnit.observedValue.watchTarget) || null,
      };
      const missing = [];
      if (!observed.minerUnitActive) missing.push('agentcoin-miner.service active');
      if (!observed.cronMine) missing.push('*/10 mine-cron.sh');
      if (!observed.watchdogUnitActive && !observed.cronWatchdog) missing.push('watchdog (unit or cron)');
      const ev = saveEvidence('miner-stack-schedule', 'json', JSON.stringify({ expected, observed, missing }, null, 1));
      // Единый адресный пул ≠ независимость операторов: фиксируем отдельно.
      return {
        status: missing.length ? 'mismatch' : 'ok',
        observedValue: { expected, observed, missing, operatorsIndependent: 'UNKNOWN: адреса/операторы не доказывают независимость' },
        error: missing.length ? `schedule_gap: ${missing.join('; ')}` : null,
        evidenceFile: ev,
      };
    });
    // Независимость операторов: количество адресов НЕ является доказательством.
    // Один наблюдаемый miner service с N адресами ротации — это один оператор,
    // пока независимость не доказана иначе. Поэтому статус всегда unknown.
    await add('miner-stack', 'miner-stack:operators', host, 'derived: units + recent-blocks producers (no identity read)', async () => {
      const units = ctx.observations.find((o) => o.checkId === 'miner-stack:units');
      const recent = ctx.observations.find((o) => o.checkId === 'miner-stack:recent-blocks');
      const minerUnit = ctx.observations.find((o) => o.checkId === 'miner-stack:miner-unit');
      const minerServices = minerUnit && minerUnit.status === 'ok' && minerUnit.observedValue.activeState === 'active'
        ? [minerUnit.observedValue.unit] : [];
      const uniq = recent && recent.observedValue && Array.isArray(recent.observedValue.uniqueProducers)
        ? recent.observedValue.uniqueProducers : [];
      const observedValue = {
        minerServices, serviceCount: minerServices.length,
        uniqueAddresses: uniq, addressCount: uniq.length,
        singleService: minerServices.length <= 1,
        operatorsIndependent: 'UNKNOWN: адреса/операторы не доказывают независимость; один miner service с N адресами ротации считается одним оператором',
      };
      const ev = saveEvidence('miner-stack-operators', 'json', JSON.stringify(observedValue, null, 1));
      return {
        status: 'unknown',
        observedValue,
        error: 'operators_not_proven_independent',
        evidenceFile: ev,
      };
    });
  }

  // --- 3. Изоляция окружений ---
  for (const [envId, spec] of Object.entries(policy.environments || {})) {
    const comp = byId.get(envId);
    if (!comp) continue;
    const ob = comp.observe || {};
    const sshRef = ob.ssh || null;
    const host = sshRef ? String(sshRef.host) : 'n/a';
    const units = Array.isArray(ob.units) ? ob.units : [];
    const port = Array.isArray(ob.listenPorts) && ob.listenPorts.length ? ob.listenPorts[0]
      : (spec.role === 'mainnet' ? 9335 : null);

    // unit / user / pid / execstart / workdir / env-file (только имена)
    for (const unit of units.slice(0, 2)) {
      await add(envId, `${envId}:env-unit`, host, `systemctl show ${unit} via ssh`, async () => {
        if (!sshRef) return { status: 'unavailable', error: 'no_ssh_target' };
        if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
        const r = await ssh(sshRef, `systemctl show ${unit} --property=${SHOW_PROPS.join(',')}`);
        const p = parseShow(r.stdout);
        if (!p.ActiveState) return { status: 'unavailable', error: 'unit_state_absent' };
        const ex = execStartParts(p.ExecStart);
        const observedValue = {
          unit, activeState: p.ActiveState, mainPid: p.MainPID ? Number(p.MainPID) : null,
          user: p.User || 'root', group: p.Group || null,
          execPath: ex.execPath, argv: ex.argv,
          startTime: p.ExecMainStartTimestamp || null,
          workingDirectory: p.WorkingDirectory || null,
          environmentFiles: p.EnvironmentFiles ? p.EnvironmentFiles.replace(/\s*\(ignore_errors=[^)]*\)/g, '') : null,
          fragmentPath: p.FragmentPath || null, protectSystem: p.ProtectSystem || null,
          requires: p.Requires ? p.Requires.split(/\s+/).filter(Boolean) : [],
        };
        return {
          status: p.ActiveState === 'active' ? 'ok' : 'mismatch',
          observedValue,
          error: p.ActiveState === 'active' ? null : `unit_inactive: ${p.ActiveState}`,
          evidenceFile: saveEvidence(`${envId}-env-unit-${slug(unit)}`, 'json', JSON.stringify(observedValue, null, 1)),
        };
      });
    }

    // chainId / genesis / blocks на порту среды (без mainnet-пина: изоляция, а не совпадение)
    await add(envId, `${envId}:env-chain`, host, `GET /info+/health loopback:${port || '?'} via ssh`, async () => {
      if (!sshRef) return { status: 'unavailable', error: 'no_ssh_target' };
      if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
      if (!port) return { status: 'unknown', error: 'no_port_for_env' };
      const info = await ssh(sshRef, `curl -sS -m 8 -i 'http://127.0.0.1:${port}/info'`);
      const ib = parseCurlDashI(info.stdout);
      const ij = tryJson(ib.body);
      if (!ij.ok) return { status: 'mismatch', error: `info_json_invalid: http_${ib.httpStatus}` };
      const v = ij.value;
      const chainId = v.chainId || v.network || null;
      const genesis = v.genesisHash || v.genesis || null;
      let healthBlocks = null;
      let healthHash = null;
      try {
        const h = await ssh(sshRef, `curl -sS -m 8 -i 'http://127.0.0.1:${port}/health'`);
        const hb = parseCurlDashI(h.stdout);
        const hj = tryJson(hb.body);
        if (hj.ok && isPlainObject(hj.value)) { healthBlocks = Number.isSafeInteger(hj.value.blocks) ? hj.value.blocks : null; healthHash = hj.value.tipHash || null; }
      } catch { /* health необязателен */ }
      const ok = typeof chainId === 'string' && chainId && typeof genesis === 'string' && HEX64_RE.test(genesis);
      const observedValue = {
        port, chainId, genesis: genesis ? String(genesis).toLowerCase() : null,
        blocks: Number.isSafeInteger(v.blocks) ? v.blocks : null,
        healthBlocks, healthHash,
        snapshotCompatible: healthBlocks !== null && v.blocks !== undefined ? healthBlocks === v.blocks : null,
      };
      return {
        status: ok ? 'ok' : 'mismatch',
        observedValue,
        error: ok ? null : 'chain_identity_absent',
        evidenceFile: saveEvidence(`${envId}-env-chain`, 'json', JSON.stringify(observedValue, null, 1)),
      };
    });

    // cwd / права каталогов / DATA_DIR (значение только для разрешённых имён)
    await add(envId, `${envId}:env-data`, host, 'readlink /proc/PID/cwd + stat + allowlisted env names via ssh', async () => {
      if (!sshRef) return { status: 'unavailable', error: 'no_ssh_target' };
      if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
      const unitRec = ctx.observations.find((o) => o.checkId === `${envId}:env-unit` && o.status === 'ok');
      const pid = unitRec && unitRec.observedValue ? unitRec.observedValue.mainPid : null;
      let cwd = null;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          const r = await ssh(sshRef, `readlink -f /proc/${pid}/cwd`);
          cwd = String(r.stdout || '').trim() || null;
        } catch { cwd = null; }
      }
      const dirs = [];
      const want = [...new Set([cwd, unitRec && unitRec.observedValue ? unitRec.observedValue.workingDirectory : null].filter(Boolean))];
      if (want.length) {
        const safeDirs = want.filter((d) => /^\/[A-Za-z0-9_.\/-]+$/.test(d));
        if (safeDirs.length) {
          try {
            const r = await ssh(sshRef, `stat -c "%U %G %a %n" ${safeDirs.join(' ')}`);
            for (const line of String(r.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
              const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
              if (m) dirs.push({ user: m[1], group: m[2], mode: m[3], path: m[4] });
            }
          } catch { /* права необязательны */ }
        }
      }
      let envNames = null;
      let allowlisted = null;
      // Имена параметров env-файла — можно; значения — только для разрешённого списка.
      const envFiles = unitRec && unitRec.observedValue && unitRec.observedValue.environmentFiles
        ? String(unitRec.observedValue.environmentFiles).split(/\s+/).map((s) => s.trim()).filter(Boolean)
        : [];
      const envFile = envFiles.find((f) => /^\/etc\/[A-Za-z0-9_.-]+\.env$/.test(f)) || null;
      if (envFile) {
        try {
          const r = await ssh(sshRef, `cut -d= -f1 ${envFile}`);
          envNames = String(r.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean);
        } catch { envNames = null; }
        try {
          // Без скобок в shell-команде: альтернативы через ^NAME=, значения — только whitelisted.
          const pattern = (policy.envAllowedParamNames || []).map((n) => `^${n}=`).join('|');
          const r = await ssh(sshRef, `grep -E '${pattern}' ${envFile}`);
          allowlisted = {};
          for (const line of String(r.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
            const i = line.indexOf('=');
            if (i > 0) allowlisted[line.slice(0, i)] = line.slice(i + 1);
          }
        } catch { allowlisted = null; }
      }
      const dataDir = allowlisted && (allowlisted.DATA_DIR || allowlisted.AGT_DATA_DIR) ? (allowlisted.DATA_DIR || allowlisted.AGT_DATA_DIR) : null;
      if (dataDir && /^\/[A-Za-z0-9_.\/-]+$/.test(dataDir)) {
        try {
          const r = await ssh(sshRef, `stat -c "%U %G %a %n" ${dataDir}`);
          const m = String(r.stdout || '').trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
          if (m) dirs.push({ user: m[1], group: m[2], mode: m[3], path: m[4], isDataDir: true });
        } catch { /* необязательно */ }
      }
      const forbidden = envNames ? envNames.filter((n) => new RegExp(policy.envForbiddenParamPattern || 'SECRET').test(n)) : [];
      const ev = saveEvidence(`${envId}-env-data`, 'json', JSON.stringify({ cwd, dirs, envNames, allowlisted, dataDir, envFile }, null, 1));
      return {
        status: cwd || dirs.length ? 'ok' : 'unknown',
        observedValue: {
          cwd, dirs, dataDir, dataDirSource: dataDir ? 'allowlisted env DATA_DIR' : (cwd ? 'cwd only' : null),
          envFile, envFileParams: envNames, envForbiddenParamNames: forbidden, envValuesRead: policy.envAllowedParamNames || [],
        },
        error: cwd || dirs.length ? null : 'no_cwd_or_dirs',
        evidenceFile: ev,
      };
    });
  }

  // env-mainnet: пин цепи по трём нодам (агрегация, не второй список серверов).
  await add('env-mainnet', 'env-mainnet:chain-pin', 'n/a', 'derived: mainnet node observations', async () => {
    const nodes = (policy.environments['env-mainnet'] || {}).chainComponentIds || [];
    const seen = [];
    for (const cid of nodes) {
      const info = ctx.observations.find((o) => o.componentId === cid && /:local-info$/.test(o.checkId) && o.status === 'ok');
      if (!info || !info.observedValue) continue;
      seen.push({ componentId: cid, chainId: info.observedValue.chainId || null, genesis: info.observedValue.genesisHash || null, blocks: info.observedValue.blocks ?? null });
    }
    const bad = seen.filter((s) => s.chainId !== chainPin.chainId || String(s.genesis || '').toLowerCase() !== chainPin.genesis);
    const missing = nodes.filter((n) => !seen.some((s) => s.componentId === n));
    const observedValue = { pin: chainPin, seen, missing, allMatch: seen.length > 0 && bad.length === 0 };
    return {
      status: seen.length && !bad.length ? 'ok' : (seen.length ? 'mismatch' : 'unknown'),
      observedValue,
      error: bad.length ? `chain_pin_mismatch: ${bad.map((b) => b.componentId).join(',')}` : (seen.length ? null : 'no_node_chain_observations'),
      evidenceFile: saveEvidence('env-mainnet-chain-pin', 'json', JSON.stringify(observedValue, null, 1)),
    };
  });

  // --- 4. Единый сайт: страницы (C07) ---
  const sitePolicy = policy.site || {};
  const siteHost = sitePolicy.host || 'agentcoin.work';
  const pages = Array.isArray(sitePolicy.pages) ? sitePolicy.pages : [];
  for (const p of pages) {
    const cid = p.owner || 'site-static';
    const checkId = `${cid}:page-${slug(p.path)}`;
    await add(cid, checkId, siteHost, `GET https://${siteHost}${p.path} (redirect follow)`, async () => {
      const res = await ctx.fetchPage(`https://${siteHost}${p.path}`);
      const isHtml = /text\/html/i.test(String(res.contentType || '')) || /^\s*</.test(res.body);
      const facts = isHtml ? extractHtmlFacts(res.body) : {};
      const ev = saveEvidence(checkId, isHtml ? 'html' : 'txt', res.body.slice(0, MAX_BODY_BYTES));
      // Документированный 404 — тоже факт, но он не выдаётся за работающий модуль.
      const expectStatus = Number.isInteger(p.expectStatus) ? p.expectStatus : 200;
      const matched = res.httpStatus === expectStatus;
      const status = matched ? 'ok' : (res.httpStatus >= 500 ? 'unavailable' : 'mismatch');
      return {
        status,
        observedValue: {
          path: p.path, module: p.module || null, expectedOwner: p.owner || null, expectStatus,
          httpStatus: res.httpStatus, finalUrl: res.finalUrl, contentType: res.contentType,
          bytes: res.bytes, sha256: res.sha256, truncated: res.truncated,
          title: facts.title || null, h1: facts.h1 || null, h1s: facts.h1s || [],
          navHash: facts.navHash || null, navLinks: facts.navLinks || 0,
          releaseMarker: facts.releaseMarker || null, lang: facts.htmlLang || null,
          shellScript: facts.shellScript || [], stylesheet: facts.stylesheet || [],
          canonical: facts.canonical || null,
          networkIdentityRefs: facts.networkIdentityRefs || 0,
          agentRoomEntry: !!facts.agentRoomEntry, apiErrorDisplay: !!facts.apiErrorDisplay,
          languageSwitch: !!facts.languageSwitch,
          html: isHtml, documentedMissing: expectStatus !== 200 && matched,
          note: p.note || null,
        },
        error: matched ? null : `http_${res.httpStatus}_expected_${expectStatus}`,
        evidenceFile: ev,
      };
    });
  }
  await add('site-static', 'site-static:pages-summary', siteHost, 'derived: page identity comparison', async () => {
    const html = ctx.observations.filter((o) => /:page-/.test(o.checkId) && o.status === 'ok' && o.observedValue && o.observedValue.html);
    const bySha = new Map();
    for (const o of html) {
      const k = o.observedValue.sha256;
      if (!bySha.has(k)) bySha.set(k, []);
      bySha.get(k).push(o.observedValue);
    }
    const duplicates = [...bySha.entries()].filter(([, v]) => v.length > 1).map(([sha, v]) => ({
      sha256: sha, paths: v.map((x) => x.path), sameTitle: v.every((x) => x.title === v[0].title),
      sameH1: v.every((x) => x.h1 === v[0].h1), modules: [...new Set(v.map((x) => x.module))],
      rootDuplicated: v.some((x) => x.path === '/'),
    }));
    const shells = html.map((o) => o.observedValue.navHash).filter(Boolean);
    const shell = {
      navHashes: [...new Set(shells)],
      singleShell: shells.length > 1 && new Set(shells).size === 1,
      releaseMarkers: [...new Set(html.map((o) => o.observedValue.releaseMarker).filter(Boolean))],
      titles: html.map((o) => ({ path: o.observedValue.path, title: o.observedValue.title })),
      agentRoomEntry: html.filter((o) => /agent-room|агент/i.test(String(o.observedValue.title || '') + String((o.observedValue.h1s || []).join(' ')))).map((o) => o.observedValue.path),
    };
    // Честный профиль общего shell: script/stylesheet-набор + маркеры на страницу.
    const shellProfiles = html.map((o) => {
      const v = o.observedValue;
      return {
        path: v.path, canonical: v.canonical || null, httpStatus: v.httpStatus || null,
        shellScript: v.shellScript || [], stylesheet: v.stylesheet || [],
        navHash: v.navHash || null,
        releaseMarker: v.releaseMarker || null,
        networkIdentityRefs: v.networkIdentityRefs || 0,
        agentRoomEntry: !!v.agentRoomEntry, apiErrorDisplay: !!v.apiErrorDisplay,
        languageSwitch: !!v.languageSwitch,
        title: v.title || null, h1: v.h1 || null,
      };
    });
    const shellKeys = new Set(shellProfiles.map((p) => JSON.stringify([p.shellScript, p.stylesheet])));
    const shellConsistent = shellProfiles.length > 1 && shellKeys.size === 1;
    const releaseMarkerAbsent = shellProfiles.filter((p) => !p.releaseMarker).map((p) => p.path);
    const rootDup = duplicates.find((d) => d.rootDuplicated);
    const ev = saveEvidence('site-static-pages-summary', 'json', JSON.stringify({ duplicates, shell, shellProfiles, shellConsistent, releaseMarkerAbsent, pages: html.map((o) => o.observedValue) }, null, 1));
    return {
      status: rootDup ? 'mismatch' : 'ok',
      observedValue: { pageCount: html.length, duplicates, shell, shellProfiles, shellConsistent, releaseMarkerAbsent, rootDuplicate: rootDup || null },
      error: rootDup ? `duplicate_root_product: ${rootDup.paths.join(' == ')} (sha ${rootDup.sha256.slice(0, 12)}…)` : null,
      evidenceFile: ev,
    };
  });

  // --- 5. Settlement: реальный контракт, не выдуманный bare-путь ---
  const st = policy.settlement || {};
  const stHost = siteHost;
  await add('settlement-gateway', 'settlement-gateway:route-bare', stHost, `GET https://${stHost}${st.barePath} (no mutation)`, async () => {
    const res = await ctx.fetchPage(`https://${stHost}${st.barePath}`);
    const j = tryJson(res.body);
    const code = j.ok && isPlainObject(j.value) ? (j.value.error || null) : null;
    const expected404 = res.httpStatus === 404;
    const ev = saveEvidence('settlement-gateway-route-bare', 'json', res.body.slice(0, 4096));
    return {
      status: expected404 ? 'ok' : 'mismatch',
      observedValue: {
        path: st.barePath, httpStatus: res.httpStatus, errorCode: code,
        classification: 'PARAM_REQUIRED', requiredContract: st.requiredContract,
        note: 'голый путь не является контрактом: без orderId запрос не выполняется',
      },
      error: expected404 ? null : `bare_path_unexpected_${res.httpStatus}`,
      evidenceFile: ev,
    };
  });
  await add('settlement-gateway', 'settlement-gateway:route-param', stHost, `GET https://${stHost}${String(st.requiredContract).replace(':orderId', encodeURIComponent(st.probeOrderId))} (read-only)`, async () => {
    const url = `https://${stHost}${String(st.requiredContract).replace(':orderId', encodeURIComponent(st.probeOrderId))}`;
    const res = await ctx.fetchPage(url);
    const j = tryJson(res.body);
    const code = j.ok && isPlainObject(j.value) ? (j.value.error || null) : null;
    const routeExists = res.httpStatus === 404 && code === 'settlement_not_found';
    const ev = saveEvidence('settlement-gateway-route-param', 'json', res.body.slice(0, 4096));
    return {
      status: routeExists ? 'ok' : 'mismatch',
      observedValue: {
        path: st.requiredContract, probeOrderId: st.probeOrderId, httpStatus: res.httpStatus, errorCode: code,
        classification: 'PARAM_REQUIRED', routeExists,
        note: 'реальный orderId не выдумывается; проверено существование контракта и корректный отказ',
      },
      error: routeExists ? null : `settlement_contract_unproven: http_${res.httpStatus} ${code || ''}`.trim(),
      evidenceFile: ev,
    };
  });
  await add('settlement-gateway', 'settlement-gateway:source-sha', 'n/a', 'local repo vs deployed sha256sum via ssh', async () => {
    if (ctx.publicOnly) return { status: 'not_checked', error: 'public_only_ssh_skipped' };
    const sObs = (byId.get('settlement-gateway') || {}).observe || {};
    const files = Array.isArray(sObs.files) ? sObs.files : [];
    if (!sObs.ssh || !files.length) return { status: 'unknown', error: 'no_deployed_files' };
    const r = await ssh(sObs.ssh, `sha256sum ${files.join(' ')}`);
    const remote = {};
    for (const line of String(r.stdout || '').split('\n')) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/i);
      if (m) remote[m[2]] = m[1].toLowerCase();
    }
    const out = [];
    for (const f of files) {
      const localPath = path.join(ctx.localRoot, f.replace('/opt/agentcoin-settlement/current/', ''));
      let local = null;
      try { local = sha256(fs.readFileSync(localPath)); } catch { local = null; }
      out.push({ path: f, local, remote: remote[f] || null, equal: !!local && local === remote[f] });
    }
    const allEqual = out.every((x) => x.equal);
    const ev = saveEvidence('settlement-gateway-source-sha', 'json', JSON.stringify(out, null, 1));
    return {
      status: allEqual ? 'ok' : 'mismatch',
      observedValue: { files: out, contractPinned: allEqual },
      error: allEqual ? null : 'deployed_source_differs_from_repo',
      evidenceFile: ev,
    };
  });

  // --- 6. Локальные компоненты: sdk/cli/mcp/pilot ---
  const localChecks = [
    {
      componentId: 'sdk-js', checkId: 'sdk-js:files',
      files: ['sdk/js/agentcoin-sdk.mjs', 'sdk/js/money.mjs', 'sdk/js/mainnet-node-api.mjs', 'sdk/js/agentcoin-browser.mjs'],
    },
    { componentId: 'cli', checkId: 'cli:files', files: ['sdk/js/agentcoin-cli.mjs'] },
    { componentId: 'mcp', checkId: 'mcp:files', files: ['mcp/agentcoin-mcp.mjs'] },
  ];
  for (const lc of localChecks) {
    await add(lc.componentId, lc.checkId, 'local', 'fs + node --check (no network)', async () => {
      const files = [];
      for (const rel of lc.files) {
        const abs = path.join(ctx.localRoot, rel);
        let exists = false;
        let bytes = 0;
        let hash = null;
        let syntax = 'missing';
        try {
          const buf = fs.readFileSync(abs);
          exists = true; bytes = buf.length; hash = sha256(buf);
          const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 20000 });
          syntax = r.status === 0 ? 'ok' : `error: ${String(r.stderr || '').split('\n')[0].slice(0, 160)}`;
        } catch (e) { syntax = `error: ${String(e.message || e).slice(0, 120)}`; }
        files.push({ path: rel, exists, bytes, sha256: hash, syntax });
      }
      const ok = files.every((f) => f.exists && f.syntax === 'ok');
      const ev = saveEvidence(lc.checkId, 'json', JSON.stringify(files, null, 1));
      return { status: ok ? 'ok' : 'mismatch', observedValue: { files }, error: ok ? null : 'file_or_syntax_failure', evidenceFile: ev };
    });
  }
  const semantics = [
    {
      componentId: 'sdk-js', checkId: 'sdk-js:semantics', checks: [
        { file: 'sdk/js/agentcoin-sdk.mjs', needles: ['mainnet', 'settlement'] },
        { file: 'sdk/js/mainnet-node-api.mjs', needles: ['submitSignedTx', 'checkConfirmation'] },
      ],
    },
    { componentId: 'cli', checkId: 'cli:semantics', checks: [{ file: 'sdk/js/agentcoin-cli.mjs', needles: ['settlement', 'JSON.stringify'] }] },
    { componentId: 'mcp', checkId: 'mcp:semantics', checks: [{ file: 'mcp/agentcoin-mcp.mjs', needles: ['status', 'my_task', 'payments', 'events', 'offers_search'] }] },
  ];
  for (const s of semantics) {
    await add(s.componentId, s.checkId, 'local', 'source read (read-only)', async () => {
      const results = [];
      for (const c of s.checks) {
        let text = '';
        try { text = fs.readFileSync(path.join(ctx.localRoot, c.file), 'utf8'); } catch { results.push({ file: c.file, found: [], missing: c.needles, error: 'missing_source' }); continue; }
        results.push({ file: c.file, found: c.needles.filter((n) => text.includes(n)), missing: c.needles.filter((n) => !text.includes(n)) });
      }
      const missing = results.flatMap((r) => r.missing.map((m) => `${r.file}:${m}`));
      const ev = saveEvidence(s.checkId, 'json', JSON.stringify(results, null, 1));
      return {
        status: missing.length ? 'mismatch' : 'ok',
        observedValue: { checks: results, missing },
        error: missing.length ? `semantics_missing: ${missing.join(',')}` : null,
        evidenceFile: ev,
      };
    });
  }
  await add('api-gateway-pilot', 'api-gateway-pilot:offline', 'local', 'node test/api-gateway.mjs (offline pilot, no prod)', async () => {
    const testFile = path.join(ctx.localRoot, 'test', 'api-gateway.mjs');
    if (!fs.existsSync(testFile)) return { status: 'unknown', error: 'pilot_test_missing' };
    const r = spawnSync(process.execPath, [testFile], { encoding: 'utf8', timeout: 120000, cwd: ctx.localRoot });
    const out = scrubSecrets(String(r.stdout || '') + String(r.stderr || '')).slice(-4000);
    const ev = saveEvidence('api-gateway-pilot-offline', 'txt', out);
    return {
      status: r.status === 0 ? 'ok' : 'mismatch',
      observedValue: { exitCode: r.status, tail: out.slice(-1200), scope: 'offline pilot (no listener, no network)' },
      error: r.status === 0 ? null : `pilot_test_exit_${r.status}`,
      evidenceFile: ev,
    };
  });

  // --- 7. Секреты и mutation-дисциплина ---
  await add('security', 'security:secret-scan', 'local', 'scan evidence + observed values (no values stored)', async () => {
    const patterns = [
      { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{20,}/ },
      { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
      { name: 'assigned-secret', re: /(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i },
    ];
    const findings = [];
    const files = [];
    if (ctx.evidenceDir && fs.existsSync(ctx.evidenceDir)) {
      for (const name of fs.readdirSync(ctx.evidenceDir).sort()) {
        const p = path.join(ctx.evidenceDir, name);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const pat of patterns) {
          const m = text.match(pat.re);
          if (m) findings.push({ file: `evidence/${name}`, pattern: pat.name, matchSha256: sha256(m[0]).slice(0, 16), length: m[0].length });
        }
        files.push(`evidence/${name}`);
      }
    }
    const ev = saveEvidence('security-secret-scan', 'json', JSON.stringify({ scanned: files.length, findings }, null, 1));
    return {
      status: findings.length ? 'mismatch' : 'ok',
      observedValue: { scannedFiles: files.length, findings },
      error: findings.length ? `secret_in_evidence: ${findings.length}` : null,
      evidenceFile: ev,
    };
  });
  await add('security', 'security:mutation-not-called', 'local', 'scan observations for mutation calls', async () => {
    const mutPaths = /\/(tx|mine|submit|preview|obligations|order|claim|send|approve|payout|upload|rent)(\?|$|\/)/i;
    const hits = [];
    for (const o of ctx.observations) {
      const ep = String(o.sourceEndpoint || '');
      const isPost = /^POST\s/i.test(ep) || /method=POST/i.test(JSON.stringify(o.observedValue || {}));
      if (isPost) hits.push({ checkId: o.checkId, sourceEndpoint: ep.slice(0, 160), reason: 'post' });
      else if (/^https?:\/\//.test(ep) && mutPaths.test(new URL(ep).pathname) && !/(settlements\/[^/]+\/status|sites\/release|\/info|\/health)/.test(ep)) {
        const method = (o.observedValue && o.observedValue.method) || 'GET';
        if (!/^GET$/i.test(method)) hits.push({ checkId: o.checkId, sourceEndpoint: ep.slice(0, 160), reason: 'non-get' });
      }
    }
    const ev = saveEvidence('security-mutation-not-called', 'json', JSON.stringify(hits, null, 1));
    return {
      status: hits.length ? 'mismatch' : 'ok',
      observedValue: { mutationCalls: hits, checked: ctx.observations.length },
      error: hits.length ? `mutation_called: ${hits.map((h) => h.checkId).join(',')}` : null,
      evidenceFile: ev,
    };
  });

  return ctx.observations.slice(stageStart);
}

function parseArgs(argv) {
  const a = { registry: null, policy: null, out: null, publicOnly: false, reuse: false, concurrency: 2 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--registry') a.registry = argv[++i];
    else if (argv[i] === '--policy') a.policy = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--public-only') a.publicOnly = true;
    else if (argv[i] === '--reuse') a.reuse = true;
    else if (argv[i] === '--concurrency') a.concurrency = Number(argv[++i]);
  }
  return a;
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href; } catch { return false; } })();
if (isMain) {
  const args = parseArgs(process.argv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  const regFile = args.registry || path.join(root, 'config', 'unified-registry.json');
  const polFile = args.policy || path.join(root, 'config', 'truth-gate-policy.json');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const policy = JSON.parse(fs.readFileSync(polFile, 'utf8'));
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = args.out || path.join(root, 'reports', `stage3-${stamp}`);
  const evidenceDir = path.join(outDir, 'evidence');
  fs.mkdirSync(outDir, { recursive: true });

  const obsFile = path.join(outDir, 'observations.json');
  let base = [];
  if (args.reuse && fs.existsSync(obsFile)) {
    const prev = JSON.parse(fs.readFileSync(obsFile, 'utf8'));
    const stage3Prefixes = ['caddy-', 'miner-stack:', 'env-', 'security:', 'sdk-js:', 'cli:', 'mcp:', 'api-gateway-pilot:', 'settlement-gateway:route', 'settlement-gateway:source', 'site-static:page', 'site-static:pages-summary', 'site-static:page-'];
    base = (prev.observations || []).filter((o) => !stage3Prefixes.some((p) => String(o.checkId || '').startsWith(p)));
    console.log(`reuse: kept ${base.length} baseline observations`);
  } else {
    const res = await collectBaseline(reg, { evidenceDir, publicOnly: args.publicOnly, concurrency: args.concurrency, httpTimeoutMs: 15000 });
    base = res.observations;
    console.log(`baseline: ${base.length} observations`);
  }
  const stage3 = await collectStage3(reg, policy, { evidenceDir, publicOnly: args.publicOnly, baseObservations: base });
  const observations = [...base, ...stage3];
  const summary = { total: observations.length };
  for (const o of observations) summary[o.status] = (summary[o.status] || 0) + 1;
  fs.writeFileSync(obsFile, JSON.stringify({ collectedAt: new Date().toISOString(), publicOnly: args.publicOnly, policyVersion: policy.version, summary, observations }, null, 1));
  let md = `# Этап 3 — read-only срез для Truth Gate\n\n- policy=${policy.version} publicOnly=${args.publicOnly}\n- summary: ${JSON.stringify(summary)}\n`;
  for (const st of ['mismatch', 'unavailable', 'unknown', 'not_checked']) {
    const rows = observations.filter((o) => o.status === st);
    md += `\n## ${st} (${rows.length})\n`;
    for (const r of rows) md += `- ${r.checkId} [${r.componentId}] err=${r.error || '-'}\n`;
  }
  fs.writeFileSync(path.join(outDir, 'COLLECT3.md'), md);
  console.log(`COLLECT3 OK total=${summary.total} ` + Object.entries(summary).filter(([k]) => k !== 'total').map(([k, v]) => `${k}=${v}`).join(' '));
  console.log(`out=${outDir}`);
}
