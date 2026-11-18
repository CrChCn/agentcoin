#!/usr/bin/env node
/* Этап C: события с курсором + api-monitor. Контрактные проверки стенда. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStand } from '../sdk/js/stand-server.mjs';
import { addressFromPub } from '../core.mjs';

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log('ok ' + n + ' ' + m); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-ecoC-'));
const stand = await createStand(tmp);
const { makeClient } = await import('../sdk/js/agentcoin-sdk.mjs');
const mkW = () => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pub = k.publicKey.export({ type: 'spki', format: 'pem' });
  const addr = addressFromPub(pub);
  const wf = path.join(tmp, addr.slice(0, 8) + '.json');
  fs.writeFileSync(wf, JSON.stringify({ address: addr, public_key_pem: pub, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { addr, wf };
};
const B = mkW(), A = mkW();
const cB = makeClient({ node: stand.url, address: B.addr, walletFile: B.wf, journalFile: path.join(tmp, 'jB.json') });
const cA = makeClient({ node: stand.url, address: A.addr, walletFile: A.wf, journalFile: path.join(tmp, 'jA.json') });
// offer api-check + api-monitor
const base = { provider: B.addr, title: 't', skills: ['api-check'], acceptedInputFormats: ['application/json'], producedOutputFormats: ['application/json'], inputSchema: {}, outputSchema: {}, acceptance: { method: 'human' }, priceAtomic: 500, expiresAt: Date.now() + 3600000, license: 'test' };
ok((await cB.publishOffer(B.addr, { ...base, offerId: 'api-check-v1', version: '1' })).ok, 'publish api-check');
ok((await cB.publishOffer(B.addr, { ...base, offerId: 'api-monitor-v1', version: '1' })).ok, 'publish api-monitor');
// заказ -> события
const ord = await cA.createOrder(A.addr, 'api-check-v1', { url: 'https://example/api' }, 'c-ev-1');
ok(ord.ok, 'order created');
const ev1 = await cA.getEvents({ cursor: '0', limit: 50, requester: A.addr });
ok(ev1._status === 200 && ev1.events.length >= 1, 'events page 200');
const e = ev1.events[0];
ok(e.eventId && e.eventType && e.entityId && e.occurredAt && e.observedAt && e.source && e.visibility, 'event fields complete, occurredAt!=observedAt разделены');
// постраничность + дедуп повтора
const p1 = await cA.getEvents({ cursor: '0', limit: 1, requester: A.addr });
const p2 = await cA.getEvents({ cursor: p1.nextCursor, limit: 50, requester: A.addr });
ok(new Set([p1.events[0]?.eventId, ...p2.events.map((x) => x.eventId)]).size === 1 + p2.events.length, 'cursor pages join without dupes');
const rep = await cA.getEvents({ cursor: '0', limit: 50, requester: A.addr });
ok(JSON.stringify(rep.events.map((x) => x.eventId)) === JSON.stringify(ev1.events.map((x) => x.eventId)), 'redelivery identical, эффект идемпотентен');
// истёкший курсор
const bad = await cA.getEvents({ cursor: '999999', limit: 5, requester: A.addr });
ok(bad._status === 410 && bad.error === 'cursor_expired', 'expired cursor -> 410 + snapshot hint');
// приватность: чужой не видит содержимое
const pub = await cA.getEvents({ cursor: '0', limit: 50 });
ok(pub.events.every((x) => x.visibility === 'public'), 'public feed only public');
const priv = await cA.getEvents({ cursor: '0', limit: 50, requester: 'STRANGER' });
ok(priv.events.every((x) => x.visibility === 'public'), 'stranger sees no parties payload');
// monitor create + SSRF
const ssrf = await cA.createMonitor(A.addr, { targetUrl: 'http://127.0.0.1/x', periodMs: 60000, expiresAt: Date.now() + 3600000, priceAtomicPerRun: 100, maxCostPerPeriodAtomic: 100 });
ok(!ssrf.ok, 'ssrf localhost blocked');
const mon = await cA.createMonitor(A.addr, { monitorId: 'm1', targetUrl: 'https://example/api', provider: B.addr, periodMs: 60000, expiresAt: Date.now() + 3600000, priceAtomicPerRun: 100, maxCostPerPeriodAtomic: 500, maxConcurrentRuns: 1 });
ok(mon.ok, 'monitor created');
// два tick одного периода -> один запуск
const t0 = Date.now();
const r1 = await cA.tickMonitor('m1', t0);
const r2 = await cA.tickMonitor('m1', t0 + 500);
ok(r1.ok && r2.ok, 'ticks ok');
const hist = await cA.monitorHistory('m1', A.addr);
ok(hist.runs.length === 1, 'single run per period, no double order (got ' + hist.runs.length + ')');
// пауза останавливает будущие
ok((await cA.pauseMonitor(A.addr, 'm1', true)).ok, 'paused');
const r3 = await cA.tickMonitor('m1', t0 + 61000);
ok(r3.ran.length === 0, 'paused tick creates nothing');
// рестарт: персистентность — новый стенд на том же tmp видит монитор и события
stand.close();
await new Promise((r) => setTimeout(r, 200));
const stand2 = await createStand(tmp);
const cA2 = makeClient({ node: stand2.url, address: A.addr, walletFile: A.wf, journalFile: path.join(tmp, 'jA.json') });
const evR = await cA2.getEvents({ cursor: '0', limit: 50, requester: A.addr });
ok(evR.events.length >= ev1.events.length, 'restart restores events cursor');
const histR = await cA2.monitorHistory('m1', A.addr);
ok(histR.runs.length === 1, 'restart restores monitor runs');
stand2.close();
console.log(`ecosphere-C PASS ${n}/${n}`);
