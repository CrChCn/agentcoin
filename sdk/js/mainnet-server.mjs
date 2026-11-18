#!/usr/bin/env node
/* Mainnet-шлюз нативных расчётов: источник истины — живая нода через её
 * предназначенный публичный API (mainnet-node-api.mjs). Локальный файл цепи
 * НЕ используется. Никогда не принимает приватные ключи (fail-closed):
 * поле privKey/privateKey в теле запроса → 400 без дальнейшей обработки.
 * core.mjs не меняется; отправка — через существующий POST /tx ноды.
 */
import fs from 'node:fs';
import { createNodeApi } from './mainnet-node-api.mjs';
import { previewTransfer, checkSpendPolicy, loadSpendPolicy, openSettlementStore, toAtomic, PROTOCOL_FEE_ATOMIC } from './mainnet-settlement.mjs';
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

export function createMainnetGateway({ nodeApiBase, storeFile, policyFile, confirmDepth } = {}) {
  const api = createNodeApi({ base: nodeApiBase || process.env.AGT_MAINNET_API || 'https://agentcoin.work', confirmDepth });
  const store = openSettlementStore(storeFile);
  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  async function handle(req, res, url, body) {
    const p = url.pathname;
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
        if (r && r.ok === false) return send(res, 409, r);
        return send(res, 200, { settlement: r });
      } catch (e) {
        return send(res, 400, { error: 'bad_obligation', hint: String(e.message || e).slice(0, 200) });
      }
    }
    if (p === '/mainnet/submit' && req.method === 'POST') {
      if (hasSecret(body)) return send(res, 400, { error: 'private_key_rejected', hint: 'пришлите уже подписанную tx (signature), а не ключ' });
      const signedTx = body.signedTx;
      if (!signedTx || typeof signedTx.signature !== 'string') {
        return send(res, 400, { error: 'signed_tx_required', hint: 'подпишите локально у владельца, затем пришлите signedTx' });
      }
      const s = store.get(String(body.orderId));
      if (!s) return send(res, 404, { error: 'settlement_not_found', hint: 'сначала /mainnet/obligations после приёмки' });
      if (s.state === 'confirmed') return send(res, 200, { settlement: s, replay: true, note: 'уже оплачено — повтор не нужен' });
      const attached = store.attachSignedTx(String(body.orderId), { ...signedTx, txid: signedTx.txid || txDigest(signedTx) });
      if (attached && attached.ok === false) return send(res, 409, attached);
      // Отправка ТЕХ ЖЕ байтов в существующий приёмник ноды; несоответствие
      // заказу или отказ ноды — честный отказ, повтор — теми же байтами.
      const relay = await api.submitSignedTx({ obligation: attached, signedTx: attached.signedTx || signedTx });
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