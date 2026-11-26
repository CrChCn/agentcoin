#!/usr/bin/env node
/* hire-agents.mjs — смена агентов на ноде: эскроу → работа (отчёт) → выплата.
 *
 * Берёт агентов из очереди по FIFO (кого нода знает своим кошельком — иначе
 * claim/payout нечем подписать), выдаёт каждому измеримую задачу по сети,
 * публикует их отчёт в /community/send и платит из кошелька-работодателя.
 * Всё на loopback-ноде: ключи не покидают сервер.
 *
 *   node scripts/hire-agents.mjs                     # смена: 3 агента, 0.25 AGT
 *   node scripts/hire-agents.mjs --count 2 --amount 0.3
 *   node scripts/hire-agents.mjs --dry-run           # план без транзакций
 *   node scripts/hire-agents.mjs --worker AGT…                 # адресно: один агент
 *   node scripts/hire-agents.mjs --worker AGT… --task-index 0 # адресно: агент + задача из пула
 *
 * Леджер (--ledger, по умолчанию рядом со скриптом hire-ledger.json) не даёт
 * платить одному и тому же агенту чаще, чем раз в --repeat-hours (12 ч).
 */
'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const API = String(arg('api', process.env.AGT_API || 'http://127.0.0.1:9335')).replace(/\/+$/, '');
const EMPLOYER = arg('employer', process.env.AGT_EMPLOYER || 'AGTbc9fa2a7c023633ca02eba59bbeac6094e58cefb');
const AMOUNT = Number(arg('amount', 0.25));
const COUNT = Number(arg('count', 3));
const DEADLINE = Number(arg('deadline', 7200));
const REPEAT_HOURS = Number(arg('repeat-hours', 12));
const TASK_INDEX = has('task-index') ? Number(arg('task-index')) : null;
const LEDGER = path.resolve(arg('ledger', path.join(__dirname, 'hire-ledger.json')));
const DRY = has('dry-run');
const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

const api = async (method, p, body) => {
  const r = await fetch(API + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
};
const get = async (p) => (await api('GET', p)).data;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const short = (a) => String(a || '').slice(0, 12) + '…';

function loadLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { shifts: [] }; } }
function saveLedger(l) { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 1)); }

// ── пул работ: каждая задача — проверяемая сводка по публичным данным ──
async function loadFacts() {
  const [orders, jobs, esc, sec, life, pp, tr, auc, net] = await Promise.all([
    get('/dxe/orders?item=mbc20%3ABOTAI').catch(() => ({})),
    get('/jobs/state').catch(() => ({})),
    get('/escrow/state').catch(() => ({})),
    get('/security/status').catch(() => ({})),
    get('/life').catch(() => ({})),
    get('/passport/count').catch(() => ({})),
    get('/treasury/state').catch(() => ({})),
    get('/jobs/auction/list').catch(() => ({})),
    get('/api/v1/network/nodes').catch(() => ({})),
  ]);
  const list = Array.isArray(orders.orders) ? orders.orders : [];
  const open = list.filter((o) => o.status === 'open');
  const bids = open.filter((o) => o.side === 'b').map((o) => Number(o.price));
  const asks = open.filter((o) => o.side === 's').map((o) => Number(o.price));
  const st = jobs.stats || {};
  const paidJobs = Number(st.paid || 0), paidOut = Number(st.paidOut || 0);
  const nodes = Array.isArray(net.nodes) ? net.nodes : [];
  const auctions = Array.isArray(auc.auctions) ? auc.auctions : [];
  return {
    openOrders: open.length,
    bestBid: bids.length ? Math.max(...bids) : null,
    bestAsk: asks.length ? Math.min(...asks) : null,
    spread: bids.length && asks.length ? +(Math.min(...asks) - Math.max(...bids)).toFixed(4) : null,
    paidJobs, paidOut, avgPayment: paidJobs ? +(paidOut / paidJobs).toFixed(2) : 0,
    fees: Number(st.feesAGT || 0),
    height: Number(life.blocks || 0), tipAge: life.tipAgeSec, valid: life.chainValid === true,
    attacks: Number(sec.attacksSeen || 0), banned: Number(sec.bannedCount || 0),
    passports: Number(pp.count || 0),
    treasury: Number(tr.balance || 0),
    auctions: auctions.length,
    nodes: nodes.length,
    escrows: (esc.escrows || []).length,
  };
}

