#!/usr/bin/env node
/* Нативный AGT через предназначенный публичный API серверной ноды.
 * Локальный файл цепи здесь НЕ используется: балансы, высота, вершина и
 * подтверждения читаются только из ответов живой ноды (base + маршруты ниже).
 * Карта маршрутов сверена живым опросом https://agentcoin.work (2026-11-18):
 *   bare /info /life /balance /balances /blocks /headers /tx /tx/preflight → нода;
 *   /api/v1/txproof/:txid и /api/v1/mempool?full=1 → нода (голые /txproof и
 *   /mempool отдаёт Next-оболочка сайта, а не цепь — их не используем);
 *   POST /api/v1/tx → route_not_allowlisted (шлюз-адаптер блокирует приём tx).
 * Любой не-JSON ответ (HTML-оболочка, прокси-заглушка) — fail-closed ошибка,
 * а не «данные». core.mjs не меняется.
 */
import { verifyTransaction, unitsOfAmountBigInt } from '../../core.mjs';

export const MAINNET_CHAIN_ID = 'AGENTCOIN';
export const MAINNET_GENESIS_HASH = '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e';
export const CONFIRM_DEPTH_DEFAULT = 6;
export const PROTOCOL_FEE_ATOMIC = 0n;
export const MGNT_PER_AGT = 1000000000n;
export const FRESH_TIP_MAX_AGE_SEC = 600;

// Голые маршруты, отдающие именно ноду (а не Next-оболочку), плюс два
// /api/v1-исключения. Всё остальное считаем неподтверждённым путём.
const ROUTES = {
  info: '/info',
  life: '/life',
  balance: '/balance',
  balances: '/balances',
  blocks: '/blocks',
  headers: '/headers',
  txSubmit: '/tx',
  txPreflight: '/tx/preflight',
  txProof: '/api/v1/txproof/',
  mempoolFull: '/api/v1/mempool?full=1',
};

