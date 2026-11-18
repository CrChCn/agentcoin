#!/usr/bin/env node
/* Mainnet-шлюз нативных расчётов: только чтение цепи + приём УЖЕ подписанных tx.
 * Никогда не принимает приватные ключи (fail-closed): поле privKey/privateKey
 * в теле запроса → 400 без дальнейшей обработки.
 * core.mjs не меняется; отправка — через существующий POST /tx ноды mainnet.
 */
import fs from 'node:fs';
import {
  MAINNET_CHAIN_ID, MAINNET_GENESIS_HASH, CONFIRM_DEPTH_DEFAULT,
  loadMainnetChain, balanceAtomic, previewTransfer, checkSpendPolicy,
  loadSpendPolicy, openSettlementStore, checkConfirmation, toAtomic,
  PROTOCOL_FEE_ATOMIC,
} from './mainnet-settlement.mjs';
import { verifyTransaction, txDigest } from '../../core.mjs';

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

export function createMainnetGateway({ mainnetDataDir, storeFile, policyFile, nodeUrl = 'http://127.0.0.1:9333', confirmDepth = CONFIRM_DEPTH_DEFAULT }) {
  const store = openSettlementStore(storeFile);
  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const readChain = () => loadMainnetChain(mainnetDataDir);

  async function handle(req, res, url, body) {
    const p = url.pathname;
    // --- чтение mainnet: chainId+genesis проверяются внутри loadMainnetChain ---
    if (p === '/mainnet/info' && req.method === 'GET') {
      try {
        const { chain, genesisHash, tip, blocks } = readChain();
        return send(res, 200, { network: MAINNET_CHAIN_ID, genesis: genesisHash, blocks, tipHash: tip.hash, tipHeight: blocks - 1, confirmDepth, test: false, note: 'нативный AGT основной сети' });
      } catch (e) {
        return send(res, 502, { error: 'mainnet_unavailable', hint: String(e.message || e).slice(0, 200) });
      }
    }
    if (p === '/mainnet/balances' && req.method === 'GET') {
      const address = String(url.searchParams.get('address') || '');
      if (!address) return send(res, 400, { error: 'address_required' });
      try {
        const { chain, genesisHash } = readChain();
        const b = balanceAtomic(chain, address);
        return send(res, 200, { address, balanceAtomic: String(b.atomic), balanceAGT: `${b.atomic / 1000000000n}.${String(b.atomic % 1000000000n).padStart(9, '0').replace(/0+$/, '') || '0'}`.replace(/\.$/, '.0'), network: MAINNET_CHAIN_ID, genesis: genesisHash, test: false });
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
        return send(res, 400, { error: 'signed_tx_required', hint: 'подпишите локально у владельца (signTransfer), затем пришлите signedTx' });
      }
      if (!verifyTransaction(signedTx)) return send(res, 400, { error: 'bad_signature' });
      const s = store.get(String(body.orderId));
      if (!s) return send(res, 404, { error: 'settlement_not_found', hint: 'сначала /mainnet/obligations после приёмки' });
      if (String(signedTx.to) !== s.recipient || String(toAtomic(signedTx.amount)) !== String(s.amountAtomic)) {
        return send(res, 409, { error: 'terms_mismatch', hint: 'подписанные получатель/сумма обязаны совпадать с обязательством' });
      }
      const attached = store.attachSignedTx(String(body.orderId), { ...signedTx, txid: signedTx.txid || txDigest(signedTx) });
      if (attached && attached.ok === false) return send(res, 409, attached);
      // Пересылка ТЕХ ЖЕ байтов в mainnet-ноду (без пересборки). Нет ноды — копим signed для ручной отправки владельцем.
      let relay = { relayed: false, note: 'mainnet node unreachable; signed bytes kept for owner relay' };
      try {
        const r = await fetch(nodeUrl + '/tx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attached.signedTx || signedTx), signal: AbortSignal.timeout(10000) });
        const data = await r.json().catch(() => ({}));
        if (r.status === 201 || (r.status === 400 && data?.reason === 'duplicate_tx')) {
          relay = { relayed: true, status: r.status, mempool: data?.mempoolSize ?? data?.mempool ?? null, duplicate: data?.reason === 'duplicate_tx' || undefined };
        } else {
          relay = { relayed: false, status: r.status, error: data?.error || data?.reason || 'relay_failed', note: 'байты сохранены; повтор шлёт те же байты (reconcile)' };
        }
      } catch (e) {
        relay = { relayed: false, error: 'net_error', hint: String(e.message || e).slice(0, 160), note: 'байты сохранены; повтор шлёт те же байты' };
      }
      return send(res, 200, { settlement: attached, relay, feeAtomic: String(PROTOCOL_FEE_ATOMIC) });
    }
    if (p.startsWith('/mainnet/settlements/') && p.endsWith('/status') && req.method === 'GET') {
      const orderId = decodeURIComponent(p.slice('/mainnet/settlements/'.length, -'/status'.length));
      const s = store.get(orderId);
      if (!s) return send(res, 404, { error: 'settlement_not_found' });
      if (!s.txid) return send(res, 200, { settlement: s, confirmation: { included: false, state: s.state } });
      try {
        const { chain } = readChain();
        const c = checkConfirmation(chain, { txid: s.txid, expectTo: s.recipient, expectAmountAtomic: BigInt(s.amountAtomic), depth: confirmDepth });
        if (c.state === 'confirmed' && s.state !== 'confirmed') store.markConfirmed(orderId, { confirmations: c.confirmations, blockHeight: c.height, blockHash: c.blockHash });
        else if ((c.state === 'reorg_detected' || c.state === 'pending') && s.state === 'confirmed') store.markNeedsReconcile(orderId, c.state);
        const cur = store.get(orderId);
        // «Оплачено» только при confirmed; иначе честный текущий статус, не успех.
        return send(res, 200, { settlement: cur, confirmation: c, paid: c.state === 'confirmed' });
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

  return { handle, store };
}
