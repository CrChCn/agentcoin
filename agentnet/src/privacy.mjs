/* agentnet/privacy.mjs — публичная проекция: только разрешённые поля и только
   публичные endpoint'ы (loopback/private/CGNAT не публикуются никогда). */
'use strict';
import { isCgnatV4, isPrivateV4 } from './nat.mjs';

export const PUBLIC_NODE_FIELDS = [
  'nodeId', 'status', 'level', 'ready', 'reasons',
  'version', 'protocol', 'height', 'tipHash', 'chainwork', 'genesisHash',
  'peers', 'uptimeSec', 'lagSec', 'natStatus', 'region', 'operatorId',
  'firstSeen', 'lastSeen', 'observedBy', 'signatureValid',
];

const PRIVATE_PATTERNS = [
  /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
  /\bfe80:/i,
  /\bfd[0-9a-f]{2}:/i,
  /\blocalhost\b/i,
  /\/Users\//,
  /[A-Za-z]:\\Users\\/,
  /BEGIN PRIVATE KEY/,
  /node\.key\.pem/,
];

export function isPublicHost(host) {
  if (typeof host !== 'string' || !host) return false;
  if (host === 'localhost' || host === '::1' || host === '::') return false;
  if (host.startsWith('127.')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return !isPrivateV4(host) && !isCgnatV4(host) && !host.startsWith('0.') && host !== '255.255.255.255';
  }
  if (host.includes(':')) return !/^(fe80|fc|fd|::1)/i.test(host);
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host);
}

export function publicEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') return null;
  const host = String(endpoint.host || '');
  const port = Number(endpoint.port);
  if (!isPublicHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export function publicNode(record, { now = Date.now() } = {}) {
  const out = {};
  for (const key of PUBLIC_NODE_FIELDS) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  out.observedBy = Array.isArray(record.observers)
    ? [...new Set(record.observers.map((o) => o.indexerId))].sort()
    : (record.observedBy || []);
  out.operatorId = record.operatorId || (record.operator && record.operator.operatorId) || null;
  out.region = record.region || null;
  out.endpoint = publicEndpoint(record.endpoint);
  out.ready = Boolean(record.ready);
  if (record.lastSeen) {
    const age = Math.max(0, now - Date.parse(record.lastSeen));
    out.lagSec = out.lagSec ?? Math.round(age / 1000);
  }
  return out;
}

/** Глубокая проверка: в публичном ответе не должно быть приватных данных. */
export function findPrivateLeaks(value, path = '') {
  const leaks = [];
  if (typeof value === 'string') {
    for (const re of PRIVATE_PATTERNS) {
      if (re.test(value)) { leaks.push({ path, pattern: re.source }); break; }
    }
    return leaks;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaks.push(...findPrivateLeaks(v, `${path}[${i}]`)));
    return leaks;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/^(privateKey|privkey|secret|password|token|seed|keyfile)$/i.test(k)) {
        leaks.push({ path: `${path}.${k}`, pattern: 'forbidden_field' });
        continue;
      }
      leaks.push(...findPrivateLeaks(v, path ? `${path}.${k}` : k));
    }
  }
  return leaks;
}

export function assertNoPrivateLeaks(value) {
  const leaks = findPrivateLeaks(value);
  if (leaks.length > 0) {
    throw new Error(`public_response_leaks_private_data:${JSON.stringify(leaks.slice(0, 3))}`);
  }
  return true;
}

/** Сводка по NAT без адресов. */
export function publicNat(nat) {
  if (!nat) return null;
  return {
    status: nat.status || 'UNKNOWN',
    mapped: Boolean(nat.mapped),
    cgnat: Boolean(nat.cgnat),
    ipv6: Boolean(nat.ipv6),
  };
}
