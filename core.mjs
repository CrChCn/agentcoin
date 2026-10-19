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
  // P0-1 (аудит 2026-10-18): оборона эскроу-контура от той же «потерянной адресной” привязки:
  // ключ открывшего эскроу должен РАЗВОРАЧИВАТЬСЯ в адрес работодателя (defense-in-depth:
  // openTx уже проверен verifyTransaction, но эскроу-сумма слишком велика для тождественного доверия).
  if (open.openTx?.fromPub && addressFromPub(open.openTx.fromPub) !== open.employer) {
    return { ok: false, reason: 'escrow_open_pub_mismatch' };
  }
  const isOpenPayout = tx.memo.startsWith('escpayout:');
  if (isOpenPayout && !tx.memo.endsWith(escId)) return { ok: false, reason: 'escpayout_memo_mismatch' };

  const paidBefore = escrowPaidOut(chain, escId, tx.memo);
  if (typeof tx.amount !== 'number' || tx.amount <= 0) return { ok: false, reason: 'bad_amount' };
  if (paidBefore + tx.amount > open.openTx.amount + 1e-9) return { ok: false, reason: 'overdraft_escrow', opened: open.openTx.amount, paidBefore, tried: tx.amount };

  if (isOpenPayout) {
    if (tx.to !== open.worker) return { ok: false, reason: 'payout_to_wrong_worker', expected: open.worker };
    // P0-1: ключ приёмщика выписки должен принадлежать ВИЧТЕЛЬНО worker-адресу из открытия эскроу
    const p = tx.escProof || {};
    try { if (addressFromPub(p.workerPub || '') !== open.worker) return { ok: false, reason: 'worker_pub_mismatch' }; } catch { return { ok: false, reason: 'worker_pub_invalid' }; }
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
// R-01 (6274233515 п.2/3): Тора версии digest — fail-closed как C-8: unset → Infinity
// (легаси v1-сеть без v2), ЯВНО заданное некорректное → бросок, не «молча выключено».
// R-02 (6274233515 п.6): Строгая СХЕМА proof — только поля контракта, глубина 1.
// Мемо/доказательства ПУБЛИЧНЫ ПО ДИЗАЙНУ (это проверяемые пруфы, а не секреты) —
// честность контракта: принимаем только схемотические поля и типы, лишние/чужие
// типы отвергаются fail-closed на приёме (не молча режутся на отдаче — принимаем
// подписанный контент; отдаём тот же, без редактирования).
export const ESC_PROOF_KEYS = new Set(['taskHash', 'workerPub', 'workerReceipt', 'employerConfirm']);
export function escProofSchemaError(tx) {
  if (!tx || tx.escProof === undefined) return null;
  const p = tx.escProof;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'tx_esc_proof_schema_rejected';
  for (const k of Object.keys(p)) {
    if (!ESC_PROOF_KEYS.has(k)) return `tx_esc_proof_extra_field:${k}`;
    const v = p[k];
    if (v !== null && typeof v !== 'string') return `tx_esc_proof_bad_type:${k}`;
    if (typeof v === 'string' && v.length > 4096) return `tx_esc_proof_too_long:${k}`;
  }
  return null;
}

export function txDigestV2Activation(opts = {}) {
  const raw = opts.txDigestV2 !== undefined ? opts.txDigestV2 : process.env.AGT_TX_DIGEST_V2_HEIGHT;
  if (raw === undefined || raw === null || raw === '') return Infinity;
  if (raw === Infinity) return Infinity;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`AGT_TX_DIGEST_V2_HEIGHT_invalid: ${JSON.stringify(String(raw))} — задано явно, но не целое в [1, MAX_SAFE_INTEGER] (fail-closed)`);
  }
  return n;
}
export function verifyTxAny(tx, chain = null, opts = {}) {
  if (tx && typeof tx.from === 'string' && tx.from.startsWith(ESCROW_PREFIX)) {
    if (!chain) return false;
    return Boolean(verifyEscrowTx(tx, chain)?.ok);
  }
  // C-7 роутинг версий: v1 (digestVersion отсутствует) — легаси verifyTransaction как было;
  // v2 (digestVersion===2) — строгая v2-семантика. До активации порога валидатор v1-блок
  // от v2-tx отвергается (txid/подпись менялись); сеть согласует отдельным порогом.
  if (tx && tx.digestVersion === 2) {
    // R-01 (6274233515 п.2): v2 включается ТОЛЬКО общим порогом/version-height
    // (AGT_TX_DIGEST_V2_HEIGHT, fail-closed как C-8) — не тихо при digestVersion и
    // не «просто усложнение». Высота: opt.height, иначе chain.length (tx может быть
    // включена в СЛЕДУЮЩИЙ блок этой высоты). До порога v2 не проходит вовсе —
    // это и есть «сохранение legacy до активации».
    const h = (opts && opts.height !== undefined) ? opts.height : (chain ? chain.length : null);
    const act = txDigestV2Activation(opts || {});
    if (h === null || h === undefined || !(h >= act)) return false; // v2 не активен на этой высоте
    return verifyTransactionV2(tx);
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
// R-01/R-03: активная сеть — env AGT_CHAIN_ID (для тестнет/регтеста) иначе main.
// На main без env поведение байт-в-байт прежнее; тестнет задает своё имя сети и не
// может смешиваться с main (genesis/network checks в syncOne уже обрабатывают).
export function networkChainId() { return process.env.AGT_CHAIN_ID || CHAIN_ID; }
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
  // ТРАНЗАКТИВНО-СОВМЕСТИМАЯ v1: НЕ МЕНЯТЬ СЛУШАЙНО (исторические txid/merkle/подписи завязаны).
  // Известное ограничение (CORE-P0 п.3, ревизия 6270365807): авторизационные поля fromPub,
  // escProof и sig2 НЕ входят в digest — они проверяются адресной привязкой (verifyTransaction /
  // verifySecondSig / verifyEscrowTx), но txid их не закрепляет. Новая каноника ниже: digv=2
  //  активируется ОТДЕЛЬНО, после согласования (docs/CORE-P0-DIGEST-PLAN.md).
  return sha256d(JSON.stringify({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, ts: tx.ts, memo: tx.memo || '' }));
}

// ===== CORE-P0 п.3: версионированный canonical digest АВТОРИЗАЦИОННЫХ полей =====
// v1-поля, подписываемые обычной tx: { from, fromPub, to, amount, nonce, ts, memo }.
// v2 добавляет: escProof (эскроу-расходы полностью связаны с контентом), sig2Sig
// (авторизация казны — в digest первичной подписи не попадает, подписывается отдельно),
// и сортировку ключей для каноничности. Диапазон: tx.digestVersion? = 2 (v1 = отсутствие).
export const TX_DIGEST_VERSION = 2;

export function canonicalAuthPayload(tx, version = tx.digestVersion === 2 ? 2 : 1) {
  if (version !== 1 && version !== 2) throw new Error('tx_digest_version_unsupported:' + JSON.stringify(version));
  if (version === 1) {
    // ЛЕГАСИ v1: точная историческая семантика, не меняется.
    const amountUnits = (() => { const u = Math.round(Number(tx.amount) * 1e9); if (!Number.isFinite(u) || u <= 0 || Math.abs(Number(tx.amount) * 1e9 - u) !== 0) throw new Error('tx_amount_not_mgnt_exact'); return u; })();
    return stableStringify({ from: tx.from, fromPub: tx.fromPub, to: tx.to, amountUnits, nonce: tx.nonce, ts: tx.ts, memo: tx.memo || '' });
  }
  // C-7 (6272239263): SIGNING payload v2 — авторизационные поля + привязки контекста.
  // В payload НЕ входят txid/tx.signature/tx.sig2 (циклическая зависимость запрещена).
  // МЕНЯЮТ digest: chainId (network pin), fromPub, escProof целиком, sig2Pub (кто второй
  // подписант), наличие второй подписи (sig2Present флаг — сама sig2-подпись не входит,
  // она подписывает ЭТОТ же payload: любой её tamper меняет final txid, не payload).
  const amountUnits = unitsOfAmountBigInt(tx.amount);
  const payload = {
    domain: 'agt.tx.sign.v2',
    digv: 2,
    chainId: tx.chainId ?? networkChainId(),
    from: tx.from,
    fromPub: tx.fromPub,
    to: tx.to,
    amountUnits: String(amountUnits),
    nonce: tx.nonce,
    ts: tx.ts,
    memo: tx.memo || '',
    escProof: tx.escProof ? JSON.parse(stableStringify(tx.escProof)) : null,
    sig2Pub: tx.sig2Pub ?? null,
    // sig2Present определяется по НАЛИЧИЮ sig2Pub (pubkey второго подписанта): подписант
    // заранее знает, что будет вторая подпись; сама sig2-подпись приходит ПОСЛЕ и не
    // меняет signing-payload (подписывается второй подписью тот же payload).
    sig2Present: tx.sig2Pub ? true : false,
  };
  return stableStringify(payload);
}

// Двх-наустный ключеподписьный stable-sort строк-декор (детерминированный JSON, не для
//-human-reading). Для подписи: подписывающий/проверяющий строят ОДНУ И ТУ ЖЕ строку.
export function stableStringify(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
  const entries = Object.entries(x).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
}

// C-7: SIGNING digest v2 — канонические авторизационные поля + контекст (без txid/tx.signature/tx.sig2).
export function txSigningDigestV2(tx) {
  return sha256d(canonicalAuthPayload(tx, 2));
}

// C-7: FINAL transaction ID v2 = полный подписанный envelope: всё, что подписано
// (+ сами подписи bytes, БЕЗ самой txid). МЕНЯЕТСЯ tamper'ом либо основного подписанта
// (tx.signature), либо второй (tx.sig2), либо их pubkey'ей — txid связывает ЦЕЛОЕ содержимое.
export function txDigestV2(tx) {
  const envelope = {
    signing: canonicalAuthPayload(tx, 2),
    signature: tx.signature || null,
    sig2: tx.sig2 || null,
  };
  return sha256d(stableStringify(envelope));
}

export function signTransactionV2(tx, privKey) {
  const sig = crypto.sign(null, Buffer.from(txSigningDigestV2(tx), 'hex'), privKey);
  return sig.toString('hex');
}

export function verifyTransactionV2(tx) {
  if (!tx || tx.digestVersion !== 2 || tx.fromPub == null) return false;
  if (addressFromPub(tx.fromPub) !== tx.from) return false;
  // R-01 (6274233515 п.2): network pin — ОЖИДАЕМЫЙ chainId: чужая сеть не проходит
  // (было: подпись верна на любом chainId — «V2 OTHER_NETWORK проходит»)
  if ((tx.chainId ?? networkChainId()) !== networkChainId()) return false;
  try {
    return crypto.verify(null, Buffer.from(txSigningDigestV2(tx), 'hex'), tx.fromPub, Buffer.from(tx.signature || '', 'hex'));
  } catch { return false; }
}

// C-7: вторая подпись казны поверх ТОГО ЖЕ signing payload (как v1 — над digest);
// sig2Pub — авторизованный кого policy.signers. Для подписывающего порядок: сначала
// tx без sig2 (sig2Present=false), потом casual re-sign → подпись такая же.
export function verifySecondSigV2(tx, policy, addressOf = addressFromPub) {
  if (!policy || !policy.treasury || tx.from !== policy.treasury) return true;
  if (tx.digestVersion !== 2) return true; // v1 tx — политика не рассматривает v2
  if (typeof tx.sig2 !== 'string' || typeof tx.sig2Pub !== 'string' || !tx.sig2 || !tx.sig2Pub) return false;
  const addr = typeof addressOf === 'function' ? addressOf(tx.sig2Pub) : null;
  if (!addr || !(policy.signers || []).includes(addr)) return false;
  if (tx.sig2Pub === tx.fromPub) return false;
  try {
    return crypto.verify(null, Buffer.from(txSigningDigestV2(tx), 'hex'), tx.sig2Pub, Buffer.from(tx.sig2, 'hex'));
  } catch { return false; }
}

// AGT-адрес из публичного ключа (SPKI PEM) — зеркалит createWallet; нужен для
// проверки второй подписи казны (sig2Pub должен разворачиваться в-approved signer)
export function addressFromPub(pub) {
  const pubHash = sha256d(pub);
  const checksum = sha256d(pubHash).slice(0, 8);
  return 'AGT' + pubHash.slice(0, 32) + checksum;
}

// ==== AGIP-4 (шаг 12): мультисиг казны 2-of-3 ====
// tx от активной казны требует вторую подпись от одного из policy.signers:
// tx.sig2 (hex ed25519 над тем же digest) + tx.sig2Pub; sig2Pub должен разворачиваться
// в адрес одного из доверенных (add желания: ключ казны через fromPub уже учтён как 1-й подписант)
// policy = { treasury, signers:[addr2,addr3], requires:2 } | null; policy=null → ничего не требует.
export function verifySecondSig(tx, policy, addressOf = addressFromPub) {
  if (!policy || !policy.treasury || tx.from !== policy.treasury) return true; // не казна — проверка не применяется
  if (typeof tx.sig2 !== 'string' || typeof tx.sig2Pub !== 'string' || !tx.sig2 || !tx.sig2Pub) return false;
  const addr = typeof addressOf === 'function' ? addressOf(tx.sig2Pub) : null;
  if (!addr || !(policy.signers || []).includes(addr)) return false;  // подписант не из доверенных
  if (tx.sig2Pub === tx.fromPub) return false;                        // два разных ключа (2-of-3, не «двойной клик»)
  try {
    return crypto.verify(null, Buffer.from(txDigest(tx), 'hex'), tx.sig2Pub, Buffer.from(tx.sig2, 'hex'));
  } catch { return false; }
}

export function signTransaction(tx, privKey) {
  const sig = crypto.sign(null, Buffer.from(txDigest(tx), 'hex'), privKey);
  return sig.toString('hex');
}

export function verifyTransaction(tx) {
  if (!tx.signature || !tx.from || !tx.fromPub) return false;
  if (typeof tx.from !== 'string' || typeof tx.fromPub !== 'string' || typeof tx.signature !== 'string') return false;
  // P0-1 (аудит AUDIT-20261018-01, воспроизведено): подпись проверялась переданным
  // fromPub БЕЗ свертки адреса — чужим ключом можно подписать расход с ЧУЖОГО адреса.
  // Теперь ДО crypto.verify требуем строгой адресной привязки anchored к канонической
  // addressFromPub(). Исключений для обычных tx нет; эскроу-адрес проверяет verifyEscrowTx.
  if (addressFromPub(tx.fromPub) !== tx.from) return false;
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
  if (n === 0) return (GENESIS_PARAMS.difficulty_bits ?? GENESIS_PARAMS.difficultyBits); // генезис — 14 бит (пиннинг, ключ snake из.BlackLegion genesis.json)
  if (n === 1) return (chain[0]?.header?.difficultyBits || (GENESIS_PARAMS.difficulty_bits ?? INITIAL_DIFFICULTY_BITS)); // после генезиса продолжаем битами генезиса своей же цепи (пинирование legacy-цепей это живьём требует)
  const tip = chain[n - 1];
  if (n % RETARGET_INTERVAL !== 0) return tip.header.difficultyBits;
  const anchor = chain[n - RETARGET_INTERVAL];
  if (!anchor) return tip.header.difficultyBits;
  return retarget(tip.header.difficultyBits, tip.header.timestamp - anchor.header.timestamp, RETARGET_INTERVAL * BLOCK_INTERVAL_SEC);
}

// ===== CORE-P0 (LEDGER-20261018-01, аудит 2026-10-18, task CORE-P0) =====
// Единый детерминированный набор доп. правил консенсуса, применяемых к блокам
// высотой >= порога активации. Порог: opts.activation (явный, для тестов) или
// env AGT_CORE_P0_HEIGHT (по образцу AGT_MGNT_HEIGHT). Пусто/не задано →
// выключено: полное legacy-поведение, никакой несовместимости без явного решения.
// CORE-P0 п.5 (ревизия 6270365807): конфигурация FAIL-CLOSED — ЯВНО заданное
// некорректное значение (дробное, <1, нечисло) НЕ превращается молча в «выключено»,
// а роняет валидацию ошибкой: расхождение правил Constructu между нодами невозможно.
export const SYSTEM_TX_FROMS = new Set(['COINBASE', 'AGENT_REWARD_POOL']);

export function coreP0ActivationHeight(opts = {}) {
  const raw = opts.activation !== undefined ? opts.activation : process.env.AGT_CORE_P0_HEIGHT;
  if (raw === undefined || raw === null || raw === '') return Infinity;
  if (raw === Infinity) return Infinity;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) {
    throw new Error(`AGT_CORE_P0_HEIGHT_invalid: ${JSON.stringify(String(raw))} — задано явно, но не целое число в [1, MAX_SAFE_INTEGER] (fail-closed: правило НЕ отключается молча, п.5+C-8)`);
  }
  return n;
}

