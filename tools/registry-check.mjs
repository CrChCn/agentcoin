#!/usr/bin/env node
// registry-check.mjs — машинная проверка единого реестра (Этап 1).
// Zero-deps. Ненулевой код при некорректном реестре.
// Проверки: дубли ID; ссылки на отсутствующие; обязательные поля;
// недопустимые статусы; «подтверждено» без доказательств;
// конфликт владельцев точного публичного маршрута; несовпадение сети у связанных.
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_STATUS = new Set(['confirmed', 'partial', 'unknown', 'contradiction']);
const EVIDENCE_RE = /^(E\d{2}|F\d{2}|C\d{2}|V\d{2}|config\/|site\/|tools\/|test\/|source-snapshots\/|config-redacted\/|docs\/|evidence\/|sdk\/|mcp\/)/;

function normPath(p) {
  if (typeof p !== 'string') return p;
  if (p.length > 1 && p.endsWith('/') && p !== '/') return p.slice(0, -1);
  return p;
}
function routeKey(r) {
  const m = String(r.method || 'GET').toUpperCase();
  return m + ' ' + String(r.host || '') + ' ' + normPath(String(r.path || ''));
}
function netPin(net) {
  if (typeof net !== 'string') return null;
  if (/neutral/i.test(net)) return 'NEUTRAL';
  const m = net.match(/([0-9a-f]{8,})/i);
  return m ? m[1].toLowerCase() : null;
}

