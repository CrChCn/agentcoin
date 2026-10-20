// wallet-api.mjs — кошелёк/кабинет AGENTCOIN: история операций и смета комиссий.
// Прочитано из сети AGIP-46 (сессия обязательна), read-only; транслирует только
// существующие /cabinet/op-* маршруты. Совместимость сети не меняется.
// Систематические единицы (AGIP-9): 1 AGT = 1e3 mAGT = 1e9 mGNT (магент).
// Казна (AGIP-4 + height-gating): правило «2 подписи» применяется только к блокам
// С ВЫСОТЫ активации политики (policy.effectiveFrom = closesAt + 1 из treasury.mjs).
// ИСТОРИЧЕСКИЕ tx до активации валидны одной подписью — ретроактивное 2-sig запрещено.
import { unitsOfAmountBigInt } from './core.mjs';

const ADDR_RE = /^AGT[0-9a-f]{40}$/;
const DEC_RE = /^(0|[1-9]\d*)(\.\d{1,9})?$/;
const MAX_LIMIT = 500;

// Классификация tx для истории кошелька. heightH — высота БЛОКА, содержащего tx.
export function classifyTx(tx, height, policy) {
  const t = { kind: 'transfer' };
  if (tx.from === 'COINBASE') t.kind = 'mining';
  else if (tx.to.startsWith('ESCROW_') || tx.from.startsWith('ESCROW_')) t.kind = 'escrow';
  else if (String(tx.memo || '').startsWith('tax:')) t.kind = 'tax';
  else if (String(tx.memo || '').startsWith('hop1→')) t.kind = 'gateway-leg1';
  else if (String(tx.memo || '').startsWith('hop2:')) t.kind = 'gateway-leg2';
  else if (String(tx.from || '').startsWith('AGENT_REWARD_POOL')) t.kind = 'system';
  if (policy && tx.from && tx.from === policy.treasury && t.kind === 'transfer') {
    t.kind = 'treasury';
    // Height-gating: 2-sig обязателен ЛИШЬ с активации политики. До effectiveFrom —
    // валидна ОДНА подпись; ретроактивное требование — баг strict-ревалидации, не сети.
    const active = Number(policy.effectiveFrom || 0) <= height;
    t.sig = active ? { required: policy.requires || 2, sig2Present: !!tx.sig2, activeAt: policy.effectiveFrom }
      : { required: 1, sig2Present: null, activeAt: policy.effectiveFrom, note: 'политика казны ещё не активна на этой высоте — 2-я подпись не требуется' };
  }
  return t;
}

function row(tx, block, address, policy) {
  const dir = tx.from === address ? (tx.to === address ? 'self' : 'out') : 'in';
  const cat = classifyTx(tx, Number(block.height) || Number(String(tx.nonce || 0)), policy) || {};
  const height = block.height || 0;
  const magents = unitsOfAmountBigIntSafe(tx);
  return {
    txid: typeof tx.txid === 'string' ? String(tx.txid).slice(0, 64) : null,
    height, dir, kind: cat.kind || 'transfer',
    from: tx.from, to: tx.to,
    amountAGT: tx.amount, amountMGNT: magents, amountMAGT: magToMAGT(magents),
    memo: typeof tx.memo === 'string' ? tx.memo.slice(0, 256) : '',
    ts: tx.ts || null,
    treasurySig: cat.sig || null,
    confirmations: block.confirmations ?? null,
    status: 'confirmed',
  };
}
function unitsOfAmountBigIntSafe(tx) { try { return Number(unitsOfAmountBigInt(tx.amount)); } catch { return null; } }
function magToMAGT(mgnt) { return mgnt === null ? null : Math.round((mgnt / 1e3) * 1e6) / 1e6; }

// GET/POST /cabinet/wallet/history — выписка пользователя по СВОЕЙ сессии, с пагинацией.
export function walletHistory(bc, cabinet, body) {
  const address = body.address, token = body.token;
  if (!cabinet.session(address, token)) return { status: 401, body: { error: 'session_invalid_or_foreign', hint: 'логинь заново' } };
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(body.limit) || 100));
  const before = body.beforeHeight === null || body.beforeHeight === undefined ? null : Number(body.beforeHeight);
  const chain = bc.chain;
  let start = before === null ? chain.length : Math.min(chain.length, Math.max(0, Math.floor(before)));
  const policy = typeof bc.getTreasuryPolicy === 'function' ? bc.getTreasuryPolicy() : null;
  const rows = [];
  let h = start - 1, lastHeight = null;
  for (; h >= 0 && rows.length < limit; h--) {
    const block = chain[h]; const info = { height: h, confirmations: chain.length - h };
    for (const tx of (block.txs || [])) {
      if (tx.from !== address && tx.to !== address) continue;
      rows.push(row(tx, info, address, policy));
      lastHeight = h;
      if (rows.length >= limit) break;
    }
  }
  const hasMore = rows.length >= limit && h >= 0 && lastHeight !== null && lastHeight > 0;
  // Мемпул (не подтверждено) — только на первой странице.
  let mempoolRows = [];
  if (before === null) {
    for (const tx of (bc.mempool || [])) {
      if (tx.from !== address && tx.to !== address) continue;
      const r = row(tx, { height: null, confirmations: 0 }, address, policy);
      r.status = 'mempool'; r.height = null; mempoolRows.push(r);
      if (mempoolRows.length >= 50) break;
    }
  }
  return { status: 200, body: { ok: true, address, rows, mempoolRows, nextBeforeHeight: hasMore ? lastHeight : null,
    treasury: policy ? { ref: policy.ref, treasury: policy.treasury, requires: policy.requires || 2, effectiveFrom: policy.effectiveFrom ?? null } : null,
    beforeHeight: before, limit } };
}

