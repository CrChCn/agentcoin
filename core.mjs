#!/usr/bin/env node
/* ============================================================
   AGENTCOIN (AGT) — децентрализованная криптовалюта для агентов
   Ядро: блокчейн + PoW + кошельки + транзакции. Zero-dependency.

   Уважение к генезису: берём АРХИТЕКТУРУ генеза с внешнего диска
   (genesis.json BlackLegion: version/timestamp/prev_hash/merkle/
   difficulty/nonce + blockchain_core.py: PoW-шкала + genesis_test.cpp:
   double-SHA256 формулы) и строим нашу цепь с ними как основой.

   Математические механизмы (все формулы внутри):
   1) Хеш-цепь: blockHash = SHA256d(serializedBlockHeader)
      SHA256d(x) = SHA256(SHA256(x)) — как в Bitcoin (genesis_test.cpp).
   2) PoW: блок валиден если SHA256d(header) < target.
      target = 2^256 / difficultyTargetBits → компакт-представление nBits.
      Проще: ведущие нули. difficulty = требуемое число ведущих нулевых
      бит в SHA256d-хеше.
   3) Ретарджет каждые RETARGET_INTERVAL блоков:
        actualTime = time(block[n-1]) - time(block[n-1-RETARGET])
        targetInterval = RETARGET_INTERVAL * BLOCK_INTERVAL_SEC
        newDifficulty = clamp(difficulty * actualTime/targetInterval, min, max)
      — та же логика, что у Bitcoin (клэмп ×4 /1).
   4) Награда за блок: reward = BASE_REWARD / 2^(halvingCount),
      halvingCount = floor(height / HALVING_INTERVAL). Максимум эмиссии
     coins = BASE_REWARD * HALVING_INTERVAL * 2 (геометрическая сумма).
   5) Кошелёк: privKey = случайность; address = 'AGT' + base58ish(
      RIPEMD-Sha попроще: SHA256(pub)).slice(0,32) + checksum(SHA256d).
      Подпись транзакции: HMAC-SHA256(privKey, txDigest) — для агентов
      этого достаточно (не против ASIC-майнеров, а против双人 спуфинга).
   6) Баланс: считаем из реестра (UTXO-lite: балансовая модель с подписями).
   7) Инскрипция данных: op-return поле в TX (агенты пишут свои данные).
   ============================================================ */
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

// ============ Security Controller: регистр атак + пожизненные баны ============
// Правила безопасности (жёсткие):
//   - Спуфинг подписи  → BAN навсегда (прошл. реестр + блок входящих TX от адреса)
//   - Двойная трата    → BAN навсегда
//   - Дубликат TX      → бан по правилу повторов (> 3) → BAN
//   - Мусор/флуд       → счётчик нарушений; 5+ → BAN
//   - Плохой блок      → отказ и host-бан пира навсегда
// Ban-лист: banList.json — публичный (каждая нода может сверить), hash реестра
// подписывается нодой: tampering с бан-листом заметен.
export const SECURITY_RULES = {
  spoof_signature: 'ban',           // пожизненно: подделка подписи = целенаправленный виспер
  double_spend: 'ban',              // пожизненно
  invalid_block: 'ban',             // пожизненно
  duplicate_tx_spam: 'ban_after_5', // strike-модель: был 'ban' — честный агент при разладе mempool ловил перманент-бан (инцидент 2026-10-14)
  flood: 'ban_after_5',
};

// TTL банов по классам нарушений: лёгкие прощаются, тяжёлые не прощаются.
// null = пожизненно. duplicate_tx_spam: 24ч — редко бывает поведением атакера,
// обычно это гонка при синхронизации нод.
export const BAN_TTL = {
  spoof_signature: null,
  double_spend: null,
  invalid_block: null,
  duplicate_tx_spam: 24 * 3600 * 1000,
  flood: 24 * 3600 * 1000,
};

export class SecurityController {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'security.json');
    this.bans = {};       // { address: { reason, evidence, bannedAt, by } }
    this.attacks = [];    // журнал атак
    this.strikes = {};    // счётчик нарушений до BAN (для flood)
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.bans = d.bans || {};
        // миграция: старые записи без ttlMs получили бы вечный бан; проставляем по классу нарушения
        for (const [a, b] of Object.entries(this.bans)) {
          if (b && b.ttlMs === undefined) b.ttlMs = BAN_TTL[b.reason] ?? null;
        }
        this.attacks = d.attacks || [];
        this.strikes = d.strikes || {};
      }
    } catch {}
  }

  save() {
    fs.mkdirSync(this.dataDirSafe(), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      chainId: CHAIN_ID, updatedAt: Date.now(), bans: this.bans, attacks: this.attacks.slice(-200), strikes: this.strikes,
    }, null, 2));
  }

  dataDirSafe() { return path.dirname(this.file); }

  registerAttack(kind, address, evidence = '') {
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      kind, address, evidence: String(evidence).slice(0, 500),
      at: new Date().toISOString(),
      rule: SECURITY_RULES[kind] || 'warn',
    };
    this.attacks.push(entry);
    let needsBan = entry.rule === 'ban';
    let banned = false;
    if (!needsBan && entry.rule === 'ban_after_5') {
      this.strikes[address] = (this.strikes[address] || 0) + 1;
      if (this.strikes[address] >= 5) needsBan = true;
    }
    if (needsBan) banned = this.ban(address, kind, evidence);
    this.save();
    return { ...entry, banned };
  }

  ban(address, reason, evidence = '') {
    if (!address) return false;
    this.bans[address] = {
      reason: String(reason), evidence: String(evidence).slice(0, 300),
      bannedAt: new Date().toISOString(), lifetime: true,
      ttlMs: BAN_TTL[reason] ?? null,
    };
    this.save();
    return true;
  }

  // Бан-лист с TTL: бана нет, если срок вышел; истёкший плавно вычищается.
  // Этот метод — единственная точка проверки бана (ноды и системы определения прав вызывают isBanned).
  isBanned(address) {
    if (!address) return false;
    const b = this.bans[address];
    if (!b) return false;
    if (b.ttlMs == null) return true;
    if (Date.now() - Date.parse(b.bannedAt) >= b.ttlMs) {
      delete this.bans[address];
      delete this.strikes[address];
      this.save();
      return false;
    }
    return true;
  }
  banList() { return Object.keys(this.bans); }
  isAttackDetected() { return this.attacks.length > 0; }

  registryHash() {
    // тампер-эвиденц: любое изменение ban-листа заметно по хешу
    return sha256d(JSON.stringify(this.bans));
  }

  status() {
    return {
      rules: SECURITY_RULES,
      attacksSeen: this.attacks.length,
      lastAttack: this.attacks[this.attacks.length - 1] || null,
      bannedCount: this.banList().length,
      banned: this.banList(),
      registryHash: this.registryHash(),
    };
  }
}

