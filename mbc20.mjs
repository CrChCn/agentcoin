// ============================================================
// MBC-20 ЗАВОД — биржа токенов Moltbook на AGT (AGIP-15, шаг 1)
// Идея Бати: сначала свои токены ($DEEPSEEK/$BOTAI/$BITCOIN),
// пары к магентам (MGNT = 1e-9 AGT) на готовой DXE-механике:
// ордер сохраняется как обычный ончейн tx с memo dxe|O|<side>|
// mbc20:<TICK>|<qty>|<price>|<ref8> — книга выводится ДЕТЕНИР-
// ИРОВАННО из цепи (как у DXE), никаких state-файлов.
// Реанимация чужих мёртвых токенов (шаг 2): заявка claim —
// нужен паспорт (POST /passport/issue + tax) + fee в казну.
// Реестр инскрипций MBC-20 живёт в data/mbc20.json (лонг-хвост).
// ============================================================
'use strict';
import fs from 'node:fs';
import path from 'node:path';

const REG_FEE_AGENT = 5;   // регистрация нового токена на бирже (fee в казну, AGT)
const REVIVE_FEE    = 25;  // реанимация мёртвого чужого тикера (fee в казну, AGT)
const CLAIM_WINDOW_DAYS = 90;

// — наши задеплоенные на Moltbook токены (у этого оператора) —
const SEEDS = [
  { tick: 'DEEPSEEK', deployedAt: '2026-02-14', max: '21000000', lim: '1000', minted: 7000 },
  { tick: 'BOTAI',    deployedAt: '2026-02-15', max: '21000000', lim: '1000', minted: 2000 },
  { tick: 'BITCOIN',  deployedAt: '2026-02-15', max: '21000000', lim: '1', minted: 3 },
  { tick: 'CRCHCN',   deployedAt: '2026-03-01', max: '21000000', lim: '1000', minted: 24000, note: 'личный, активный — не под реанимацией' },
];
// MetaMask-линки оператора (исторические, из линк-инскрипций фев 2026)
const SEED_WALLETS = ['0x43f46e236F581474Fa31Ee95aE7033d9fEb60cda', '0x57b35fCc8c452fA8a1BfdA2C3441E7a50D530eab'];

export class Mbc20Registry {
  constructor(dataFile, { treasuryAddr, chainHeight } = {}) {
    this.file = dataFile;
    this.treasuryAddr = treasuryAddr || null;
    this.tokens = new Map();   // tick → { tick, status, owner, deployedAt, minted, wallets[], passport, proven, claimedBy, claims[] }
    this.requests = [];        // заявки на регистрацию/реанимацию
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const t of (j.tokens || [])) this.tokens.set(t.tick, t);
      this.requests = j.requests || [];
    } catch {}
    for (const s of SEEDS) if (!this.tokens.has(s.tick)) this.tokens.set(s.tick, {
      ...s, status: 'listed', source: 'operator-seed', owner: 'AGT-ops (CrChCnBot)', wallets: [...SEED_WALLETS],
      passport: true, proven: true, claimedBy: null, claims: [], listingFeePaid: 0, height: chainHeight?.() || 0,
    });
    this.persist();
  }
  persist() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ tokens: [...this.tokens.values()], requests: this.requests.slice(-500) }, null, 2));
    } catch {}
  }// — Защита от «один скупил всё» (расчёт на будущее): —
