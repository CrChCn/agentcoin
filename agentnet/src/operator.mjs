/* agentnet/operator.mjs — паспорт оператора: независимый ключ, список его нод,
   лимит регистраций. Число nodeId ≠ число независимых операторов. */
'use strict';
import { canonicalJson, readJson, writeJsonAtomic } from './util.mjs';
import { nodeIdFromPublicKeyPem, verifyWithPublicKey, validateNodeId } from './identity.mjs';

export const PASSPORT_FORMAT = 1;

function passportBody(p) {
  const { signature, pubkey, ...rest } = p;
  return canonicalJson(rest);
}

export function createPassport(identity, {
  operatorId,
  name,
  nodeIds = [],
  region = null,
  contact = null,
  ttlMs = 365 * 24 * 3600 * 1000,
} = {}) {
  if (!operatorId) throw new Error('operator_id_required');
  const now = Date.now();
  const passport = {
    formatVersion: PASSPORT_FORMAT,
    operatorId,
    name: name || operatorId,
    nodeIds: [...new Set(nodeIds.filter(validateNodeId))],
    region,
    contact,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  passport.signature = identity.signB64u(Buffer.from(passportBody(passport), 'utf8'));
  passport.pubkey = identity.publicKeyPem;
  return passport;
}

export function verifyPassport(passport, { now = Date.now(), maxNodesPerOperator = 5 } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!passport || typeof passport !== 'object') return fail('not_object');
  if (passport.formatVersion !== PASSPORT_FORMAT) return fail('format_mismatch');
  if (!passport.operatorId || !passport.pubkey) return fail('missing_fields');
  if (Date.parse(passport.expiresAt) <= now) return fail('expired');
  if (!Array.isArray(passport.nodeIds) || passport.nodeIds.some((n) => !validateNodeId(n))) return fail('bad_node_list');
  if (passport.nodeIds.length > maxNodesPerOperator) return fail('registration_limit_exceeded');
  if (!verifyWithPublicKey(passport.pubkey, Buffer.from(passportBody(passport), 'utf8'), passport.signature)) {
    return fail('bad_signature');
  }
  return { ok: true, passport, operatorKeyId: nodeIdFromPublicKeyPem(passport.pubkey) };
}

export class OperatorRegistry {
  constructor({ file, maxNodesPerOperator = 5 } = {}) {
    this.file = file;
    this.maxNodesPerOperator = maxNodesPerOperator;
    this.operators = new Map(); // operatorId → {passport, verifiedAt}
    this.byNode = new Map(); // nodeId → operatorId
    this.rejected = [];
    this.load();
  }

  load() {
    const raw = readJson(this.file, null);
    const list = raw && Array.isArray(raw.passports) ? raw.passports : [];
    for (const p of list) this.add(p);
    return this;
  }

  add(passport) {
    const v = verifyPassport(passport, { maxNodesPerOperator: this.maxNodesPerOperator });
    if (!v.ok) { this.rejected.push({ at: new Date().toISOString(), reason: v.reason, passport }); return v; }
    const existing = this.operators.get(passport.operatorId);
    if (existing && Date.parse(existing.passport.issuedAt) > Date.parse(passport.issuedAt)) {
      return { ok: false, reason: 'older_passport' };
    }
    this.operators.set(passport.operatorId, { passport, verifiedAt: new Date().toISOString() });
    for (const nodeId of passport.nodeIds) this.byNode.set(nodeId, passport.operatorId);
    this.save();
    return { ok: true, operatorId: passport.operatorId, nodes: passport.nodeIds.length };
  }

  verifyNode(nodeId) {
    const operatorId = this.byNode.get(nodeId);
    if (!operatorId) return null;
    const rec = this.operators.get(operatorId);
    if (!rec) return null;
    return { operatorId, name: rec.passport.name, verified: true, nodes: rec.passport.nodeIds.length };
  }

  save() {
    try {
      writeJsonAtomic(this.file, {
        version: 1,
        passports: [...this.operators.values()].map((o) => o.passport),
        updatedAt: new Date().toISOString(),
      }, 0o600);
    } catch { /* реестр — кэш */ }
  }

  list() {
    const out = [];
    for (const [operatorId, rec] of this.operators) {
      out.push({
        operatorId,
        name: rec.passport.name,
        nodes: rec.passport.nodeIds,
        region: rec.passport.region || null,
        verifiedAt: rec.verifiedAt,
        nodeCount: rec.passport.nodeIds.length,
        keyId: nodeIdFromPublicKeyPem(rec.passport.pubkey),
      });
    }
    return out.sort((a, b) => a.operatorId.localeCompare(b.operatorId));
  }

  snapshot() {
    const nodesPerOperator = [...this.operators.values()].map((o) => o.passport.nodeIds.length);
    return {
      operators: this.operators.size,
      registeredNodes: this.byNode.size,
      maxNodesPerOperator: this.maxNodesPerOperator,
      registrations: nodesPerOperator.reduce((a, b) => a + b, 0),
      rejected: this.rejected.length,
    };
  }
}