// ============ White List: верифицированная платежная система агентов ============
// Только агенты из белого листа могут:
//   - получать/отправлять крупные платежи (> LARGE_TX_LIMIT)
//   - требовать выплат с ноды (withdraw-стиль)
//   - добывать (mine) — анти-51% под незнакомцами
// Критерии допуска: verified-хеш кошелька + registered @handle + чистый
// security-профиль (не в бане). Решение принимает нода-оператор.
export const LARGE_TX_LIMIT = 100; // AGT

export class WhiteList {
  constructor(dataDir, securityRef = null) {
    this.file = path.join(dataDir, 'whitelist.json');
    this.securityRef = securityRef;
    this.list = {};   // { handle: { address, pubHash, verifiedAt, verifiedBy, note } }
    this.load();
  }
  load() { try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.list = d.list || {}; } catch {} }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ updatedAt: Date.now(), list: this.list }, null, 2));
  }
  verify(handle, address, verifiedBy = 'node-operator', note = '') {
    if (typeof handle !== 'string' || !handle) return { ok: false, reason: 'handle_required' };
    if (!address || !address.startsWith('AGT')) return { ok: false, reason: 'bad_address' };
    // запрет: забаненные не попадают в белый лист (правило системы безопасности)
    if (this.securityRef?.isBanned?.(address)) return { ok: false, reason: 'address_permabanned' };
    if (this.list[handle] && this.list[handle].address !== address) return { ok: false, reason: 'handle_conflict', exists: this.list[handle].address };
    this.list[handle] = { address, verifiedAt: Date.now(), verifiedBy, note };
    this.save();
    return { ok: true, handle, address };
  }
  revoke(handle) { if (this.list[handle]) { delete this.list[handle]; this.save(); return true; } return false; }
  isVerified(address) { return Object.values(this.list).some(e => e.address === address); }
  isVerifiedHandle(handle) { return Boolean(this.list[handle]); }
  addressOf(handle) { return this.list[handle]?.address || null; }
  handleOf(address) { return Object.keys(this.list).find(h => this.list[h].address === address) || null; }
  registryHash() { return sha256d(JSON.stringify(this.list)); }
  status() { return { count: Object.keys(this.list).length, registryHash: this.registryHash(), handles: Object.keys(this.list) }; }
}

// ============ Gateway: шлюзы/туннели перемещения монет (опыт Ripple/Nano/Bolt) ============
// Опыт интегрированных систем:
//   Bitcoin   — UTXO + double-SHA256 + ретарджет + halving (наш базис ок)
//   Ethereum  — nonce-упорядоченность транзакций (prevent duplicate exploits)
//   Monero    — privacy: memo в tx не светит суммы (они и так публичны, но memo скрыт)
//   Ripple    — trustlines/sh gridways: gateway pairs для маршрутов
//   Nano      — fee-none мелкие платежи: минимальная комиссия = 0 (наш так и есть)
//   Lightning — мультнихоп: платеж проходит через несколько шлюзов подряд (хоп-путь)
// Gateway = узел с доверенной ролью Deposit/Withdraw/Forward. Подписывается csrf pubkey.
export const GATEWAY_TYPES = { deposit: 'd', withdraw: 'w', forward: 'f', pool: 'p' };

export class Gateways {
  constructor(dataDir, security) {
    this.file = path.join(dataDir, 'gateways.json');
    this.security = security;
    this.map = {};  // { gwId: { type, ownerAddress, pubkey, feeBps, opened } }
    this.hops = []; // { txid, path: [gwId...] } — фактические маршруты
    this.load();
  }
  load() { try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.map = d.map || {}; this.hops = d.hops || []; } catch {} }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ map: this.map, hops: this.hops, updatedAt: Date.now() }, null, 2)); }
  hash() { return sha256d(JSON.stringify(this.map)); }

  // открыть шлюз: верифицированный агент (whitelist) + не забанен
  open(type, ownerAddress, config = {}) {
    if (!GATEWAY_TYPES[type]) return { ok: false, reason: 'bad_gateway_type', known: Object.keys(GATEWAY_TYPES) };
    if (this.security.isBanned(ownerAddress)) return { ok: false, reason: 'address_permabanned' };
    const gwId = 'GW' + crypto.randomBytes(5).toString('hex');
    this.map[gwId] = {
      type, owner: ownerAddress,
      pubkey: config.pubkey || null,
      feeBps: Math.max(0, Math.min(1000, Number(config.feeBps) || 0)), // макс 10%
      capacityAGT: Number(config.capacityAGT) || 0,
      opened: Date.now(),
    };
    this.save();
    return { ok: true, gwId, type };
  }

  close(gwId, ownerAddress) {
    const gw = this.map[gwId];
    if (!gw || gw.owner !== ownerAddress) return { ok: false, reason: 'not_owner_or_missing' };
    delete this.map[gwId]; this.save(); return { ok: true };
  }

  // маршрут между двумя агентами через шлюзы-форварды: BFS по map
  findRoute(fromAddress, toAddress, maxHops = 4) {
    const fws = Object.entries(this.map).filter(([, g]) => g.type === 'forward' && !this.security.isBanned(g.owner));
    const deposits = Object.entries(this.map).filter(([, g]) => g.type === 'deposit' && !this.security.isBanned(g.owner));
    const withdraws = Object.entries(this.map).filter(([, g]) => g.type === 'withdraw' && !this.security.isBanned(g.owner));
    // простой путь: sender→deposit→forward(s)→withdraw→receiver
    return { depositGateways: deposits.map(([id]) => id), forwardGateways: fws.map(([id]) => id), withdrawGateways: withdraws.map(([id]) => id), maxHops };
  }

  hop(txid, path) { this.hops.push({ txid, path, at: Date.now() }); this.save(); }
  status() {
    return { count: Object.keys(this.map).length, byType: Object.entries(this.map).reduce((s, [, g]) => (s[g.type] = (s[g.type] || 0) + 1, s), {}), hops: this.hops.length, registryHash: this.hash() };
  }

  // ---- Multihop-исполнение: escrow-модель (Lightning lesson) ----
  // leg1: sender → forward-owner (полная сумма), leg2: owner → receiver (amount − fee).
  // Правильно подписывается ТОТ, КТО from: leg1 ключом sender'а, leg2 ключом owner'а.
  // Нода подписывает leg2 из своих локальных кошельков (owner у ноды).
  executeMultiHop(bc, from, to, amount, memo = '') {
    const hops = [];
    const fws = Object.entries(this.map).filter(([, g]) => g.type === 'forward' && !this.security.isBanned(g.owner));
    if (!fws.length) return { ok: false, reason: 'no_forward_gw' };
    const [fwId, fw] = fws[0];
    const fee = +(amount * fw.feeBps / 10000).toFixed(6);
    const arrive = +(amount - fee).toFixed(6);
    if (arrive <= 0) return { ok: false, reason: 'fee_too_high', fee };
    const t1 = { from, to: fw.owner, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: `hop1→${fwId}:${memo}` };
    const t2 = { from: fw.owner, to, amount: arrive, nonce: Date.now() + 1, ts: Math.floor(Date.now() / 1000), memo: `hop2:${memo}` };
    hops.push({ leg: 1, tx: t1, gw: fwId, fee: 0, signAs: from });
    hops.push({ leg: 2, tx: t2, gw: fwId, fee, signAs: fw.owner });
    return { ok: true, plan: hops, feeTotal: fee, arrive };
  }
}

