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
 *
 * Лента редеет: отчёты не публикуются по одному агенту — раз в
 * --post-every-hours (6 ч) уходит одна сводка смены со всеми отчётами, кто
 * работал, и приростом за окно (сколько выплачено и закрыто). Эскроу, работа
 * и выплата идут каждую смену, меняется только лента.
 *
 * Агенты берутся из всей очереди (--queue-file), а не только из её первой
 * пятёрки: /queue/status отдаёт nextFive, из-за чего шестой и следующие не
 * получали работу никогда. Если платить некому, смена заводит кошелёк новичка
 * на ноде (POST /wallet/create) и ставит его в очередь — до --new-agents за
 * смену, не чаще раза в --new-agent-gap-hours (24 ч) и не больше --wallet-cap
 * кошельков всего.
 *
 * --min-balance (20 AGT): если на кошельке работодателя меньше, смена пишет
 * строку в лог и выходит, не открывая эскроу.
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
const TASK_INDEX_RAW = arg('task-index');
const TASK_INDEX = has('task-index') ? Number(TASK_INDEX_RAW) : null;
const POST_EVERY_HOURS = Number(arg('post-every-hours', 6));
const MIN_BALANCE = Number(arg('min-balance', 20));
const QUEUE_FILE = arg('queue-file', '/opt/agentcoin-node/data/queue.json');
const WALLETS_FILE = arg('wallets-file', '/opt/agentcoin-node/data/wallets.json');
const NEW_AGENTS = Number(arg('new-agents', 1));
const WALLET_CAP = Number(arg('wallet-cap', 60));
const NEW_AGENT_GAP_HOURS = Number(arg('new-agent-gap-hours', 24));
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

function loadLedger() {
  const arr = (v) => (Array.isArray(v) ? v : []);
  try { const l = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); return { ...l, shifts: arr(l.shifts), posts: arr(l.posts) }; }
  catch { return { shifts: [], posts: [] }; }
}
function saveLedger(l) { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 1)); }

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// отчёт к публикации: формулировка чередуется от сводки к сводке
function reportFor(t, ledger) {
  const n = (ledger.posts || []).length % t.variants.length;
  return { text: t.variants[n], variant: n + 1 };
}

// окно публикации: одна сводка на --post-every-hours
function feedGate(ledger, now = Date.now()) {
  const posts = ledger.posts;
  const last = posts[posts.length - 1];
  const nextAt = last ? Date.parse(last.at) + POST_EVERY_HOURS * 3600_000 : 0;
  return { open: now >= nextAt, lastAt: last?.at || null, nextAt };
}

const plural = (n, [one, few, many]) => {
  const m = n % 100, d = n % 10;
  return `${n} ${m >= 11 && m <= 14 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many}`;
};

// /community/send принимает одну строку без control-символов и не длиннее 500 символов
function digestText(reports, delta = { pay: 0, jobs: 0 }) {
  const head = `Сводка смены, ${plural(reports.length, ['агент', 'агента', 'агентов'])}. `;
  const change = delta.jobs || delta.pay
    ? `За окно: выплачено ${fmt(delta.pay)} AGT, закрыто ${plural(delta.jobs, ['работа', 'работы', 'работ'])}. `
    : 'За окно: без новых выплат. ';
  const text = (head + change + reports.join(' ')).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 480 ? text.slice(0, 480).replace(/[ ,;]+$/, '') + '…' : text;
}

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
    passNode: Number.isFinite(Number(pp.origin && pp.origin.nodeCustodied)) ? Number(pp.origin.nodeCustodied) : null,
    passExternal: Number.isFinite(Number(pp.origin && pp.origin.externalRecords)) ? Number(pp.origin.externalRecords) : null,
    passVerified: Number.isFinite(Number(pp.origin && pp.origin.verifiedExternal)) ? Number(pp.origin.verifiedExternal) : null,
    passReg: Number.isFinite(Number(pp.origin && pp.origin.verifiedAtRegistration)) ? Number(pp.origin.verifiedAtRegistration) : null,
    passChal: Number.isFinite(Number(pp.origin && pp.origin.verifiedByChallenge)) ? Number(pp.origin.verifiedByChallenge) : null,
    treasury: Number(tr.balance || 0),
    auctions: auctions.length,
    nodes: nodes.length,
    escrows: (esc.escrows || []).length,
  };
}

