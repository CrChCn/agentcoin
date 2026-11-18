#!/usr/bin/env node
/* Mainnet-шлюз нативных расчётов: источник истины — живая нода через её
 * предназначенный публичный API (mainnet-node-api.mjs). Локальный файл цепи
 * НЕ используется. Никогда не принимает приватные ключи (fail-closed):
 * поле privKey/privateKey в теле запроса → 400 без дальнейшей обработки.
 * core.mjs не меняется; отправка — через существующий POST /tx ноды.
 *
 * Безопасность (приоритет 1):
 * - manualApprove — только подписью плательщика (settle-approve), не флагом.
 * - повтор отправляет ТЕ ЖЕ байты (store под блокировкой, second_payment_refused).
 * - payments_paused блокирует новые обязательства/подписи/отправки, сверка открыта.
 * - rate-limit POST + журнал решений без секретов (orderId/причина, без подписей).
 */
import fs from 'node:fs';
import { createNodeApi } from './mainnet-node-api.mjs';
import { previewTransfer, checkSpendPolicy, loadSpendPolicy, openSettlementStore, toAtomic, PROTOCOL_FEE_ATOMIC } from './mainnet-settlement.mjs';
import { verifyActionSig } from '../../queue-auth.mjs';
import { txDigest } from '../../core.mjs';

const SECRET_KEYS = ['privkey', 'privatekey', 'private_key', 'priv_key', 'mnemonic', 'seed'];

function hasSecret(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return false;
  for (const k of Object.keys(obj)) {
    const kl = k.toLowerCase().replace(/[^a-z]/g, '');
    if (SECRET_KEYS.some((s) => kl.includes(s.replace(/[^a-z]/g, '')))) return true;
    if (hasSecret(obj[k], depth + 1)) return true;
  }
  return false;
}

// Простой rate-limit POST на процесс (защита от спама обязательствами).
const RATE_MAX_POST = 60;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();
function rateAllow(ip) {
  const now = Date.now();
  const key = String(ip || 'unknown');
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateBuckets.set(key, arr);
  return arr.length <= RATE_MAX_POST;
}

// Ручное подтверждение владельца — подписью плательщика, не флагом в теле.
// Действие settle-approve, тело {orderId, txid, amountAtomic, recipient}.
function verifyManualApprove({ obligation, body }) {
  const env = body && body.manualApproveSig;
  if (!env || typeof env !== 'object') return { ok: false, error: 'manual_approve_signature_required' };
  const txid = String((body.signedTx && (body.signedTx.txid || '')) || obligation.txid || '');
  const v = verifyActionSig({
    address: env.address, fromPub: env.fromPub, signature: env.signature,
    action: 'settle-approve',
    body: { orderId: obligation.orderId, txid, amountAtomic: String(obligation.amountAtomic), recipient: obligation.recipient },
    nonce: env.nonce, expiry: env.expiry, chain: 'AGENTCOIN',
  });
  if (!v.ok) return v;
  if (String(env.address) !== String(obligation.payer)) return { ok: false, error: 'manual_approve_foreign' };
  return { ok: true };
}

function logDecision(evt, fields) {
  // Без секретов: только идентификаторы и причины.
  const safe = { ev: evt, at: new Date().toISOString() };
  for (const [k, val] of Object.entries(fields || {})) {
    if (/signature|priv|mnemonic|seed|fromPub/i.test(k)) continue;
    safe[k] = typeof val === 'string' ? val.slice(0, 120) : val;
  }
  try { console.log(JSON.stringify(safe)); } catch {}
}

