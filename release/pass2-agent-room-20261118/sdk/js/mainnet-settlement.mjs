#!/usr/bin/env node
/* Нативный AGT: чтение балансов из основной сети + прямой перевод заказчик→исполнитель.
 * Поверх консенсуса (core.mjs НЕ меняется): только чтение цепи + сборка/проверка
 * обычных tx через существующие verify/sign/digest правила.
 *
 * Правила:
 *  - chainId обязан быть AGENTCOIN, genesisHash обязан совпасть с пином mainnet.
 *  - Деньги — целые атомарные единицы (магнеты, 1 AGT = 1_000_000_000).
 *  - Приватный ключ НЕ принимается сервером/сайтом: подпись только локально
 *    у владельца (signTransfer), сервер принимает только уже подписанные tx.
 *  - Перед подписью: заказ, получатель, сумма, комиссия — previewTransfer.
 *  - Автономные платежи только внутри политики расходов владельца.
 *  - orderId → obligationId → signed tx → txid; повтор отправляет ТЕ ЖЕ байты.
 *  - «Оплачено» только после: получатель+сумма совпали, tx в канонической цепи,
 *    глубина >= CONFIRM_DEPTH; при реорге — повторная сверка.
 *  - Приёмка и оплата разделены; нехватка средств/отказ подписи = честный отказ,
 *    не фиктивный успех. Прямой перевод НЕ называется эскроу (kind direct-transfer).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  networkChainId, GENESIS_PARAMS, computeBlockHash,
  unitsOfAmountBigInt, chainBalanceUnitsOf, REPLAY_SCALE_EXP,
  signTransaction, verifyTransaction, txDigest, isCanonicalAddress,
} from '../../core.mjs';

export const MAINNET_CHAIN_ID = 'AGENTCOIN';
export const MAINNET_GENESIS_HASH = '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e';
export const MGNT_PER_AGT = 1000000000n;
export const CONFIRM_DEPTH_DEFAULT = 6;
// Комиссия протокола: в действующей цепи отсутствует (ноль). Показываем явно.
export const PROTOCOL_FEE_ATOMIC = 0n;

export function assertMainnetChainId(chainId) {
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`wrong_network: expected ${MAINNET_CHAIN_ID}, got ${String(chainId)}`);
  }
}

export function assertMainnetGenesis(genesisHash) {
  if (String(genesisHash).toLowerCase() !== MAINNET_GENESIS_HASH) {
    throw new Error(`wrong_genesis: expected ${MAINNET_GENESIS_HASH}, got ${String(genesisHash)}`);
  }
}

// Строгий перевод AGT-суммы в атомарные единицы (целые магнеты, без float).
export function toAtomic(amount) {
  if (typeof amount === 'string' && !/^\d+(\.\d+)?$/.test(amount.trim())) {
    throw new Error('bad_amount: only plain decimal, no exponent');
  }
  let u;
  try {
    u = unitsOfAmountBigInt(amount);
  } catch (e) {
    throw new Error('bad_amount: ' + String(e.message || e).slice(0, 120));
  }
  if (u <= 0n) throw new Error('bad_amount: must be positive integer atomic units');
  if (u > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('bad_amount: exceeds safe tx range');
  // round-trip: число обязано точно представлять атомы (иначе float-артефакт)
  const asNum = Number(u) / 1e9;
  const back = unitsOfAmountBigInt(asNum);
  if (back !== u) throw new Error('bad_amount: not representable as exact atomic units');
  return u;
}

export function fromAtomic(atomic) {
  const u = BigInt(atomic);
  const whole = u / MGNT_PER_AGT;
  const frac = u % MGNT_PER_AGT;
  if (frac === 0n) return String(whole);
  return `${whole}.${String(frac).padStart(9, '0').replace(/0+$/, '')}`;
}

// Чтение цепи mainnet (read-only). Проверяет chainId окружения + генезис файла.
export function loadMainnetChain(dataDir) {
  const file = path.join(dataDir, 'chain.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertMainnetChainId(networkChainId());
  const chain = raw.chain || [];
  if (!chain.length) throw new Error('empty_chain');
  const genesisHash = chain[0].hash || computeBlockHash(chain[0].header);
  assertMainnetGenesis(genesisHash);
  if (chain[0].header?.chainId && chain[0].header.chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`wrong_network: genesis chainId ${chain[0].header.chainId}`);
  }
  return { chain, genesisHash, tip: chain[chain.length - 1], blocks: chain.length };
}

// Баланс адреса в атомарных единицах (точный per-tx replay, без float-сумм).
export function balanceAtomic(chain, address) {
  const units = chainBalanceUnitsOf(chain); // масштаб 1e19
  const v = units[address] || 0n;
  const scaleDiff = REPLAY_SCALE_EXP - 9n;
  const div = 10n ** scaleDiff;
  // Legacy-пыль меньше магнета не тратится, но честно показываем остаток пыли.
  return { atomic: v / div, dustUnits: v % div };
}

// Политика расходов владельца (файл, правит только владелец кошелька).
// { maxPerPaymentAtomic: "1000000000", maxPerDayAtomic: "...", autonomous: true,
//   allowedRecipients: null | [addr...], requireManualApproveAboveAtomic: "..." }
export function loadSpendPolicy(file) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      maxPerPaymentAtomic: p.maxPerPaymentAtomic != null ? BigInt(p.maxPerPaymentAtomic) : null,
      maxPerDayAtomic: p.maxPerDayAtomic != null ? BigInt(p.maxPerDayAtomic) : null,
      autonomous: p.autonomous !== false,
      allowedRecipients: Array.isArray(p.allowedRecipients) ? p.allowedRecipients : null,
      requireManualApproveAboveAtomic: p.requireManualApproveAboveAtomic != null
        ? BigInt(p.requireManualApproveAboveAtomic) : null,
    };
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new Error('bad_policy: ' + String(e.message || e).slice(0, 200));
  }
}

export function checkSpendPolicy({ policy, amountAtomic, recipient, daySpentAtomic = 0n, manualApprove = false }) {
  if (!policy) return { ok: false, reason: 'no_policy', hint: 'владелец задаёт settlement-policy.json явно' };
  const amt = BigInt(amountAtomic);
  if (policy.allowedRecipients && !policy.allowedRecipients.includes(recipient)) {
    return { ok: false, reason: 'recipient_not_allowlisted' };
  }
  if (policy.maxPerPaymentAtomic != null && amt > policy.maxPerPaymentAtomic) {
    return { ok: false, reason: 'exceeds_per_payment_limit' };
  }
  if (policy.maxPerDayAtomic != null && BigInt(daySpentAtomic) + amt > policy.maxPerDayAtomic) {
    return { ok: false, reason: 'exceeds_daily_limit' };
  }
  const needManual = policy.requireManualApproveAboveAtomic != null && amt > policy.requireManualApproveAboveAtomic;
  if (needManual && !manualApprove) return { ok: false, reason: 'manual_approval_required' };
  if (!policy.autonomous && !manualApprove) return { ok: false, reason: 'autonomous_disabled' };
  return { ok: true, autonomous: !needManual && policy.autonomous };
}

// Что увидит владелец ПЕРЕД подписью. Подписи здесь нет.
export function previewTransfer({ orderId, payer, recipient, amountAtomic, memo = '' }) {
  if (!orderId || !payer || !recipient) throw new Error('bad_preview: orderId/payer/recipient required');
  if (!isCanonicalAddress(recipient)) throw new Error('bad_recipient');
  const amt = BigInt(amountAtomic);
  if (amt <= 0n) throw new Error('bad_amount');
  return {
    kind: 'direct-transfer',
    escrow: false,
    orderId: String(orderId),
    payer: String(payer),
    recipient: String(recipient),
    amountAtomic: String(amt),
    amountAGT: fromAtomic(amt),
    feeAtomic: String(PROTOCOL_FEE_ATOMIC),
    feeAGT: '0',
    totalAtomic: String(amt + PROTOCOL_FEE_ATOMIC),
    memo: String(memo || ''),
    network: MAINNET_CHAIN_ID,
    genesis: MAINNET_GENESIS_HASH,
    warning: 'прямой перевод нативной AGT, без удержания. Проверьте получателя и сумму до подписи.',
  };
}

// Сборка неподписанной tx из превью (сумма — number, требование консенсуса:
// validateBlockAgainstChain/addTransaction отвергают не-number 'tx_bad_fields'.
// Строгость без Number*1e9: atomic → точная decimal-строка → Number → обратная
// сверка через unitsOfAmountBigInt; непредставимое как точный number — отказ.
export function buildTransferTx({ from, fromPub, to, amountAtomic, nonce, memo = '' }) {
  const amt = BigInt(amountAtomic);
  const amount = Number(fromAtomic(amt));
  const back = unitsOfAmountBigInt(amount);
  if (back !== amt) throw new Error('bad_amount: not exact in protocol units');
  const tx = {
    from: String(from), fromPub: String(fromPub), to: String(to),
    amount, nonce: nonce ?? Date.now(), ts: Math.floor(Date.now() / 1000),
    memo: String(memo || ''),
  };
  tx.txid = txDigest(tx);
  return tx;
}

// Локальная подпись владельца. Ключ сюда приходит только из локального подписанта.
export function signTransfer(tx, privKeyPem) {
  if (!tx || !privKeyPem) throw new Error('sign_failed: tx and local private key required');
  const sig = signTransaction(tx, privKeyPem);
  const signed = { ...tx, signature: sig };
  if (!verifyTransaction(signed)) throw new Error('sign_failed: signature does not verify');
  return signed;
}

// Журнал orderId → obligationId → signed tx → txid (идемпотентность повторов).
// Конкурентные attaching идут через межпроцессную блокировку mkdir (как в
// queue-auth.withFileLock): без неё два процесса могли оба прочитать "нет подписи"
// и отправить РАЗНЫЕ байты — двойная выплата. Повтор отправляет ТЕ ЖЕ байты.
// Блокировка платежей (paused): останавливает новые подписи/отправки, сверка
// уже отправленных остаётся доступной.
function withStoreLockSync(file, fn, { timeoutMs = 5000 } = {}) {
  const lockDir = String(file) + '.lock';
  const start = Date.now();
  for (;;) {
    try { fs.mkdirSync(lockDir); break; }
    catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) {
        const err = new Error('store_locked');
        err.code = 'STORE_LOCKED';
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); }
  finally { try { fs.rmdirSync(lockDir); } catch {} }
}

export function openSettlementStore(file) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { settlements: {} }; } };
  const save = (d) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, file);
  };
  const locked = (fn) => withStoreLockSync(file, fn);
  const isPaused = () => {
    try {
      const d = load();
      if (d.paused === true) return true;
    } catch {}
    return process.env.AGT_SETTLEMENT_PAUSED === '1';
  };
  return {
    file,
    get(orderId) { return load().settlements[String(orderId)] || null; },
    isPaused,
    setPaused(paused, reason = '') {
      return locked(() => {
        const d = load();
        d.paused = paused === true;
        d.pauseNote = String(reason || '').slice(0, 300);
        d.pauseAt = Date.now();
        save(d);
        return { paused: d.paused };
      });
    },
    createObligation({ orderId, payer, recipient, amountAtomic, acceptedProof }) {
      return locked(() => {
      if (isPaused()) return { ok: false, error: 'payments_paused', hint: 'новые обязательства заблокированы; сверка уже отправленных доступна' };
      const d = load();
      const id = String(orderId);
      if (d.settlements[id]) return { ...d.settlements[id], replay: true };
      if (!acceptedProof || acceptedProof.state !== 'accepted') {
        return { ok: false, error: 'no_obligation', hint: 'обязательство только после приёмки (accept), приёмка ≠ оплата' };
      }
      if (String(acceptedProof.recipient || acceptedProof.provider || recipient) !== String(recipient)) {
        return { ok: false, error: 'recipient_mismatch', hint: 'получатель обязан совпадать с provider принятого заказа' };
      }
      const s = {
        ok: true,
        obligationId: 'obl-' + crypto.createHash('sha256').update('mainnet:' + id).digest('hex').slice(0, 12),
        orderId: id,
        payer: String(payer),
        recipient: String(recipient),
        amountAtomic: String(BigInt(amountAtomic)),
        feeAtomic: String(PROTOCOL_FEE_ATOMIC),
        kind: 'direct-transfer',
        escrow: false,
        network: MAINNET_CHAIN_ID,
        genesis: MAINNET_GENESIS_HASH,
        state: 'obligation',
        signedTx: null,
        txid: null,
        confirmations: 0,
        tipAtSeen: null,
        createdAt: Date.now(),
        history: [{ at: Date.now(), ev: 'obligation', note: 'приёмка подтверждена, оплата ещё не отправлена' }],
      };
      d.settlements[id] = s;
      save(d);
      return { ...s, replay: false };
      });
    },
    attachSignedTx(orderId, signedTx) {
      return locked(() => {
      if (isPaused()) return { ok: false, error: 'payments_paused', hint: 'новые подписи/отправки заблокированы; сверка уже отправленных доступна' };
      const d = load();
      const s = d.settlements[String(orderId)];
      if (!s) return { ok: false, error: 'settlement_not_found' };
      if (s.signedTx && s.signedTx.signature === signedTx.signature && s.txid) {
        return { ...s, replay: true };
      }
      if (s.signedTx && s.signedTx.signature !== signedTx.signature) {
        return { ok: false, error: 'second_payment_refused', hint: 'повтор отправляет ТЕ ЖЕ подписанные байты; новая подпись — только новым orderId' };
      }
      s.signedTx = signedTx;
      s.txid = signedTx.txid || txDigest(signedTx);
      s.state = 'sent';
      s.history.push({ at: Date.now(), ev: 'sent', txid: s.txid });
      d.settlements[String(orderId)] = s;
      save(d);
      return { ...s };
      });
    },
    markConfirmed(orderId, { confirmations, blockHeight, blockHash }) {
      const d = load();
      const s = d.settlements[String(orderId)];
      if (!s) return null;
      s.state = 'confirmed';
      s.confirmations = confirmations;
      s.confirmedAt = Date.now();
      s.confirmedIn = { height: blockHeight, blockHash };
      s.history.push({ at: Date.now(), ev: 'confirmed', confirmations, blockHeight });
      d.settlements[String(orderId)] = s;
      save(d);
      return { ...s };
    },
    markNeedsReconcile(orderId, reason) {
      const d = load();
      const s = d.settlements[String(orderId)];
      if (!s) return null;
      s.state = 'needs_reconcile';
      s.history.push({ at: Date.now(), ev: 'needs_reconcile', reason: String(reason).slice(0, 300) });
      d.settlements[String(orderId)] = s;
      save(d);
      return { ...s };
    },
    list() { return Object.values(load().settlements); },
  };
}

// Поиск tx в канонической цепи + проверка получателя/суммы + глубина.
export function findTxInChain(chain, txid) {
  for (let h = 0; h < chain.length; h++) {
    const blk = chain[h];
    for (const tx of blk.txs || []) {
      if (tx && tx.txid === txid) return { height: h, block: blk, tx };
    }
  }
  return null;
}

export function checkConfirmation(chain, { txid, expectTo, expectAmountAtomic, depth = CONFIRM_DEPTH_DEFAULT }) {
  const found = findTxInChain(chain, txid);
  if (!found) return { included: false, confirmations: 0, state: 'pending' };
  const amt = unitsOfAmountBigInt(found.tx.amount);
  if (String(found.tx.to) !== String(expectTo)) {
    return { included: true, confirmations: 0, state: 'recipient_mismatch', height: found.height };
  }
  if (amt !== BigInt(expectAmountAtomic)) {
    return { included: true, confirmations: 0, state: 'amount_mismatch', height: found.height };
  }
  const tipHeight = chain.length - 1;
  // Каноничность: проверяем связность prevHash от найденного блока до tip.
  for (let h = found.height + 1; h < chain.length; h++) {
    if (chain[h].header?.prevHash !== chain[h - 1].hash) {
      return { included: false, confirmations: 0, state: 'reorg_detected', height: found.height };
    }
  }
  const confirmations = tipHeight - found.height + 1;
  if (confirmations >= depth) {
    return { included: true, confirmations, state: 'confirmed', height: found.height, blockHash: found.block.hash };
  }
  return { included: true, confirmations, state: 'sent', height: found.height, blockHash: found.block.hash };
}