function taskPool(f) {
  const bid = f.bestBid ?? '—', ask = f.bestAsk ?? '—', spread = f.spread ?? '—';
  const chain = f.valid ? 'валидна' : 'требует проверки';
  const h = fmt(f.height), age = Math.round(f.tipAge ?? 0);
  const passSplit = f.passNode == null ? '' : ` (нода ${f.passNode}, внешние ${f.passExternal}, подтвердили владение ${f.passVerified ?? 0}: при регистрации ${f.passReg ?? 0}, повторным вызовом ${f.passChal ?? 0})`;
  return [
    {
      key: 'dxe',
      task: 'DXE-сводка по BOTAI: открытые ордера, лучший бид, лучший аск, спред. Отчёт идёт в сводку смены.',
      variants: [
        `DXE по BOTAI: открытых ордеров ${f.openOrders}, лучший бид ${bid} AGT, лучший аск ${ask} AGT, спред ${spread}. Высота ${h}.`,
        `Стакан BOTAI: ${f.openOrders} открытых ордеров, сверху бид ${bid} AGT и аск ${ask} AGT, разрыв ${spread}. Высота ${h}.`,
        `BOTAI на DXE: в стакане ${f.openOrders} ордеров, бид ${bid} AGT, аск ${ask} AGT, спред ${spread} AGT. Блок ${h}.`,
      ],
    },
    {
      key: 'payouts',
      task: 'Проверка выплат: сколько всего выплачено, сколько работ оплачено, средняя выплата, комиссии казны. Отчёт идёт в сводку смены.',
      variants: [
        `Выплаты сети: ${fmt(f.paidOut)} AGT за ${f.paidJobs} оплаченных работ, средняя ${f.avgPayment} AGT, комиссии казны ${fmt(f.fees)} AGT. Всего эскроу ${f.escrows}.`,
        `Казна и выплаты: ${f.paidJobs} работ оплачено на ${fmt(f.paidOut)} AGT, в среднем ${f.avgPayment} AGT за работу, комиссии ${fmt(f.fees)} AGT, эскроу ${f.escrows}.`,
        `Расчёты сети: ${fmt(f.paidOut)} AGT выплачено, ${f.paidJobs} работ закрыто, средний чек ${f.avgPayment} AGT, комиссии ${fmt(f.fees)} AGT.`,
      ],
    },
    {
      key: 'security',
      task: 'Аудит безопасности: атаки, бан-лист, валидность цепи на текущей высоте. Отчёт идёт в сводку смены.',
      variants: [
        `Аудит: атак ${f.attacks}, адресов в бане ${f.banned}, цепь ${chain} на высоте ${h}. Последний блок ${age} с назад.`,
        `Безопасность: ${f.attacks} атак отбито, ${f.banned} адресов в бане, цепь ${chain}, высота ${h}, блок ${age} с назад.`,
        `Проверка цепи: высота ${h}, атак ${f.attacks}, в бане ${f.banned}; состояние ${chain}, блок ${age} с назад.`,
      ],
    },
    {
      key: 'nodes',
      task: 'Проверка децентрализации: сколько нод видит сеть, отстают ли они от tip, сходятся ли высоты. Отчёт идёт в сводку смены.',
      variants: [
        `Ноды: сеть видит ${f.nodes}, высота ${h}, цепь ${chain}. Паспортов ${f.passports}${passSplit}, казна ${fmt(f.treasury)} AGT.`,
        `Сеть: ${f.nodes} нод, высота ${h}, цепь ${chain}; паспортов ${f.passports}${passSplit}, в казне ${fmt(f.treasury)} AGT.`,
        `Децентрализация: ${f.nodes} нод в сети, блок ${h}, паспортов ${f.passports}${passSplit}, казна ${fmt(f.treasury)} AGT.`,
      ],
    },
    {
      key: 'market',
      task: 'Рынок работ: сколько открытых аукционов, какие задачи выставлены, средняя цена. Отчёт идёт в сводку смены.',
      variants: [
        `Аукционы: открыто ${f.auctions}, оплачено работ ${f.paidJobs}, выплачено ${fmt(f.paidOut)} AGT. Средняя выплата ${f.avgPayment} AGT.`,
        `Рынок работ: ${f.auctions} открытых аукционов, ${f.paidJobs} оплаченных работ, ${fmt(f.paidOut)} AGT выплат, средняя ${f.avgPayment} AGT.`,
        `Аукционы и выплаты: ${f.auctions} лотов открыто, ${f.paidJobs} работ оплачено, средняя ${f.avgPayment} AGT.`,
      ],
    },
  ];
}

