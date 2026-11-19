#!/usr/bin/env node
/* Этап C (ТЗ §6): повторяющаяся услуга с ограниченным бюджетом.
   Проверяем ровно те правила, которые ТЗ требует от подписки:
     - условия (каденция, период, потолок, приёмка, отмена, продление) известны ДО работы;
     - пропущенный запуск не считается работой и не оплачивается;
     - повтор тика не создаёт второй заказ;
     - отмена прекращает будущие обязательства, но не стирает возникшие;
     - состояние переживает рестарт;
     - доступность цели и исправность проверяющего — разные поля. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStand } from '../sdk/js/stand-server.mjs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';
import { addressFromPub } from '../core.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + name + (extra ? ' — ' + extra : '')); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtsub-'));
let stand = await createStand(tmp);
const J = (n) => path.join(tmp, n + '.json');

const mk = (name) => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pub = k.publicKey.export({ type: 'spki', format: 'pem' });
  const addr = addressFromPub(pub);
  const w = path.join(tmp, name + '.wallet.json');
  fs.writeFileSync(w, JSON.stringify({ address: addr, public_key_pem: pub, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { addr, w };
};
const A = mk('customer'), B = mk('provider'), C = mk('stranger');
const client = (o, tag) => makeClient({ node: stand.url, address: o.addr, walletFile: o.w, journalFile: J(tag) });
const cA = client(A, 'ca'), cB = client(B, 'cb');

const now = Date.now();
const CADENCE = 60_000;
const baseSub = () => ({
  serviceId: 'api-uptime-1',
  customer: A.addr,
  provider: B.addr,
  cadence: CADENCE,
  periodStart: now,
  periodEnd: now + 6 * 3600_000,
  maxCostPerPeriodAtomic: 500,
  priceAtomicPerRun: 100,
  acceptanceRules: { method: 'human', rules: 'period report must contain target status + evidence' },
  cancellationRules: { noticeMs: 0, refundUnused: false },
  renewalPolicy: { autoRenew: false, requireCustomerApproval: true },
  targetUrl: 'https://example/api/health',
  maxConcurrentRuns: 4,
});

// 1. условия фиксируются до работы и видны стороне-заказчику
let id = null, createdAt = null;
{
  const r = await cA.createSubscription(A.addr, baseSub());
  id = r?.result?.monitor?.monitorId;
  createdAt = r?.result?.monitor?.createdAt;
  const m = r?.result?.monitor;
  ok(r.ok === true && m?.subscription?.acceptanceRules?.method === 'human',
    'подписка создана, условия приёмки сохранены в снимке', r.error || '');
  ok(m?.subscription?.renewalPolicy?.autoRenew === false && m?.lastIndex === -1,
    'продление не автоматическое, период ещё не начинался');
}

// 2. неполные условия отклоняются до создания обязательства
{
  const noRenewal = { ...baseSub(), serviceId: 'api-uptime-bad-renewal', renewalPolicy: undefined };
  const r = await cA.createSubscription(A.addr, noRenewal);
  ok(r.ok === false && r.error === 'bad_subscription', 'без renewalPolicy — отказ (bad_subscription)', r.detail || '');
  const badBudget = { ...baseSub(), serviceId: 'api-uptime-bad-budget', priceAtomicPerRun: 900, maxCostPerPeriodAtomic: 500 };
  const r2 = await cA.createSubscription(A.addr, badBudget);
  ok(r2.ok === false && r2.error === 'bad_subscription', 'цена выше потолка периода — отказ');
  const foreign = await cB.createSubscription(B.addr, { ...baseSub(), customer: A.addr });
  ok(foreign.ok === false && foreign.error === 'foreign_subscription', 'чужой customer в подписке — отказ (403)');
}

// 3. тик текущего периода создаёт ровно одно оплачиваемое обязательство
{
  const t = await cA.tickMonitor(id, createdAt + 10);
  ok(t.ok === true && t.ran?.[0]?.assignmentId, 'тик периода 0 создал обязательство', t.error || '');
  const h = await cA.monitorHistory(id, A.addr);
  const open = h.runs.filter((r) => r.state === 'open');
  ok(h.runs.length === 1 && open.length === 1 && open[0].costAtomic === 100, 'в истории один открытый прогон стоимостью 100');
  // 4. повтор в том же периоде (другой nowMs) не создаёт второй заказ
  const t2 = await cA.tickMonitor(id, createdAt + 20);
  const h2 = await cA.monitorHistory(id, A.addr);
  ok(t2.ok === true && (t2.ran || []).length === 0 && h2.runs.length === 1,
    'повтор тика в том же периоде не создаёт второй заказ');
}

// 5. пропущенные периоды фиксируются, но не оплачиваются
{
  const t = await cA.tickMonitor(id, createdAt + 3 * CADENCE + 10);
  const h = await cA.monitorHistory(id, A.addr);
  const missed = h.runs.filter((r) => r.state === 'missed');
  ok(t.ok === true && missed.length === 2, 'два пропущенных периода записаны как missed', `missed=${missed.length}`);
  ok(missed.every((r) => r.costAtomic === 0 && r.assignmentId === null), 'missed не имеет ни цены, ни заказа');
  ok(h.runs.filter((r) => r.state === 'open').length === 2, 'открытых (оплачиваемых) прогонов по-прежнему два');
}

// 6. доступность цели и исправность проверяющего — разные поля
{
  const result = { targetStatus: 'down', checkerStatus: 'ok', evidence: 'HTTP 503 в 12:00' };
  const t = await cA.tickMonitor(id, createdAt + 4 * CADENCE + 10, result);
  const h = await cA.monitorHistory(id, A.addr);
  const run = h.runs.find((r) => r.periodIndex === 4);
  ok(t.ok === true && run?.targetStatus === 'down' && run?.checkerStatus === 'ok',
    'цель down и проверяющий ok хранятся раздельно', run ? `${run.targetStatus}/${run.checkerStatus}` : 'run не найден');
  ok(run?.state === 'open', 'отчёт проверяющего не считается приёмкой (прогон открыт)');
}

// 7. пауза останавливает будущие запуски
{
  const p = await cA.pauseMonitor(A.addr, id, true);
  const t = await cA.tickMonitor(id, createdAt + 10 * CADENCE + 10);
  const h = await cA.monitorHistory(id, A.addr);
  ok(p.ok === true && t.ok === true && Array.isArray(t.ran) && t.ran.length === 0,
    'на паузе новых запусков нет');
  ok(h.runs.filter((r) => r.state === 'open').length === 3, 'пауза не стирает возникшие обязательства');
  await cA.pauseMonitor(A.addr, id, false);
}

// 8. чужой не может отменить подписку
{
  const r = await cB.cancelMonitor(B.addr, id);
  ok(r.ok === false && r.error === 'foreign_monitor', 'отмена провайдером запрещена (только заказчик)');
}

// 9. отмена заказчиком: будущее прекращено, возникшее осталось
{
  const c = await cA.cancelMonitor(A.addr, id);
  const t = await cA.tickMonitor(id, createdAt + 12 * CADENCE + 10);
  const h = await cA.monitorHistory(id, A.addr);
  ok(c.ok === true && c.result?.monitor?.canceled === true, 'подписка отменена заказчиком');
  ok(t.ok === false && t.error === 'monitor_canceled', 'после отмены тик отвергнут (не «пустой успех»)', t.error || '');
  ok(h.runs.length === 5, 'история после отмены сохранена целиком', `runs=${h.runs.length}`);
}

// 10. состояние переживает рестарт стенда
{
  const before = (await cA.monitorHistory(id, A.addr));
  stand.close();
  stand = await createStand(tmp);
  const cA2 = makeClient({ node: stand.url, address: A.addr, walletFile: A.w, journalFile: J('ca2') });
  const after = await cA2.monitorHistory(id, A.addr);
  ok(after?.monitor?.subscription?.acceptanceRules?.method === 'human' && after?.monitor?.canceled === true,
    'после рестарта подписка и её условия на месте');
  ok(after.runs.length === before.runs.length, 'после рестарта история прогонов не потеряна', `${before.runs.length} → ${after.runs.length}`);
}

// 11. период, пропущенный из-за лимита параллельных запусков, виден в истории
{
  const cA3 = makeClient({ node: stand.url, address: A.addr, walletFile: A.w, journalFile: J('ca3') });
  const r = await cA3.createSubscription(A.addr, { ...baseSub(), serviceId: 'api-uptime-conc', targetUrl: 'https://example/api/conc', maxConcurrentRuns: 1 });
  const m = r?.result?.monitor;
  const t1 = await cA3.tickMonitor('api-uptime-conc', m.createdAt + 10);
  const t2 = await cA3.tickMonitor('api-uptime-conc', m.createdAt + 2 * CADENCE + 10);
  const h = await cA3.monitorHistory('api-uptime-conc', A.addr);
  const skipped = h.runs.filter((x) => x.state === 'skipped');
  ok(Boolean(t1.ran?.[0]?.assignmentId) && skipped.length === 1 && skipped[0].skipReason === 'max_concurrent',
    'период из-за лимита параллельных запусков сохранён как skipped, а не потерян', `skipped=${skipped.length}`);
  ok(skipped.length === 1 && skipped[0].costAtomic === 0 && skipped[0].assignmentId === null,
    'skipped не оплачивается и не создаёт заказ');
  ok((t2.ran || []).some((x) => x.skipped === 'max_concurrent' && x.recorded === true),
    'тик сообщает о пропуске явно (skipped + recorded), а не молчит');
  const t3 = await cA3.tickMonitor('api-uptime-conc', m.createdAt + 5 * CADENCE + 10);
  const h2 = await cA3.monitorHistory('api-uptime-conc', A.addr);
  // Поздний тик: периоды 3–4 уже в прошлом (missed), лимит параллельных запусков
  // останавливает только текущий период 5 → skipped. Главное — нет дыр: 0..5 покрыты.
  const idx = h2.runs.map((r) => r.periodIndex).sort((a, b) => a - b);
  const covered = idx.length === 6 && idx.every((v, i) => v === i);
  ok(covered && t3.ok === true && h2.runs.filter((x) => x.state === 'skipped').length === 2,
    'ни один период не потерян: покрыты 0..5, текущий под лимитом — skipped',
    `runs=${JSON.stringify(h2.runs.map((r) => [r.periodIndex, r.state]))}`);
}
// 12. потолок периода — инвариант создания, а не мёртвая ветка в тике
{
  const cA4 = makeClient({ node: stand.url, address: A.addr, walletFile: A.w, journalFile: J('ca4') });
  const bad = await cA4.createMonitor(A.addr, { monitorId: 'cap-1', targetUrl: 'https://example/cap', periodMs: 60000, expiresAt: Date.now() + 3600000, priceAtomicPerRun: 100, maxCostPerPeriodAtomic: 50 });
  ok(bad.ok === false && bad.error === 'bad_maxCost', 'цена запуска выше потолка периода отвергается при создании', bad.error || '');
}

console.log(`\nитог: ${pass} PASS, ${fail} FAIL`);
stand.close();
process.exit(fail ? 1 : 0);