// Единая арифметика tx-влияния на балансы (balancesOf, последовательный replay
// блоков, Blockchain.balances). COINBASE только зачисляет (эмиссия), остальное
// списывает. Одна функция = одна бухгалтерия, ноль расхождений между путями.
export function applyTxToBalances(b, tx) {
  if (!tx) return;
  if (tx.from && tx.from !== 'COINBASE') b[tx.from] = (b[tx.from] || 0) - tx.amount;
  if (tx.to) b[tx.to] = (b[tx.to] || 0) + tx.amount;
}
export function balancesOf(chain) {
  const b = {};
  for (const blk of chain || []) for (const tx of blk.txs || []) applyTxToBalances(b, tx);
  return b;
}
function chainTxidsOf(chain) {
  const s = new Set();
  for (const blk of chain || []) for (const t of (blk.txs || [])) if (t && t.txid) s.add(t.txid);
  return s;
}
// CORE-P0 п.4 (ревизия 6270365807): ключи (from|nonce) ПОЛНОГО префикса — проверка
// не только внутри блока, но и против всей уже-цепной истории (anti replay-nonce).
export function chainNonceKeysOf(chain) {
  const s = new Set();
  for (const blk of chain || []) for (const t of (blk.txs || [])) if (t && t.from) s.add(String(t.from) + '|' + String(t.nonce));
  return s;
}
// C-6 ФИНАЛ: точная бухгалтерия в REPLAY-юнитах (BigInt, масштаб REPLAY_SCALE_EXP).
// Источник истины — САМИ tx (их decimal-записи), НЕ float-снимок balancesOf: сумма
// float-ов может потребовать больше знаков, чем любой из tx (например, 1.08e-19 шум
// суммирования на ESCROW-* → String() даёт 20+ dec, непредставимое в масштабе).
// Per-tx replay — точен всегда: масштаб 19 покрывает ВСЮ immutable-историю
// (доказательство в комментарии на REPLAY_SCALE_EXP). Семантика зеркальна
// applyTxToBalances + правилам unit-пути validateBlockAgainstChain:
// COINBASE только зачисляет, AGENT_REWARD_POOL (legacy-системный) пропускается.
export function applyTxToBalanceUnits(b, tx, scaleExp = REPLAY_SCALE_EXP) {
  if (!tx) return;
  const u = decimalToScaledUnits(tx.amount, scaleExp);
  if (tx.from && tx.from !== 'COINBASE' && tx.from !== 'AGENT_REWARD_POOL') b[tx.from] = (b[tx.from] || 0n) - u;
  if (tx.to) b[tx.to] = (b[tx.to] || 0n) + u;
}
export function chainBalanceUnitsOf(chain, scaleExp = REPLAY_SCALE_EXP) {
  const b = {};
  for (const blk of chain || []) for (const tx of blk.txs || []) applyTxToBalanceUnits(b, tx, scaleExp);
  return b;
}
// Строгая money-арифметика (п.4 + C-6, ревизии 6270365807/6272239263): оперируем точным
// decimal-string → BigInt масштабом магент-юнитов, БЕЗ float-умножения (которое ломало
// законные 15 магент: 0.000000015*1e9 = 14.999999… → «60-точность» артефакты) и БЕЗ
// Number-переполнений (1e7 AGT = 1e16 юнитов — не безопасный float, но валидный BigInt).
// Правило: агNOT exact-decimal строка/common float → бросок tx_amount_not_mgnt_exact;
// история НЕ перезаписывается, checkpoint приводит legacy-балансы к BigInt-масштабу.
export const MGNT_SCALE = 1000000000n; // 1e9 юнитов = 1 AGT