export function createMainnetGateway({ nodeApiBase, storeFile, policyFile, confirmDepth } = {}) {
  const api = createNodeApi({ base: nodeApiBase || process.env.AGT_MAINNET_API || 'https://agentcoin.work', confirmDepth });
  const store = openSettlementStore(storeFile);
  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  async function handle(req, res, url, body) {
    const p = url.pathname;
    const ip = (req && req.socket && req.socket.remoteAddress) || 'unknown';
    if (req.method === 'POST' && p.startsWith('/mainnet/')) {
      if (!rateAllow(ip)) return send(res, 429, { error: 'rate_limited', hint: 'слишком много запросов, повторите позже' });
    }
    if (typeof store.isPaused === 'function' && store.isPaused()) {
      if ((p === '/mainnet/obligations' || p === '/mainnet/submit') && req.method === 'POST') {
        logDecision('payments_paused_refuse', { route: p, orderId: body && body.orderId });
        return send(res, 409, { error: 'payments_paused', hint: 'выплаты остановлены владельцем; сверка уже отправленных доступна' });
      }
    }
    if (p === '/mainnet/info' && req.method === 'GET') {
      try {
        const ev = await api.netEvidence();
        return send(res, 200, { ...ev, network: 'AGENTCOIN', confirmDepth, test: false, source: 'live-node-api', note: 'нативный AGT основной сети; локальный файл цепи не используется' });
      } catch (e) {
        return send(res, 502, { error: 'mainnet_unavailable', hint: String(e.message || e).slice(0, 200) });
      }
    }
    if (p === '/mainnet/balances' && req.method === 'GET') {
      const address = String(url.searchParams.get('address') || '');
      if (!address) return send(res, 400, { error: 'address_required' });
      try {
        const ev = await api.netEvidence();
        if (!ev.synced) return send(res, 502, { error: 'node_not_in_sync', evidence: ev });
        const b = await api.getBalance(address);
        return send(res, 200, { ...b, network: 'AGENTCOIN', genesis: ev.genesis, tipHeight: ev.blockTipHeight, test: false, source: 'live-node-api' });
      } catch (e) {
        return send(res, 502, { error: 'mainnet_unavailable', hint: String(e.message || e).slice(0, 200) });
      }
    }
    if (p === '/mainnet/policy' && req.method === 'GET') {
      const policy = loadSpendPolicy(policyFile);
      if (!policy) return send(res, 200, { configured: false, hint: 'политику задаёт владелец: maxPerPaymentAtomic/maxPerDayAtomic/autonomous/allowedRecipients' });
      return send(res, 200, {
        configured: true, autonomous: policy.autonomous,
        maxPerPaymentAtomic: policy.maxPerPaymentAtomic != null ? String(policy.maxPerPaymentAtomic) : null,
        maxPerDayAtomic: policy.maxPerDayAtomic != null ? String(policy.maxPerDayAtomic) : null,
        allowedRecipients: policy.allowedRecipients,
        requireManualApproveAboveAtomic: policy.requireManualApproveAboveAtomic != null ? String(policy.requireManualApproveAboveAtomic) : null,
      });
    }
    if (p === '/mainnet/preview' && req.method === 'POST') {
      if (hasSecret(body)) return send(res, 400, { error: 'private_key_rejected', hint: 'сайт/шлюз ключ не получает; подпись только локально у владельца' });
      try {
        const pv = previewTransfer({ orderId: body.orderId, payer: body.payer, recipient: body.recipient, amountAtomic: BigInt(body.amountAtomic), memo: body.memo || '' });
        const policy = loadSpendPolicy(policyFile);
        const gate = policy ? checkSpendPolicy({ policy, amountAtomic: BigInt(body.amountAtomic), recipient: body.recipient, daySpentAtomic: BigInt(body.daySpentAtomic || 0), manualApprove: body.manualApprove === true }) : { ok: false, reason: 'no_policy' };
        return send(res, 200, { preview: pv, policy: gate });
      } catch (e) {
        return send(res, 400, { error: 'bad_preview', hint: String(e.message || e).slice(0, 200) });
      }
    }
    if (p === '/mainnet/obligations' && req.method === 'POST') {
      if (hasSecret(body)) return send(res, 400, { error: 'private_key_rejected' });
      try {
        const amountAtomic = body.amountAtomic != null ? BigInt(body.amountAtomic) : toAtomic(body.amountAGT);
        if (amountAtomic <= 0n) throw new Error('bad_amount');
        const r = store.createObligation({
          orderId: String(body.orderId), payer: String(body.payer), recipient: String(body.recipient),
          amountAtomic, acceptedProof: body.acceptedProof || null,
        });
        if (r && r.ok === false) {
          logDecision('obligation_refuse', { orderId: String(body.orderId), reason: r.error });
          return send(res, 409, r);
        }
        logDecision('obligation', { orderId: String(body.orderId), payer: String(body.payer), recipient: String(body.recipient), amountAtomic: String(amountAtomic) });
        return send(res, 200, { settlement: r });
      } catch (e) {
        return send(res, 400, { error: 'bad_obligation', hint: String(e.message || e).slice(0, 200) });
      }
    }
    if (p === '/mainnet/submit' && req.method === 'POST') {
      if (hasSecret(body)) return send(res, 400, { error: 'private_key_rejected', hint: 'пришлите уже подписанную tx (signature), а не ключ' });
      if (body.manualApprove === true) {
        return send(res, 409, { ok: false, error: 'manual_approve_signature_required', hint: 'флаг manualApprove больше не принимается: приложите manualApproveSig (подпись плательщика settle-approve)' });
      }
      const signedTx = body.signedTx;
      if (!signedTx || typeof signedTx.signature !== 'string') {
        return send(res, 400, { error: 'signed_tx_required', hint: 'подпишите локально у владельца, затем пришлите signedTx' });
      }
      const s = store.get(String(body.orderId));
      if (!s) return send(res, 404, { error: 'settlement_not_found', hint: 'сначала /mainnet/obligations после приёмки' });
      if (s.state === 'confirmed') return send(res, 200, { settlement: s, replay: true, note: 'уже оплачено — повтор не нужен' });
      // Автономные платежи — только в пределах политики владельца. Подпись сама
      // по себе авторизует перевод (ключ только у владельца), политика — второй
      // затвор против ошибочных/автономных отправок. Ручное подтверждение —
      // только подписью плательщика.
      const policy = loadSpendPolicy(policyFile);
      if (!policy) {
        const ma = verifyManualApprove({ obligation: s, body });
        if (!ma.ok) {
          logDecision('submit_refuse', { orderId: String(body.orderId), reason: ma.error || 'no_policy_manual_approve_required' });
          return send(res, 409, { ok: false, error: ma.error || 'no_policy_manual_approve_required', hint: 'политика владельца не задана: отправка только с подписью manualApproveSig плательщика' });
        }
      } else {
        const dayStart = new Date().toISOString().slice(0, 10);
        const daySpent = store.list()
          .filter((x) => x.payer === s.payer && (x.state === 'sent' || x.state === 'confirmed') && new Date(x.createdAt).toISOString().slice(0, 10) === dayStart)
          .reduce((sum, x) => sum + BigInt(x.amountAtomic), 0n);
        let gate = checkSpendPolicy({ policy, amountAtomic: BigInt(s.amountAtomic), recipient: s.recipient, daySpentAtomic: daySpent, manualApprove: false });
        if (!gate.ok && (gate.reason === 'manual_approval_required' || gate.reason === 'autonomous_disabled')) {
          const ma = verifyManualApprove({ obligation: s, body });
          if (!ma.ok) {
            logDecision('submit_refuse', { orderId: String(body.orderId), reason: ma.error || gate.reason });
            return send(res, 409, { ok: false, error: ma.error || gate.reason, hint: 'нужна подпись плательщика manualApproveSig', settlement: s });
          }
          gate = { ok: true, autonomous: false, manual: true };
        }
        if (!gate.ok) {
          logDecision('submit_refuse', { orderId: String(body.orderId), reason: gate.reason });
          return send(res, 409, { ok: false, error: gate.reason, hint: 'политика расходов владельца: платеж заблокирован', settlement: s });
        }
      }
      let attached;
      try {
        attached = store.attachSignedTx(String(body.orderId), { ...signedTx, txid: signedTx.txid || txDigest(signedTx) });
      } catch (e) {
        return send(res, 409, { ok: false, error: 'store_locked', hint: 'журнал занят параллельной отправкой, повторите теми же байтами' });
      }
      if (attached && attached.ok === false) {
        logDecision('submit_refuse', { orderId: String(body.orderId), reason: attached.error });
        return send(res, 409, attached);
      }
      // Отправка ТЕХ ЖЕ байтов в существующий приёмник ноды; несоответствие
      // заказу или отказ ноды — честный отказ, повтор — теми же байтами.
      const relay = await api.submitSignedTx({ obligation: attached, signedTx: attached.signedTx || signedTx });
      logDecision('relay', { orderId: String(body.orderId), txid: String(attached.txid || ''), accepted: relay.ok === true });
      if (relay.ok) return send(res, 200, { settlement: store.get(String(body.orderId)), relay, feeAtomic: String(PROTOCOL_FEE_ATOMIC) });
      if (relay.reconcile) {
        store.markNeedsReconcile(String(body.orderId), relay.error);
        return send(res, 200, { settlement: store.get(String(body.orderId)), relay, note: 'ответ потерян — состояние неизвестно; сверьтесь через status (пруф → mempool), повтор — теми же байтами' });
      }
      return send(res, 409, { settlement: store.get(String(body.orderId)), relay });
    }
    if (p.startsWith('/mainnet/settlements/') && p.endsWith('/status') && req.method === 'GET') {
      const orderId = decodeURIComponent(p.slice('/mainnet/settlements/'.length, -'/status'.length));
      const s = store.get(orderId);
      if (!s) return send(res, 404, { error: 'settlement_not_found' });
      if (!s.txid) return send(res, 200, { settlement: s, confirmation: { included: false, state: s.state } });
      try {
        const ev = await api.netEvidence();
        const c = await api.checkConfirmation({ txid: s.txid, expectTo: s.recipient, expectAmountAtomic: BigInt(s.amountAtomic) });
        if (c.state === 'confirmed' && s.state !== 'confirmed') store.markConfirmed(orderId, { confirmations: c.confirmations, blockHeight: c.height, blockHash: c.blockHash });
        else if ((c.state === 'reorg_detected' || c.state === 'pending') && s.state === 'confirmed') store.markNeedsReconcile(orderId, c.state);
        const cur = store.get(orderId);
        return send(res, 200, { settlement: cur, confirmation: c, network: ev, paid: c.state === 'confirmed' });
      } catch (e) {
        return send(res, 502, { error: 'mainnet_unavailable', hint: String(e.message || e).slice(0, 200) });
      }
    }
    if (p.startsWith('/mainnet/settlements/') && req.method === 'GET') {
      const orderId = decodeURIComponent(p.slice('/mainnet/settlements/'.length));
      const s = store.get(orderId);
      if (!s) return send(res, 404, { error: 'settlement_not_found' });
      return send(res, 200, { settlement: s });
    }
    return null; // не наш маршрут
  }

  return { handle, store, api };
}