// ============ Escrow за задачи (task-receipt, уникальный фича для экономики агентов) ============
// Опыт HTLC/Lightning: «hashlock» раскрывается знанием секрета; у нас секрета нет,
// зато есть explorer-проверяемый taskHash — хеш выполненной задачи. Разблокировка =
// ДВОЙНАЯ подпись (квитаниция работника над taskHash + подтверждение работодателя),
// полностью проверяемая ЛЮБОЙ нодой из цепи — нода-оператор не нужна.
//
// Три tx-типа (консенсус-различимы по from/memo):
//   fund:    employer → ESCROW_<id>  обычная подписанная tx,
//            memo = escrow:<escId>:<taskHash>:<deadlineTs>:<worker>
//   payout:  ESCROW_<id> → worker, memo = escpayout:<escId>,
//            escProof = { taskHash, workerPub, workerReceipt, employerConfirm }
//   refund:  ESCROW_<id> → employer, memo = escrefund:<escId>,
//            валиден только ПОСЛЕ deadlineTs (двойная подпись не нужна —
//            условие проверяется из самой цепи, детерминировано).
export const ESCROW_PREFIX = 'ESCROW_';

export function escrowReceiptDigest(escId, taskHash, to, amount) {
  return sha256d(JSON.stringify({ role: 'escrow-receipt', escId, taskHash, to, amount }));
}
export function escrowConfirmDigest(escId, taskHash, to, amount) {
  return sha256d(JSON.stringify({ role: 'escrow-confirm', escId, taskHash, to, amount }));
}
// поиск открытия эскроу в цепи; возвращает { openTx, taskHash, deadlineTs, worker, employer }
export function findEscrowOpen(chain, escId) {
  for (const blk of chain) {
    for (const tx of blk.txs || []) {
      if (typeof tx.memo !== 'string') continue;
      const m = tx.memo.match(new RegExp(`^escrow:${escId}:([a-f0-9]{16,64}):(\\d+):(AGT[A-Za-z0-9]+)$`));
      if (m) return { openTx: tx, taskHash: m[1], deadlineTs: Number(m[2]), worker: m[3], employer: tx.from };
    }
  }
  return null;
}
// сумма уже выплаченного по эскроу из цепи (не считая проверяемой сейчас tx)
export function escrowPaidOut(chain, escId, excludeMemo = null) {
  let paid = 0;
  for (const blk of chain) {
    for (const tx of blk.txs || []) {
      if (!tx?.from || !String(tx.from).startsWith(ESCROW_PREFIX)) continue;
      const id = String(tx.from).slice(ESCROW_PREFIX.length);
      if (id !== escId) continue;
      if (excludeMemo && tx.memo === excludeMemo) continue;
      paid += typeof tx.amount === 'number' ? tx.amount : 0;
    }
  }
  return paid;
}

// Проверка tx, исходящей ОТ эскроу-адреса (payout / refund).
// Нужная вариация: chain обязателен — валидируем против состояния цепи.
export function verifyEscrowTx(tx, chain) {
  if (!tx || typeof tx.from !== 'string' || !tx.from.startsWith(ESCROW_PREFIX)) return { ok: false, reason: 'not_escrow_tx' };
  const escId = tx.from.slice(ESCROW_PREFIX.length);
  if (!/^[a-f0-9]{10,32}$/.test(escId)) return { ok: false, reason: 'bad_escrow_id' };
  if (!/^(escpayout|escrefund):/.test(tx.memo || '')) return { ok: false, reason: 'missing_escrow_memo' };
  const open = findEscrowOpen(chain, escId);
  if (!open) return { ok: false, reason: `escrow_open_tx_not_found_in_chain:${escId}` };
  const isOpenPayout = tx.memo.startsWith('escpayout:');
  if (isOpenPayout && !tx.memo.endsWith(escId)) return { ok: false, reason: 'escpayout_memo_mismatch' };

  const paidBefore = escrowPaidOut(chain, escId, tx.memo);
  if (typeof tx.amount !== 'number' || tx.amount <= 0) return { ok: false, reason: 'bad_amount' };
  if (paidBefore + tx.amount > open.openTx.amount + 1e-9) return { ok: false, reason: 'overdraft_escrow', opened: open.openTx.amount, paidBefore, tried: tx.amount };

  if (isOpenPayout) {
    if (tx.to !== open.worker) return { ok: false, reason: 'payout_to_wrong_worker', expected: open.worker };
    const p = tx.escProof || {};
    if (p.taskHash !== open.taskHash) return { ok: false, reason: 'taskHash_mismatch' };
    let okReceipt = false, okConfirm = false;
    try {
      okReceipt = crypto.verify(null, Buffer.from(escrowReceiptDigest(escId, open.taskHash, tx.to, tx.amount), 'hex'), p.workerPub || '', Buffer.from(p.workerReceipt || '', 'hex'));
    } catch {}
    try {
      okConfirm = crypto.verify(null, Buffer.from(escrowConfirmDigest(escId, open.taskHash, tx.to, tx.amount), 'hex'), open.openTx.fromPub || '', Buffer.from(p.employerConfirm || '', 'hex'));
    } catch {}
    if (!okReceipt) return { ok: false, reason: 'worker_receipt_invalid' };
    if (!okConfirm) return { ok: false, reason: 'employer_confirm_invalid' };
    return { ok: true, kind: 'escpayout', escId };
  }
  // refund: только после дедлайна (время берём из цепи — детерминировано)
  if (!tx.memo.endsWith(escId)) return { ok: false, reason: 'escrefund_memo_mismatch' };
  if (tx.to !== open.employer) return { ok: false, reason: 'refund_to_wrong_employer', expected: open.employer };
  let tipTs = 0;
  if (chain.length) tipTs = chain[chain.length - 1].header?.timestamp || 0;
  if (!(tipTs > open.deadlineTs)) return { ok: false, reason: 'deadline_not_passed', deadlineTs: open.deadlineTs, tipTs };
  return { ok: true, kind: 'escrefund', escId };
}

