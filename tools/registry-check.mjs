#!/usr/bin/env node
// registry-check.mjs — машинная проверка единого реестра (Этап 1).
// Zero-deps. Ненулевой код при некорректном реестре.
// Контракт: config/registry.schema.json — единственный источник ограничений.
// Валидатор ОБЯЗАН читать схему и применять её required/типы/паттерны.
// Расхождение схемы и валидатора запрещено.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ALLOWED_STATUS = new Set(['confirmed', 'partial', 'unknown', 'contradiction']);
const ISO_DT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?Z$/;
const COMP_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CHAIN_ID_RE = /^[A-Z][A-Z0-9_]*$/;
const GENESIS_RE = /^[0-9a-f]{64}$/;
const BARE_EVIDENCE_RE = /^[EFVC][0-9]{2}(-[A-Z0-9-]+)?$/;
const BLOCKCHAIN_KIND = 'blockchain-node';
const KNOWN_KINDS = new Set(['blockchain-node', 'miner', 'proxy', 'static-site', 'app', 'gateway', 'queue', 'monitor', 'env', 'sdk', 'cli', 'mcp', 'pilot']);

function normPath(p) {
  if (typeof p !== 'string') return p;
  if (p.length > 1 && p.endsWith('/') && p !== '/') return p.slice(0, -1);
  return p;
}
function baseEnv(env) {
  const s = String(env || '').trim().toLowerCase();
  if (s.startsWith('mainnet')) return 'mainnet';
  const m = s.match(/^[a-z0-9-]+/);
  return m ? m[0] : s;
}
function routeKey(r, componentEnv) {
  const m = String(r.method || 'GET').toUpperCase();
  const scope = baseEnv(r.env || componentEnv || '');
  return scope + '|' + m + ' ' + String(r.host || '') + ' ' + normPath(String(r.path || ''));
}
function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0); }
function isValidDateTime(s) {
  if (typeof s !== 'string' || !ISO_DT_RE.test(s)) return false;
  const m = s.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?Z$/);
  if (!m) return false;
  const Y = Number(m[1]); const Mo = Number(m[2]); const D = Number(m[3]);
  const H = Number(m[4]); const Mi = Number(m[5]); const Se = m[6] !== undefined ? Number(m[6]) : 0;
  if (Mo < 1 || Mo > 12) return false;
  if (H > 23 || Mi > 59 || Se > 59) return false;
  const dim = [31, (isLeapYear(Y) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Mo - 1];
  if (D < 1 || D > dim) return false;
  // Date.parse normalizes 2026-02-30 -> 2026-03-02, so calendar check above is authoritative.
  const t = Date.parse(s);
  return Number.isFinite(t);
}

