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
  }
  state() {
    const list = [...this.tokens.values()].map(t => ({ ...t }));
    return {
      standard: 'MBC-20 → AGT wrap (AGIP-15)',
      baseUnit: 'MGNT (1e-9 AGT)',
      feeRegister: REG_FEE_AGENT, feeRevive: REVIVE_FEE, claimWindowDays: CLAIM_WINDOW_DAYS,
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