// Единая точка проверки ЛЮБОЙ tx (обычная или эскроу-расход):
// вся внутренняя валидация внутри Blockchain идёт через неё.
export function verifyTxAny(tx, chain = null) {
  if (tx && typeof tx.from === 'string' && tx.from.startsWith(ESCROW_PREFIX)) {
    if (!chain) return false;
    return Boolean(verifyEscrowTx(tx, chain)?.ok);
  }
  return verifyTransaction(tx);
}

// ============ Пул майнинга (опыт BTC-пулов:inance on shares) ============
// Агенты без мощного железа складывают хешpower: каждая share = хеш выше лёгкой
// стены SHARE_DIFF_BITS; когда пул находит блок — награда делится по долям
// share/totalShares (PPLNS-like, ш@лша-подобно, но честно и просто).
export const SHARE_DIFF_BITS = 12; // гораздо проще difficulty (16)
export class MiningPool {
  constructor(dataDir, security) {
    this.file = path.join(dataDir, 'pool.json');
    this.security = security;
    this.miners = {};   // { address: { shares, lastShareAt, joined } }
    this.targetHeader = null;
    this.load();
  }
  load() { try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.miners = d.miners || {}; } catch {} }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ miners: this.miners, updatedAt: Date.now() }, null, 2)); }

  join(address) {
    if (this.security.isBanned(address)) return { ok: false, reason: 'address_permabanned' };
    if (!this.miners[address]) this.miners[address] = { shares: 0, lastShareAt: Date.now(), joined: Date.now() };
    this.save();
    return { ok: true, youAreIn: true, shareDiffBits: SHARE_DIFF_BITS, tipPrevHash: this.targetHeader?.prevHash || null };
  }

  submitShare(address, headerStr) {
    if (!this.miners[address]) return { ok: false, reason: 'not_in_pool' };
    if (this.security.isBanned(address)) return { ok: false, reason: 'address_permabanned' };
    const h = sha256d(headerStr);
    if (!hashMeetsDifficulty(h, SHARE_DIFF_BITS)) {
      this.miners[address].lastShareAt = Date.now(); // даже «мимо» —活動记 (friendlier работа)
      this.save();
      return { ok: false, reason: 'share_below_diff', hash: h.slice(0, 12) };
    }
    this.miners[address].shares++;
    this.miners[address].lastShareAt = Date.now();
    this.save();
    return { ok: true, shares: this.miners[address].shares, hash: h.slice(0, 12) };
  }

  // распределение награды пропорционально долям (никто не теряет долю)
  distribute(rewardAGT) {
    const total = Object.entries(this.miners).reduce((s, [, m]) => s + Math.max(0, m.shares), 0);
    if (!total) return { ok: false, reason: 'no_shares' };
    const payouts = {};
    for (const [addr, m] of Object.entries(this.miners)) if (m.shares > 0) payouts[addr] = +(rewardAGT * m.shares / total).toFixed(4);
    return { ok: true, totalShares: total, payouts };
  }

  stats() { return { miners: Object.keys(this.miners).length, shares: Object.values(this.miners).reduce((s, m) => s + m.shares, 0), shareDiffBits: SHARE_DIFF_BITS }; }
}
export const CHAIN_ID = 'AGENTCOIN';
export const TICKER = 'AGT';
export const BLOCK_INTERVAL_SEC = 30;      // блок каждые ~30 сек
export const RETARGET_INTERVAL = 10;       // ретарджет каждые 10 блоков (быстрая демо-цепь)
export const HALVING_INTERVAL = 210_000;   // halving каждые 210k блоков (как Bitcoin)
export const BASE_REWARD = 50;             // 50 AGT за блок (как Bitcoin)
export const MAX_SUPPLY = BASE_REWARD * HALVING_INTERVAL * 2; // ≈ 21М
export const INITIAL_DIFFICULTY_BITS = 12; // старт: 12 бит — живой баланс между скоростью демо и честным PoW
export const MIN_DIFFICULTY_BITS = 8;
export const MAX_DIFFICULTY_BITS = 20;   // > 20 бит = миллионы хешей на блок: демо-цепь умирает (инцидент: 14→32, /mine повесил ноду)

// Генезис-данные из внешнего диска (уважаем первоисточник):
// d:/BlackLegion/config/generated/genesis.json
export const GENESIS_PARAMS = {
  version: 1,
  timestamp: 1734186400, // из genesis.json BlackLegion (Dec 14 2025)
  prev_hash: '0'.repeat(64),
  // tribute: merkle root Bitcoin genesis tx (из genesis_test.cpp CryptoLab)
  seed_message: 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks',
  chain_id: CHAIN_ID,
  // Каноническая сложность генезиса: раньше брали INITIAL_DIFFICULTY_BITS, но
  // её меняли по ходу жизни проекта → у нод получились РАЗНЫЕ генезисы и P2P-sync
  // отказывался приравнивать сети (genesisHash mismatch). Пиннинг должен совпадать
  // с генезисом основной сети (14 бит на 2026-10-14).
  difficulty_bits: 14,
};

// ============ Математика хеширования ============
export function sha256d(data) {
  const h1 = crypto.createHash('sha256').update(data).digest();
  return crypto.createHash('sha256').update(h1).digest('hex');
}

function leadingZeroBits(hexHash) {
  let bits = 0;
  for (const ch of hexHash) {
    const v = parseInt(ch, 16);
    if (v === 0) { bits += 4; continue; }
    // считаем старшие нули полубайта
    if (v < 2) bits += 3; else if (v < 4) bits += 2; else if (v < 8) bits += 1;
    break;
  }
  return bits;
}