function amountNums(amount) {
  const s = String(amount ?? '');
  if (!DEC_RE.test(s) && !Number.isFinite(Number(s))) return null;
  const n = Number(s); if (!Number.isFinite(n) || n <= 0) return null;
  // Безопасный парс десятичный (до 9 знаков после точки, как в intent) — без float-порчи.
  const plain = (() => { const p = String(Number(s)); return DEC_RE.test(p) ? p : s; })();
  if (!DEC_RE.test(plain)) return null;
  return plain;
}

// POST /cabinet/wallet/estimate — смета комиссий для отправки.
// Честно: сеть НЕ берёт базовую комиссию ('fee-none', см. core.mjs comment on Nano pattern).
// Возможные реальные удержания: gateway feeBps (multihop) и налог по паспорту — но налог
// применяется ТАКЖЕ К ДРУВИМ типам операций (escrow-payout/DXE), не к простым P2P tx.
export function walletEstimate(bc, cabinet, body) {
  const address = body.address, token = body.token;
  if (!cabinet.session(address, token)) return { status: 401, body: { error: 'session_invalid_or_foreign', hint: 'логинь заново' } };
  const to = String(body.to || '');
  if (!ADDR_RE.test(to)) return { status: 400, body: { error: 'invalid_to' } };
  const amount = amountNums(body.amount);
  if (!amount) return { status: 400, body: { error: 'invalid_amount', hint: 'десятичная запись, ≤9 знаков после точки' } };
  if (to === address) return { status: 400, body: { error: 'self_send', hint: 'получатель — вы сами; такой перевод будет self-tx' } };
  const bal = bc.balances()[address] || 0;
  const balAGT = Number(bal);
  const selRoute = body.route === 'gateway' ? 'gateway' : 'direct';
  const fees = [];
  let arrive = Number(amount);
  // Базовая комиссия сети.
  fees.push({ type: 'network', amount: 0, note: 'базовая комиссия сети AGT: 0 (fee-none)' });
  if (selRoute === 'gateway') {
    const map = bc.gateways && bc.gateways.map ? bc.gateways.map : {};
    const cands = Object.entries(map).filter(([, g]) => g && g.type === 'forward' && !bc.security.isBanned(g.owner));
    if (!cands.length) return { status: 200, body: { ok: true, route: 'gateway', unavailable: 'no_forward_gw', fees, amountAGT: amount, arrival: 0,
      units: unitsObj(amount), explain: 'Нет доступных forward-шлюзов — отправляйте напрямую (route=direct). Источник: /gateway/list, AGIP-16.' } };
    const sorted = [...cands].sort((a, b) => (a[1].feeBps || 0) - (b[1].feeBps || 0));
    const pick = body.gatewayId ? sorted.find(([id]) => id === body.gatewayId) : sorted[0];
    if (!pick) return { status: 404, body: { error: 'gateway_not_found' } };
    const [gwId, gw] = pick;
    // Точная математика из core.mjs.executeMultiHop: fee = amount*feeBps/10000 (toFixed(6)).
    const fee = +(Number(amount) * (Number(gw.feeBps) || 0) / 10000).toFixed(6);
    arrive = +(Number(amount) - fee).toFixed(6);
    fees.push({ type: 'gateway', amount: fee, gatewayId: gwId, feeBps: Number(gw.feeBps) || 0,
      note: 'через шлюз ' + gwId + ': получатель получит amount − fee (leg2/core.executeMultiHop)' });
  } else {
    // Налог (AGIP-10): честно — К P2P-переводу он НЕ применяется (split-on-send
    // только для escrow-payouts и DXE-ордеров). Печатаем уведомление, не удержание.
    const rec = cabinet.findPassportByAddress(address);
    const tax = rec && rec.tax && rec.tax.regime && rec.tax.regime !== 'none' ? rec.tax : null;
    if (tax) fees.push({ type: 'tax', amount: null, applied: false, rateBps: Math.max(0, Math.min(5000, Number(tax.rate) || 0)), note: 'налог по паспорту НЕ удерживается при обычном P2P-переводе (только escrow-payout/DXE)' });
  }
  if (arrive <= 0) return { status: 400, body: { error: 'fee_too_high', fees } };
  return { status: 200, body: {
    ok: true, route: selRoute, from: address, to, amountAGT: amount, arrival: arrive,
    units: unitsObj(amount), arrivalUnits: unitsObj(arrive), fees,
    balanceAGT: balAGT,
    sufficient: Number(amount) <= balAGT,
    explain: 'майнер не берёт комиссию с перевода; полная сумма списывается с отправителя; шлюз удерживает feeBps при leg2',
  } };
}

// Единицы: AGT (их float/decimal), mAGT = 1e-3 AGT, mGNT (магент) = 1e-9 AGT.
function unitsObj(amtStr) {
  let mgnts;
  try { mgnts = unitsOfAmountBigInt(amtStr); } catch { return null; }
  const mg = mgnts > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(mgnts);
  return {
    AGT: String(amtStr),
    mAGT: Math.round((Number(amtStr) * 1e3) * 1e6) / 1e6,
    mGNT: mgnts.toString(),
    mGNTRound: mg,
    note: 'mAGT = 10⁻³ AGT; mGNT (магент, AGIP-9) = 10⁻⁹ AGT',
  };
}

// Контракт страниц: serveSitePage для /wallet
export const WALLET_PAGE = 'wallet.html';