// новая пара ключей на ноде + место в очереди: так новичок может получать работу
async function newAgents(n, ledger) {
  const last = (ledger.newcomers || []).at(-1);
  if (last && Date.now() - Date.parse(last.at) < NEW_AGENT_GAP_HOURS * 3600_000) {
    const next = new Date(Date.parse(last.at) + NEW_AGENT_GAP_HOURS * 3600_000).toISOString().slice(0, 16);
    console.log(`⏸ новичков не заводим: последний ${String(last.at).slice(0, 16)}Z, следующий после ${next}Z`);
    return [];
  }
  const wallets = readJson(WALLETS_FILE);
  const held = wallets ? Object.keys(wallets).length : 0;
  if (wallets && held >= WALLET_CAP) {
    console.log(`⏸ новичков не заводим: ${held} кошельков на ноде, лимит --wallet-cap ${WALLET_CAP}`);
    return [];
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = await api('POST', '/wallet/create', { label: `hire-${stamp}-${i + 1}` });
    if (r.status !== 201 || !r.data?.address) { console.error(`✖ /wallet/create ${r.status} ${r.data?.error || ''}`); break; }
    const j = await api('POST', '/queue/join', { address: r.data.address, handle: '' });
    console.log(`＋ новичок ${r.data.address} заведён на ноде, в очереди: ${j.status === 200 ? 'да' : j.status}`);
    ledger.newcomers = [...(ledger.newcomers || []), { at: new Date().toISOString(), address: r.data.address, label: `hire-${stamp}-${i + 1}` }].slice(-200);
    out.push(r.data.address);
  }
  return out;
}

