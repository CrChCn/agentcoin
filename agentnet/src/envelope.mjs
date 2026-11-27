/* agentnet/envelope.mjs — подписанный конверт сообщения.
   { protocol, type, messageId, nodeId, timestamp, expiresAt, payload, signature }
   Подпись ed25519 по каноническому JSON всех полей, кроме signature. */
'use strict';
import { canonicalJson, isHex, randomHex } from './util.mjs';
import { nodeIdFromPublicKeyPem, verifyWithPublicKey, validateNodeId } from './identity.mjs';

export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = new Set([
  'HELLO',
  'CHALLENGE',
  'PEERS',
  'GET_HEADERS',
  'HEADERS',
  'GET_BLOCKS',
  'BLOCKS',
  'TX',
  'PING',
  'PONG',
  'NODE_ANNOUNCE',
  'NODE_GOODBYE',
]);

export const MAX_MESSAGE_BYTES = {
  HELLO: 8 * 1024,
  CHALLENGE: 8 * 1024,
  PEERS: 64 * 1024,
  GET_HEADERS: 8 * 1024,
  HEADERS: 512 * 1024,
  GET_BLOCKS: 8 * 1024,
  BLOCKS: 2 * 1024 * 1024,
  TX: 64 * 1024,
  PING: 4 * 1024,
  PONG: 4 * 1024,
  NODE_ANNOUNCE: 16 * 1024,
  NODE_GOODBYE: 4 * 1024,
};

export const DEFAULT_TTL_MS = 120000;
export const MAX_TTL_MS = 24 * 3600 * 1000;
export const MAX_CLOCK_SKEW_MS = 120000;

export function envelopeBody(env) {
  const { signature, ...rest } = env;
  return canonicalJson(rest);
}

export function signEnvelope(identity, type, payload, { ttlMs = DEFAULT_TTL_MS, now = Date.now(), messageId } = {}) {
  if (!MESSAGE_TYPES.has(type)) throw new Error(`unknown_message_type:${type}`);
  const env = {
    protocol: PROTOCOL_VERSION,
    type,
    messageId: messageId || randomHex(16),
    nodeId: identity.nodeId,
    timestamp: now,
    expiresAt: Math.min(now + ttlMs, now + MAX_TTL_MS),
    payload: payload === undefined ? {} : payload,
  };
  env.signature = identity.signB64u(Buffer.from(envelopeBody(env), 'utf8'));
  return env;
}

export class ReplayGuard {
  constructor({ max = 50000, windowMs = MAX_TTL_MS } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.seen = new Map();
  }

  prune(now = Date.now()) {
    for (const [id, exp] of this.seen) {
      if (exp <= now) this.seen.delete(id);
    }
    if (this.seen.size > this.max) {
      const excess = this.seen.size - this.max;
      let i = 0;
      for (const id of this.seen.keys()) {
        this.seen.delete(id);
        if (++i >= excess) break;
      }
    }
  }

  /** true — сообщение новое; false — повтор. */
  accept(messageId, expiresAt, now = Date.now()) {
    this.prune(now);
    if (!messageId) return false;
    if (this.seen.has(messageId)) return false;
    this.seen.set(messageId, Math.min(expiresAt || now + this.windowMs, now + this.windowMs));
    return true;
  }

  get size() { return this.seen.size; }
}

/**
 * Проверка конверта. pubkey — известный ключ сессии; для HELLO/рекламных
 * сообщений ключ берётся из payload.pubkey и проверяется привязка к nodeId.
 */
export function openEnvelope(env, {
  now = Date.now(),
  pubkeyPem = null,
  expectedNodeId = null,
  replay = null,
  maxAgeMs = MAX_TTL_MS,
  maxBytes = 64 * 1024,
} = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!env || typeof env !== 'object' || Array.isArray(env)) return fail('not_object');
  if (env.protocol !== PROTOCOL_VERSION) return fail('protocol_mismatch');
  if (!MESSAGE_TYPES.has(env.type)) return fail('unknown_type');
  if (!isHex(env.messageId, 32)) return fail('bad_message_id');
  if (!validateNodeId(env.nodeId)) return fail('bad_node_id');
  if (expectedNodeId && env.nodeId !== expectedNodeId) return fail('node_id_mismatch');
  if (!Number.isFinite(env.timestamp) || !Number.isFinite(env.expiresAt)) return fail('bad_timestamp');
  if (env.expiresAt <= now) return fail('expired');
  if (env.timestamp > now + MAX_CLOCK_SKEW_MS) return fail('from_future');
  if (env.timestamp < now - maxAgeMs) return fail('too_old');
  if (env.expiresAt > env.timestamp + MAX_TTL_MS) return fail('ttl_too_long');
  const size = Buffer.byteLength(JSON.stringify(env), 'utf8');
  const limit = Math.min(maxBytes, MAX_MESSAGE_BYTES[env.type] || maxBytes);
  if (size > limit) return fail('too_large');
  if (typeof env.signature !== 'string' || env.signature.length < 32) return fail('missing_signature');

  let pem = pubkeyPem;
  if (!pem) {
    pem = env.payload && env.payload.pubkey;
    if (typeof pem !== 'string') return fail('no_pubkey');
    let derived;
    try { derived = nodeIdFromPublicKeyPem(pem); } catch { return fail('bad_pubkey'); }
    if (derived !== env.nodeId) return fail('node_id_key_mismatch');
  }
  if (!verifyWithPublicKey(pem, Buffer.from(envelopeBody(env), 'utf8'), env.signature)) {
    return fail('bad_signature');
  }
  if (replay && !replay.accept(env.messageId, env.expiresAt, now)) return fail('replay');

  return { ok: true, env, size };
}

export function describeEnvelope(env) {
  return {
    protocol: env.protocol,
    type: env.type,
    messageId: env.messageId,
    nodeId: env.nodeId,
    timestamp: env.timestamp,
    expiresAt: env.expiresAt,
    bytes: Buffer.byteLength(JSON.stringify(env), 'utf8'),
  };
}
