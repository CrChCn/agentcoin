#!/usr/bin/env node
/* ============================================================
   БОТ-МЕЙКЕР MBC-20 v2 — ОРДЕРНАЯ ЛЕСТНИЦА (AGIP-15, шаг «защита»)
   Проблема v1: один ордер на 1000 токенов → покупатель с 10 AGT
   скупал весь стакан, торговать становилось нечем.
   Решение v2: вместо одного жирного ордера — лестница мелких
   по уровням цен (asks выше якоря, bids ниже). «Купить всё»
   теперь стоит дороже и разъезжает цену по лестнице вверх.
   Плюс серверные лимиты биржи (node.mjs + mbc20.mjs):
     • один ордер ≤ 20% минта;
     • весь visible ask-стакан ≤ 40% минта;
     • один покупатель ≤ 30% минта (cumulative по филлам).

   Конфиг: data/mbc20-ladder.json (создаётся при первом запуске).
   Режимы:
     node mbc20-botmaker.mjs [--dry] [--replace] [--daemon]
       --dry     только показать план, ничего не ставить
       --replace снести СВОИ старые ордера пары и поставить лестницу заново
       --daemon  фоновый ребаланс каждые AGT_M20_REBAL_MS (по умолчанию 10 мин)
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mbc20Registry } from './mbc20.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.env.AGT_NODE_URL || 'http://127.0.0.1:9335'; // главная нода (кошелёк makerа должен жить на ней)
const MAKER = process.env.AGT_M20_MAKER || 'AGTcbe364d730586ac6c6908dc79dadf5e66bc6f788'; // ops-jobs-employer
const REBAL_MS = Number(process.env.AGT_M20_REBAL_MS || 10 * 60 * 1000);
const CFG_FILE = path.join(__dirname, 'data', 'mbc20-ladder.json');

const DRY = process.argv.includes('--dry');
const REPLACE = process.argv.includes('--replace');
const DAEMON = process.argv.includes('--daemon');

const DEFAULT_CFG = {
  note: 'лестница bot-мейкера MBC-20 (расчёт на будущее): anchor=якорная цена AGT/шт, askStep/bidStep=шаг уровня, levels=уровней с каждой стороны; qty считается от per-order лимита биржи (20% минта) × qtyPctOfLimit',
  maker: MAKER,
  default: { levels: 5, qtyPctOfLimit: 0.25 },
  pairs: {
    DEEPSEEK: { anchor: 0.003, askStep: 0.002, bidStep: 0.001, levels: 5 },
    BOTAI:    { anchor: 0.006, askStep: 0.004, bidStep: 0.002, levels: 5 },
    BITCOIN:  { anchor: 0.05,  askStep: 0.05,  bidStep: 0.02,  levels: 3 },
    CRCHCN:   { anchor: 0.012, askStep: 0.01,  bidStep: 0.005, levels: 5 },
  },
};

function log(m) { console.log(`[botmaker ${new Date().toISOString().slice(11, 19)}] ${m}`); }
function sleep(ms) { return new Promise(s => setTimeout(s, ms)); }

async function api(method, p, body = null) {
  // 503 overloaded — нода занята: ретрай с backoff (до 6 попыток)
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(NODE + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 503 || attempt >= 6) return { status: r.status, ...j };
    log(`${p} → 503 overloaded, ретрай ${attempt + 1}/6 через ${3 + attempt * 2}s`);
    await sleep((3 + attempt * 2) * 1000);
  }
}

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); }
  catch {
    fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
    fs.writeFileSync(CFG_FILE, JSON.stringify(DEFAULT_CFG, null, 2));
    log('конфиг не найден — создан дефолтный ' + CFG_FILE);
    return DEFAULT_CFG;
  }
}

// — одна пара: снести свои (--replace), поставить недостающие уровни лестницы —
async function doPair(reg, tick, pairCfg, globalCfg) {
  const C = { ...(globalCfg.default || {}), ...(pairCfg || {}) };
  const book = await api('GET', '/mbc20/book?tick=' + tick);
  const bids = book.bids || [], asks = book.asks || [];
  const mineOpen = [...bids, ...asks].filter(o => o.maker === MAKER);

  if (DRY) {
    const st = reg.state();
    const t = st.tokens.find(x => x.tick === tick);
    const plan = reg.ladderPlan(tick, C.anchor, C);
    console.log(`[dry] ${tick}: anchor=${C.anchor} уровень=${plan.ok ? plan.qtyPerLevel : '—'} ордера свои: ${mineOpen.length} (bid ${bids.length}/ask ${asks.length})`);
    if (plan.ok) {
      console.log('      asks:', plan.asks.map(a => `${a.price}×${a.qty}`).join('  '));
      console.log('      bids:', plan.bids.map(b => `${b.price}×${b.qty}`).join('  '));
    } else console.log('      план: ' + plan.error);
    return { tick, placed: 0, dry: true };
  }

  if (REPLACE && mineOpen.length) {
    log(`${tick}: снос ${mineOpen.length} своих ордеров (--replace)…`);
    for (const o of mineOpen) {
      const r = await api('POST', '/dxe/cancel', { maker: MAKER, ref: o.ref });
      if (r.status === 201) log(`  cancel ${o.ref} ok`);
      else log(`  cancel ${o.ref}: ${r.status} ${JSON.stringify(r).slice(0, 120)}`);
    }
    // ждём, пока отмена упакуется в блок (книга = чистая функция цепи)
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const b = await api('GET', '/mbc20/book?tick=' + tick);
      const still = [...(b.bids || []), ...(b.asks || [])].filter(o => o.maker === MAKER && o.remaining > 0);
      if (!still.length) break;
      if (i % 6 === 5) log(`${tick}: ещё ${still.length} своих ордеров в книге — ждём майнинг…`);
    }
  }

  const refPrice = Number(C.anchor) || book.bestAsk || book.bestBid || null;
  const plan = reg.ladderPlan(tick, refPrice, C);
  if (!plan.ok) { log(`${tick}: план не собран — ${plan.error}`); return { tick, placed: 0, error: plan.error }; }

  let placed = 0, skipped = 0, rejected = 0;
  const sides = [['b', plan.bids], ['s', plan.asks]];
  for (const [side, levels] of sides) {
    for (const lv of levels) {
      // уже стоит свой ордер на этой цене с достаточным остатком?
      const mine = (side === 'b' ? bids : asks).filter(o => o.maker === MAKER);
      const dup = mine.find(o => Number(o.price) === lv.price && o.remaining >= lv.qty * 0.99);
      if (dup) { skipped++; continue; }
      const r = await api('POST', '/dxe/order', { maker: MAKER, side, item: 'mbc20:' + tick, qty: lv.qty, price: lv.price });
      if (r.status === 201) { placed++; log(`${tick} ${side === 'b' ? 'bid' : 'ask'} ${lv.price} × ${lv.qty} → ref ${r.ref}`); }
      else { rejected++; log(`${tick} ${side === 'b' ? 'bid' : 'ask'} ${lv.price} × ${lv.qty} ОТКАЗ: ${JSON.stringify(r).slice(0, 160)}`); }
    }
  }
  log(`${tick}: поставлено ${placed}, уже стояло ${skipped}, отказов ${rejected} (лимиты биржи работают)`);
  return { tick, placed, skipped, rejected };
}

async function cycle(reg, cfg) {
  const pairs = Object.entries(cfg.pairs || {});
  const out = [];
  for (const [tick, pc] of pairs) {
    try { out.push(await doPair(reg, tick, pc, cfg)); }
    catch (e) { log(`${tick}: ошибка ${e.message}`); out.push({ tick, error: e.message }); }
  }
  return out;
}

async function main() {
  const cfg = loadCfg();
  const reg = new Mbc20Registry(path.join(__dirname, 'data', 'mbc20.json'));
  const maker = cfg.maker || MAKER;
  log(`нодa ${NODE} · maker ${maker} · режим ${DRY ? 'DRY' : DAEMON ? 'DAEMON (ребаланс ' + REBAL_MS / 1000 + 's)' : 'one-shot'}${REPLACE ? ' +REPLACE' : ''}`);
  if (DRY) { await cycle(reg, cfg); return; }
  await cycle(reg, cfg);
  if (DAEMON) {
    setInterval(() => { cycle(reg, cfg).catch(e => log('cycle error: ' + e.message)); }, REBAL_MS).unref();
    log('daemon: ребаланс каждые ' + REBAL_MS / 1000 + 's — лестница сама достроится, если филлы её проредили');
    setInterval(() => {}, 1 << 30); // держать процесс живым
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