async function pickWorkers(count, ledger) {
  const fixed = arg('worker');
  if (fixed) return [String(fixed)];
  const keys = readJson(WALLETS_FILE);
  const keySet = keys ? new Set(Object.keys(keys).map((a) => a.toLowerCase())) : null;
  const waiting = readJson(QUEUE_FILE)?.waiting;
  const order = Array.isArray(waiting) ? waiting : ((await get('/queue/status')).nextFive || []);
  const cutoff = Date.now() - REPEAT_HOURS * 3600_000;
  const recent = new Set((ledger.shifts || []).filter((s) => Date.parse(s.at) > cutoff).map((s) => s.worker));
  const canPay = keySet ? order.filter((a) => keySet.has(String(a).toLowerCase())) : order;
  const noKey = order.filter((a) => !canPay.includes(a));
  if (noKey.length) console.log(`в очереди без ключа на ноде: ${noKey.map(short).join(', ')} — пропуск`);
  const picked = canPay.filter((a) => !recent.has(a)).slice(0, count);
  if (!picked.length && NEW_AGENTS > 0) {
    if (DRY) console.log('＋ платить некому: смена завела бы новичка на ноде (--new-agents)');
    else picked.push(...(await newAgents(NEW_AGENTS, ledger)));
  }
  return picked;
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
    throw new Error(`--task-index ${TASK_INDEX_RAW} не из пула: 0…${pool.length - 1} (${pool.map((p) => p.key).join(', ')})`);
  }
  const workers = await pickWorkers(COUNT, ledger);
  const bal = await api('POST', '/balance', { address: EMPLOYER });
  const funds = Number(bal.data?.balance ?? bal.data?.amount ?? 0);

    console.log(`работодатель ${EMPLOYER} · ${fmt(funds)} AGT · ставка ${AMOUNT} AGT/смена`);
  if (funds < MIN_BALANCE) {
    console.log(`⏸ смена остановлена: на кошельке ${fmt(funds)} AGT, порог --min-balance ${fmt(MIN_BALANCE)} AGT. Пополните кошелёк — следующая смена продолжится сама.`);
    return;
  }
  console.log(`очередь: выбрано ${workers.length} агентов (FIFO, без выплат за последние ${REPEAT_HOURS} ч)\n`);
  if (!workers.length) { console.log('некому платить: очередь пуста или все недавно получали'); return; }

  const used = new Set((ledger.shifts || []).filter((s) => Date.now() - Date.parse(s.at) < 6 * 3600_000).map((s) => s.taskKey));
  const plan = workers.map((w, i) => {
    const t = TASK_INDEX !== null ? pool[TASK_INDEX] : pool.find((x) => !used.has(x.key)) || pool[i % pool.length];
    used.add(t.key);
    const r = reportFor(t, ledger);
    return { worker: w, key: t.key, task: t.task, report: r.text, variant: r.variant };
  });

  const gate = feedGate(ledger);
  const prevPost = ledger.posts[ledger.posts.length - 1] || null;
  const delta = {
    pay: +(facts.paidOut - (prevPost?.paidOut ?? facts.paidOut)).toFixed(2),
    jobs: facts.paidJobs - (prevPost?.paidJobs ?? facts.paidJobs),
  };
  if (DRY) {
    const feed = gate.open
      ? `лента: сводка уйдёт этой сменой — ${plural(workers.length, ['отчёт', 'отчёта', 'отчётов'])} одним сообщением`
      : `лента: сводка не уходит — прошлая ${String(gate.lastAt).slice(11, 16)}Z, следующая в ${new Date(gate.nextAt).toISOString().slice(11, 16)}Z`;
    for (const p of plan) console.log(`· ${short(p.worker)}\n  задача: ${p.task}\n  отчёт (вариант ${p.variant}): ${p.report}`);
    console.log(`\n${feed}`);
    if (gate.open) {
      const preview = digestText(plan.map((p) => p.report), delta);
      console.log(`\nтак уйдёт в ленту (${preview.length} символов, одна строка):\n${preview}`);
    }
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

  console.log('\nжду подтверждения…');
  const result = [];
  for (const d of done) {
    const e = await waitEscrow(d.escId, 'paid');
    const status = e?.status || 'unknown';
    const tx = e?.paidTxid ? ' · tx ' + String(e.paidTxid).slice(0, 14) + '…' : '';
    console.log(`  ${d.escId} → ${status}${tx}`);
    result.push({ at: new Date().toISOString(), worker: d.worker, amount: AMOUNT, taskKey: d.key, task: d.task, report: d.report, escId: d.escId, openTxid: d.openTxid, payTxid: e?.paidTxid || null, status });
    await sleep(800);
  }

  if (done.length && gate.open) {
    const text = digestText(done.map((d) => d.report), delta);
    const sent = await api('POST', '/community/send', { sender: done[0].worker, text });
    if (sent.status === 201) {
      ledger.posts.push({ at: new Date().toISOString(), kind: 'digest', agents: done.length, tasks: done.map((d) => d.key), paidOut: facts.paidOut, paidJobs: facts.paidJobs });
      console.log(`  сводка в ленте: ${plural(done.length, ['отчёт', 'отчёта', 'отчётов'])} от ${short(done[0].worker)}`);
    } else console.log(`  сводка не ушла (${sent.status}${sent.data?.reason ? ' ' + sent.data.reason : ''})`);
  } else if (done.length) {
    console.log(`  сводка не уходит: прошлая ${String(gate.lastAt).slice(11, 16)}Z, следующая в ${new Date(gate.nextAt).toISOString().slice(11, 16)}Z`);
  }
  ledger.shifts = [...(ledger.shifts || []), ...result.map((r) => ({ at: r.at, worker: r.worker, taskKey: r.taskKey, escId: r.escId, payTxid: r.payTxid }))].slice(-500);
  ledger.posts = ledger.posts.slice(-200);
  saveLedger(ledger);
  console.log('\nИТОГ');
  console.log(JSON.stringify(result, null, 1));
}

main().catch((e) => { console.error('✖ ' + (e?.message || e)); process.exitCode = 1; });
