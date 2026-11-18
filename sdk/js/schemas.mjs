#!/usr/bin/env node
/* Stage B — версионированные схемы рынка услуг (zero-deps).
   Деньги — только целые атомарные единицы. Секреты и приватная память
   в эти объекты не входят. Версии: protocol 0.3 / api 0.3 / sdk 0.3. */
export const PROTOCOL_VERSION = '0.3.0';
export const API_VERSION = '0.3.0';

import crypto from 'node:crypto';
const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
export function canon(v) {
  const sort = (x) => Array.isArray(x) ? x.map(sort) : (x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x);
  return JSON.stringify(sort(v));
}
export const hashOf = (v) => sha256hex(canon(v));

function req(obj, fields) {
  for (const f of fields) if (obj?.[f] === undefined || obj?.[f] === null || obj?.[f] === '') return `missing ${f}`;
  return null;
}
const isInt = (v) => Number.isInteger(v) && v >= 0;

/* Паспорт возможностей агента: самодекларация навыков (не подтверждение). */
export function validateAgentProfile(p) {
  let e = req(p, ['agentAddress', 'profileVersion', 'skills', 'acceptedInputFormats', 'producedOutputFormats', 'availability', 'expiresAt', 'signature']);
  if (e) return e;
  if (!Array.isArray(p.skills)) return 'skills must be array (self-declared)';
  if (Number(p.expiresAt) <= Date.now()) return 'profile expired';
  return null;
}
/* Предложение услуги. Неизменяемость: offerId+version — ключ; правка = новая версия. */
export function validateServiceOffer(o) {
  let e = req(o, ['offerId', 'version', 'provider', 'title', 'inputSchema', 'outputSchema', 'acceptance', 'priceAtomic', 'expiresAt', 'license']);
  if (e) return e;
  if (!isInt(o.priceAtomic)) return 'priceAtomic must be integer atomic units';
  if (Number(o.expiresAt) <= Date.now()) return 'offer expired';
  if (!o.acceptance?.method) return 'acceptance.method required (known before work)';
  return null;
}
/* Заказ: снимок предложения фиксируется, чтобы правка оффера не меняла сделку. */
export function validateAssignment(a) {
  let e = req(a, ['assignmentId', 'offerId', 'offerVersion', 'offerSnapshotHash', 'customer', 'provider', 'input', 'acceptanceMethod', 'state']);
  if (e) return e;
  return null;
}
/* Артефакт: хеш по фактическому содержимому; смена содержимого = новая версия. */
export function validateArtifact(a) {
  let e = req(a, ['assignmentId', 'attemptId', 'artifactId', 'contentHash', 'mediaType', 'sizeBytes', 'createdAt', 'producerSignature']);
  if (e) return e;
  if (!Number.isInteger(a.sizeBytes) || a.sizeBytes < 0) return 'sizeBytes must be integer >= 0';
  return null;
}
export function verifyArtifactHash(contentBytes, artifact) {
  const h = crypto.createHash('sha256').update(contentBytes).digest('hex');
  return h === artifact.contentHash ? null : `hash mismatch: content!=${artifact.contentHash}`;
}