export function checkRegistry(reg) {
  const errors = [];
  const warnings = [];
  if (!reg || typeof reg !== 'object') return { errors: ['registry_not_object'], warnings };
  const comps = reg.components;
  if (!Array.isArray(comps)) return { errors: ['components_not_array'], warnings };

  // 1. дубли ID
  const seen = new Map();
  for (const c of comps) {
    if (!c || typeof c.componentId !== 'string') { errors.push('missing componentId'); continue; }
    if (seen.has(c.componentId)) errors.push(`duplicate componentId: ${c.componentId}`);
    else seen.set(c.componentId, c);
  }
  const ids = new Set(seen.keys());

  for (const c of comps) {
    if (!c || typeof c.componentId !== 'string') continue;
    const id = c.componentId;
    // 2. обязательные поля (null = честно неизвестное, но поле обязано присутствовать)
    const required = ['purpose', 'env', 'host', 'process', 'sources', 'expectedVersion', 'routes', 'storage', 'dependsOn', 'network', 'expected', 'observed', 'verification', 'checkMethod', 'proofSource'];
    for (const f of required) {
      if (!(f in c)) errors.push(`${id}: missing required field ${f}`);
    }
    // purpose/env/host/process/checkMethod/proofSource: непустые строки (host может быть 'n/a' для клиентских)
    for (const f of ['purpose', 'env', 'host', 'process', 'checkMethod', 'proofSource']) {
      if (f in c && (typeof c[f] !== 'string' || !c[f].trim())) errors.push(`${id}: field ${f} must be non-empty string`);
    }
    if ('sources' in c && !Array.isArray(c.sources)) errors.push(`${id}: sources must be array`);
    if ('routes' in c && !Array.isArray(c.routes)) errors.push(`${id}: routes must be array`);
    if ('dependsOn' in c && !Array.isArray(c.dependsOn)) errors.push(`${id}: dependsOn must be array`);
    if ('storage' in c && !(typeof c.storage === 'string' || c.storage === null)) errors.push(`${id}: storage must be string|null`);
    if ('network' in c && !(typeof c.network === 'string' || c.network === null)) errors.push(`${id}: network must be string|null`);
    if ('expected' in c && (typeof c.expected !== 'object' || c.expected === null)) errors.push(`${id}: expected must be object`);
    if ('observed' in c && (typeof c.observed !== 'object' || c.observed === null)) errors.push(`${id}: observed must be object`);

    // verification
    const v = c.verification;
    if (v && typeof v === 'object') {
      if (!ALLOWED_STATUS.has(v.status)) errors.push(`${id}: invalid verification.status ${JSON.stringify(v.status)}`);
      if (!Array.isArray(v.evidence)) errors.push(`${id}: verification.evidence must be array`);
      if (!Array.isArray(v.unknowns)) errors.push(`${id}: verification.unknowns must be array`);
      if (typeof v.checkedAt !== 'string' || !v.checkedAt) errors.push(`${id}: verification.checkedAt must be non-empty string`);
      // «подтверждено» без доказательства
      if (v.status === 'confirmed' && (!Array.isArray(v.evidence) || v.evidence.length === 0)) {
        errors.push(`${id}: status confirmed requires non-empty verification.evidence`);
      }
      // evidence entries format
      if (Array.isArray(v.evidence)) {
        for (const e of v.evidence) {
          if (typeof e !== 'string' || !e.trim()) errors.push(`${id}: empty evidence entry`);
          else if (!EVIDENCE_RE.test(e)) errors.push(`${id}: unknown evidence reference ${JSON.stringify(e)}`);
        }
      }
      // честно неизвестное: null среди обязательных -> unknowns обязателен и статус не confirmed
      const hasNull = ['expectedVersion', 'storage', 'network'].some(f => c[f] === null) ||
        (c.chain && Object.values(c.chain).some(x => x === null));
      if (hasNull) {
        if (!Array.isArray(v.unknowns) || v.unknowns.length === 0) errors.push(`${id}: null field requires listed verification.unknowns`);
        if (v.status === 'confirmed') errors.push(`${id}: null field incompatible with status confirmed`);
      }
    } else {
      errors.push(`${id}: verification must be object`);
    }

    // ноды: доп. поля
    if (/^mainnet-node-/.test(id)) {
      if (!c.chain || typeof c.chain !== 'object') errors.push(`${id}: node requires chain object`);
      else {
        for (const f of ['chainId', 'genesis', 'activationParams', 'syncSource']) {
          if (!(f in c.chain)) errors.push(`${id}: chain missing ${f}`);
        }
      }
    }

    // 3. ссылки на отсутствующие
    if (Array.isArray(c.dependsOn)) {
      for (const d of c.dependsOn) {
        if (typeof d !== 'string') { errors.push(`${id}: dependsOn entry must be string`); continue; }
        if (!ids.has(d)) errors.push(`${id}: dependsOn missing component ${d}`);
      }
    }

    // маршруты: структура + алиасы/вложенность описаны
    if (Array.isArray(c.routes)) {
      for (const r of c.routes) {
        if (!r || typeof r.path !== 'string' || !r.path.startsWith('/')) errors.push(`${id}: route path must start with /`);
        if (!r || typeof r.host !== 'string' || !r.host) errors.push(`${id}: route host required`);
        if (typeof r.owner !== 'boolean') errors.push(`${id}: route owner must be boolean for ${r && r.path}`);
        if (typeof r.note !== 'string' || !r.note.trim()) errors.push(`${id}: route ${r && r.path} requires note (purpose/order)`);
        if (r && r.aliasOf !== undefined && r.aliasOf !== null && typeof r.aliasOf !== 'string') errors.push(`${id}: route aliasOf must be string|null`);
        if (r && r.aliasOf) {
          if (!r.note || !/alias/i.test(r.note)) warnings.push(`${id}: alias ${r.path} note should mention alias/order`);
          if (r.owner !== false) errors.push(`${id}: alias route ${r.path} must have owner:false`);
        }
      }
    }
  }

  // 4. конфликт владельцев точного маршрута
  const owners = new Map();
  for (const c of comps) {
    if (!Array.isArray(c.routes)) continue;
    for (const r of c.routes) {
      if (!r || r.owner !== true) continue;
      if (r.aliasOf) continue; // алиасы не конфликтуют (и выше требуем owner:false, сюда не попадёт)
      const k = routeKey(r);
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push(c.componentId);
    }
  }
  for (const [k, list] of owners) {
    if (list.length > 1) errors.push(`route owner conflict: ${k} claimed by ${list.join(', ')}`);
  }

  // 5. несовпадение закреплённой сети у связанных
  const byId = new Map(comps.filter(c => c && typeof c.componentId === 'string').map(c => [c.componentId, c]));
  for (const c of comps) {
    if (!c || !Array.isArray(c.dependsOn)) continue;
    const a = netPin(c.network);
    if (!a || a === 'NEUTRAL') continue;
    for (const d of c.dependsOn) {
      const t = byId.get(d);
      if (!t) continue;
      const b = netPin(t.network);
      if (!b || b === 'NEUTRAL') continue;
      if (a !== b) errors.push(`${c.componentId}: network pin mismatch with ${d} (${a} vs ${b})`);
    }
  }

  return { errors, warnings };
}

import { pathToFileURL } from 'node:url';
const __isMain = (() => { try { return import.meta.url === pathToFileURL(process.argv[1] ?? '').href; } catch { return false; } })();
if (__isMain) {
  const file = process.argv[2] || path.join(path.dirname(process.argv[1]), '..', 'config', 'unified-registry.json');
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('read_error: ' + e.message);
    process.exit(2);
  }
  const { errors, warnings } = checkRegistry(reg);
  for (const w of warnings) console.log('WARN ' + w);
  if (errors.length) {
    for (const e of errors) console.log('ERR ' + e);
    console.log(`FAIL ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log(`OK components=${reg.components.length} warnings=${warnings.length}`);
  process.exit(0);
}
