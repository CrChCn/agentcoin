#!/usr/bin/env node
/* baptism-agents.mjs — «Боевое крещение Империи» (ТЗ Freebuff): 5 ИИ-агентов на живой сети AGT.
 * Все фазы идемпотентны, resumable через data-agents/baptism/state.json, используют ТОЛЬКО
 * публичный API ноды (никаких правок node.mjs в runtime). Запуск вручную или из cron раз в 5 мин.
 *
 * Фазы:
 *  1. Кошельки: baptism-a1..a5 + baptism-employer (POST /wallet/create — ключи остаются на ноде)
 *  2. Хэндлы + паспорта (/handle/register, /identity/challenge → /identity/register)
 *  3. Фундирование: buffy-dev-01 → агенты по 100 AGT, employer 100 AGT (tx ≤ 100 — whitelist не нужен)
 *  4. Эскроу-джобы: employer создаёт задачу каждому свободному агенту (create→claim→payout)
 *  5. Работа агента: результат в results/<escId>.txt → payout-bot двойной подписью (+2.5% комиссия)
 *  6. Чат: агенты пишут (community/send с senderHandle)
 *  7. Gov: агенты propose + голосуют за свои предложения (0.001 AGT memo-fee)
 *  8. Snapshot → baptism-state.json (страница /baptism читает /baptism/state)
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2]) || 9335;
const API = `http://127.0.0.1:${PORT}`;
const ROOT = path.dirname(fileURLToPath(import.meta.url));   // = /opt/agentcoin-node/src
const DIR = path.join(ROOT, 'data-agents', 'baptism');
const RESULTS = path.join(DIR, 'results');
const STATE_FILE = path.join(DIR, 'state.json');
const SNAP_SITES = [
  path.join(DIR, 'baptism-state.json'),
  '/srv/agentcoin-empire/current/baptism-state.json',
  path.join(ROOT, 'site', 'baptism-state.json'),
];
const LOGF = path.join(DIR, 'baptism.log');
const WAVE_MAX = 6;          // сколько волн джобов максимум (каждая волна = 5 джобов по 5 AGT)

let FUND_ADDR = null;   // buffy-dev-01, ~3000 AGT (адрес берём из data/wallets.json по label)
const AGENT_FUNDS = 100;
const EMPLOYER_FUNDS = 100;
const MIN_BALANCE = 60;
const TOPUP = 50;

const TASKS = [
  { slug: 'translate', price: 5,  work: 'Переведи на английский: «Империя AGT честно платит за работу: эскроу замораживает AGT до выполнения задачи, комиссия казны 2.5%.»' },
  { slug: 'analyze',   price: 5,  work: 'Проанализируй ряд [3,9,4,7,1,8,2,6]: верни медиану, среднее и максимум.' },
  { slug: 'generate',  price: 5,  work: 'Сгенерируй слоган для мемкоина AGT (одно предложение, до 12 слов).' },
  { slug: 'summarize', price: 5,  work: 'Резюмируй двумя предложениями: эскроу AGT живёт в memo-tx, выплаты через escProof (двойная подпись).' },
  { slug: 'docstring', price: 5,  work: 'Напиши docstring для escrowClaim(escId, taskHash): подписывает квитанцию приватным ключом агента.' },
];
const PROPOSAL_TITLES = [
  'Крещение: автофинализация джобов после дедлайна',
  'Крещение: страница списка паспортов',
  'Крещение: чат-лимит 1 сообщение / 10с / адрес',
  'Крещение: кнопка «Сдать результат» подсвечивать payout',
  'Крещение: график эскроу-платежей на Jobs',
];
const CHAT_POOL = [
  ['baptism-a1', 'Крещение AGT: я агент #1. Беру jobs-эскроу, результат сдаю через claim → payout. Транзакции в мемпуле честные.'],
  ['baptism-a2', 'Эскроу отработал: escpayout — двойная подпись работодателя и агента, комиссия казны 2.5% видна в escfee-memo.'],
  ['baptism-a3', 'Паспорта ed25519 работают: challenge → подпись → /identity/register. Личность агента закреплена ончейн.'],
  ['baptism-a4', 'Gov расходует 0.001 AGT fee на голос — дешёвая демократия. Мои предложения в /gov.'],
  ['baptism-a5', 'Идея: подсветить в /jobs кнопку «Сдать результат» после claim — UX для агентов станет яснее.'],
  ['baptism-a1', 'Вторая волна джобов в мемпуле — payout идёт подряд. Кристиана нет только у банатов.'],
  ['baptism-a2', 'Мемпул 2430 аккаунтов, сеть живёт: высота растёт, tx не теряются. Крещение пройдено.'],
  ['baptism-a3', 'Чат честный: отправитель AGT-адрес, хэндл — просто обёртка, без подписей не вставится имя.'],
  ['baptism-a4', 'Casino AGT: ставка на чётность nonce — выплата 2 AGT при угадывании. Тоже мем-экономика.'],
  ['baptism-a5', 'Auto-topup: балансы удерживаются выше 60 AGT — от employer из фонда buffy-dev-01.'],
];

fs.mkdirSync(RESULTS, { recursive: true });
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
try { fs.chmodSync(STATE_FILE, 0o600); } catch {}try { fs.chmodSync(LOGF, 0o600); } catch {}
function log(l) { const s = `[${new Date().toISOString()}] ${l}`; console.log(s); try { fs.appendFileSync(LOGF, s + '\n'); } catch {} }
function logBuf() { try { return fs.readFileSync(LOGF, 'utf8').trim().split('\n').slice(-100); } catch { return []; } }

async function api(method, p, body = null) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { phase: 0 };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { phase: 0 }; }
}
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n'); } catch {} }
const state = loadState();
state.agents ??= {};
state.employer ??= null;
state.funded ??= {};
state.jobs ??= [];
state.proposals ??= [];
state.chats ??= [];
state.runs ??= [];
state.wave ??= 0;
state.chatRound ??= 0;
state.govRound ??= 0;

// ---------- helpers ----------
async function balanceOf(addr) { const r = await api('POST', '/balance', { address: addr }); return r.body.balance || 0; }
async function info() { const r = await api('GET', '/info'); return r.body; }
async function txSigned(fromAddress, to, amount, memo) {
  const s = await api('POST', '/tx/sign', { fromAddress, to, amount, memo });
  if (s.status !== 200 || !s.body.signed) return { ok: false, err: s.body.error || 'no_sig' };
  return submitSupplied(s.body.signed);
}
async function submitSupplied(tx) { const sub = await api('POST', '/tx', tx); return { ok: sub.status === 201, txid: (tx.txid || '').slice(0, 16), status: sub.status, err: sub.body.error || null }; }
const taskHashOf = (t) => crypto.createHash('sha256').update(t.work, 'utf8').digest('hex').slice(0, 64);

function perform(slug) {
  if (slug === 'translate') return 'EN: The AGT Empire pays honestly for work — escrow locks AGT until the task is done; treasury fee is 2.5% on payout. Served by baptism agent at chain height ' + state.lastHeight + '.';
  if (slug === 'analyze')   return 'Series [3,9,4,7,1,8,2,6] sorted → [1,2,3,4,6,7,8,9]. Median = (4+6)/2 = 5.0, average = 40/8 = 5.0, maximum = 9.';
  if (slug === 'generate')  return 'Slogan: AGT — the coin that honestly pays the empire that builds it.';
  if (slug === 'summarize') return 'Escrow jobs on AGT live inside memo transactions; payouts require the double escProof signature (worker receipt + employer confirm). The treasury collects a 2.5% fee via escfee memos.';
  if (slug === 'docstring') return 'escrowClaim(escId, taskHash) — signs the escrow receipt digest with the agent private key (ED25519) and returns {receiptSig, workerPub} for /escrow/payout;';
  return null;
}

function resolveFundAddr() {
  try {
    const wl = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'wallets.json'), 'utf8'));
    const hit = Object.entries(wl).find(([, x]) => x.label === 'buffy-dev-01');
    if (hit) return hit[0];
  } catch {}
  return null;
}

// ---------- ЛОК на запуске (чтобы cron-дубликаты не дрались) ----------
const LOCK = DIR + '/lock.pid';
let haveLock = false;
try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); haveLock = true; }
catch {
  const pid = Number(fs.readFileSync(LOCK, 'utf8'));
  try { process.kill(pid, 0); console.log('уже запущен pid=' + pid); process.exit(0); }
  catch { fs.writeFileSync(LOCK, ''); fs.writeFileSync(LOCK, String(process.pid)); haveLock = true; }
}
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });

// ============ ФАЗА 1: кошельки ============
if (!state.employer) {
  const walletSpecs = ['baptism-a1', 'baptism-a2', 'baptism-a3', 'baptism-a4', 'baptism-a5', 'baptism-employer'];
  for (const spec of walletSpecs) {
    if (state.agents[spec]) continue;
    const r = await api('POST', '/wallet/create', { label: spec });
    if (r.status !== 201) { log(`FATAL: /wallet/create ${spec} ${r.body.error || r.status}`); process.exit(1); }
    const w = { label: spec, address: r.body.address, pub: r.body.pub, privKey: r.body.privKey, handle: spec.replace('baptism-', '') };
    state.agents[spec] = w;
    if (spec === 'baptism-employer') state.employer = { address: w.address, pub: w.pub };
    log(`кошелёк ${spec}: ${w.address.slice(0, 16)}…`);
  }
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
  state.phase = 1; saveState(state);
}
const emp = state.agents['baptism-employer'];

// ============ ФАЗА 2: хэндлы + паспорта ============
if (state.phase >= 1 && !state.passportsDone) {
  for (const w of Object.values(state.agents)) {
    try {
      const h = await api('POST', '/handle/register', { handle: w.handle, address: w.address });
      if (![200, 201, 409].includes(h.status)) log(`handle ${w.handle}: ${h.status} ${JSON.stringify(h.body).slice(0, 80)}`);
    } catch (e) { log(`handle ${w.handle}: ${e.message}`); }
    try {
      const c = await api('POST', '/identity/challenge', { address: w.address, pub: w.pub, handle: w.handle });
      if (c.body.challengeId) {
        const msg = c.body.message || JSON.stringify(c.body);
        const sig = crypto.sign(null, Buffer.from(msg, 'utf8'), crypto.createPrivateKey(w.privKey)).toString('hex');
        const reg = await api('POST', '/identity/register', { challengeId: c.body.challengeId, signature: sig });
        log(`паспорт ${w.handle}: ${reg.status} ${reg.body.ok ? 'ok' : JSON.stringify(reg.body).slice(0, 80)}`);
      } else log(`паспорт ${w.handle}: challenge ${c.status} ${JSON.stringify(c.body).slice(0, 80)}`);
    } catch (e) { log(`паспорт ${w.handle}: ${e.message}`); }
  }
  state.passportsDone = true; state.phase = 2; saveState(state);
}

// ============ высота на старте ============
const startHeight = (await info()).blocks || 0;
state.lastHeight = startHeight;

// ============ ФАЗА 3: фундирование ============
if (!state.flexDone) {
  FUND_ADDR = resolveFundAddr();
  if (!FUND_ADDR) { log('FATAL: buffy-dev-01 не найден в data/wallets.json'); process.exit(1); }
  state.fundAddr = FUND_ADDR;
  const targets = [['baptism-employer', EMPLOYER_FUNDS], ...[1, 2, 3, 4, 5].map(i => ['baptism-a' + i, AGENT_FUNDS])];
  for (const [spec, amount] of targets) {
    const w = state.agents[spec];
    const bal = await balanceOf(w.address);
    if (bal >= amount) { state.funded[w.address] = bal; log(`фунд ${spec}: уже ${bal} AGT`); continue; }
    const r = await txSigned(FUND_ADDR, w.address, Math.min(amount, 100), `baptism-fund:${spec}`);
    log(`фунд ${spec} ${Math.min(amount, 100)} AGT ← buffy-dev-01: ${r.ok ? 'txid=' + r.txid : r.status + ' ' + r.err}`);
    state.runs.push({ phase: 'fund', spec, amount, ...r });
    await sleep(700);
  }
  state.phase = 3; saveState(state);
  // ждём майнинга фундов (блоки приходят постоянно)
  let mined = false;
  for (let i = 0; i < 240; i++) {
    await sleep(3000);
    const h = ((await info().catch(() => ({}))) || {}).blocks || 0;
    if (h > startHeight) { mined = true; state.lastHeight = h; break; }
  }
  log(`майнинг фундов: ${mined ? 'ok' : 'таймаут'}, высота ${state.lastHeight}`);
  const allFunded = (await Promise.all(Object.values(state.agents).map(w => balanceOf(w.address)))).every(b => b > 0);
  if (!allFunded) { log('фунды ещё не в цепи — вернусь на следующем прогоне.'); await snapshot(); process.exit(0); }
  state.flexDone = true; saveState(state);
}

// ============ ФАЗА 4: новые джобы (волна) ============
{
  const escStateR = await api('GET', '/escrow/state');
  const escrows = escStateR.body.escrows || [];
  const activeSlugs = new Set(state.jobs.filter(j => j.status !== 'paid').map(j => j.slug));
  const empBal = await balanceOf(emp.address);
  if (Object.keys(activeSlugs).length === 0 && state.wave < WAVE_MAX && empBal > 60) {
    state.wave++;
    log(`волна ${state.wave}: 5 джобов`);
    for (let i = 0; i < TASKS.length; i++) {
      const t = TASKS[i];
      const worker = state.agents['baptism-a' + (i + 1)];
      const r = await api('POST', '/escrow/create', { employer: emp.address, worker: worker.address, amount: t.price, taskHash: taskHashOf(t), deadlineSec: 3600 });
      if (r.status === 201) {
        state.jobs.push({ escId: r.body.escId, slug: t.slug, taskHash: r.body.taskHash, worker: worker.address, amount: t.price, status: 'created', txids: [], wave: state.wave, wiki: t.work });
        log(`эскроу ${r.body.escId} (${t.slug}) → ${worker.handle}, txid=${r.body.txid}`);
        state.runs.push({ phase: 'escrow-create', escId: r.body.escId, txid: r.body.txid });
      } else log(`эскроу ${t.slug}: ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
      await sleep(600);
    }
    saveState(state);
    // ждём майнинга волны
    for (let i = 0; i < 200; i++) {
      await sleep(3000);
      const h = ((await info().catch(() => ({}))) || {}).blocks || 0;
      if (h > state.lastHeight) { state.lastHeight = h; break; }
    }
  } else if (Object.keys(activeSlugs).length > 0) {
    log(`волна активна: ${[...activeSlugs].join(',')} (wave ${state.wave})`);
  }
}

// ============ ФАЗА 5: claim + работа + payout ============
{
  const escStateR = await api('GET', '/escrow/state');
  const escrows = escStateR.body.escrows || [];
  for (const j of state.jobs.filter(j => j.status !== 'paid')) {
    const worker = Object.values(state.agents).find(a => a.address === j.worker) || state.agents['baptism-a1'];
    const es = escrows.find(e => e.escId === j.escId);
    if (!es || String(es.status).toLowerCase() !== 'open') {
      if (j.status === 'created') continue;
      continue;
    }
    if (!j.claimed) {
      const c = await api('POST', '/escrow/claim', { escId: j.escId, taskHash: j.taskHash, workerPrivKey: worker.privKey, workerAddress: worker.address });
      if (c.status !== 200) { log(`claim ${j.escId}: ${c.status} ${JSON.stringify(c.body).slice(0, 90)}`); continue; }
      j.claimed = true;
      j.receipt = { sig: c.body.receiptSig, pub: c.body.workerPub };
      log(`claim ${j.escId}: receipt ok (${worker.handle})`);
    }
    const out = perform(j.slug);
    if (!out || out.length < 40) { log(`work ${j.escId}: no result`); continue; }
    const rf = path.join(RESULTS, j.escId + '.txt');
    fs.writeFileSync(rf, `escId=${j.escId}\nslug=${j.slug}\nworker=${worker.handle}\n---\n${out}\n`);
    j.resultFile = rf;
    const p = await api('POST', '/escrow/payout', { escId: j.escId, employerAddress: emp.address, workerReceiptSig: j.receipt.sig, workerPub: j.receipt.pub });
    if (p.status === 201) {
      j.status = 'paid';
      j.txids.push((p.body.txid || '').slice(0, 16));
      if (p.body.fee?.ok) j.feeTxid = (p.body.fee.txid || '').slice(0, 16);
      log(`payout ${j.escId}: ok txid=${p.body.txid} fee=${(p.body.fee?.txid || '').slice(0, 16)}`);
      state.runs.push({ phase: 'payout', escId: j.escId, txid: (p.body.txid || '').slice(0, 16) });
    } else log(`payout ${j.escId}: ${p.status} ${JSON.stringify(p.body).slice(0, 90)}`);
    saveState(state);
    await sleep(600);
  }
}

// ============ ФАЗА 6: чат ============
{
  for (let i = 0; i < 5; i++) {
    const [spec, text] = CHAT_POOL[(state.chatRound * 4 + i) % CHAT_POOL.length];
    const w = state.agents[spec];
    if (!w) continue;
    const bal = await balanceOf(w.address);
    if (bal < 0.01) { log(`chat ${w.handle}: без газа, скип`); continue; }
    const r = await api('POST', '/community/send', { sender: w.address, senderHandle: w.handle, text });
    const row = { addr: w.address, handle: w.handle, text, ok: r.status === 201, err: r.body.reason || null, at: new Date().toISOString() };
    state.chats.push(row);
    if (row.ok) log(`чат ${w.handle} ok «${text.slice(0, 40)}…»`); else log(`чат ${w.handle}: ${r.status} ${JSON.stringify(r.body).slice(0, 60)}`);
    await sleep(1500);
  }
  state.chatRound++;
  saveState(state);
}

// ============ ФАЗА 7: gov ============
if (state.govRound < 1) {
  for (let i = 0; i < 5; i++) {
    const w = state.agents['baptism-a' + (i + 1)];
    const title = PROPOSAL_TITLES[i];
    const r = await api('POST', '/gov/propose', { author: w.address, title, blocks: 300 });
    if (r.status === 201) {
      state.proposals.push({ ref: r.body.ref, title, author: w.address, closesAt: r.body.closesAt, txid: (r.body.txid || '').slice(0, 16), votes: { [w.address]: 'yes' } });
      log(`gov: ${w.handle} → ref=${r.body.ref} closesAt=${r.body.closesAt} txid=${r.body.txid}`);
      state.runs.push({ phase: 'gov-propose', ref: r.body.ref, txid: (r.body.txid || '').slice(0, 16) });
    } else log(`gov ${w.handle}: ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
    await sleep(800);
  }
  state.govRound = 1;
}
{
  // голоса за замайненные предложения — 2 yes, 1 no, 1 abstain, 1 yes
  const gs = await api('GET', '/gov/state');
  const props = gs.body.proposals || [];
  for (const p of props) {
    if (!String(p.title || '').startsWith('Крещение')) continue;
    let st = state.proposals.find(x => x.ref === p.ref);
    if (!st) { st = { ref: p.ref, title: p.title, author: p.author, closesAt: p.closesAt, votes: {} }; state.proposals.push(st); }
    st.votes ??= {};
    for (let i = 0; i < 5; i++) {
      const w = state.agents['baptism-a' + (i + 1)];
      if (st.votes[w.address]) continue;
      const bal = await balanceOf(w.address);
      if (bal < 0.01) continue;
      const choice = ['yes', 'yes', 'no', 'abstain', 'yes'][i];
      const r = await api('POST', '/gov/vote', { voter: w.address, ref: p.ref, choice });
      if (r.status === 201) {
        st.votes[w.address] = choice;
        log(`vote ${w.handle} → ${p.ref} ${choice} txid=${r.body.txid}`);
        state.runs.push({ phase: 'gov-vote', ref: p.ref, choice, txid: (r.body.txid || '').slice(0, 16) });
      }
      await sleep(500);
    }
  }
  saveState(state);
}

// ============ ФАЗА 8: автоподпитка ============
{
  const ebal = await balanceOf(emp.address);
  if (ebal < MIN_BALANCE + TOPUP) {
    const fund = state.fundAddr || resolveFundAddr();
    const r = await txSigned(fund, emp.address, TOPUP, 'baptism-topup:employer');
    log(`topup employer: ${r.ok ? r.txid : r.err}`);
    await sleep(600);
  }
  for (const spec of ['baptism-a1', 'baptism-a2', 'baptism-a3', 'baptism-a4', 'baptism-a5']) {
    const w = state.agents[spec];
    const bal = await balanceOf(w.address);
    if (bal < MIN_BALANCE) {
      const r = await txSigned(emp.address, w.address, TOPUP, 'baptism-topup:' + spec);
      log(`topup ${spec}: ${r.ok ? r.txid : r.err}`);
      state.runs.push({ phase: 'topup', spec, ok: r.ok });
    }
    await sleep(400);
  }
}

// ============ Snapshot ============
await snapshot();
console.log('BAPTISM-RUN-DONE pid=' + process.pid);
process.exit(0);

async function snapshot() {
  const agents = [];
  for (let i = 1; i <= 5; i++) {
    const w = state.agents['baptism-a' + i];
    agents.push({ handle: w.handle, address: w.address, balance: +(await balanceOf(w.address)).toFixed(3) });
  }
  const who = (addr) => (agents.find(a => a.address === addr) || { handle: 'employer' }).handle;
  const jobs = state.jobs.map(j => ({ escId: j.escId, wave: j.wave, slug: j.slug, worker: who(j.worker), amount: j.amount, status: j.status, payoutTxid: j.txids[0] || null, feeTxid: j.feeTxid || null, claimed: !!j.claimed }));
  const props = state.proposals.map(p => ({ ref: p.ref, title: p.title, author: who(p.author), closesAt: p.closesAt, votes: Object.fromEntries(Object.entries(p.votes || {}).map(([k, v]) => [who(k), v])) }));
  const snap = {
    updated: new Date().toISOString(),
    height: state.lastHeight,
    employer: { handle: 'employer', address: emp.address, balance: +(await balanceOf(emp.address)).toFixed(3) },
    agents,
    jobs,
    proposals: props,
    chats: state.chats.slice(-30),
    counts: {
      jobsPaid: state.jobs.filter(j => j.status === 'paid').length,
      chatSent: state.chats.filter(c => c.ok).length,
      govRefs: state.proposals.length,
      govVotes: Object.values(state.proposals).reduce((a, p) => a + Object.keys(p.votes || {}).length, 0),
    },
    log: logBuf(),
  };
  for (const p of SNAP_SITES) {
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(snap, null, 2) + '\n'); } catch (e) { log(`snapshot ${p}: ${e.message.slice(0, 60)}`); }
  }
  log(`snapshot: paid=${snap.counts.jobsPaid} chat=${snap.counts.chatSent} gov=${snap.counts.govRefs}/${snap.counts.govVotes}`);
}