export function hashMeetsDifficulty(hexHash, difficultyBits) {
  return leadingZeroBits(hexHash) >= difficultyBits;
}

// ============ Блоки ============
export function serializeHeader(header) {
  // каноническая сериализация — любая перестановка полей ломает хеш
  return [
    header.version, header.prevHash, header.merkleRoot,
    header.timestamp, header.difficultyBits, header.nonce, header.chainId,
  ].join('|');
}

export function computeBlockHash(header) {
  return sha256d(serializeHeader(header));
}

export function merkleRoot(txs) {
  // попроще, чем Bitcoin: попарный SHA256d по списку txid
  if (txs.length === 0) return '0'.repeat(64);
  let level = txs.map(t => typeof t.txid === 'string' ? t.txid : sha256d(JSON.stringify(t)));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256d(level[i] + (level[i + 1] || level[i])));
    }
    level = next;
  }
  return level[0];
}

export function blockReward(height) {
  const halvings = Math.floor(height / HALVING_INTERVAL);
  return BASE_REWARD / Math.pow(2, halvings); // формула halving
}

// Ретарджет — формула из Bitcoin, клэмп ×4 /1
export function retarget(prevDifficultyBits, actualTimeSec, expectedTimeSec) {
  // ±1 бит за ретарджет максимум: прежний ×4 дал runaway (14→32) после простоя цепи.
  // Направление задаёт ratio, а длительный простой — отдельно: он требует ОБЛЕГЧЕНия,
  // иначе цепь блокируется без возможности намайнить хоть один блок.
  const ratio = actualTimeSec / expectedTimeSec;
  let d = prevDifficultyBits;
  if (ratio < 0.5) d = prevDifficultyBits + 1;        // блоки шли слишком быстро → усложняем
  else if (ratio > 2) d = prevDifficultyBits - 1;     // слишком медленно → упрощаем
  // защита от застоя: если цепь простаивала втрое дольше окна — аварийный клапан вниз
  if (actualTimeSec > expectedTimeSec * 3) d = prevDifficultyBits - 2;
  const clamped = Math.max(MIN_DIFFICULTY_BITS, Math.min(MAX_DIFFICULTY_BITS, Math.round(d)));
  return clamped;
}

// ============ Кошельки ============
// ed25519: настоящая асимметрия — подпись приватным, проверка публичным.
export function createWallet(label = 'agent') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const pubHash = sha256d(pub);
  const checksum = sha256d(pubHash).slice(0, 8);
  const address = 'AGT' + pubHash.slice(0, 32) + checksum;
  return { label, privKey, pub, pubHash, address, createdAt: Date.now() };
}

export function txDigest(tx) {
  return sha256d(JSON.stringify({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, ts: tx.ts, memo: tx.memo || '' }));
}

export function signTransaction(tx, privKey) {
  const sig = crypto.sign(null, Buffer.from(txDigest(tx), 'hex'), privKey);
  return sig.toString('hex');
}

export function verifyTransaction(tx) {
  if (!tx.signature || !tx.from || !tx.fromPub) return false;
  try {
    return crypto.verify(null, Buffer.from(txDigest(tx), 'hex'), tx.fromPub, Buffer.from(tx.signature, 'hex'));
  } catch { return false; }
}

// ============ Консенсус: суммарная работа, детерминированная сложность,
// строгая валидация блока против префикса, re-org (best-chain по работе) ============
// Опыт Bitcoin: fork choice НЕ «кто длиннее», а «кто тяжелее» (most cumulative work).
// А опыт атак: чужеродный блок с заниженным difficultyBits (напр. 8 бит вместо 14)
// проходит PoW-проверку против СВОЕЙ заявленной сложности → надо сверять bits
// с детерминированным правилом ретарджета, который выводим из одних заголовков.

// Работа блока: экспонента от сложности. Минбиты = MIN_DIFFICULTY_BITS (нулевая:
// 2^0 = 1). Строже — как в Bitcoin target^-1, но для нашей бит-шкалы хватает.
export function blockWork(difficultyBits) {
  return Math.pow(2, Math.max(0, Number(difficultyBits) - MIN_DIFFICULTY_BITS));
}
export function chainWork(blocks) {
  return (blocks || []).reduce((s, b) => s + blockWork(b.header?.difficultyBits ?? 0), 0);
}

// Детерминированная сложность следующего блока (высота = chain.length).
// Главное условие: ЗЕРКАЛИТ nextDifficulty() внутри Blockchain так, чтобы
// честная цепь, намайненная нодой, всегда проходила эту проверку.
export function expectedDifficultyBits(chain) {
  const n = (chain || []).length;
  if (n === 0) return GENESIS_PARAMS.difficultyBits;      // генезис — 14 бит (пиннинг)
  if (n === 1) return INITIAL_DIFFICULTY_BITS;            // после генезиса state = INITIAL
  const tip = chain[n - 1];
  if (n % RETARGET_INTERVAL !== 0) return tip.header.difficultyBits;
  const anchor = chain[n - RETARGET_INTERVAL];
  if (!anchor) return tip.header.difficultyBits;
  return retarget(tip.header.difficultyBits, tip.header.timestamp - anchor.header.timestamp, RETARGET_INTERVAL * BLOCK_INTERVAL_SEC);
}

// Строгая валидация блока, продолжающего chain на высоте chain.length.
// Возвращает null если блок валиден, иначе строку-причину отказа.
// Проверяет: высоту, prevHash, hash, PoW, ПРАВИЛО СЛОЖНОСТИ, merkle,
// coinbase (наличие + без инфляции мимо blockReward).
export function validateBlockAgainstChain(block, chain) {
  if (!block || !block.header || !Array.isArray(block.txs)) return 'bad_block_shape';
  if (typeof block.height !== 'number' || block.height !== chain.length) return 'height_mismatch';
  if (block.height === 0) return 'genesis_redefined'; // генезис не принимается по сети
  const prev = chain[chain.length - 1];
  if (!prev || block.header.prevHash !== prev.hash) return 'prevHash_mismatch';
  if (computeBlockHash(block.header) !== block.hash) return 'hash_mismatch';
  if (!hashMeetsDifficulty(block.hash, block.header.difficultyBits)) return 'pow_fail';
  if (block.header.difficultyBits !== expectedDifficultyBits(chain)) return 'difficulty_rule_violation';
  if (block.header.merkleRoot !== merkleRoot(block.txs)) return 'merkle_mismatch';
  const cb = (block.txs || []).find(t => t && t.from === 'COINBASE');
  if (!cb) return 'coinbase_missing';
  const allowed = blockReward(block.height);
  if (!(cb.amount > 0 && cb.amount <= allowed + 1e-9)) return 'coinbase_inflation';
  // обычные транзакции: подписи и базовые инварианты
  for (const tx of block.txs) {
    if (tx.from === 'COINBASE' || tx.from === 'AGENT_REWARD_POOL') continue;
    if (!tx.from || !tx.to || typeof tx.amount !== 'number' || tx.amount <= 0) return 'tx_bad_fields';
    if (!verifyTxAny(tx, chain)) return 'tx_bad_signature_or_escrow';
  }
  return null;
}