// ---- generic schema walker (subset draft-07) ----
function schemaTypeMatches(value, t) {
  if (t === 'string') return typeof value === 'string';
  if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (t === 'boolean') return typeof value === 'boolean';
  if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (t === 'array') return Array.isArray(value);
  if (t === 'null') return value === null;
  return false;
}
function validateBySchema(value, schema, loc, out) {
  if (!schema || typeof schema !== 'object') return;
  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : null);
  if (types) {
    const ok = types.some((t) => schemaTypeMatches(value, t));
    if (!ok) {
      out.push(`${loc}: expected type ${types.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    out.push(`${loc}: value ${JSON.stringify(value)} not in enum ${schema.enum.join(',')}`);
    return;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push(`${loc}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern) {
      let re;
      try { re = new RegExp(schema.pattern); } catch { re = null; }
      if (re && !re.test(value)) out.push(`${loc}: string ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const f of schema.required) {
        if (!(f in value)) out.push(`${loc}: missing required field ${f}`);
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) validateBySchema(value[k], sub, `${loc}.${k}`, out);
      }
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    for (let i = 0; i < value.length; i++) validateBySchema(value[i], schema.items, `${loc}[${i}]`, out);
  }
}

function inferRoot(fromFile) {
  try {
    if (fromFile) {
      // registry file is <root>/config/unified-registry.json
      const d = path.dirname(path.resolve(fromFile));
      if (path.basename(d) === 'config') return path.dirname(d);
      return d;
    }
  } catch { /* ignore */ }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..');
  } catch { return null; }
}
function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function loadAux(baseDir) {
  const aux = { actionIds: null, navHrefs: null, eIds: null, fIds: null, cIds: null, vIds: null, missing: [] };
  if (!baseDir) return aux;
  try { aux.actionIds = new Set(loadJson(path.join(baseDir, 'config', 'action-registry.json')).actions.map((a) => a.actionId)); }
  catch { aux.missing.push('config/action-registry.json'); }
  try {
    const tree = loadJson(path.join(baseDir, 'site', 'tree.json'));
    const hrefs = new Set();
    for (const s of (tree.sections || [])) for (const l of (s.links || [])) if (typeof l.href === 'string') hrefs.add(l.href);
    aux.navHrefs = hrefs;
  } catch { aux.missing.push('site/tree.json'); }
  try {
    const csv = fs.readFileSync(path.join(baseDir, 'docs', 'audit-network', 'evidence', 'EVIDENCE-INDEX.csv'), 'utf8');
    aux.eIds = new Set(csv.split('\n').slice(1).map((l) => l.split(',')[0].trim()).filter((x) => /^E[0-9]{2}$/.test(x)));
  } catch { aux.missing.push('docs/audit-network/evidence/EVIDENCE-INDEX.csv'); }
  try {
    const csv = fs.readFileSync(path.join(baseDir, 'docs', 'audit-network', 'FACTS.csv'), 'utf8');
    aux.fIds = new Set(csv.split('\n').slice(1).map((l) => l.split(',')[0].trim()).filter((x) => /^F[0-9]{2}$/.test(x)));
  } catch { aux.missing.push('docs/audit-network/FACTS.csv'); }
  try {
    const md = fs.readFileSync(path.join(baseDir, 'docs', 'audit-network', 'CONTRADICTIONS.md'), 'utf8');
    aux.cIds = new Set([...md.matchAll(/C[0-9]{2}/g)].map((m) => m[0]));
  } catch { aux.missing.push('docs/audit-network/CONTRADICTIONS.md'); }
  try {
    const md = fs.readFileSync(path.join(baseDir, 'docs', 'audit-network', 'VERIFICATION-PLAN.md'), 'utf8');
    aux.vIds = new Set([...md.matchAll(/V[0-9]{2}/g)].map((m) => m[0]));
  } catch { aux.missing.push('docs/audit-network/VERIFICATION-PLAN.md'); }
  return aux;
}

export function checkRegistry(reg, opts = {}) {
  const errors = [];
  const warnings = [];
  const baseDir = opts.baseDir || inferRoot(opts.registryFile || null);
  // 0. schema is mandatory contract
  let schema = opts.schema || null;
  let schemaFrom = opts.schemaPath || null;
  if (!schema && baseDir) {
    const p = path.join(baseDir, 'config', 'registry.schema.json');
    try { schema = loadJson(p); schemaFrom = p; } catch { /* below */ }
  }
  if (!schema) {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const p = path.resolve(here, '..', 'config', 'registry.schema.json');
      schema = loadJson(p); schemaFrom = p;
    } catch { /* below */ }
  }
  if (!schema) {
    errors.push('schema_missing: cannot load config/registry.schema.json — contract unavailable');
    return { errors, warnings };
  }
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) {
    errors.push('registry_not_object');
    return { errors, warnings };
  }
  // 0a. apply schema strictly
  const schemaErrors = [];
  validateBySchema(reg, schema, 'registry', schemaErrors);
  for (const e of schemaErrors) errors.push(e);
  // explicit root field messages for clear regression matching
  for (const f of ['version', 'updatedAt', 'chain', 'sources', 'statusVocabulary', 'components']) {
    if (!(f in reg)) errors.push(`registry: missing required field ${f} (schema ${schemaFrom || 'registry.schema.json'})`);
  }
  if ('version' in reg && !(typeof reg.version === 'number' && Number.isInteger(reg.version))) {
    errors.push(`registry.version: expected integer, got ${JSON.stringify(reg.version)}`);
  }
  if ('updatedAt' in reg && !isValidDateTime(reg.updatedAt)) {
    errors.push(`registry.updatedAt: invalid date-time ${JSON.stringify(reg.updatedAt)} (expected YYYY-MM-DDTHH:MM[:SS]Z)`);
  }

  const comps = reg.components;
  if (!Array.isArray(comps)) {
    errors.push('components_not_array');
    return { errors, warnings };
  }

  // aux indexes for existence checks (explicit null in opts simulates missing source for regression tests)
  const aux = loadAux(baseDir);
  for (const k of ['actionIds', 'navHrefs', 'eIds', 'fIds', 'cIds', 'vIds']) {
    if (k in opts) aux[k] = opts[k];
  }
  // backing files for bare E## ids: E-index row alone is NOT enough, concrete file required.
  let evidenceFiles = null;
  if ('evidenceFiles' in opts && opts.evidenceFiles) {
    evidenceFiles = new Set([...opts.evidenceFiles].map((s) => String(s)));
  } else if (baseDir) {
    try {
      evidenceFiles = new Set(fs.readdirSync(path.join(baseDir, 'docs', 'audit-network', 'evidence')));
    } catch { evidenceFiles = null; }
  }
  const auxUnavailable = [];
  if (!aux.actionIds) auxUnavailable.push('action-registry');
  if (!aux.navHrefs) auxUnavailable.push('nav-tree');
  if (!aux.eIds) auxUnavailable.push('E-index');

  // 1. components must be objects (null-safe)
  const seen = new Map();
  comps.forEach((c, i) => {
    const loc = `components[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`${loc}: must be object, got ${c === null ? 'null' : Array.isArray(c) ? 'array' : typeof c}`);
      return;
    }
    if (typeof c.componentId !== 'string' || !c.componentId) {
      errors.push(`${loc}: missing componentId (must be non-empty string matching ${COMP_ID_RE})`);
      return;
    }
    if (!COMP_ID_RE.test(c.componentId)) {
      errors.push(`${loc}.componentId: invalid identifier ${JSON.stringify(c.componentId)} (expected ${COMP_ID_RE})`);
    }
    if (seen.has(c.componentId)) errors.push(`duplicate componentId: ${c.componentId} (also at ${seen.get(c.componentId)})`);
    else seen.set(c.componentId, loc);
  });
  const ids = new Set(seen.keys());
  const byId = new Map();
  for (const c of comps) {
    if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.componentId === 'string' && COMP_ID_RE.test(c.componentId)) {
      if (!byId.has(c.componentId)) byId.set(c.componentId, c);
    }
  }

  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    if (typeof c.componentId !== 'string' || !c.componentId) continue;
    const id = c.componentId;
    const loc = `components[${i}](${id})`;
    // required fields presence (schema already, but explicit for message stability)
    const required = ['kind', 'purpose', 'env', 'host', 'process', 'sources', 'expectedVersion', 'routes', 'storage', 'dependsOn', 'network', 'expected', 'observed', 'verification', 'checkMethod', 'proofSource'];
    if (!('kind' in c)) errors.push(`${id}: missing required field kind (explicit role required — rename must not disable chain pin)`);
    else if (typeof c.kind !== 'string' || !c.kind.trim()) errors.push(`${id}: field kind must be non-empty string (explicit role, e.g. blockchain-node)`);
    else if (!KNOWN_KINDS.has(c.kind)) errors.push(`${id}: unknown kind ${JSON.stringify(c.kind)} (expected one of ${[...KNOWN_KINDS].join(',')})`);
    for (const f of required) {
      if (!(f in c)) errors.push(`${id}: missing required field ${f}`);
    }
    for (const f of ['purpose', 'env', 'host', 'process', 'checkMethod', 'proofSource']) {
      if (f in c && (typeof c[f] !== 'string' || !c[f].trim())) errors.push(`${id}: field ${f} must be non-empty string`);
    }
    if ('sources' in c && !Array.isArray(c.sources)) errors.push(`${id}: sources must be array`);
    else if (Array.isArray(c.sources)) {
      c.sources.forEach((s, k) => { if (typeof s !== 'string' || !s.trim()) errors.push(`${id}.sources[${k}]: must be non-empty string`); });
    }
    if ('routes' in c && !Array.isArray(c.routes)) errors.push(`${id}: routes must be array`);
    if ('dependsOn' in c && !Array.isArray(c.dependsOn)) errors.push(`${id}: dependsOn must be array`);
    if ('storage' in c && !(typeof c.storage === 'string' || c.storage === null)) errors.push(`${id}: storage must be string|null, got ${typeof c.storage}`);
    if ('network' in c && !(typeof c.network === 'string' || c.network === null)) errors.push(`${id}: network must be string|null`);
    if ('expected' in c && (typeof c.expected !== 'object' || c.expected === null || Array.isArray(c.expected))) errors.push(`${id}: expected must be object`);
    if ('observed' in c && (typeof c.observed !== 'object' || c.observed === null || Array.isArray(c.observed))) errors.push(`${id}: observed must be object`);
    if ('expectedVersion' in c && !(typeof c.expectedVersion === 'string' || c.expectedVersion === null)) {
      errors.push(`${id}.expectedVersion: expected string|null, got ${Array.isArray(c.expectedVersion) ? 'object(array)' : typeof c.expectedVersion} ${JSON.stringify(c.expectedVersion)}`);
    }
    if ('observedVersion' in c && !(typeof c.observedVersion === 'string' || c.observedVersion === null)) {
      errors.push(`${id}.observedVersion: expected string|null, got ${typeof c.observedVersion}`);
    }
    if ('actionIds' in c && c.actionIds !== undefined && c.actionIds !== null) {
      if (!Array.isArray(c.actionIds)) errors.push(`${id}: actionIds must be array`);
      else {
        c.actionIds.forEach((a, k) => {
          if (typeof a !== 'string' || !a.trim()) { errors.push(`${id}.actionIds[${k}]: must be non-empty string`); return; }
          if (aux.actionIds) {
            if (!aux.actionIds.has(a)) errors.push(`${id}.actionIds[${k}]: unknown actionId ${JSON.stringify(a)} not in config/action-registry.json`);
          } else {
            errors.push(`${id}.actionIds[${k}]: action-registry unavailable (site/tree.json or config/action-registry.json missing/unreadable) — cannot verify link ${JSON.stringify(a)}`);
          }
        });
      }
    }
    if ('navIds' in c && c.navIds !== undefined && c.navIds !== null) {
      if (!Array.isArray(c.navIds)) errors.push(`${id}: navIds must be array`);
      else {
        c.navIds.forEach((n, k) => {
          if (typeof n !== 'string' || !n.startsWith('/')) { errors.push(`${id}.navIds[${k}]: must be path starting with /, got ${JSON.stringify(n)}`); return; }
          if (aux.navHrefs) {
            if (!aux.navHrefs.has(n)) errors.push(`${id}.navIds[${k}]: unknown navId ${JSON.stringify(n)} not in site/tree.json`);
          } else {
            errors.push(`${id}.navIds[${k}]: nav-tree unavailable (site/tree.json missing/unreadable) — cannot verify link ${JSON.stringify(n)}`);
          }
        });
      }
    }

    // verification
    const v = c.verification;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!ALLOWED_STATUS.has(v.status)) errors.push(`${id}: invalid verification.status ${JSON.stringify(v.status)}`);
      if (!Array.isArray(v.evidence)) errors.push(`${id}: verification.evidence must be array`);
      if (!Array.isArray(v.unknowns)) errors.push(`${id}: verification.unknowns must be array`);
      else {
        v.unknowns.forEach((u, k) => { if (typeof u !== 'string' || !u.trim()) errors.push(`${id}.verification.unknowns[${k}]: must be non-empty string`); });
      }
      if (!isValidDateTime(v.checkedAt)) errors.push(`${id}.verification.checkedAt: invalid date-time ${JSON.stringify(v.checkedAt)} (expected YYYY-MM-DDTHH:MM[:SS]Z)`);
      if (v.status === 'confirmed' && (!Array.isArray(v.evidence) || v.evidence.length === 0)) {
        errors.push(`${id}: status confirmed requires non-empty verification.evidence`);
      }
      if (Array.isArray(v.evidence)) {
        let hasVerifiable = false;
        v.evidence.forEach((e, k) => {
          if (typeof e !== 'string' || !e.trim()) { errors.push(`${id}.verification.evidence[${k}]: empty evidence entry`); return; }
          if (e.startsWith('external:')) {
            warnings.push(`${id}: external evidence ${JSON.stringify(e)} not verifiable in package`);
            return;
          }
          const isPath = e.includes('/') || e.includes('\\') || e.startsWith('config') || e.startsWith('site') || e.startsWith('tools') || e.startsWith('test') || e.startsWith('docs') || e.startsWith('sdk') || e.startsWith('mcp') || e.includes('.');
          if (isPath) {
            const rel = e.split('#')[0].split('?')[0];
            if (baseDir) {
              const full = path.join(baseDir, rel);
              if (!fs.existsSync(full)) {
                errors.push(`${id}.verification.evidence[${k}]: unknown evidence file ${JSON.stringify(e)} not found in package (baseDir ${baseDir})`);
              } else hasVerifiable = true;
            } else {
              hasVerifiable = true;
            }
            return;
          }
          if (!BARE_EVIDENCE_RE.test(e)) {
            errors.push(`${id}.verification.evidence[${k}]: unknown evidence reference ${JSON.stringify(e)} (expected E##/F##/C##/V##, file path, or external:...)`);
            return;
          }
          const prefix = e[0];
          const code = e.slice(0, 3);
          const known = prefix === 'E' ? aux.eIds : prefix === 'F' ? aux.fIds : prefix === 'C' ? aux.cIds : aux.vIds;
          const auxName = prefix === 'E' ? 'E-index' : prefix === 'F' ? 'FACTS' : prefix === 'C' ? 'CONTRADICTIONS' : 'VERIFICATION-PLAN';
          if (!known) {
            errors.push(`${id}.verification.evidence[${k}]: index ${auxName} unavailable — cannot verify link ${JSON.stringify(e)} (missing index is not a pass)`);
          } else if (!known.has(code)) {
            errors.push(`${id}.verification.evidence[${k}]: unknown evidence reference ${JSON.stringify(e)} not in ${auxName} (code ${code} absent)`);
          } else if (prefix === 'E') {
            // bare E## must be backed by a concrete file; index row alone is insufficient.
            if (!evidenceFiles) {
              errors.push(`${id}.verification.evidence[${k}]: evidence file for ${code} unavailable (docs/audit-network/evidence unreadable) — cannot verify link ${JSON.stringify(e)}`);
            } else {
              const hasFile = [...evidenceFiles].some((f) => f === code || f.startsWith(code + '-') || f.startsWith(code + '.') || f.startsWith(code + '_'));
              if (!hasFile) errors.push(`${id}.verification.evidence[${k}]: evidence file for ${code} missing in docs/audit-network/evidence/ (index alone insufficient) — link ${JSON.stringify(e)} unverifiable`);
              else hasVerifiable = true;
            }
          } else {
            hasVerifiable = true;
          }
        });
        if (v.status === 'confirmed' && !hasVerifiable) {
          errors.push(`${id}: status confirmed requires at least one verifiable in-package evidence (external-only or missing files insufficient)`);
        }
      }
      const hasNull = ['expectedVersion', 'storage', 'network'].some((f) => c[f] === null) ||
        (c.chain && typeof c.chain === 'object' && Object.values(c.chain).some((x) => x === null));
      if (hasNull) {
        if (!Array.isArray(v.unknowns) || v.unknowns.length === 0) errors.push(`${id}: null field requires listed verification.unknowns`);
        if (v.status === 'confirmed') errors.push(`${id}: null field incompatible with status confirmed`);
      }
    } else {
      errors.push(`${id}: verification must be object`);
    }

    // chain object: pin requirement follows explicit kind, never the componentId prefix.
    // Renaming a node must not disable its network pin.
    if (c.kind === BLOCKCHAIN_KIND) {
      if (!c.chain || typeof c.chain !== 'object' || Array.isArray(c.chain)) errors.push(`${id}: node requires chain object with chainId+genesis (kind=blockchain-node, id prefix ignored)`);
      else {
        for (const f of ['chainId', 'genesis']) {
          if (!(f in c.chain)) errors.push(`${id}: chain missing ${f} (structured pin required, display network insufficient)`);
        }
        if ('chainId' in c.chain && (typeof c.chain.chainId !== 'string' || !CHAIN_ID_RE.test(c.chain.chainId))) {
          errors.push(`${id}.chain.chainId: invalid ${JSON.stringify(c.chain.chainId)} (expected ${CHAIN_ID_RE})`);
        }
        if ('genesis' in c.chain && (typeof c.chain.genesis !== 'string' || !GENESIS_RE.test(c.chain.genesis))) {
          errors.push(`${id}.chain.genesis: invalid pin ${JSON.stringify(c.chain.genesis)} (expected full 64-hex genesis, short display insufficient)`);
        }
        for (const f of ['activationParams', 'syncSource']) {
          if (f in c.chain && typeof c.chain[f] !== 'string') errors.push(`${id}.chain.${f}: must be string`);
        }
      }
    } else if (c.chain !== undefined && c.chain !== null) {
      if (typeof c.chain !== 'object' || Array.isArray(c.chain)) errors.push(`${id}: chain must be object|null`);
      else {
        if ('chainId' in c.chain && (typeof c.chain.chainId !== 'string' || !CHAIN_ID_RE.test(c.chain.chainId))) {
          errors.push(`${id}.chain.chainId: invalid ${JSON.stringify(c.chain.chainId)}`);
        }
        if ('genesis' in c.chain && (typeof c.chain.genesis !== 'string' || !GENESIS_RE.test(c.chain.genesis))) {
          errors.push(`${id}.chain.genesis: invalid pin ${JSON.stringify(c.chain.genesis)} (expected full 64-hex)`);
        }
      }
    }
    if ('bridges' in c && c.bridges !== undefined && c.bridges !== null) {
      if (!Array.isArray(c.bridges)) errors.push(`${id}: bridges must be array`);
      else {
        c.bridges.forEach((b, k) => {
          if (!b || typeof b !== 'object') { errors.push(`${id}.bridges[${k}]: must be object`); return; }
          if (typeof b.chainId !== 'string' || !CHAIN_ID_RE.test(b.chainId)) errors.push(`${id}.bridges[${k}].chainId: invalid ${JSON.stringify(b.chainId)}`);
          if (typeof b.genesis !== 'string' || !GENESIS_RE.test(b.genesis)) errors.push(`${id}.bridges[${k}].genesis: invalid pin (expected full 64-hex)`);
        });
      }
    }

    // observe: machine-readable collection targets (Stage 2). Optional, but if present must be strict.
    // No second server list: collector reads ONLY these targets. Secrets must never appear here.
    if ('observe' in c && c.observe !== undefined && c.observe !== null) {
      const o = c.observe;
      if (typeof o !== 'object' || Array.isArray(o)) errors.push(`${id}: observe must be object|null`);
      else {
        if ('ssh' in o && o.ssh !== undefined && o.ssh !== null) {
          const s = o.ssh;
          if (typeof s !== 'object' || Array.isArray(s)) errors.push(`${id}.observe.ssh: must be object`);
          else {
            if (typeof s.host !== 'string' || !s.host.trim()) errors.push(`${id}.observe.ssh.host: required non-empty string (IP or hostname from registry host)`);
            if ('user' in s && (typeof s.user !== 'string' || !s.user.trim())) errors.push(`${id}.observe.ssh.user: must be non-empty string`);
            if ('port' in s && !(Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535)) errors.push(`${id}.observe.ssh.port: must be integer 1-65535, got ${JSON.stringify(s.port)}`);
          }
        }
        if ('localBase' in o && o.localBase !== undefined && o.localBase !== null) {
          if (typeof o.localBase !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o.localBase)) {
            errors.push(`${id}.observe.localBase: must be loopback http(s) base (http://127.0.0.1:PORT), got ${JSON.stringify(o.localBase)} — remote bases forbidden`);
          }
        }
        for (const f of ['localEndpoints', 'units', 'files']) {
          if (f in o && o[f] !== undefined && o[f] !== null) {
            if (!Array.isArray(o[f])) errors.push(`${id}.observe.${f}: must be array`);
            else o[f].forEach((v, k) => {
              if (typeof v !== 'string' || !v.trim()) { errors.push(`${id}.observe.${f}[${k}]: must be non-empty string`); return; }
              if (f === 'localEndpoints' && !v.startsWith('/')) errors.push(`${id}.observe.${f}[${k}]: must start with /, got ${JSON.stringify(v)}`);
              if (f === 'files' && !v.startsWith('/')) errors.push(`${id}.observe.${f}[${k}]: must be absolute path, got ${JSON.stringify(v)}`);
              if (f === 'files' && /(\.env$|\.env\.|settlement-policy|mainnet-settlements|id_rsa|id_ed25519|secret|passwd|shadow)/i.test(v)) {
                errors.push(`${id}.observe.${f}[${k}]: must not reference secrets/policy/journal/keys (${JSON.stringify(v)}) — read-only collection never reads secrets`);
              }
            });
          }
        }
        if ('listenPorts' in o && o.listenPorts !== undefined && o.listenPorts !== null) {
          if (!Array.isArray(o.listenPorts)) errors.push(`${id}.observe.listenPorts: must be array`);
          else o.listenPorts.forEach((p, k) => {
            if (!(Number.isInteger(p) && p >= 1 && p <= 65535)) errors.push(`${id}.observe.listenPorts[${k}]: must be integer 1-65535, got ${JSON.stringify(p)}`);
          });
        }
        if ('publicBase' in o && o.publicBase !== undefined && o.publicBase !== null) {
          if (typeof o.publicBase !== 'string' || !/^https?:\/\/[^\s/]+$/.test(o.publicBase)) {
            errors.push(`${id}.observe.publicBase: must be http(s) origin without path, got ${JSON.stringify(o.publicBase)}`);
          }
        }
      }
    }

    // dependsOn
    if (Array.isArray(c.dependsOn)) {
      c.dependsOn.forEach((d, k) => {
        if (typeof d !== 'string' || !d) { errors.push(`${id}.dependsOn[${k}]: must be non-empty string`); return; }
        if (!ids.has(d)) errors.push(`${id}: dependsOn missing component ${d}`);
      });
    }

    // routes (null-safe)
    if (Array.isArray(c.routes)) {
      c.routes.forEach((r, k) => {
        const rloc = `${id}.routes[${k}]`;
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
          errors.push(`${rloc}: must be object, got ${r === null ? 'null' : typeof r}`);
          return;
        }
        if (typeof r.path !== 'string' || !r.path.startsWith('/')) errors.push(`${rloc}: route path must start with /, got ${JSON.stringify(r.path)}`);
        if (typeof r.host !== 'string' || !r.host) errors.push(`${rloc}: route host required`);
        if (typeof r.owner !== 'boolean') errors.push(`${rloc}: route owner must be boolean for ${JSON.stringify(r.path)}`);
        if (typeof r.note !== 'string' || !r.note.trim()) errors.push(`${rloc}: route ${JSON.stringify(r.path)} requires note (purpose/order)`);
        if (r.env !== undefined && r.env !== null && (typeof r.env !== 'string' || !r.env.trim())) errors.push(`${rloc}: route env must be non-empty string`);
        if (r.aliasOf !== undefined && r.aliasOf !== null && typeof r.aliasOf !== 'string') errors.push(`${rloc}: route aliasOf must be string|null`);
        if (r.aliasOf) {
          if (!r.note || !/alias/i.test(r.note)) warnings.push(`${id}: alias ${r.path} note should mention alias/order`);
          if (r.owner !== false) errors.push(`${rloc}: alias route ${JSON.stringify(r.path)} must have owner:false`);
        }
      });
    }
  }

  // 4. route owner conflict WITHIN one environment scope
  const owners = new Map();
  for (const c of comps) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    if (!Array.isArray(c.routes)) continue;
    for (const r of c.routes) {
      if (!r || typeof r !== 'object' || r.owner !== true) continue;
      if (r.aliasOf) continue;
      const k = routeKey(r, c.env);
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push(c.componentId);
    }
  }
  for (const [k, list] of owners) {
    if (list.length > 1) errors.push(`route owner conflict: ${k} claimed by ${list.join(', ')} (same environment scope)`);
  }

  // 5. structured chain pins: same-chain components must match root pin; unknown != match
  if (reg.chain && typeof reg.chain === 'object') {
    const rootId = reg.chain.network;
    const rootGen = reg.chain.genesis;
    const rootValid = typeof rootId === 'string' && CHAIN_ID_RE.test(rootId) && typeof rootGen === 'string' && GENESIS_RE.test(rootGen);
    if (!rootValid) {
      errors.push('registry.chain: root pin invalid (network must match chainId pattern, genesis full 64-hex)');
    } else {
      for (const c of comps) {
        if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
        if (!c.chain || typeof c.chain !== 'object') continue;
        if (Array.isArray(c.bridges) && c.bridges.length > 0) continue; // gateways describe sides explicitly
        const envScope = baseEnv(c.env || '');
        const isMainScope = envScope === 'mainnet';
        if (!isMainScope) continue; // testnet/jobtest/offline pilots have own pins
        const cid = c.chain.chainId;
        const gen = c.chain.genesis;
        if (typeof cid !== 'string' || typeof gen !== 'string' || !CHAIN_ID_RE.test(cid) || !GENESIS_RE.test(gen)) {
          errors.push(`${c.componentId}: unknown chain pin (chainId/genesis invalid) — cannot claim match with root ${rootId}/${String(rootGen).slice(0, 8)}…`);
          continue;
        }
        if (cid !== rootId || gen.toLowerCase() !== String(rootGen).toLowerCase()) {
          errors.push(`${c.componentId}: chain pin mismatch with root (component ${cid}/${gen.slice(0, 8)}… vs root ${rootId}/${String(rootGen).slice(0, 8)}…)`);
        }
      }
      // pairwise among linked mainnet components with pins
      for (const c of comps) {
        if (!c || typeof c !== 'object' || !Array.isArray(c.dependsOn)) continue;
        if (baseEnv(c.env || '') !== 'mainnet') continue;
        const a = c.chain;
        if (!a || typeof a !== 'object' || typeof a.chainId !== 'string' || typeof a.genesis !== 'string') continue;
        if (!CHAIN_ID_RE.test(a.chainId) || !GENESIS_RE.test(a.genesis)) continue;
        for (const d of c.dependsOn) {
          const t = byId.get(d);
          if (!t || !t.chain || typeof t.chain !== 'object') continue;
          if (baseEnv(t.env || '') !== 'mainnet') continue;
          const b = t.chain;
          if (typeof b.chainId !== 'string' || typeof b.genesis !== 'string') continue;
          if (!CHAIN_ID_RE.test(b.chainId) || !GENESIS_RE.test(b.genesis)) continue;
          if (a.chainId !== b.chainId || a.genesis.toLowerCase() !== String(b.genesis).toLowerCase()) {
            errors.push(`${c.componentId}: chain pin mismatch with ${d} (${a.chainId}/${a.genesis.slice(0, 8)}… vs ${b.chainId}/${String(b.genesis).slice(0, 8)}…)`);
          }
        }
      }
    }
  }

  return { errors, warnings };
}

const __isMain = (() => { try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href; } catch { return false; } })();
if (__isMain) {
  const file = process.argv[2] || path.join(path.dirname(process.argv[1]), '..', 'config', 'unified-registry.json');
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('read_error: ' + e.message);
    process.exit(2);
  }
  const baseDir = inferRoot(file);
  let schema = null;
  try { schema = loadJson(path.join(baseDir, 'config', 'registry.schema.json')); }
  catch (e) { console.error('schema_missing: ' + e.message); process.exit(2); }
  const { errors, warnings } = checkRegistry(reg, { schema, baseDir, registryFile: file, schemaPath: path.join(baseDir, 'config', 'registry.schema.json') });
  for (const w of warnings) console.log('WARN ' + w);
  if (errors.length) {
    for (const e of errors) console.log('ERR ' + e);
    console.log(`FAIL ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log(`OK components=${reg.components.length} warnings=${warnings.length}`);
  process.exit(0);
}