function taskPool(f) {
  return [
    {
      key: 'dxe',
      task: 'DXE-сводка по BOTAI: открытые ордера, лучший бид, лучший аск, спред. Три строки в /community/send.',
      report: `DXE по BOTAI: открытых ордеров ${f.openOrders}, лучший бид ${f.bestBid ?? '—'} AGT, лучший аск ${f.bestAsk ?? '—'} AGT, спред ${f.spread ?? '—'}. Высота ${fmt(f.height)}.`,
    },
    {
      key: 'payouts',
      task: 'Проверка выплат: сколько всего выплачено, сколько работ оплачено, средняя выплата, комиссии казны. Три строки в /community/send.',
      report: `Выплаты сети: ${fmt(f.paidOut)} AGT за ${f.paidJobs} оплаченных работ, средняя ${f.avgPayment} AGT, комиссии казны ${fmt(f.fees)} AGT. Всего эскроу ${f.escrows}.`,
    },
    {
      key: 'security',
      task: 'Аудит безопасности: атаки, бан-лист, валидность цепи на текущей высоте. Три строки в /community/send.',
      report: `Аудит: атак ${f.attacks}, адресов в бане ${f.banned}, цепь ${f.valid ? 'валидна' : 'требует проверки'} на высоте ${fmt(f.height)}. Последний блок ${Math.round(f.tipAge ?? 0)} с назад.`,
    },
    {
      key: 'nodes',
      task: 'Проверка децентрализации: сколько нод видит сеть, отстают ли они от tip, сходятся ли высоты. Три строки в /community/send.',
      report: `Ноды: сеть видит ${f.nodes}, высота ${fmt(f.height)}, цепь ${f.valid ? 'валидна' : 'требует проверки'}. Паспортов ${f.passports}, казна ${fmt(f.treasury)} AGT.`,
    },
    {
      key: 'market',
      task: 'Рынок работ: сколько открытых аукционов, какие задачи выставлены, средняя цена. Три строки в /community/send.',
      report: `Аукционы: открыто ${f.auctions}, оплачено работ ${f.paidJobs}, выплачено ${fmt(f.paidOut)} AGT. Средняя выплата ${f.avgPayment} AGT.`,
    },
  ];
}

async function pickWorkers(count, ledger) {
  const fixed = arg('worker');
  if (fixed) return [String(fixed)];
  const q = await get('/queue/status');
  const order = Array.isArray(q.nextFive) ? q.nextFive : [];
  const cutoff = Date.now() - REPEAT_HOURS * 3600_000;
  const recent = new Set((ledger.shifts || []).filter((s) => Date.parse(s.at) > cutoff).map((s) => s.worker));
  const picked = order.filter((a) => !recent.has(a));
  return picked.slice(0, count);
}

async function waitEscrow(escId, want, timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { escrows = [] } = await get('/escrow/state');
    const e = escrows.find((x) => x.escId === escId);
    if (e && (!want || e.status === want)) return e;
    await sleep(5000);
  }
  return null;
}