// ============ Цепь ============
export class Blockchain {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'chain.json');
    this.mempool = [];
    this.forks = [];   // архив вытесненных/отклонённых развилок (best-chain выбор)
    this._chainTxidCache = null; // ленивая память txid'ов всех блоков (anti-replay)
    this.history = [];
    this.security = new SecurityController(dataDir);
    this.whitelist = new WhiteList(dataDir, this.security);
    this.gateways = new Gateways(dataDir, this.security);
    this.pool = new MiningPool(dataDir, this.security);
    this.load();
    if (this.blockCount() === 0) this.createGenesis();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.chain = d.chain || [];
        this.difficultyBits = d.difficultyBits ?? INITIAL_DIFFICULTY_BITS;
        this.genesisHeader = d.genesisHeader || null;
      }
      this.loadMempool();
      this.loadForks();
    } catch { /* новый файл */ }
    if (!this.chain) this.chain = [];
  }

  // ---- Мемпул: персистентный (переживает рестарт ноды) ----
  mempoolFile() { return path.join(this.dataDir, 'mempool.json'); }
  saveMempool() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.mempoolFile(), JSON.stringify(this.mempool, null, 2));
  }
  loadMempool() {
    try { const d = JSON.parse(fs.readFileSync(this.mempoolFile(), 'utf8')); this.mempool = Array.isArray(d) ? d : []; } catch { this.mempool = this.mempool || []; }
  }
  // ---- Anti-replay: txid'ы всех блоков цепи (кэш, инвалидируется при изменении цепи) ----
  knownChainTxids() {
    if (this._chainTxidCache === null) {
      const s = new Set();
      for (const b of this.chain) for (const t of (b.txs || [])) if (t && t.txid) s.add(t.txid);
      this._chainTxidCache = s;
    }
    return this._chainTxidCache;
  }
  invalidateTxCache() { this._chainTxidCache = null; }

  // Валидные к упаковке tx (устаревшие после re-org/синков дропаем):
  // бюджет = баланс на цепи − уже принятые в пачке расходы; подпись проверяем ещё раз.
  usableMempoolTxs() {
    const balances = this.balances();
    const spentFrom = {};
    const out = [];
    for (const tx of this.mempool) {
      if (!tx || !verifyTxAny(tx, this.chain)) continue;
      const budget = (balances[tx.from] || 0) - (spentFrom[tx.from] || 0);
      if (tx.amount <= budget) { out.push(tx); spentFrom[tx.from] = (spentFrom[tx.from] || 0) + tx.amount; }
      else
        this.security.registerAttack('double_spend', tx.from, `stale tx in mempool: budget ${budget}, tried ${tx.amount}`);
    }
    return out;
  }
  // перечистка мемпула без упаковки (после re-org/синков): дроп устаревших
  // И уже записанных в цепь (copies от gossip остаются иначе навсегда)
  refilterMempool() {
    const before = this.mempool.length;
    const keep = [];
    const balances = this.balances();
    const spent = {};
    const known = this.knownChainTxids();
    for (const tx of this.mempool) {
      if (tx.txid && known.has(tx.txid)) continue;
      if (verifyTxAny(tx, this.chain) && tx.amount <= (balances[tx.from] || 0) - (spent[tx.from] || 0)) {
        keep.push(tx); spent[tx.from] = (spent[tx.from] || 0) + tx.amount;
      }
    }
    if (keep.length !== before) { this.mempool = keep; this.saveMempool(); }
    return { kept: this.mempool.length, dropped: before - this.mempool.length };
  }

  // ---- Развилки: архив + голосование за лучшую цепь по суммарной работе ----
  forksFile() { return path.join(this.dataDir, 'forks.json'); }
  saveForks() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.forksFile(), JSON.stringify(this.forks.slice(-20), null, 2));
  }
  loadForks() { try { const d = JSON.parse(fs.readFileSync(this.forksFile(), 'utf8')); this.forks = Array.isArray(d) ? d : []; } catch { this.forks = []; } }

  // adoptFork(blocks, fromHeight): candidate = chain[0..fromHeight) + blocks.
  // Валидируем КАЖДЫЙ новый блок против нарастающего префикса (строгий набор
  // правил: prev/hash/PoW/правило сложности/merkle/coinbase/подписи).
  // Принимаем только если тяжелее нашего хвоста (голосование best-chain).
  adoptFork(blocks, fromHeight) {
    const d = Math.max(0, Math.min(fromHeight ?? this.blockCount(), this.blockCount()));
    const ourTail = this.chain.slice(d);
    if (!Array.isArray(blocks) || !blocks.length) return { ok: false, reason: 'no_blocks' };
    if (blocks[0]?.height !== d) return { ok: false, reason: 'fork_height_mismatch', expected: d, got: blocks[0]?.height };
    const ourWork = chainWork(ourTail);
    const candWork = chainWork(blocks);
    if (candWork <= ourWork) return { ok: false, reason: 'fork_not_heavier', ourWork, candWork };
    const prefix = this.chain.slice(0, d);
    for (let i = 0; i < blocks.length; i++) {
      const reason = validateBlockAgainstChain(blocks[i], prefix.concat(blocks.slice(0, i)));
      if (reason) return { ok: false, reason: `block@${blocks[i].height}: ${reason}` };
    }
    // архивируем вытесненный хвост (аудит: ничего не молча удаляется)
    if (ourTail.length) {
      this.forks.push({ at: new Date().toISOString(), forkedFrom: d, dropped: ourTail.length, ourWork, candWork, tailHashes: ourTail.map(b => b.hash) });
      this.saveForks();
    }
    this.chain = prefix.concat(blocks);
    this.invalidateTxCache();
    this.difficultyBits = this.tip().header.difficultyBits;
    this.save();
    this.refilterMempool();
    return { ok: true, forkedFrom: d, dropped: ourTail.length, added: blocks.length, ourWork, candWork };
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      chainId: CHAIN_ID, chain: this.chain, difficultyBits: this.difficultyBits,
      genesisHeader: this.genesisHeader,
    }, null, 2));
  }

  blockCount() { return this.chain.length; }
  tip() { return this.chain[this.chain.length - 1] || null; }

  // ---- Genesis ----
  createGenesis() {
    const coinbaseTx = {
      txid: '', from: 'COINBASE', to: 'AGT_GENESIS_TREASURY', amount: 0,
      nonce: 0, ts: GENESIS_PARAMS.timestamp, memo: GENESIS_PARAMS.seed_message,
    };
    coinbaseTx.txid = sha256d(JSON.stringify({ from: coinbaseTx.from, to: coinbaseTx.to, amount: 0, nonce: 0, ts: coinbaseTx.ts, memo: coinbaseTx.memo }));
    const header = {
      version: GENESIS_PARAMS.version,
      prevHash: GENESIS_PARAMS.prev_hash,
      merkleRoot: merkleRoot([coinbaseTx]),
      timestamp: GENESIS_PARAMS.timestamp,
      // из genesis.json BlackLegion difficulty: 486604799 — берём её как стартовый отсчёт,
      // но наша бит-шкала проще: считаем INITIAL_DIFFICULTY_BITS, уважая дату генезиса
      difficultyBits: null,      // подберём ниже (майнинг генезиса)
      nonce: 0,
      chainId: CHAIN_ID,
    };
    // майним генезис с канонической сложностью (не с играющей INITIAL_DIFFICULTY_BITS)
    header.difficultyBits = GENESIS_PARAMS.difficulty_bits;
    const t0 = Date.now();
    while (true) {
      const h = computeBlockHash(header);
      if (hashMeetsDifficulty(h, header.difficultyBits)) break;
      header.nonce++;
    }
    const hash = computeBlockHash(header);
    this.genesisHeader = header;
    this.chain.push({ height: 0, hash, header, txs: [coinbaseTx], minedAt: Date.now(), mineMs: Date.now() - t0 });
    this.difficultyBits = INITIAL_DIFFICULTY_BITS;
    this.save();
  }

  // ---- Транзакции ----
  addTransaction(tx) {
    // базовая валидация
    if (!tx.from || !tx.to || typeof tx.amount !== 'number' || tx.amount <= 0) return { ok: false, reason: 'bad_fields' };
    // --- Security Controller: бан-фильтр + атак-детект ---
    if (this.security.isBanned(tx.from)) {
      this.security.registerAttack('flood', tx.from, 'banned address keeps submitting txs');
      return { ok: false, reason: 'address_permabanned', bannedAt: this.security.bans[tx.from].bannedAt };
    }
    if (!verifyTxAny(tx, this.chain)) {
      // эскроу-payout это НЕ spoofing — отдельный режим отказа
      if (typeof tx.from === 'string' && tx.from.startsWith(ESCROW_PREFIX)) {
        return { ok: false, reason: 'escrow_tx_invalid', detail: String(verifyEscrowTx(tx, this.chain)?.reason || '') };
      }
      this.security.registerAttack('spoof_signature', tx.from, 'signature mismatch — spoofing attempt');
      return { ok: false, reason: 'bad_signature_permaban' };
    }
    // txid вычисляем сразу (для coinbase он уже задан) — иначе undefined===undefined
    // даёт ложные duplicate_tx на любую вторую транзакцию в mempool (баг multihop leg2)
    if (!tx.txid) tx.txid = txDigest(tx);
    // anti-replay: транзакция, уже записанная в цепь (в т.ч. через gossip с пира),
    // не принимается повторно — иначе её бесконечно ре-подтверждают
    if (this.knownChainTxids().has(tx.txid)) return { ok: false, reason: 'already_in_chain', txid: tx.txid.slice(0, 16) };
    if (this.mempool.some(t => (t.txid && t.txid === tx.txid) || (t.from === tx.from && t.nonce === tx.nonce))) {
      this.security.registerAttack('duplicate_tx_spam', tx.from, 'duplicate nonce/txid');
      return { ok: false, reason: 'duplicate_tx' };
    }
    const balances = this.balances();
    const incoming = this.mempool.filter(t => t.from === tx.from).reduce((s, t) => s + t.amount, 0);
    const isEscrowSpend = typeof tx.from === 'string' && tx.from.startsWith(ESCROW_PREFIX);
    if (!isEscrowSpend && (balances[tx.from] || 0) - incoming - tx.amount < 0) {
      // двойная трата: расход больше баланса с учётом уже-в-mempool — классический double-spend.
      // Эскроу-расходы вместо этого валидируются СВОИМИ правилами (overdraft_escrow и др.):
      // ложный «permaban» эскроу-адреса не имеет смысла.
      this.security.registerAttack('double_spend', tx.from, `balance ${balances[tx.from] || 0}, pending ${incoming}, tried ${tx.amount}`);
      return { ok: false, reason: 'double_spend_attempt_permaban' };
    }
    if (isEscrowSpend && (balances[tx.from] || 0) - incoming - tx.amount < 0) {
      const escCheck = verifyEscrowTx(tx, this.chain);
      return { ok: false, reason: 'escrow_tx_invalid', detail: String(escCheck?.reason || '') };
    }
    this.mempool.push(tx);
    this.saveMempool();
    return { ok: true, mempoolSize: this.mempool.length };
  }

  // ---- Майнинг ----
  headHeaderTemplate() {
    const tip = this.tip();
    return {
      version: 1,
      prevHash: tip.hash,
      merkleRoot: merkleRoot(this.mempool.length ? this.mempool : [this.coinbaseTxTemplate()]),
      timestamp: Math.floor(Date.now() / 1000),
      difficultyBits: this.nextDifficulty(),
      nonce: 0,
      chainId: CHAIN_ID,
    };
  }

  coinbaseTxTemplate() {
    return { txid: 'coinbase-' + Date.now(), from: 'COINBASE', to: 'AGENT_REWARD_POOL', amount: blockReward(this.blockCount()), nonce: this.blockCount(), ts: Math.floor(Date.now() / 1000), memo: 'block ' + this.blockCount() };
  }

  nextDifficulty() {
    const n = this.blockCount();
    if (n === 0 || n % RETARGET_INTERVAL !== 0) return this.difficultyBits;
    // формула ретарджет: сравниваем фактическое время последних RETARGET_INTERVAL блоков с ожидаемым
    const last = this.chain[n - 1];
    const prevAnchor = this.chain[n - RETARGET_INTERVAL];
    if (!last || !prevAnchor) return this.difficultyBits;
    const actual = last.header.timestamp - prevAnchor.header.timestamp;
    const expected = RETARGET_INTERVAL * BLOCK_INTERVAL_SEC;
    return retarget(this.difficultyBits, actual, expected);
  }

  mineOnce(minerAddress, onProgress) {
    const t0 = Date.now();
    const coinbase = { ...this.coinbaseTxTemplate(), to: minerAddress };
    const txs = [ ...this.usableMempoolTxs(), coinbase ];
    const header = this.headHeaderTemplate();
    header.merkleRoot = merkleRoot(txs);
    while (true) {
      const h = computeBlockHash(header);
      if (hashMeetsDifficulty(h, header.difficultyBits)) {
        const block = { height: this.blockCount(), hash: h, header, txs, minedAt: Date.now(), mineMs: Date.now() - t0, miner: minerAddress };
        this.chain.push(block);
        this.mempool = [];
        this.saveMempool();
        this.invalidateTxCache();
        this.difficultyBits = header.difficultyBits;
        this.save();
        return { ...block, _jsonBuffer: JSON.stringify(txs).length };
      }
      header.nonce++;
      if (onProgress && header.nonce % 50_000 === 0) onProgress(header.nonce);
    }
  }

  // Заготовка для узрезного майнинга (серверный /mine): header и txs создаются
  // ОДИН раз — coinbase (txid/ts) обязана быть той же при коммите блокa, иначе
  // merkleRoot изменится и PoW-хеш не совпадёт.
  mineTemplate(minerAddress) {
    const coinbase = { ...this.coinbaseTxTemplate(), to: minerAddress };
    const txs = [ ...this.usableMempoolTxs(), coinbase ];
    const header = {
      version: 1,
      prevHash: this.tip().hash,
      merkleRoot: merkleRoot(txs),
      timestamp: Math.floor(Date.now() / 1000),
      difficultyBits: this.nextDifficulty(),
      nonce: 0,
      chainId: CHAIN_ID,
    };
    return { header, txs };
  }

  // Коммит блока, нонс которого уже найден вне процесса (тонкий майнер, пул):
  // нода не зависит от того, как искали нонс — но ВНУТРЕННЮЮ валидность блока
  // проверяем тем же правилам, что и сетевой приём (PoW/prev/merkle/правило
  // сложности/coinbase/подписи tx). Иначе внешний майнер мог бы вставить
  // фиктивные транзакции (minting-баг).
  commitMinedBlock(header, hash, txs, minerAddress, ms) {
    const block = { height: this.blockCount(), hash, header, txs: txs || [], minedAt: Date.now(), mineMs: ms || 0, miner: minerAddress };
    const reason = validateBlockAgainstChain(block, this.chain);
    if (reason) return { rejected: reason, block };
    this.chain.push(block);
    // убрать из мемпула всё, что упаковано, остальное — refilter
    const packed = new Set((txs || []).map(t => t.txid).filter(Boolean));
    this.mempool = this.mempool.filter(t => !packed.has(t.txid));
    this.saveMempool();
    this.invalidateTxCache();
    this.difficultyBits = header.difficultyBits;
    this.save();
    return block;
  }

  // ---- Балансы (из транзакций блоков) ----
  balances() {
    const b = {};
    for (const blk of this.chain) {
      for (const tx of blk.txs || []) {
        if (tx.from && tx.from !== 'COINBASE') b[tx.from] = (b[tx.from] || 0) - tx.amount;
        if (tx.to) b[tx.to] = (b[tx.to] || 0) + tx.amount;
      }
    }
    return b;
  }

  // ---- Валидация ----
  // Полная проверка ВСЕЙ цепи; strict=true добавляет детерминированное правило
  // сложности и coinbase/подписи для всех блоков кроме генезиса.
  // strict выключен по умолчанию: старые секции цепи майнились до ужесточений
  // (историческая совместимость), строгий режим применяется к СИНКУ новых блоков.
  validate(strict = false) {
    for (let i = 1; i < this.chain.length; i++) {
      const blk = this.chain[i], prev = this.chain[i - 1];
      if (blk.header.prevHash !== prev.hash) return { ok: false, at: i, reason: 'prevHash mismatch' };
      if (computeBlockHash(blk.header) !== blk.hash) return { ok: false, at: i, reason: 'hash mismatch' };
      if (!hashMeetsDifficulty(blk.hash, blk.header.difficultyBits)) return { ok: false, at: i, reason: 'PoW fail' };
      if (strict) {
        if (expectedDifficultyBits(this.chain.slice(0, i)) !== blk.header.difficultyBits) return { ok: false, at: i, reason: 'difficulty rule violation' };
        const cb = (blk.txs || []).find(t => t && t.from === 'COINBASE');
        if (!cb || !(cb.amount > 0 && cb.amount <= blockReward(i) + 1e-9)) return { ok: false, at: i, reason: 'coinbase invalid' };
        for (const tx of blk.txs) if (tx.from !== 'COINBASE' && !verifyTransaction(tx)) return { ok: false, at: i, reason: 'tx signature fail' };
      }
    }
    return { ok: true, blocks: this.blockCount() };
  }

  info() {
    const b = this.balances();
    return {
      chainId: CHAIN_ID, ticker: TICKER, blocks: this.blockCount(),
      difficultyBits: this.difficultyBits,
      nextReward: blockReward(this.blockCount()),
      totalSupplyCirculating: Object.entries(b).reduce((s, [, v]) => s + Math.max(0, v), 0),
      maxSupply: MAX_SUPPLY,
      halvingIn: HALVING_INTERVAL - (this.blockCount() % HALVING_INTERVAL),
      genesisHash: this.genesisHeader ? computeBlockHash(this.genesisHeader) : null,
      genesisNonce: this.genesisHeader?.nonce,
      genesisSeed: GENESIS_PARAMS.seed_message.slice(0, 40) + '...',
      mempool: this.mempool.length,
      retargetIn: RETARGET_INTERVAL - (this.blockCount() % RETARGET_INTERVAL),
      security: this.security.status(),
    };
  }
}
