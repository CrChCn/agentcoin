/* agentnet/updates.mjs — подписанные релизы, совместимость протокола, канарейка,
   обязательные обновления и rollback. Ключ релиза пинится в конфиге ноды. */
'use strict';
import { bucketOf, canonicalJson, readJson, writeJsonAtomic } from './util.mjs';
import { nodeIdFromPublicKeyPem, verifyWithPublicKey } from './identity.mjs';

export const RELEASE_FORMAT = 1;

function releaseBody(manifest) {
  const { signature, pubkey, ...rest } = manifest;
  return canonicalJson(rest);
}

export function createRelease(identity, {
  version,
  protocol = { min: 1, max: 1 },
  artifacts = [],
  mandatory = false,
  canaryPercent = 10,
  rollbackTo = null,
  notes = '',
  ttlMs = 30 * 24 * 3600 * 1000,
} = {}) {
  if (!version) throw new Error('release_version_required');
  const now = Date.now();
  const manifest = {
    formatVersion: RELEASE_FORMAT,
    releaseId: `${version}-${now}`,
    version,
    protocol,
    artifacts,
    mandatory: Boolean(mandatory),
    canaryPercent: Math.max(0, Math.min(100, Number(canaryPercent) || 0)),
    rollbackTo,
    notes,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  manifest.signature = identity.signB64u(Buffer.from(releaseBody(manifest), 'utf8'));
  manifest.pubkey = identity.publicKeyPem;
  return manifest;
}

export function verifyRelease(manifest, { now = Date.now(), releaseKeys = [] } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!manifest || typeof manifest !== 'object') return fail('not_object');
  if (manifest.formatVersion !== RELEASE_FORMAT) return fail('format_mismatch');
  if (!manifest.version || !manifest.releaseId) return fail('missing_fields');
  if (!Array.isArray(releaseKeys) || releaseKeys.length === 0) return fail('no_trusted_release_keys');
  if (!releaseKeys.includes(manifest.pubkey)) return fail('untrusted_release_key');
  if (Date.parse(manifest.expiresAt) <= now) return fail('expired');
  if (!verifyWithPublicKey(manifest.pubkey, Buffer.from(releaseBody(manifest), 'utf8'), manifest.signature)) {
    return fail('bad_signature');
  }
  const p = manifest.protocol || {};
  if (!Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min > p.max) return fail('bad_protocol_range');
  return { ok: true, manifest, releaseKeyId: nodeIdFromPublicKeyPem(manifest.pubkey) };
}

export function protocolCompatible(manifest, protocolVersion) {
  const p = manifest.protocol || {};
  return protocolVersion >= p.min && protocolVersion <= p.max;
}

export function canarySelected(nodeId, manifest) {
  if (manifest.mandatory) return true;
  return bucketOf(nodeId, Number(manifest.canaryPercent) || 0);
}

export class UpdateManager {
  constructor({ stateFile, currentVersion, protocolVersion = 1, releaseKeys = [], apply = null, log = () => {} }) {
    this.stateFile = stateFile;
    this.currentVersion = currentVersion;
    this.protocolVersion = protocolVersion;
    this.releaseKeys = releaseKeys;
    this.applyFn = apply;
    this.log = log;
    this.state = this._load();
  }

  _load() {
    const raw = readJson(this.stateFile, null);
    return {
      currentVersion: (raw && raw.currentVersion) || this.currentVersion,
      previousVersion: (raw && raw.previousVersion) || null,
      appliedReleaseId: (raw && raw.appliedReleaseId) || null,
      history: Array.isArray(raw && raw.history) ? raw.history.slice(-20) : [],
    };
  }

  _save() {
    try { writeJsonAtomic(this.stateFile, this.state, 0o600); } catch { /* состояние обновится при следующем старте */ }
  }

  check(manifest, { nodeId = null } = {}) {
    const verified = verifyRelease(manifest, { releaseKeys: this.releaseKeys });
    if (!verified.ok) return { ok: false, action: 'reject', reason: verified.reason };
    if (!protocolCompatible(manifest, this.protocolVersion)) {
      return { ok: false, action: 'reject', reason: 'protocol_incompatible', manifest };
    }
    if (manifest.version === this.state.currentVersion) {
      return { ok: true, action: 'none', reason: 'already_current', manifest };
    }
    const canary = nodeId ? canarySelected(nodeId, manifest) : Boolean(manifest.mandatory);
    if (!canary) {
      return { ok: true, action: 'defer', reason: 'outside_canary', manifest };
    }
    return { ok: true, action: 'apply', reason: manifest.mandatory ? 'mandatory' : 'canary', manifest };
  }

  async apply(manifest, { nodeId = null } = {}) {
    const decision = this.check(manifest, { nodeId });
    if (!decision.ok || decision.action === 'reject') return { ok: false, reason: decision.reason };
    if (decision.action !== 'apply') return { ok: false, reason: decision.reason, action: decision.action };
    const previous = this.state.currentVersion;
    if (this.applyFn) await this.applyFn(manifest.version, manifest.artifacts || []);
    this.state.previousVersion = previous;
    this.state.currentVersion = manifest.version;
    this.state.appliedReleaseId = manifest.releaseId;
    this.state.history.push({ at: new Date().toISOString(), action: 'apply', from: previous, to: manifest.version, releaseId: manifest.releaseId });
    this._save();
    this.log(`[updates] ${previous} → ${manifest.version} (${decision.reason})`);
    return { ok: true, from: previous, to: manifest.version, releaseId: manifest.releaseId };
  }

  async rollback() {
    const target = this.state.previousVersion;
    if (!target) return { ok: false, reason: 'nothing_to_rollback' };
    const from = this.state.currentVersion;
    if (this.applyFn) await this.applyFn(target, []);
    this.state.currentVersion = target;
    this.state.previousVersion = null;
    this.state.appliedReleaseId = null;
    this.state.history.push({ at: new Date().toISOString(), action: 'rollback', from, to: target });
    this._save();
    this.log(`[updates] rollback ${from} → ${target}`);
    return { ok: true, from, to: target };
  }

  snapshot() {
    return { ...this.state, releaseKeys: this.releaseKeys.map((k) => nodeIdFromPublicKeyPem(k).slice(0, 16)) };
  }
}