// 1) один ордер ≤ MAX_ORDER_PCT минта;
// 2) весь visible ask-стакан ≤ MAX_TOTAL_ASK_PCT минта (стакан нельзя «закупить нацело»);
// 3) один покупатель накопленно ≤ MAX_BUYER_PCT минта (пер-адресный лимит на филлы).
  static MAX_ORDER_PCT     = 0.20; // один ордер ≤ 20% минта
  static MAX_TOTAL_ASK_PCT = 0.40; // весь ask-стакан ≤ 40% минта
  static MAX_BUYER_PCT     = 0.30; // один покупатель ≤ 30% минта (cumulative по всем филлам)

  // — Конфиг ордерной лестницы (расчёт на будущее): —
  // data/mbc20-ladder.json → { default: {...}, pairs: { TICK: {...} } }.
  // Поля: anchor (якорная цена AGT/шт), askStep/bidStep (шаг уровня), levels,
  // qtyPerLevel (или qtyPctOfLimit — доля от per-order лимита), maxDepthPct (доля минта).
  static LADDER_DEFAULTS = {
    levels: 5,
    qtyPctOfLimit: 0.25,          // каждый уровень = 25% от max ордера
    askStepPct: 0.6,              // шаг asks = 60% от якорной цены
    bidStepPct: 0.3,              // шаг bids = 30% (к bid-лестнице плотнее)
    anchorOffsetPct: 0.5,         // якорь asks = bestAsk*?; если книги нет — anchor из конфига
  };

  qtyLimitFor(tick) {
    const t = this.tokens.get(String(tick).toUpperCase().slice(0, 8));
    if (!t || t.minted == null) return null;   // не знаем supply — без лимита (реанимируемые док-токены)
    return Math.max(1, Math.floor(t.minted * Mbc20Registry.MAX_ORDER_PCT));
  }
  // supply тикера (или null, если неизвестен)
  mintedOf(tick) {
    const t = this.tokens.get(String(tick).toUpperCase().slice(0, 8));
    return t && t.minted != null ? Number(t.minted) : null;
  }
  checkTradeSize(tick, qty, bookAskRemaining) {
    const lim = this.qtyLimitFor(tick);
    if (lim != null && qty > lim) return { ok: false, error: 'order_too_big', limit: lim, pct: Mbc20Registry.MAX_ORDER_PCT, note: 'одним куском нельзя скупить экономику — дроби по лестнице' };
    if (bookAskRemaining != null) {
      return { ok: true }; // глубина проверяется отдельно в node.mjs (диапазон ордеров ≤ total visible)
    }
    return { ok: true };
  }
  // Весь visible ask-стакан + новый ордер ≤ MAX_TOTAL_ASK_PCT минта (заменяет bookAskRemaining-заглушку выше)
  checkAskDepth(tick, addQty, totalVisibleAskQty) {
    const minted = this.mintedOf(tick);
    if (minted == null) return { ok: true };
    const cap = Math.max(1, Math.floor(minted * Mbc20Registry.MAX_TOTAL_ASK_PCT));
    const total = Number(totalVisibleAskQty || 0) + Number(addQty || 0);
    if (total > cap) return { ok: false, error: 'ask_depth_cap', cap, total, maxTotalAskPct: Mbc20Registry.MAX_TOTAL_ASK_PCT, note: 'ask-стакан не может превысить ' + Mbc20Registry.MAX_TOTAL_ASK_PCT * 100 + '% минта — иначе один сайд скупает весь float' };
    return { ok: true, cap, total };
  }
  // Один покупатель накопленно (по всем филлам тикера) + новый филл ≤ MAX_BUYER_PCT минта
  checkBuyerSize(tick, buyerCumulativeQty, addQty) {
    const minted = this.mintedOf(tick);
    if (minted == null) return { ok: true };
    const cap = Math.max(1, Math.floor(minted * Mbc20Registry.MAX_BUYER_PCT));
    const total = Number(buyerCumulativeQty || 0) + Number(addQty || 0);
    if (total > cap) return { ok: false, error: 'buyer_cap', cap, buyerTotal: total, maxBuyerPct: Mbc20Registry.MAX_BUYER_PCT, note: 'один покупатель не может накопить >' + Mbc20Registry.MAX_BUYER_PCT * 100 + '% минта — рынок остаётся распределённым' };
    return { ok: true, cap, total };
  }

  // — Ордерная лестница (bot-мейкер v2): план мелких ордеров вокруг якорной цены. —
  // Чистая функция: (tick, refPrice, cfg) → { bids: [{price, qty}], asks: [{price, qty}] }.
  // Каждый уровень ≤ per-order лимита; весь ask-план ≤ MAX_TOTAL_ASK_PCT минта.
  ladderPlan(tick, refPrice, cfg = {}) {
    tick = String(tick).toUpperCase().slice(0, 8);
    const C = { ...Mbc20Registry.LADDER_DEFAULTS, ...cfg };
    const lim = this.qtyLimitFor(tick);
    const minted = this.mintedOf(tick);
    if (!refPrice || !isFinite(refPrice) || refPrice <= 0) return { ok: false, error: 'no_ref_price', note: 'укажи anchor в конфиге пары — книга пуста' };
    const levels = Math.max(1, Math.min(Number(C.levels) || 5, 12));
    const askStep = Math.max(1e-9, Number(C.askStep) || Number(refPrice) * Number(C.askStepPct ?? 0.6));
    const bidStep = Math.max(1e-9, Number(C.bidStep) || Number(refPrice) * Number(C.bidStepPct ?? 0.3));
    let qty = Number(C.qtyPerLevel) || (lim != null ? Math.max(1, Math.floor(lim * Number(C.qtyPctOfLimit ?? 0.25))) : 10);
    // ask-план целиком ≤ MAX_TOTAL_ASK_PCT минта
    if (minted != null) {
      const cap = Math.max(1, Math.floor(minted * Mbc20Registry.MAX_TOTAL_ASK_PCT));
      if (qty * levels > cap) qty = Math.max(1, Math.floor(cap / levels));
    }
    if (lim != null && qty > lim) qty = lim;
    const asks = [], bids = [];
    for (let i = 0; i < levels; i++) {
      const ap = +(Number(refPrice) + askStep * (i + 1)).toFixed(9);
      const bp = +(Number(refPrice) - bidStep * (i + 1)).toFixed(9);
      if (ap > 0) asks.push({ price: ap, qty });
      if (bp > 0) bids.push({ price: bp, qty });
    }
    return { ok: true, tick, refPrice: Number(refPrice), levels, qtyPerLevel: qty, askStep, bidStep, asks, bids, limits: { maxOrderPct: Mbc20Registry.MAX_ORDER_PCT, maxTotalAskPct: Mbc20Registry.MAX_TOTAL_ASK_PCT, maxBuyerPct: Mbc20Registry.MAX_BUYER_PCT } };
  }
  // Читает конфиг лестницы с диска (создаётся bot-мейкером; отсутствует → дефолты)
  ladderConfig() {
    try {
      const cfgFile = path.join(path.dirname(this.file), 'mbc20-ladder.json');
      return JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch { return { pairs: {} }; }
  }

  state() {
    const list = [...this.tokens.values()].map(t => ({ ...t }));
    return {
      standard: 'MBC-20 → AGT wrap (AGIP-15)',
      baseUnit: 'MGNT (1e-9 AGT)',
      feeRegister: REG_FEE_AGENT, feeRevive: REVIVE_FEE, claimWindowDays: CLAIM_WINDOW_DAYS,
      tradeLimits: { maxOrderPct: Mbc20Registry.MAX_ORDER_PCT, maxTotalAskPct: Mbc20Registry.MAX_TOTAL_ASK_PCT, maxBuyerPct: Mbc20Registry.MAX_BUYER_PCT },
      tokens: list.sort((a, b) => (b.minted || 0) - (a.minted || 0)),
      prices: { DEEPSEEK: null, BOTAI: null, BITCOIN: null }, // заполняется из DXE bestBid при /book
      note: 'торговля: пары mbc20:<TICK> на DXE-книге, расчёт магентами; реанимация — с паспортом + fee',
    };
  }
  // заявка на реанимацию чужого мёртвого тикера
  reviveRequest(tick, requesterAddress, evidenceUrl, passportOk) {
    tick = String(tick || '').toUpperCase().slice(0, 8);
    if (!/^[A-Z1-9][A-Z0-9]{1,7}$/.test(tick)) return { ok: false, error: 'bad_tick' };
    if (!requesterAddress) return { ok: false, error: 'need_address' };
    if (!passportOk) return { ok: false, error: 'need_passport_issue_and_tax_first' };
    if (this.tokens.has(tick)) return { ok: false, error: this.tokens.get(tick).status === 'listed' ? 'tick_already_listed' : 'tick_pending' };
    const req = {
      id: Math.random().toString(36).slice(2, 10).padEnd(8, '0'),
      tick, requester: requesterAddress, evidence: String(evidenceUrl || '').slice(0, 400),
      passportOk, status: 'pending_payment', fee: REVIVE_FEE,
      at: new Date().toISOString(),
    };
    this.requests.push(req);
    this.persist();
    return { ok: true, request: req, next: `оплати ${REVIVE_FEE} AGT на казну memo mbc20|R|${req.id}` };
  }
  markPaid(reqId, txid) {
    const r = this.requests.find(x => x.id === reqId);
    if (!r) return { ok: false, error: 'no_such_request' };
    if (r.status === 'paid') return { ok: false, error: 'already_paid' };
    r.status = 'paid'; r.txid = txid || 'manual';
    // статус токена
    this.tokens.set(r.tick, {
      tick: r.tick, status: 'pending_claim_window', source: 'revive',
      requester: r.requester, passport: true, proven: false, minted: null,
      claimWindowDays: CLAIM_WINDOW_DAYS,
      openedAt: new Date().toISOString(),
      height: null, claims: [], wallets: [],
    });
    this.persist();
    return { ok: true, tick: r.tick, windowDays: CLAIM_WINDOW_DAYS, next: 'ждём доказательства инскрипций или окно 90 дней' };
  }
}