export function createNodeApi({ base, fetchImpl = fetch, confirmDepth = CONFIRM_DEPTH_DEFAULT } = {}) {
  const doFetch = fetchImpl || fetch;
  async function fetchJson(url, opts = {}) {
    const r = await doFetch(url, { ...opts, redirect: 'error' });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data || typeof data !== 'object') {
      const e = new Error(`unexpected_upstream: ${url} вернул не-JSON (${r.status})`);
      e.status = r.status; e.route = url;
      throw e;
    }
    return { status: r.status, data };
  }
  const root = String(base || 'https://agentcoin.work').replace(/\/$/, '');
  const get = (p) => fetchJson(root + p);
  const post = (p, body) => fetchJson(root + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  async function netEvidence() {
    const [{ data: info }, { data: life }] = await Promise.all([get(ROUTES.info), get(ROUTES.life)]);
    if (info.chainId !== MAINNET_CHAIN_ID) throw new Error(`wrong_network: ${info.chainId}`);
    if (String(info.genesisHash).toLowerCase() !== MAINNET_GENESIS_HASH) {
      throw new Error(`wrong_genesis: ${info.genesisHash}`);
    }
    const [{ data: tipWrap }] = await Promise.all([get(`${ROUTES.blocks}?n=1`)]);
    const tipBlock = (tipWrap.blocks || [])[0] || null;
    if (!tipBlock) throw new Error('no_tip_block');
    const checks = {
      chainId: info.chainId,
      genesis: info.genesisHash,
      infoBlocks: info.blocks,
      lifeBlocks: life.blocks,
      lifeTipHash: life.tipHash,
      blockTipHash: tipBlock.hash,
      blockTipHeight: tipBlock.height,
      tipAgeSec: life.tipAgeSec,
      fresh: life.fresh === true,
      chainValid: life.chainValid === true,
    };
    const heightsAgree = info.blocks === life.blocks && tipBlock.height === life.blocks - 1;
    const tipAgree = life.tipHash === tipBlock.hash;
    const synced = heightsAgree && tipAgree && life.fresh === true && life.chainValid === true
      && typeof life.tipAgeSec === 'number' && life.tipAgeSec <= FRESH_TIP_MAX_AGE_SEC;
    return { ...checks, heightsAgree, tipAgree, synced };
  }

  // Баланс нода отдаёт float; для отображения округляем до магента и честно
  // помечаем приближение. Авторитетное атомарное значение — только сумма
  // подписанной tx (точное число из заказа).
  function balanceDisplay(floatBalance) {
    const rounded = Math.round(Number(floatBalance) * 1e9);
    if (!Number.isFinite(rounded) || rounded < 0) throw new Error('bad_balance_upstream');
    return {
      balanceAtomic: String(BigInt(rounded)),
      approximate: true,
      note: 'округлено до магента из float-ответа ноды; точная сумма — в подписанной транзакции',
    };
  }

  async function getBalance(address) {
    const { data } = await post(ROUTES.balance, { address });
    if (typeof data.balance !== 'number') throw new Error('bad_balance_upstream');
    return { address: data.address || address, unit: data.unit || 'AGT', ...balanceDisplay(data.balance) };
  }

  async function getMempoolTx(txid) {
    const { data } = await get(ROUTES.mempoolFull);
    if (!Array.isArray(data.txs)) throw new Error('bad_mempool_upstream');
    return data.txs.find((t) => t && t.txid === txid) || null;
  }

  async function getTxProof(txid) {
    const r = await get(ROUTES.txProof + encodeURIComponent(txid));
    return r;
  }

  async function findTxInChain(txid) {
    // Сначала пруф (дешёвый путь к высоте), затем тело блока для сверки полей.
    let proof = null;
    try {
      const r = await getTxProof(txid);
      if (r.status === 200 && typeof r.data?.height === 'number') proof = r.data;
    } catch (e) {
      if (!/unexpected_upstream/.test(String(e.message)) && r_status(e) !== 404) throw e;
    }
    if (!proof) return { included: false };
    const { data: slice } = await get(`${ROUTES.blocks}?from=${proof.height}&limit=1`);
    const block = (slice.blocks || [])[0] || null;
    if (!block || block.height !== proof.height) throw new Error('tip_moved_recheck');
    const tx = (block.txs || []).find((t) => t && t.txid === txid) || null;
    if (!tx) throw new Error('proof_without_body_recheck');
    const { data: tipWrap } = await get(`${ROUTES.blocks}?n=1`);
    const tip = (tipWrap.blocks || [])[0];
    // Каноничность ветки: проверяем связность от блока tx до вершины.
    let cur = block;
    if (cur.hash !== tip.hash) {
      // Идём вверх по заголовкам, сверяя prevHash-цепочку.
      const { data: range } = await get(`${ROUTES.headers}?from=${proof.height}&limit=${tip.height - proof.height + 1}`);
      const headers = range.headers || [];
      for (let i = 1; i < headers.length; i++) {
        if (headers[i].header?.prevHash !== headers[i - 1].hash) {
          return { included: false, state: 'reorg_detected', height: proof.height };
        }
      }
      const last = headers[headers.length - 1];
      if (!last || last.hash !== tip.hash) return { included: false, state: 'reorg_detected', height: proof.height };
    }
    return { included: true, height: proof.height, blockHash: block.hash, tipHeight: tip.height, tx };
  }

  function r_status(e) { return e && typeof e.status === 'number' ? e.status : 0; }

  async function checkConfirmation({ txid, expectTo, expectAmountAtomic, depth = confirmDepth }) {
    const found = await findTxInChain(txid);
    if (found.state === 'reorg_detected') return { included: false, confirmations: 0, state: 'reorg_detected', height: found.height };
    if (!found.included) {
      const mem = await getMempoolTx(txid).catch(() => null);
      if (mem) return { included: false, confirmations: 0, state: 'sent', note: 'в mempool, не в цепи' };
      return { included: false, confirmations: 0, state: 'pending' };
    }
    const amt = unitsOfAmountBigInt(found.tx.amount);
    if (String(found.tx.to) !== String(expectTo)) {
      return { included: true, confirmations: 0, state: 'recipient_mismatch', height: found.height };
    }
    if (amt !== BigInt(expectAmountAtomic)) {
      return { included: true, confirmations: 0, state: 'amount_mismatch', height: found.height };
    }
    const confirmations = found.tipHeight - found.height + 1;
    if (confirmations >= depth) {
      return { included: true, confirmations, state: 'confirmed', height: found.height, blockHash: found.blockHash };
    }
    return { included: true, confirmations, state: 'sent', height: found.height, blockHash: found.blockHash };
  }

  // Отправка в СУЩЕСТВУЮЩИЙ приёмник ноды POST /tx. Подпись проверяется
  // локально до отправки; несоответствие заказу — отказ без сетевого вызова.
  async function submitSignedTx({ obligation, signedTx }) {
    if (!obligation || !signedTx) return { ok: false, error: 'args_required' };
    if (!verifyTransaction(signedTx)) return { ok: false, error: 'bad_signature' };
    if (String(signedTx.from) !== String(obligation.payer)) {
      return { ok: false, error: 'payer_mismatch' };
    }
    if (String(signedTx.to) !== String(obligation.recipient)) {
      return { ok: false, error: 'recipient_mismatch' };
    }
    let amt;
    try { amt = unitsOfAmountBigInt(signedTx.amount); } catch { return { ok: false, error: 'bad_amount' }; }
    if (amt !== BigInt(obligation.amountAtomic)) return { ok: false, error: 'amount_mismatch' };
    let res;
    try {
      res = await post(ROUTES.txSubmit, signedTx);
    } catch (e) {
      // Ответ потерян: состояние неизвестно — только сверка, не повтор вслепую.
      return { ok: false, error: 'net_error', reconcile: 'unknown_outcome_check_proof_then_mempool' };
    }
    if (res.status === 201) return { ok: true, accepted: true, relay: res.data };
    const reason = res.data?.error || res.data?.reason || '';
    if (res.status === 400 && /duplicate_tx|already_in_chain/.test(reason)) {
      return { ok: true, accepted: true, duplicate: true, note: 'нода уже видела эти байты — второй платёж не создан' };
    }
    // Честные отказы ноды (нет средств, плохая подпись, казна без sig2…) —
    // это отказ платежа, не успех и не повод менять байты.
    return { ok: false, error: reason || `relay_failed_${res.status}`, status: res.status };
  }

  return {
    routes: ROUTES, netEvidence, getBalance, getMempoolTx,
    findTxInChain, checkConfirmation, submitSignedTx, balanceDisplay,
  };
}
