#!/usr/bin/env node
// truth-gate.mjs — Этап 3: единый строгий контрольный шлюз.
// Входы: unified-registry.json, observations.json, diff.json, truth-gate-policy.json.
// Выход: verdict PASS|WARN|BLOCKED + blockers/warnings/unknowns/coverage/evidence/nextActions.
// Никаких исправлений, рестартов, деплоев и транзакций: только классификация.
// Детерминизм: в выходе нет времени генерации и случайных значений; сортировка стабильная.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HEX64_RE } from './net-collect.mjs';

const ALLOWED_NOT_CHECKED = (policy) => new Set(policy.notCheckedAllowedReasons || []);
const norm = (s) => String(s || '').replace(/\/+$/, '') || '/';

function uniqSorted(arr) {
  return [...new Set(arr)].sort();
}

function sortByKeys(arr, keys) {
  return arr.slice().sort((a, b) => {
    for (const k of keys) {
      const av = String(a[k] ?? '');
      const bv = String(b[k] ?? '');
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
}

function obsIndex(observations) {
  const byComponent = new Map();
  const byId = new Map();
  for (const o of observations) {
    if (!o || typeof o.checkId !== 'string') continue;
    if (!byComponent.has(o.componentId)) byComponent.set(o.componentId, []);
    byComponent.get(o.componentId).push(o);
    byId.set(o.checkId, o);
  }
  return { byComponent, byId };
}

// Обязательная проверка: pattern — суффикс/подстрока checkId.
function hasRequired(list, pattern) {
  if (pattern === 'any-ok') return list.some((o) => o.status === 'ok');
  if (pattern.endsWith('*')) {
    const p = pattern.slice(0, -1);
    return list.some((o) => String(o.checkId).includes(p) && o.status === 'ok');
  }
  return list.some((o) => {
    if (o.status !== 'ok') return false;
    const id = String(o.checkId);
    return id === pattern || id.endsWith(`:${pattern}`) || id.includes(pattern);
  });
}

export function evaluateGate({ registry, observations, diff, policy, evidenceFiles = null }) {
  const blockers = [];
  const warnings = [];
  const unknowns = [];
  const evidenceRefs = [];

  // Повреждённый вход — не исключение, а BLOCKED с точной причиной.
  if (!registry || !Array.isArray(registry.components) || !registry.chain) {
    return {
      verdict: 'BLOCKED',
      blockers: [{ code: 'CORRUPT_INPUT', componentId: '*', checkId: null, message: 'unified-registry.json отсутствует/повреждён: нет components[] или chain', evidence: [] }],
      warnings: [], unknowns: [],
      coverage: { components: {}, summary: { total: 0 } },
      evidence: [], nextActions: ['Восстановить валидный реестр из принятого пакета этапа 1/2.'],
    };
  }
  if (!Array.isArray(observations)) {
    return {
      verdict: 'BLOCKED',
      blockers: [{ code: 'CORRUPT_INPUT', componentId: '*', checkId: null, message: 'observations.json отсутствует/повреждён: нет observations[]', evidence: [] }],
      warnings: [], unknowns: [],
      coverage: { components: {}, summary: { total: 0 } },
      evidence: [], nextActions: ['Пересобрать read-only срез: tools/gate-collect.mjs.'],
    };
  }
  const obs = observations.filter((o) => o && typeof o.checkId === 'string');
  const { byComponent, byId } = obsIndex(obs);
  const allowed = ALLOWED_NOT_CHECKED(policy);
  const addBlocker = (code, componentId, checkId, message, evidence = []) => blockers.push({ code, componentId, checkId, message, evidence });
  const addWarning = (code, componentId, checkId, message, evidence = []) => warnings.push({ code, componentId, checkId, message, evidence });
  const addUnknown = (code, componentId, checkId, message, evidence = []) => unknowns.push({ code, componentId, checkId, message, evidence });
  // Итоговый инвариант: блокер без доказательства недопустим (кроме мета-кодов
  // про сам вход/выход). Проверяется один раз в конце — без рекурсии.
  const META_CODES = new Set(['CORRUPT_INPUT', 'CORRUPT_OUTPUT']);
  const manifest = evidenceFiles ? new Set(evidenceFiles) : null;
  const enforceEvidenceInvariant = () => {
    for (const b of blockers) {
      if (META_CODES.has(b.code)) continue;
      const ev = Array.isArray(b.evidence) ? b.evidence : [];
      if (!ev.length) {
        blockers.push({ code: 'CORRUPT_OUTPUT', componentId: b.componentId, checkId: b.checkId, message: `гейт выдал ${b.code} без ссылки на доказательство: выход признан повреждённым`, evidence: [] });
        continue;
      }
      if (manifest) {
        const missing = ev.filter((p) => typeof p !== 'string' || !manifest.has(p));
        if (missing.length) {
          blockers.push({ code: 'CORRUPT_OUTPUT', componentId: b.componentId, checkId: b.checkId, message: `доказательство ${b.code} отсутствует в пакете: ${missing.join(', ')}`, evidence: [] });
        }
      }
    }
  };

  // ---------- 1. Покрытие компонентов ----------
  const coverageComponents = {};
  const requiredMap = policy.coverage?.required || {};
  const critical = new Set(policy.coverage?.critical || []);
  for (const c of registry.components) {
    const id = c.componentId;
    const list = byComponent.get(id) || [];
    const required = requiredMap[id] || policy.coverage?.defaultRequired || ['any-ok'];
    const missingRequired = required.filter((p) => !hasRequired(list, p));
    const count = (st) => list.filter((o) => o.status === st).length;
    const counts = {
      checks: list.length, ok: count('ok'), mismatch: count('mismatch'),
      unavailable: count('unavailable'), unknown: count('unknown'), not_checked: count('not_checked'),
    };
    let status;
    let reason = null;
    if ((policy.notApplicable || []).includes(id)) status = 'NOT_APPLICABLE';
    else if ((policy.offlineExpected || []).includes(id) && !list.length) status = 'OFFLINE_EXPECTED';
    else if (!list.length) { status = 'UNKNOWN'; reason = 'наблюдений нет'; }
    else if (counts.mismatch) { status = 'FAIL'; reason = `${counts.mismatch} mismatch`; }
    else if (missingRequired.length) { status = 'UNKNOWN'; reason = `нет обязательных проверок: ${missingRequired.join(', ')}`; }
    else if (counts.unknown) { status = 'UNKNOWN'; reason = `${counts.unknown} unknown`; }
    else if (counts.unavailable || counts.not_checked) { status = 'WARN'; reason = `unavailable=${counts.unavailable} not_checked=${counts.not_checked}`; }
    else status = 'PASS';
    coverageComponents[id] = {
      status, role: c.env, critical: critical.has(id), required, missingRequired, ...counts,
      evidence: uniqSorted(list.map((o) => o.evidenceFile).filter(Boolean)),
    };
    if (status === 'UNKNOWN') addUnknown('COVERAGE_UNKNOWN', id, null, `покрытие: ${reason}`);
    // «Без наблюдения» — это ноль успешных проверок, а не любой FAIL одного чека:
    // mismatch при наличии ok — содержательная находка, а не отсутствие наблюдения.
    if (critical.has(id) && counts.ok === 0) {
      addBlocker('CRITICAL_COMPONENT_UNWATCHED', id, null, `критический компонент без успешного наблюдения: ${reason}`, coverageComponents[id].evidence);
    }
  }

  // ---------- 2. chain pin ----------
  for (const o of obs) {
    if (/chain_pin_mismatch/i.test(String(o.error || ''))) {
      addBlocker('CHAIN_PIN_MISMATCH', o.componentId, o.checkId, o.error, [o.evidenceFile].filter(Boolean));
    }
  }
  const envPin = byId.get('env-mainnet:chain-pin');
  if (envPin && envPin.status === 'mismatch') {
    addBlocker('CHAIN_PIN_MISMATCH', 'env-mainnet', envPin.checkId, envPin.error || 'mainnet chain pin mismatch', [envPin.evidenceFile].filter(Boolean));
  }

  // ---------- 3. Same-height fork / монитор ----------
  const nodeCompare = (diff && diff.monitor && Array.isArray(diff.monitor.nodeCompare)) ? diff.monitor.nodeCompare : [];
  for (const n of nodeCompare) {
    if (n.result === 'DIVERGENT') {
      addBlocker('SAME_HEIGHT_FORK', n.componentId, 'nodeCompare', `разные хэши одной высоты ${n.proofHeight ?? n.monitorTipHeight}: ${n.reason}`, [n.proofEvidence].filter(Boolean));
    }
  }
  // Прямая сверка monitor-block проб: одна высота, разные хэши.
  const probeByHeight = new Map();
  for (const o of obs) {
    const m = /^(.+):monitor-block-(\d+)$/.exec(o.checkId);
    if (!m || o.status !== 'ok' || !o.observedValue) continue;
    const h = Number(m[2]);
    if (!Number.isSafeInteger(o.observedValue.height) || o.observedValue.height !== h) continue;
    const hash = String(o.observedValue.hash || '').toLowerCase();
    if (!HEX64_RE.test(hash)) continue;
    if (!probeByHeight.has(h)) probeByHeight.set(h, new Map());
    const mm = probeByHeight.get(h);
    if (!mm.has(hash)) mm.set(hash, []);
    mm.get(hash).push(o);
  }
  for (const [h, hashes] of [...probeByHeight.entries()].sort((a, b) => a[0] - b[0])) {
    if (hashes.size > 1) {
      addBlocker('SAME_HEIGHT_FORK', '*', `monitor-block-${h}`, `на высоте ${h} разные хэши у ${[...hashes.values()].flat().map((o) => o.componentId).join(', ')}`);
    }
  }
  if (diff && diff.monitor && diff.monitor.proxySuspect === true) {
    addBlocker('MONITOR_IMPERSONATION', 'node-monitor', 'proxySuspect', diff.monitor.proxyNote || 'монитор выдаёт данные другой ноды за локальные', []);
  }

  // ---------- 4. Пересечения деклараций маршрутов + catch-all ----------
  // ROUTE_PATTERN_OVERLAP: несколько деклараций одного публичного пути при
  // однозначном порядке Caddy (исполняется первый handler, остальные — тень).
  // ROUTE_OWNER_CONFLICT: только если эффективный владелец неоднозначен
  // (смесь route-блоков и сортируемых handle) — тогда это блокер.
  const mapObs = byId.get('caddy-h1:map');
  if (mapObs && mapObs.observedValue) {
    const groups = Array.isArray(mapObs.observedValue.overlapGroups) ? mapObs.observedValue.overlapGroups : [];
    const legacy = Array.isArray(mapObs.observedValue.conflicts) ? mapObs.observedValue.conflicts : [];
    const mapEv = [mapObs.evidenceFile].filter(Boolean);
    for (const c of legacy) {
      addBlocker('ROUTE_OWNER_CONFLICT', 'caddy-h1', 'caddy-h1:map',
        `${c.host}${c.path}: ${c.first.owner} (${c.first.target}) vs ${c.second.owner} (${c.second.target}) — legacy-форма без доказательства порядка`, mapEv);
    }
    for (const g of groups) {
      const decls = (g.matchingHandlers || []).map((h) => `${h.owner}@L${h.line}`).join(', ');
      const msg = `${g.host}${g.publicPath} (${(g.methods || []).join('/') || 'any'}): декларации ${decls}; ${g.reason}; эффективный ${g.effectiveOwner} (${g.effectiveTarget})`;
      if (g.ambiguous) {
        addBlocker('ROUTE_OWNER_CONFLICT', 'caddy-h1', 'caddy-h1:map', msg, mapEv);
      } else {
        addWarning('ROUTE_PATTERN_OVERLAP', 'caddy-h1', 'caddy-h1:map',
          `${msg}; тень: ${g.fallbackOwner} (${g.fallbackTarget})`, mapEv);
      }
    }
  }
  const orderObs = byId.get('caddy-h1:order');
  if (orderObs && orderObs.status === 'mismatch') {
    addBlocker('CATCH_ALL_SHADOWS_MODULE', 'caddy-h1', orderObs.checkId, orderObs.error || 'catch-all перекрывает модуль');
  }

  // ---------- 5. Изоляция окружений ----------
  const envData = new Map();
  for (const [envId, spec] of Object.entries(policy.environments || {})) {
    const d = byId.get(`${envId}:env-data`);
    const ch = byId.get(`${envId}:env-chain`);
    const u = byId.get(`${envId}:env-unit`);
    if (!d && !ch && !u) continue;
    envData.set(envId, {
      role: spec.role,
      chainId: ch && ch.observedValue ? ch.observedValue.chainId : null,
      genesis: ch && ch.observedValue ? ch.observedValue.genesis : null,
      dataDir: d && d.observedValue ? (d.observedValue.dataDir || null) : null,
      cwd: d && d.observedValue ? (d.observedValue.cwd || null) : null,
      dirs: d && d.observedValue && Array.isArray(d.observedValue.dirs) ? d.observedValue.dirs : [],
      user: u && u.observedValue ? (u.observedValue.user || null) : null,
      evidence: [d?.evidenceFile, ch?.evidenceFile, u?.evidenceFile].filter(Boolean),
    });
  }
  const mainnetPin = (policy.chains && policy.chains.mainnet) || { chainId: registry.chain.network, genesis: String(registry.chain.genesis).toLowerCase() };
  for (const [envId, e] of envData) {
    if (e.role === 'mainnet') continue;
    if (e.chainId && e.genesis && String(e.genesis).toLowerCase() === String(mainnetPin.genesis).toLowerCase()) {
      const documented = registry.components.some((c) => c.componentId === envId && c.documentedReason);
      if (!documented) addBlocker('TEST_ENV_MAINNET_GENESIS', envId, `${envId}:env-chain`, `${envId} использует mainnet genesis ${String(e.genesis).slice(0, 12)}… без documentedReason`, e.evidence);
    }
  }
  const envEntries = [...envData.entries()];
  for (let i = 0; i < envEntries.length; i++) {
    for (let j = i + 1; j < envEntries.length; j++) {
      const [aId, a] = envEntries[i];
      const [bId, b] = envEntries[j];
      // Пишущий каталог: DATA_DIR, иначе cwd процесса. Корень '/' не считается DATA_DIR.
      const aDir = a.dataDir || (a.cwd && a.cwd !== '/' ? a.cwd : null);
      const bDir = b.dataDir || (b.cwd && b.cwd !== '/' ? b.cwd : null);
      if (!aDir || !bDir) continue;
      const same = norm(aDir) === norm(bDir);
      const nested = norm(aDir).startsWith(norm(bDir) + '/') || norm(bDir).startsWith(norm(aDir) + '/');
      if (!same && !nested) continue;
      const differentChain = (a.chainId || '') !== (b.chainId || '');
      const roles = `${a.role}/${b.role}`;
      if (differentChain || /mainnet\/(testnet|staging|job-test)|(testnet|staging|job-test)\/mainnet/.test(roles)) {
        addBlocker('SHARED_WRITABLE_DATA_DIR', `${aId},${bId}`, null, `общий writable каталог ${aDir} у ${aId} (${a.role}, ${a.chainId}) и ${bId} (${b.role}, ${b.chainId})`, [...a.evidence, ...b.evidence]);
      }
    }
  }
  const mainnetData = envData.get('env-mainnet');
  if (mainnetData && !mainnetData.dataDir) {
    addUnknown('ENV_DATA_DIR_UNKNOWN', 'env-mainnet', 'env-mainnet:env-data', 'DATA_DIR mainnet не установлен (значение разрешённого параметра не найдено); cwd/права сняты, общий каталог не доказан');
  }

  // ---------- 6. Секреты и mutation-дисциплина ----------
  const secret = byId.get('security:secret-scan');
  if (secret && secret.status === 'mismatch') {
    addBlocker('SECRET_IN_EVIDENCE', 'security', secret.checkId, secret.error || 'секрет в evidence', [secret.evidenceFile].filter(Boolean));
  }
  const mutCalled = byId.get('security:mutation-not-called');
  if (mutCalled && mutCalled.status === 'mismatch') {
    addBlocker('MUTATION_ROUTE_CALLED', 'security', mutCalled.checkId, mutCalled.error || 'наблюдался вызов mutation-route', [mutCalled.evidenceFile].filter(Boolean));
  }
  const guard = byId.get('caddy-h1:guard-scan');
  if (guard && guard.observedValue && Array.isArray(guard.observedValue.findings)) {
    for (const f of guard.observedValue.findings) {
      if (f.severity !== 'BLOCKED') continue;
      const pub = (f.publicPaths && f.publicPaths.length ? f.publicPaths : (f.paths || [])).join(' ');
      const inner = (f.paths || []).join(' ');
      const auth = f.applicationAuth || 'UNKNOWN';
      const envs = (f.environmentFrom || f.environmentTo) ? `; env ${f.environmentFrom || '?'}→${f.environmentTo || '?'}` : '';
      if (f.code === 'TEST_MUTATION_TO_MAINNET') {
        addBlocker('TEST_MUTATION_TO_MAINNET', 'caddy-h1', 'caddy-h1:guard-scan',
          `тестовый хост ${(f.host || []).join(',')} проксирует ${(f.methods || []).join('/')} public ${pub} (internal ${inner}) в mainnet (${f.upstream})${envs}; applicationAuth=${auth}`, [guard.evidenceFile].filter(Boolean));
      } else {
        addBlocker('UNPROVEN_MUTATION_ROUTE', 'caddy-h1', 'caddy-h1:guard-scan',
          `публичная mutation-route ${(f.host || []).join(',')}${pub} (internal ${inner}) без наблюдаемой защиты; applicationAuth=${auth}`, [guard.evidenceFile].filter(Boolean));
      }
    }
    for (const f of guard.observedValue.findings) {
      if (f.severity === 'WARN') {
        const pub = (f.publicPaths && f.publicPaths.length ? f.publicPaths : (f.paths || [])).join('|');
        addWarning('UNPROVEN_MUTATION_ROUTE', 'caddy-h1', 'caddy-h1:guard-scan',
          `${(f.host || []).join(',')}${pub}: защита не наблюдается в конфиге (upstream ${f.upstream || '-'}); mutation не вызывалась; applicationAuth=${f.applicationAuth || 'UNKNOWN'}`);
      }
    }
  }

  // ---------- 7. Двойная главная + единство shell ----------
  const site = byId.get('site-static:pages-summary');
  if (site && site.observedValue && site.observedValue.rootDuplicate) {
    const d = site.observedValue.rootDuplicate;
    addBlocker('DUPLICATE_ROOT_PRODUCT', 'site-static', site.checkId,
      `двойник главной: ${d.paths.join(' == ')} — одинаковое тело sha ${String(d.sha256).slice(0, 12)}…, title/H1 совпадают`, [site.evidenceFile].filter(Boolean));
  }
  // Общий shell: все HTML-страницы единого сайта обязаны делить один
  // script/stylesheet-набор. Расхождение — SITE_SHELL_INCONSISTENT (блокер).
  // Отсутствие release-маркера — предупреждение (не блокер).
  if (site && site.observedValue && Array.isArray(site.observedValue.shellProfiles)) {
    const profiles = site.observedValue.shellProfiles;
    const siteEv = [site.evidenceFile].filter(Boolean);
    if (profiles.length > 1) {
      const keys = new Set(profiles.map((p) => JSON.stringify([(p.shellScript || []).slice().sort(), (p.stylesheet || []).slice().sort()])));
      if (keys.size > 1) {
        addBlocker('SITE_SHELL_INCONSISTENT', 'site-static', site.checkId,
          `страницы используют разный shell: ${profiles.map((p) => `${p.path}=[scripts:${(p.shellScript || []).join(',') || '-'}|css:${(p.stylesheet || []).join(',') || '-'}]`).join('; ')}`, siteEv);
      }
      const absent = profiles.filter((p) => !p.releaseMarker).map((p) => p.path);
      if (absent.length) {
        addWarning('SITE_RELEASE_MARKER_ABSENT', 'site-static', site.checkId,
          `на страницах нет release-маркера единого сайта: ${absent.join(', ')}`, siteEv);
      }
    }
  }

  // Документированное отсутствие модуля: 404 зафиксирован, но модуль не опубликован.
  for (const o of obs) {
    if (!/:page-/.test(o.checkId) || !o.observedValue || !o.observedValue.documentedMissing) continue;
    addWarning('MODULE_NOT_PUBLISHED', o.componentId, o.checkId, `модуль ${o.observedValue.path} документированно не опубликован (${o.observedValue.httpStatus}), backing не выдаётся за работающий`);
  }

  // ---------- 8. Settlement / платежи ----------
  for (const cid of ['settlement-gateway:route-bare', 'settlement-gateway:route-param', 'settlement-gateway:source-sha']) {
    const o = byId.get(cid);
    if (!o) continue;
    if (o.status === 'mismatch') {
      addBlocker('SETTLEMENT_CONTRACT_BROKEN', o.componentId, cid, o.error || 'settlement-контракт не подтверждён', [o.evidenceFile].filter(Boolean));
    }
  }

  // ---------- 9. Необоснованный not_checked и evidence ----------
  for (const o of obs) {
    if (o.status !== 'not_checked') continue;
    const err = String(o.error || '');
    const justified = [...allowed].some((r) => err.startsWith(r) || err.includes(r));
    if (!justified) {
      addBlocker('UNJUSTIFIED_NOT_CHECKED', o.componentId, o.checkId, `not_checked без допустимой причины: ${err || '(пусто)'}`, [o.evidenceFile].filter(Boolean));
    }
  }
  const evidencePrefixes = policy.coverage?.evidenceRequiredPrefixes || [];
  for (const o of obs) {
    if (o.status !== 'ok') continue;
    if (!evidencePrefixes.some((p) => String(o.checkId).startsWith(p))) continue;
    if (!o.evidenceFile) {
      addBlocker('MISSING_EVIDENCE', o.componentId, o.checkId, 'ok-наблюдение без evidence', []);
    } else {
      evidenceRefs.push(o.evidenceFile);
      if (!String(o.evidenceFile).startsWith('evidence/')) addBlocker('MISSING_EVIDENCE', o.componentId, o.checkId, `evidence вне каталога evidence/: ${o.evidenceFile}`, [o.evidenceFile]);
    }
  }

  // ---------- 10. Capabilities против маршрутов ----------
  for (const o of obs) {
    if (!/:caps-probe-/.test(o.checkId)) continue;
    if (o.status === 'mismatch' && /http_404/.test(String(o.error || ''))) {
      addWarning('CAPABILITY_GHOST', o.componentId, o.checkId, `рекламируемый read-route отсутствует: ${o.sourceEndpoint}`, [o.evidenceFile].filter(Boolean));
    } else if (o.status === 'unavailable' || o.status === 'unknown') {
      addWarning('CAPABILITY_GHOST', o.componentId, o.checkId, `рекламируемый маршрут не подтверждён: ${o.error}`, [o.evidenceFile].filter(Boolean));
    }
  }
  // UNDOCUMENTED_ROUTE: публичный GET-маршрут из карты Caddy, которого нет ни в реестре, ни в capabilities.
  const advertised = new Set();
  const capsObs = byId.get('mainnet-node-1:caps');
  if (capsObs && capsObs.observedValue && Array.isArray(capsObs.observedValue.advertisedReads)) {
    for (const p of capsObs.observedValue.advertisedReads) advertised.add(String(p).split(/\s+/).pop());
  }
  const registryPaths = new Set();
  for (const c of registry.components) for (const r of (c.routes || [])) registryPaths.add(String(r.path || ''));
  if (mapObs && mapObs.observedValue && Array.isArray(mapObs.observedValue.routes)) {
    // UNDOCUMENTED_ROUTE относится к машинным/API-маршрутам, а не к страницам:
    // страницы проверяются отдельно (C07 page identity / DUPLICATE_ROOT_PRODUCT).
    // Дедупликация: один и тот же публичный путь, заявленный несколькими
    // handler (разные строки/вложенность карты), — одно предупреждение со
    // списком handlerLines, а не N дублей.
    const machinePathRe = /^\/(api|mainnet|network|queue|ws|identity|cabinet|node|health|info|life|blocks|headers|capabilities|site|peers|gateway|tx|balance|working)(\/|$)/;
    const undoc = new Map();
    for (const r of mapObs.observedValue.routes) {
      const proxied = r.kind === 'site-proxy' || r.kind === 'handle_path' || !!r.upstream;
      if (!proxied) continue;
      // Только явно read-only маршруты: отсутствие method-матчера означает «любой метод»,
      // включая mutation, — такие маршруты оценивает guard-scan, а не этот список.
      if (!Array.isArray(r.methods) || !r.methods.length) continue;
      if (!r.methods.every((m) => m === 'GET')) continue;
      const pubs = Array.isArray(r.publicPaths) && r.publicPaths.length ? r.publicPaths : (r.paths || []);
      for (let i = 0; i < (r.paths || []).length; i++) {
        const p = (r.paths || [])[i];
        const pub = pubs[i] || p;
        if (!p || !pub || pub.includes('*') || pub.startsWith('@')) continue;
        if (!machinePathRe.test(pub)) continue;
        if (registryPaths.has(p) || registryPaths.has(pub) || advertised.has(p) || advertised.has(pub)) continue;
        if ((policy.caddy?.allowedDualPaths || []).includes(p) || (policy.caddy?.allowedDualPaths || []).includes(pub)) continue;
        const owner = r.owner || 'unknown';
        const key = `UNDOCUMENTED_ROUTE|${(r.hosts || []).join('|')}|GET|${pub}|${owner}`;
        if (!undoc.has(key)) {
          undoc.set(key, {
            hosts: (r.hosts || []).join('|'), publicPath: pub, owner, kind: r.kind,
            lines: [], evidence: [mapObs.evidenceFile].filter(Boolean),
          });
        }
        if (Number.isSafeInteger(r.line)) undoc.get(key).lines.push(r.line);
      }
    }
    for (const u of undoc.values()) {
      u.lines = [...new Set(u.lines)].sort((a, b) => a - b);
      addWarning('UNDOCUMENTED_ROUTE', 'caddy-h1', 'caddy-h1:map',
        `публичный маршрут ${u.hosts} → ${u.publicPath} не рекламирован и не в реестре (${u.kind}); владелец ${u.owner}; handlerLines [${u.lines.join(', ')}]`, u.evidence);
    }
  }

  // ---------- 11. Тайм-ауты: WARN, не падение ----------
  for (const o of obs) {
    if (o.status !== 'unavailable') continue;
    const timeout = /timeout/i.test(String(o.error || ''));
    if (!timeout) continue;
    addWarning('TIMEOUT_OR_UNAVAILABLE', o.componentId, o.checkId, `тайм-аут: ${o.error} — WARN, не доказательство падения`, [o.evidenceFile].filter(Boolean));
  }
  // LAGGING/STALE — отдельные WARN, не форк.
  for (const n of nodeCompare) {
    if (n.result === 'LAGGING') addWarning('LAGGING', n.componentId, 'nodeCompare', `локальная ${n.localTipHeight} < монитора ${n.monitorTipHeight}: отставание, не расхождение`);
    if (n.result === 'STALE') addWarning('STALE_COMPARE', n.componentId, 'nodeCompare', n.reason);
  }

  // ---------- 12. Дубли майнеров ----------
  const recent = byId.get('miner-stack:recent-blocks');
  if (recent && recent.observedValue && Array.isArray(recent.observedValue.producers)) {
    // Один производитель на блок — норма; два активных юнита фиксируются schedule/units.
    const units = byId.get('miner-stack:units');
    if (units && units.observedValue && Array.isArray(units.observedValue.minerLike)) {
      const activeMiners = units.observedValue.minerLike.filter((u) => /miner|mine-cron/i.test(u));
      if (activeMiners.length > 1) addWarning('DUPLICATE_MINER', 'miner-stack', 'miner-stack:units', `несколько майнящих юнитов: ${activeMiners.join(', ')}`);
    }
  }
  if (recent && recent.observedValue && recent.observedValue.uniqueCount === 1) {
    addWarning('OWNER_UNKNOWN', 'miner-stack', 'miner-stack:recent-blocks', 'все последние блоки — один адрес; независимость операторов не доказана');
  }
  // Независимость операторов майнинга — всегда UNKNOWN, пока не доказана иначе.
  // Количество адресов доказательством не является: один наблюдаемый miner
  // service с N адресами ротации считается одним оператором. UNKNOWN виден
  // в unknowns со своим кодом, а не скрыт за нулём.
  if (registry.components.some((c) => c.componentId === 'miner-stack')) {
    const ops = byId.get('miner-stack:operators');
    const sched = byId.get('miner-stack:schedule');
    const text = (ops && ops.observedValue && ops.observedValue.operatorsIndependent)
      || (sched && sched.observedValue && sched.observedValue.operatorsIndependent)
      || null;
    if (typeof text === 'string' && /UNKNOWN/i.test(text)) {
      addUnknown('MINER_OPERATOR_INDEPENDENCE_UNKNOWN', 'miner-stack',
        ops ? ops.checkId : (sched ? sched.checkId : null), String(text),
        [(ops && ops.evidenceFile) || (sched && sched.evidenceFile)].filter(Boolean));
    }
  }

  // ---------- Сводка ----------
  enforceEvidenceInvariant();
  const order = (a, b) => (a.code + String(a.componentId) + String(a.checkId)) < (b.code + String(b.componentId) + String(b.checkId)) ? -1 : 1;
  blockers.sort(order);
  warnings.sort(order);
  unknowns.sort(order);
  const compCounts = {};
  for (const v of Object.values(coverageComponents)) compCounts[v.status] = (compCounts[v.status] || 0) + 1;
  const verdict = blockers.length ? 'BLOCKED' : (warnings.length || compCounts.WARN || compCounts.UNKNOWN || compCounts.FAIL ? 'WARN' : 'PASS');

  const actionByCode = {
    CHAIN_PIN_MISMATCH: 'Остановить доверие к цепи: сверить chainId/genesis на всех нодах и в реестре; не деплоить.',
    SAME_HEIGHT_FORK: 'Зафиксировать высоту и оба хэша; расследовать форк до любых операций с деньгами.',
    ROUTE_OWNER_CONFLICT: 'Устранить неоднозначность порядка: один публичный URL — один эффективный владелец.',
    ROUTE_PATTERN_OVERLAP: 'Убрать теневую декларацию: оставить один handler на публичный путь.',
    SITE_SHELL_INCONSISTENT: 'Унифицировать shell единого сайта: один script/stylesheet-набор на всех страницах.',
    SITE_RELEASE_MARKER_ABSENT: 'Проставить release-маркер единого сайта на всех страницах.',
    CORRUPT_OUTPUT: 'Исправить гейт: каждый блокер обязан ссылаться на доказательство из пакета.',
    SHARED_WRITABLE_DATA_DIR: 'Развести DATA_DIR сред; проверить права и смонтированные каталоги.',
    SECRET_IN_EVIDENCE: 'Удалить секрет из evidence, пересобрать пакет, ротировать засвеченный ключ.',
    DUPLICATE_ROOT_PRODUCT: 'Оставить одну главную; двойник — 308 на канон или отдельный модуль с своим URL.',
    UNPROVEN_MUTATION_ROUTE: 'Доказать защиту mutation-route (auth/remote_ip/подпись) или закрыть маршрут.',
    TEST_MUTATION_TO_MAINNET: 'Убрать запись в mainnet с тестового хоста: тестовая среда не должна писать в прод.',
    TEST_ENV_MAINNET_GENESIS: 'Дать тестовой среде собственный genesis или документировать причину.',
    MONITOR_IMPERSONATION: 'Проверить источник данных монитора: запись ноды не должна повторять чужую.',
    CRITICAL_COMPONENT_UNWATCHED: 'Добавить наблюдение критического компонента; отсутствие проверки не равно исправности.',
    SETTLEMENT_CONTRACT_BROKEN: 'Восстановить контракт settlement и сверить задеплоенный код с репозиторием.',
    UNJUSTIFIED_NOT_CHECKED: 'Заменить not_checked на проверку или на явную причину (PARAM_REQUIRED/OFFLINE_EXPECTED).',
    CATCH_ALL_SHADOWS_MODULE: 'Переставить catch-all после адресных модулей.',
    MISSING_EVIDENCE: 'Приложить evidence к каждому ok-наблюдению.',
    CORRUPT_INPUT: 'Пересобрать входы гейта (реестр/наблюдения/diff) и повторить.',
    MUTATION_ROUTE_CALLED: 'Убрать вызов mutation-route из сбора; такие маршруты не вызываются.',
    CAPABILITY_GHOST: 'Убрать рекламу отсутствующего маршрута или восстановить маршрут.',
    UNDOCUMENTED_ROUTE: 'Задокументировать маршрут в реестре/capabilities или закрыть.',
    DUPLICATE_MINER: 'Оставить один майнящий процесс, остальные отключить по слову владельца.',
    MODULE_NOT_PUBLISHED: 'Опубликовать модуль или убрать его из ожиданий единого сайта.',
  };
  const nextActions = uniqSorted([...blockers, ...warnings].map((x) => actionByCode[x.code] || `Разобрать ${x.code}`));
  if (!nextActions.length) nextActions.push('Ничего не требуется: гейт PASS. Этап 4 не начинается автоматически.');

  return {
    verdict,
    blockers,
    warnings,
    unknowns,
    coverage: {
      components: coverageComponents,
      summary: { components: Object.keys(coverageComponents).length, ...compCounts, observations: obs.length },
    },
    evidence: uniqSorted(evidenceRefs),
    nextActions,
  };
}

// Markdown-отчёт детерминирован: тот же verdict → тот же текст.
export function renderMarkdown(result, meta = {}) {
  const L = [];
  L.push('# Truth Gate — этап 3');
  L.push('');
  L.push(`**Вердикт: ${result.verdict}**`);
  L.push('');
  L.push(`- policy: ${meta.policyVersion || 'n/a'}`);
  L.push(`- компонентов: ${result.coverage.summary.components}, наблюдений: ${result.coverage.summary.observations}`);
  L.push(`- blockers: ${result.blockers.length}, warnings: ${result.warnings.length}, unknowns: ${result.unknowns.length}`);
  L.push('');
  L.push('Гейт ничего не исправляет: только чтение и классификация. Mutation-маршруты не вызывались.');
  L.push('');
  L.push('## Blockers');
  if (!result.blockers.length) L.push('нет');
  for (const b of result.blockers) {
    L.push(`- **${b.code}** [${b.componentId}${b.checkId ? ` / ${b.checkId}` : ''}] — ${b.message}`);
    if (b.evidence && b.evidence.length) L.push(`  - evidence: ${b.evidence.join(', ')}`);
  }
  L.push('');
  L.push('## Warnings');
  if (!result.warnings.length) L.push('нет');
  for (const w of result.warnings) L.push(`- **${w.code}** [${w.componentId}${w.checkId ? ` / ${w.checkId}` : ''}] — ${w.message}`);
  L.push('');
  L.push('## Unknowns');
  if (!result.unknowns.length) L.push('нет');
  for (const u of result.unknowns) L.push(`- **${u.code || 'UNKNOWN'}** [${u.componentId}${u.checkId ? ` / ${u.checkId}` : ''}] — ${u.message}`);
  L.push('');
  L.push('## Покрытие компонентов');
  L.push('');
  L.push('| component | status | checks | ok | mismatch | unavailable | unknown | not_checked | missing required |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [id, c] of Object.entries(result.coverage.components).sort(([a], [b]) => (a < b ? -1 : 1))) {
    L.push(`| ${id} | ${c.status} | ${c.checks} | ${c.ok} | ${c.mismatch} | ${c.unavailable} | ${c.unknown} | ${c.not_checked} | ${(c.missingRequired || []).join(', ') || '—'} |`);
  }
  L.push('');
  L.push('## Следующие действия');
  for (const a of result.nextActions) L.push(`- ${a}`);
  L.push('');
  L.push('Этап 4 (план исправлений с бэкапом и откатом) начинается только после приёмки этого гейта.');
  return L.join('\n') + '\n';
}

function parseArgs(argv) {
  const a = { registry: null, observations: null, diff: null, policy: null, out: null, md: null, packlist: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--registry') a.registry = argv[++i];
    else if (k === '--observations') a.observations = argv[++i];
    else if (k === '--diff') a.diff = argv[++i];
    else if (k === '--policy') a.policy = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--md') a.md = argv[++i];
    else if (k === '--packlist') a.packlist = argv[++i];
  }
  return a;
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href; } catch { return false; } })();
if (isMain) {
  const args = parseArgs(process.argv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  let result;
  let meta = {};
  try {
    const reg = readJson(args.registry || path.join(root, 'config', 'unified-registry.json'));
    const policy = readJson(args.policy || path.join(root, 'config', 'truth-gate-policy.json'));
    const obsDoc = readJson(args.observations || path.join(root, 'reports', 'observations.json'));
    const diff = args.diff ? readJson(args.diff) : null;
    let evidenceFiles = null;
    if (args.packlist) {
      // Нормализация к виду evidence/...: в PACK-FILES пути лежат как
      // reports/<срез>/evidence/..., а наблюдения ссылаются как evidence/....
      evidenceFiles = fs.readFileSync(args.packlist, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
        .map((p) => { const i = p.indexOf('evidence/'); return i >= 0 ? p.slice(i) : p; });
      meta = { policyVersion: policy.version };
    } else {
      meta = { policyVersion: policy.version };
    }
    result = evaluateGate({ registry: reg, observations: obsDoc.observations, diff, policy, evidenceFiles });
  } catch (e) {
    result = {
      verdict: 'BLOCKED',
      blockers: [{ code: 'CORRUPT_INPUT', componentId: '*', checkId: null, message: `вход не читается как JSON: ${String((e && e.message) || e).slice(0, 200)}`, evidence: [] }],
      warnings: [], unknowns: [],
      coverage: { components: {}, summary: { components: 0, observations: 0 } },
      evidence: [], nextActions: ['Пересобрать входы гейта и повторить.'],
    };
  }
  const json = JSON.stringify(result, null, 2) + '\n';
  const md = renderMarkdown(result, meta);
  if (args.out) fs.writeFileSync(args.out, json);
  if (args.md) fs.writeFileSync(args.md, md);
  if (!args.out) process.stdout.write(json);
  console.error(`TRUTH GATE ${result.verdict} blockers=${result.blockers.length} warnings=${result.warnings.length} unknowns=${result.unknowns.length}`);
  process.exit(result.verdict === 'PASS' ? 0 : (result.verdict === 'WARN' ? 1 : 2));
}