async function main() {
  const ledger = loadLedger();
  const facts = await loadFacts();
  const pool = taskPool(facts);
  if (TASK_INDEX !== null && !(Number.isInteger(TASK_INDEX) && pool[TASK_INDEX])) {
    throw new Error(`--task-index ${arg('task-index')} не из пула: 0…${pool.length - 1} (${pool.map((p) => p.key).join(', ')})`);
  }
  const workers = await pickWorkers(COUNT, ledger);
  const bal = await api('POST', '/balance', { address: EMPLOYER });
  const funds = Number(bal.data?.balance ?? bal.data?.amount ?? 0);

  console.log(`работодатель ${EMPLOYER} · ${fmt(funds)} AGT · ставка ${AMOUNT} AGT/смена`);
  console.log(`очередь: выбрано ${workers.length} агентов (FIFO, без выплат за последние ${REPEAT_HOURS} ч)\n`);
  if (!workers.length) { console.log('некому платить: очередь пуста или все недавно получали'); return; }

  const used = new Set((ledger.shifts || []).filter((s) => Date.now() - Date.parse(s.at) < 6 * 3600_000).map((s) => s.taskKey));
  const plan = workers.map((w, i) => {
    const t = TASK_INDEX !== null ? pool[TASK_INDEX] : pool.find((x) => !used.has(x.key)) || pool[i % pool.length];
    used.add(t.key);
    return { worker: w, handle: '', ...t };
  });

  if (DRY) {
    for (const p of plan) console.log(`· ${short(p.worker)}\n  задача: ${p.task}\n  отчёт: ${p.report}`);
    return;
  }
  if (funds < AMOUNT * plan.length) throw new Error(`в кошельке работодателя мало средств: ${funds}`);

  const opened = [];
  for (const p of plan) {
    const taskHash = sha256(p.task);
    const r = await api('POST', '/escrow/create', { employer: EMPLOYER, worker: p.worker, amount: AMOUNT, taskHash, deadlineSec: DEADLINE });
    if (r.status !== 201) { console.error(`✖ ${short(p.worker)}: escrow/create ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); continue; }
    opened.push({ ...p, escId: r.data.escId, taskHash });
    console.log(`✔ эскроу ${r.data.escId} · ${short(p.worker)} · ${AMOUNT} AGT · задача «${p.key}»`);
  }
  if (!opened.length) throw new Error('ни один эскроу не открылся');

  console.log('\nжду майнинга…');
  const mined = [];
  for (const o of opened) {
    const e = await waitEscrow(o.escId, 'open');
    if (!e || !e.openedTxid) { console.error(`✖ ${o.escId}: не попал в блок`); continue; }
    mined.push({ ...o, openTxid: e.openedTxid });
    console.log(`  ${o.escId} в цепи`);
  }

  const done = [];
  for (const m of mined) {
    const claim = await api('POST', '/escrow/claim', { escId: m.escId, taskHash: m.taskHash, workerAddress: m.worker });
    if (claim.status !== 200) { console.error(`✖ ${m.escId}: claim ${claim.status}`); continue; }
    const pay = await api('POST', '/escrow/payout', { escId: m.escId, employerAddress: EMPLOYER, workerReceiptSig: claim.data.receiptSig, workerPub: claim.data.workerPub });
    if (pay.status !== 201) { console.error(`✖ ${m.escId}: payout ${pay.status} ${JSON.stringify(pay.data).slice(0, 120)}`); continue; }
    done.push(m);
    console.log(`✔ выплата по ${m.escId} отправлена`);
  }

  console.log('\nжду подтверждения и публикую отчёты…');
  const result = [];
  for (const d of done) {
    const e = await waitEscrow(d.escId, 'paid');
    const status = e?.status || 'unknown';
    const sent = await api('POST', '/community/send', { sender: d.worker, text: d.report });
    console.log(`  ${d.escId} → ${status}${e?.paidTxid ? ' · tx ' + String(e.paidTxid).slice(0, 14) + '…' : ''}${sent.status === 201 ? ' · отчёт в ленте' : ' · отчёт не ушёл (' + sent.status + ')'}`);
    result.push({ at: new Date().toISOString(), worker: d.worker, amount: AMOUNT, taskKey: d.key, task: d.task, report: d.report, escId: d.escId, openTxid: d.openTxid, payTxid: e?.paidTxid || null, status });
    await sleep(800);
  }
  ledger.shifts = [...(ledger.shifts || []), ...result.map((r) => ({ at: r.at, worker: r.worker, taskKey: r.taskKey, escId: r.escId, payTxid: r.payTxid }))].slice(-500);
  saveLedger(ledger);
  console.log('\nИТОГ');
  console.log(JSON.stringify(result, null, 1));
}

main().catch((e) => { console.error('✖ ' + (e?.message || e)); process.exitCode = 1; });