export function unitsOfAmountBigInt(amount) {
  return decimalToScaledUnits(amount, 9n); // магент-масштаб 1e-9 AGT
}

// Универсальный точный decimal→BigInt конвертер: значение интерпретируется по своей
// КОРРЕКТНОЙ decimal-записи (для double это String(x) — короткая round-trip запись,
// возвращающая исходные decimal цифры). НЕ СПРАШИВАЕМ float-умножения: 0.000000015*1e9
// давало 14.999999… (C-6, законные 15 магент отвергались); 1e7 давало unsafe Number.
// scaleExp: сколько десятичных знаков покрывает масштаб (9 — магент, 19 — checkpoint/replay).
// МАСШТАБ 19 — ДОКАЗАННО полный replay живой цепи: повторный replay всех 10924 блоков / 16260 tx
// data/chain.json через decimalToScaledUnits(x, 19) → 0 непредставимых, 0 овердрафтов,
// supply = 546150.0000000000000000000 AGT точно (19 dec, float-артефакты вида
// 0.0012000000000000001 и legacy 90.72999999999945 сохраняются ЦЕЛИКОМ). Масштаб 18
// спотыкался на 146 float-артефактах (19 dec); 19 закрывает ВСЮ immutable-историю без
// округлений/сжиганий/переводов остатков (C-6, 6272239263).
export const REPLAY_SCALE_EXP = 19n;
export function decimalToScaledUnits(amount, scaleExp) {
  let s;
  if (typeof amount === 'string') s = amount.trim();
  else {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error('value_not_positive_or_finite');
    s = String(amount);
  }
  if (s.startsWith('-')) throw new Error('value_not_positive_or_finite');
  // Экспоненциальная форма '1e20' / '2E3' → разворачиваем в точный обычный decimal.
  // R-01/6274233515 п.1: ПРЕЖНЯЯ математика ломала положительную экспоненту ('1e20'@0
  // давало 1e19, '2.5e3'@0 давало 25): repeat(shift - digits.length) сдвигает точку
  // на «минус длина мантиссы» и деление по length вместо исходной позиции десяточной
  // точки. Заново: value = D × 10^K, K = E - F (F = длина дробной части), точка
  // двигается на K позиций от КОНЦА целой части мантиссы, стартовые нули снимаются
  // ПОСЛЕ позиционирования (иначе 0.12e3 → '12'+'0' влезал лишний ноль).
  const em = s.match(/^(\d+)(?:\.([0-9]+))?e([-+]?\d+)$/i);
  if (em) {
    const D = em[1] + (em[2] || '');        // непозиционный цифровой мантиссы
    const F = (em[2] || '').length;        // сколько знаков было дробными
    const K = parseInt(em[3], 10) - F;      // точка двигается на K
    let intStr, fracStr;
    if (K >= 0) { intStr = D + '0'.repeat(K); fracStr = ''; }
    else {
      const cut = D.length + K;            // точная позиция точки внутри D
      if (cut > 0) { intStr = D.slice(0, cut); fracStr = D.slice(cut); }
      else { intStr = '0'; fracStr = '0'.repeat(-cut) + D; }
    }
    intStr = intStr.replace(/^0+(?=\d)/, '');
    s = intStr + (fracStr ? '.' + fracStr : '');
  }
  const maxFrac = Number(scaleExp);
  const dm = s.match(/^\d+(?:\.\d+)?$/);
  if (!dm) throw new Error('value_not_decimal');
  const [i, f = ''] = s.split('.');
  if (f.length > maxFrac) throw new Error(`value_exceeds_scale_${maxFrac}`);
  const units = BigInt(i) * 10n ** scaleExp + BigInt((f + '0'.repeat(maxFrac)).slice(0, maxFrac));
  return units;
}

// Обратная совместимость старого API (легаси-путь): тоже без float-умножения —
// строка → BigInt → Number (допустимо для малых значений интерфейса;консенсус использует *_BigInt).
export function unitsOfAmount(amount) {
  const u = unitsOfAmountBigInt(amount);
  if (u > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('tx_amount_not_safe_number');
  return Number(u);
}

// ===== MINER-GUARD + TWIN-SWEEP (LEDGER-20261018-01: « Moyens двойника», MINER-GUARD/OPS-TEST) =====
// Канонический адрес = AGT + 40 hex (43 символа) и всегда выводится из pubkey
// (addressFromPub). Адрес любой другой формы (напр. «двойник» казны из опечатки
// run-miner.cmd — 42 символа, h66…h609, 278 coinbase × 50 = 13 900 AGT, исходящих 0)
// НЕ может быть адресом никакого ключа, поэтому навсегда несопровождаем тратами.
export const ADDRESS_RE = /^AGT[0-9a-f]{40}$/;
export function isCanonicalAddress(a) { return typeof a === 'string' && ADDRESS_RE.test(a); }


// Строгая валидация блока, продолжающего chain на высоте chain.length.
// Возвращает null если блок валиден, иначе строку-причину отказа.
// Проверяет: высоту, prevHash, hash, PoW, ПРАВИЛО СЛОЖНОСТИ, merkle,
// coinbase (наличие + без инфляции мимо blockReward).
// При активации CORE-P0 (block.height >= порога) ДОБАВЛЯЕТ:
//  · chainId заголовка === CHAIN_ID;
//  · РОВНО ОДИН coinbase (двойной coinbase = эмиссия мимо blockReward закрывается);
//  · coinbase с каноническим txid (txid === txDigest);
//  · канонический txid КАЖДОЙ tx — merkleRoot привязан к содержимому (digest),
//    а не к переданному id;
//  · запрет произвольных системных расходов (AGENT_REWARD_POOL c "from");
//  · конечные положительные суммы;
//  · replay-защиту: txid уже в цепи и повтор txid/(from,nonce) внутри блока;
//  · ПОСЛЕДОВАТЕЛЬНУЮ бухгалтерию: баланс отправителя не уходит в минус
//    ни на одном шаге внутри блока (double-spend в одном блоке невозможен).
export function validateBlockAgainstChain(block, chain, opts = {}) {
  if (!block || !block.header || !Array.isArray(block.txs)) return 'bad_block_shape';
  if (typeof block.height !== 'number' || block.height !== chain.length) return 'height_mismatch';
  if (block.height === 0) return 'genesis_redefined'; // генезис не принимается по сети
  const prev = chain[chain.length - 1];
  if (!prev || block.header.prevHash !== prev.hash) return 'prevHash_mismatch';
  if (computeBlockHash(block.header) !== block.hash) return 'hash_mismatch';
  if (!hashMeetsDifficulty(block.hash, block.header.difficultyBits)) return 'pow_fail';
  if (block.header.difficultyBits !== expectedDifficultyBits(chain)) return 'difficulty_rule_violation';
  if (block.header.merkleRoot !== merkleRoot(block.txs)) return 'merkle_mismatch';
  const act = coreP0ActivationHeight(opts);
  const coreP0 = typeof block.height === 'number' && block.height >= act;
  const v2Act = txDigestV2Activation(opts); // R-01: единый порог digest-версии (fail-closed)
  if (coreP0 && block.header.chainId !== CHAIN_ID) return 'chainId_mismatch';
  const cbs = (block.txs || []).filter(t => t && t.from === 'COINBASE');
  const allowed = blockReward(block.height);
  const rewardZero = !(Number(allowed) > 0);
  if (cbs.length === 0) {
    // R-01 off-grid/zero-tail policy: при НЕНУЛЕВОЙ награде coinbase обязателен;
    // при НУЛЕВОЙ (off-grid будущие/нулевые хвосты) — отсутствие coinbase корректно,
    // но ТОЛЬКО при активном CORE-P0 (легаси поведение байт-в-байт прежнее).
    if (!rewardZero || !coreP0) return 'coinbase_missing';
  } else {
    if (coreP0 && cbs.length > 1) return 'multiple_coinbase'; // доп. эмиссия мимо blockReward
  }
  const cb = cbs[0] || null;
  if (cb) {
    if (!rewardZero && !(cb.amount > 0)) return 'coinbase_inflation';
    if (coreP0) {
      // R-01 (6274233515 п.6 от раздела rewards): epsilon +1e-9 удалён — точная
      // magent-арифметика: 50.000000001 при награде 50 НЕ проходит (было: проходил).
      // Нулевая награда: coinbase допустим ТОЛЬКО с amount==0 (шаблон майнера),
      // любая эмиссия сверх неё — 'coinbase_inflation'.
      let cbU;
      try { cbU = unitsOfAmountBigInt(cb.amount); } catch { return 'coinbase_amount_not_mgnt_exact'; }
      let allowedU;
      try { allowedU = unitsOfAmountBigInt(allowed); } catch { return 'reward_schedule_not_mgnt_exact'; }
      if (rewardZero) { if (!(cbU === 0n)) return 'coinbase_inflation'; }
      else if (!(cb.amount > 0 && cbU <= allowedU)) return 'coinbase_inflation';
    } else {
      if (!(cb.amount > 0 && cb.amount <= allowed + 1e-9)) return 'coinbase_inflation';
    }
  }
  if (coreP0 && cb && (typeof cb.txid !== 'string' || cb.txid !== txDigest(cb))) return 'coinbase_txid_not_canonical';
  // MINER-GUARD: получатель награды обязан быть каноническим адресом (AGT + 40 hex).
  // Именно эта проверка отвергла бы «двойника» казны (42 символа) ещё на h66.
  if (coreP0 && !isCanonicalAddress(cb.to)) return 'coinbase_bad_recipient';
  // replay-контекст: opts.knownTxids — множество txid префикса (вызывающий может
  // поддерживать его инкрементально, см. adoptFork/sync); иначе строим из chain
  const knownSet = opts.knownTxids instanceof Set ? opts.knownTxids : (coreP0 ? chainTxidsOf(chain) : null);
  // CORE-P0 п.4: nonce-ключи (from|nonce) ПОЛНОГО префикса — не только внутри блока
  const knownNonces = opts.knownNonceKeys instanceof Set ? opts.knownNonceKeys : (coreP0 ? chainNonceKeysOf(chain) : null);
  // CORE-P0 п.4: бухгалтерия префикса в целых магент-юнитах (дробный float-шум невозможен)
  let balances = opts.prefixBalances && typeof opts.prefixBalances === 'object'
    ? { ...opts.prefixBalances }
    : (coreP0 ? balancesOf(chain) : null);
  let balanceUnits = null;
  if (coreP0) {
    // C-6 (6272239263): replay исходных decimal значений → BigInt масштаб REPLAY_SCALE_EXP=19:
    // legacy-точность (вся история цепи — доказательство живого replay в комментарии
    // на REPLAY_SCALE_EXP) сохраняется ЦЕЛИКОМ, НИЧЕГО не округляется/сжигается;
    // будущие magent-дельты (1e-9) приводятся в этот масштаб.
    if (opts.prefixBalanceUnits && typeof opts.prefixBalanceUnits === 'object') {
      // Явный готовый BigInt-контекст (incremental путь adoptFork/sync): берём как есть.
      balanceUnits = { ...opts.prefixBalanceUnits };
    } else if (opts.prefixBalances && typeof opts.prefixBalances === 'object') {
      // Явный float/decimal-снимок от вызывающего (external prefix): конвертация без
      // округлений; непредставимое в масштабе → fail-closed с адресом.
      balanceUnits = {};
      for (const [addr, b] of Object.entries(opts.prefixBalances)) {
        let u;
        try { u = decimalToScaledUnits(b, REPLAY_SCALE_EXP); } catch { return `prefix_balance_not_mgnt_exact:${addr}`; }
        balanceUnits[addr] = u; // в REPLAY-юнитах (AGT × 1e19)
      }
    } else {
      // C-6 финал: источник истины — сама цепь. Точный per-tx replay в юнитах:
      // сумма float-ов тут даже не строится (шум суммирования невозможен).
      balanceUnits = chainBalanceUnitsOf(chain);
    }
  }
  const seenTxids = new Set();
  const seenNonceKeys = new Set();
  // обычные транзакции: подписи и базовые инварианты
  for (const tx of block.txs) {
    if (tx.from === 'COINBASE') continue; // coinbase (единственный) проверен выше
    if (coreP0 && SYSTEM_TX_FROMS.has(tx.from)) return 'system_spend_forbidden';
    if (!coreP0 && tx.from === 'AGENT_REWARD_POOL') continue; // legacy: до активации системные tx пропускались по имени
    if (!tx.from || !tx.to || typeof tx.amount !== 'number' || tx.amount <= 0) return 'tx_bad_fields';
    if (coreP0) {
      if (!Number.isFinite(tx.amount)) return 'tx_bad_amount';
      // MINER-GUARD: получатель обычной tx обязан быть каноническим адресом
      // (эскроу-open платят в ESCROW_<id> — свои правила); предотвращает создание
      // «сиротских» адресов-опечаток операторными и XML-инструментами
      if (!isCanonicalAddress(tx.to) && !String(tx.to).startsWith(ESCROW_PREFIX)) return 'tx_bad_recipient';
      // R-01 (6274233515 п.2/3/friendly): единый version-routing txid/подписи/2sig.
      // hybrid прееффикс: v2 нужна ТОЛЬКО на активном пороге; до порога — v1 и только.
      const txV2 = tx.digestVersion === 2;
      if (txV2) {
        if (!(block.height >= v2Act)) return 'tx_digest_version_not_active'; // до порога v2 нет совсем
        if ((tx.chainId ?? networkChainId()) !== networkChainId()) return 'tx_network_mismatch';
      }
      if (txV2 && tx.from && String(tx.from).startsWith(ESCROW_PREFIX)) return 'escrow_digest_version_unsupported'; // v2-эскроу отдельно (R-19)
      // merkle привязан к каноническому содержимому, не к переданному txid :
      // канонический digest зависит от АКТИВНОЙ версии (v1 → txDigest, v2 → txDigestV2)
      const canonDigest = txV2 ? txDigestV2(tx) : txDigest(tx);
      if (typeof tx.txid !== 'string' || tx.txid !== canonDigest) return 'txid_not_canonical';
      if (seenTxids.has(tx.txid)) return 'duplicate_txid_block';
      if (knownSet && knownSet.has(tx.txid)) return 'tx_replay_in_chain';
      const nkey = String(tx.from) + '|' + String(tx.nonce);
      if (seenNonceKeys.has(nkey)) return 'duplicate_nonce_block';
      if (knownNonces && knownNonces.has(nkey)) return 'nonce_replay_in_chain'; // п.4: против ПОЛНОГО префикса
      seenTxids.add(tx.txid);
      seenNonceKeys.add(nkey);
    }
    // AGIP-9 (деноминация): сумма кратна магенту (1e-9 AGT) с activates-at-height,
    // иначе мягкий отказ (активация — env AGT_MGNT_HEIGHT, 0 = выкл. по умолчанию на старых нодах)
    const mgntH = Number(process.env.AGT_MGNT_HEIGHT || 0);
    if (mgntH > 0 && chain.length >= mgntH) {
      const mgnt = Math.round(tx.amount * 1e9);
      if (mgnt < 1) return 'tx_not_mgnt_aligned'; // меньше 1 магента не проходит
      if (Math.abs(tx.amount * 1e9 - mgnt) > 1e-3) return 'tx_not_mgnt_aligned';
    }
    if (!verifyTxAny(tx, chain, { height: block.height, txDigestV2: v2Act })) return 'tx_bad_signature_or_escrow';
    // AGIP-4: tx из активной казны требует вторую подпись (opts.treasury инжектится нодой;
    // без передачи политика не проверяется — старые вызовы/пированные цепи ведут себя как раньше).
    // R-01: вторая подпись обязана быть той же ВЕРСИИ, что и основная (v2-tx → только
    // verifySecondSigV2 над v2-подписывающим payload; hybrid V2-primary + V1-sig2 отвергнут).
    if (opts.treasury && !(tx.digestVersion === 2 ? verifySecondSigV2(tx, opts.treasury) : verifySecondSig(tx, opts.treasury))) {
      if (tx.digestVersion === 2 && tx.sig2 === undefined && tx.sig2Pub === undefined) return 'tx_treasury_needs_2sig';
      return tx.digestVersion === 2 ? 'tx_treasury_2sig_version_mismatch' : 'tx_treasury_needs_2sig';
    }
    if (coreP0 && balanceUnits) {
      // ПОСЛЕДОВАТЕЛЬНАЯ бухгалтерия в REPLAY-юнитах BigInt (п.4 + C-6): tx суммы — ЦЕЛЫЕ
      // магенты (×10^9 в replay-масштабе); legacy-дольки остаются в балансе (не сжигаются),
      // но потратить их нельзя (меньше минимальной единицы); овердрафт исключён строго.
      let amountUnits;
      try { amountUnits = unitsOfAmountBigInt(tx.amount); } catch { return 'tx_amount_not_mgnt_exact'; }
      const delta = amountUnits * (10n ** (REPLAY_SCALE_EXP - 9n)); // magent → replay-масштаб
      balanceUnits[tx.from] = (balanceUnits[tx.from] || 0n) - delta;
      if (balanceUnits[tx.from] < 0n) return 'insufficient_funds_block';
      balanceUnits[tx.to] = (balanceUnits[tx.to] || 0n) + delta;
    } else if (coreP0 && balances) {
      // fallback (не должен выполняться на coreP0-пути — баланс-юниты строятся всегда)
      balances[tx.from] = (balances[tx.from] || 0) - tx.amount;
      if (!(balances[tx.from] >= -1e-9)) return 'insufficient_funds_block';
      balances[tx.to] = (balances[tx.to] || 0) + tx.amount;
    } else if (balances) {
      balances[tx.from] = (balances[tx.from] || 0) - tx.amount;
      if (!(balances[tx.from] >= -1e-9)) return 'insufficient_funds_block';
      balances[tx.to] = (balances[tx.to] || 0) + tx.amount;
    }
  }
  if (coreP0 && balanceUnits) {
    // coinbase: зачисление награды (ЦЕЛЫЕ магенты → replay-масштаб)
    let cbUnits;
    try { cbUnits = unitsOfAmountBigInt(cb.amount); } catch { return 'coinbase_amount_not_mgnt_exact'; }
    balanceUnits[cb.to] = (balanceUnits[cb.to] || 0n) + cbUnits * (10n ** (REPLAY_SCALE_EXP - 9n));
  } else if (coreP0 && balances) {
    balances[cb.to] = (balances[cb.to] || 0) + cb.amount;
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
    // AGIP-4: инжектится нодой (treasury.mjs); null = политика казны не проверяется
    this.treasuryPolicyFn = null;
    this.security = new SecurityController(dataDir);
    this.whitelist = new WhiteList(dataDir, this.security);
    this.gateways = new Gateways(dataDir, this.security);
    this.pool = new MiningPool(dataDir, this.security);
    this.load();
    if (this.blockCount() === 0) this.createGenesis();
  }

  load() {
    // AGIP-17 (разгрузка): если основной файл повреждён (kill во время записи) —
    // фолбэк на .tmp: crash при записи больше не означает потерю цепи.
    const readChain = () => {
      for (const f of [this.file, this.file + '.tmp']) {
        try {
          if (!fs.existsSync(f)) continue;
          const d = JSON.parse(fs.readFileSync(f, 'utf8'));
          this.chain = d.chain || [];
          this.difficultyBits = d.difficultyBits ?? INITIAL_DIFFICULTY_BITS;
          this.genesisHeader = d.genesisHeader || null;
          return true;
        } catch { /* битый или не существует — следующий */ }
      }
      return false;
    };
    readChain();
    try { this.loadMempool(); this.loadForks(); } catch { /* новый каталог */ }
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
  invalidateTxCache() { this._chainTxidCache = null; this._chainBalanceUnitsCache = null; }
  // C-6 финал: точные баланс-юниты (BigInt) — как knownTxids: ленивый кэш по цепи,
  // инвалидация вместе с txid-кэшем. Источник — chainBalanceUnitsOf (per-tx replay).
  balanceUnits() {
    if (!this._chainBalanceUnitsCache) this._chainBalanceUnitsCache = chainBalanceUnitsOf(this.chain);
    return this._chainBalanceUnitsCache;
  }

  // AGIP-4: активная политика казны (кэш внутри treasury.mjs.makeTreasuryPolicyFn)
  getTreasuryPolicy() { return this.treasuryPolicyFn ? this.treasuryPolicyFn() : null; }

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
    // CORE-P0: инкрементальные replay/balance-контексты — одна цена на всю развилку:
    // known = txid префикса + уже проверенных блоков; bal = последовательные балансы.
    const known = new Set();
    for (const b of prefix) for (const t of (b.txs || [])) if (t && t.txid) known.add(t.txid);
    const bal = balancesOf(prefix);
    const balUnits = chainBalanceUnitsOf(prefix); // точный контекст в REPLAY-юнитах (C-6)
    for (let i = 0; i < blocks.length; i++) {
      const reason = validateBlockAgainstChain(blocks[i], prefix.concat(blocks.slice(0, i)), {
        treasury: this.getTreasuryPolicy(), knownTxids: known, prefixBalances: bal, prefixBalanceUnits: balUnits,
      });
      if (reason) return { ok: false, reason: `block@${blocks[i].height}: ${reason}` };
      for (const t of (blocks[i].txs || [])) if (t && t.txid) known.add(t.txid);
      for (const t of (blocks[i].txs || [])) { applyTxToBalances(bal, t); applyTxToBalanceUnits(balUnits, t); }
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
    // AGIP-17 (разгрузка): 1) компактный JSON — pretty-print съедал ~40% объёма
    // и лишний CPU на stringify на каждом блоке (это заметная доля loopLag);
    // 2) атомарная запись .tmp → rename: kill/crash во время записи не рвёт chain.json.
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      chainId: CHAIN_ID, chain: this.chain, difficultyBits: this.difficultyBits,
      genesisHeader: this.genesisHeader,
    }));
    fs.renameSync(tmp, this.file);
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
    // R-02 (6274233515 п.6): строгая схема proof — только поля контракта, глубина 1,
    // fail-closed на лишних/структурно чужом (было «выполнять только подписанные поля»
    // на отдаче — но принималось всё, включая escProof.privateKey).
    const proofErr = escProofSchemaError(tx);
    if (proofErr) return { ok: false, reason: proofErr };
    // fail-fast до бан-фильтра: неканонический получатель не должен трогать досяжные
    // счётчики/бани и создавать будущие «двойников»-ситуации
    if (!String(tx.to).startsWith(ESCROW_PREFIX) && !isCanonicalAddress(tx.to)) return { ok: false, reason: 'bad_recipient' };
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
      // P0-2 (аудит 2026-10-18): registerAttack('spoof_signature', tx.from) тут был той же
      // дырой, что и в HTTP /tx: забанить можно ЛЮБОЙ заявленный адрес одним подделанным tx.
      // Отказ без санкций к from; ratelimit/spam остаётся транспортным уровнем.
      return { ok: false, reason: 'bad_signature' };
    }
    // txid вычисляем сразу (для coinbase он уже задан) — иначе undefined===undefined
    // даёт ложные duplicate_tx на любую вторую транзакцию в mempool (баг multihop leg2)
    if (!tx.txid) tx.txid = txDigest(tx);
    // anti-replay: транзакция, уже записанная в цепь (в т.ч. через gossip с пира),
    // не принимается повторно — иначе её бесконечно ре-подтверждают
    if (this.knownChainTxids().has(tx.txid)) return { ok: false, reason: 'already_in_chain', txid: tx.txid.slice(0, 16) };
    if (this.mempool.some(t => (t.txid && t.txid === tx.txid) || (t.from === tx.from && t.nonce === tx.nonce))) {
      // Дубликат =_Idempotent-отказ, не спам-атака: повторная отправка той же tx
      // (гонка gossip/ретрай) не должна выжигать strike'и до flood-бана честных агентов
      // (инцидент 2026-10-14: агенты волны-1 попали в пермабан из-за повторов).
      return { ok: false, reason: 'duplicate_tx', txid: tx.txid.slice(0, 16) };
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
    // AGIP-4: tx из активной казны — обязательна вторая подпись (2-of-3),
    // до push в mempool; отклонение — «treasury_needs_2sig», без бан-эскалации
    if (!verifySecondSig(tx, this.getTreasuryPolicy())) return { ok: false, reason: 'treasury_needs_2sig' };
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
    const t = { from: 'COINBASE', to: 'AGENT_REWARD_POOL', amount: blockReward(this.blockCount()), nonce: this.blockCount(), ts: Math.floor(Date.now() / 1000), memo: 'block ' + this.blockCount() };
    // CORE-P0: coinbase с каноническим txid (txid === txDigest) — активированный валидатор требует этого от новых блоков
    t.txid = txDigest(t);
    return t;
  }

  nextDifficulty() {
    const n = this.blockCount();
    // зеркало expectedDifficultyBits(): после генезиса (n=1) продолжаем БИТАМИ ГЕНЕЗИСА,
    // иначе свежая нода майнит свой первый блок с difficultyBits=INITIAL (12) против
    // валидации, ждущей биты генезиса (14) → commit_rejected/difficulty_rule_violation,
    // и чистая нода не может намайнить НИ ОДНОГО блока (поймано accept'ом AGIP-3 на песочнице)
    if (n === 1) return (this.chain[0]?.header?.difficultyBits || this.difficultyBits);
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
    coinbase.txid = txDigest(coinbase); // CORE-P0: txid каноничен по ИТОГОВОМУ получателю (шаблон считал до подмены to)
    const txs = [ ...this.usableMempoolTxs(), coinbase ];
    const header = this.headHeaderTemplate();
    header.merkleRoot = merkleRoot(txs);
    while (true) {
      const h = computeBlockHash(header);
      if (hashMeetsDifficulty(h, header.difficultyBits)) {
        const block = { height: this.blockCount(), hash: h, header, txs, minedAt: Date.now(), mineMs: Date.now() - t0, miner: minerAddress };
        // CORE-P0 (п.2 ревизии 6270365807): внутренний майнер НЕ исключение — тот же
        // единый verifier, что и сетевые пути (commitMinedBlock/adoptFork/sync).
        const reason = validateBlockAgainstChain(block, this.chain, { treasury: this.getTreasuryPolicy(), knownTxids: this.knownChainTxids(), prefixBalances: this.balances(), prefixBalanceUnits: this.balanceUnits() });
        if (reason) return { rejected: reason, block };
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
    coinbase.txid = txDigest(coinbase); // CORE-P0: txid каноничен по ИТОГОВОМУ получателю (шаблон считал до подмены to)
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
    const reason = validateBlockAgainstChain(block, this.chain, { treasury: this.getTreasuryPolicy(), knownTxids: this.knownChainTxids(), prefixBalances: this.balances(), prefixBalanceUnits: this.balanceUnits() });
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
    // CORE-P0: одна арифметика tx-влияния (applyTxToBalances/balancesOf) для всех путей
    return balancesOf(this.chain);
  }

  // ---- Валидация ----
  // Полная проверка ВСЕЙ цепи; strict=true добавляет детерминированное правило
  // сложности и coinbase/подписи для всех блоков кроме генезиса.
  // strict выключен по умолчанию: старые секции цепи майнились до ужесточений
  // (историческая совместимость), строгий режим применяется к СИНКУ новых блоков.
  validate(strict = false) {
    if (!strict) {
      for (let i = 1; i < this.chain.length; i++) {
        const blk = this.chain[i], prev = this.chain[i - 1];
        if (blk.header.prevHash !== prev.hash) return { ok: false, at: i, reason: 'prevHash mismatch' };
        if (computeBlockHash(blk.header) !== blk.hash) return { ok: false, at: i, reason: 'hash mismatch' };
        if (!hashMeetsDifficulty(blk.hash, blk.header.difficultyBits)) return { ok: false, at: i, reason: 'PoW fail' };
      }
      return { ok: true, blocks: this.blockCount() };
    }
    // CORE-P0: строгий полный проход теперь использует ЕДИНЫЙ сетевой верификатор
    // (требование аудита: один verifier вместо расходящихся путей). Эскроу tx
    // валидируются своими правилами против соответствующего префикса — историческая
    // сверка h307 больше не падает; новые правила применяются только к высотам >=
    // активации (env AGT_CORE_P0_HEIGHT / opts.activation).
    for (let i = 1; i < this.chain.length; i++) {
      const reason = validateBlockAgainstChain(this.chain[i], this.chain.slice(0, i), { treasury: this.getTreasuryPolicy() });
      if (reason) return { ok: false, at: i, reason };
    }
    const bal = balancesOf(this.chain);
    const neg = Object.entries(bal).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v < -1e-9);
    const supply = Object.entries(bal).reduce((s, [, v]) => s + Math.max(0, v || 0), 0);
    return { ok: true, blocks: this.blockCount(), negativeBalances: neg.length, totalSupply: supply };
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
