import { createHash } from 'node:crypto';
import { unitsOfAmountBigInt } from '../../core.mjs';

const MAX_RESPONSE = 1024 * 1024;
export function nodeOrigin(value) {
  let u; try { u = new URL(value); } catch { throw Error('invalid_node_url'); }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash ||
      (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw Error('node_url_must_be_https_or_loopback');
  return u.origin;
}
export async function requestJson(base, route, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  let response;
  try {
    response = await fetch(nodeOrigin(base) + route, { method, redirect: 'error', credentials: 'omit',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    error.stage ||= 'http_request';
    throw error;
  }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > MAX_RESPONSE) {
        const error = Error('node_response_too_large'); error.stage = 'http_response_body'; error.httpStatus = response.status; throw error;
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    error.stage ||= 'http_response_body'; error.httpStatus ??= response.status; throw error;
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (cause) {
    const error = Error('invalid_node_json'); error.stage = 'http_response_json'; error.httpStatus = response.status;
    error.cause = cause; throw error;
  }
  return { status: response.status, data };
}
export async function pinNode(nodeUrl, expectedNetwork, expectedGenesisHash) {
  const origin = nodeOrigin(nodeUrl);
  if (typeof expectedNetwork !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(expectedNetwork) || !/^[a-f0-9]{64}$/.test(expectedGenesisHash || '')) throw Error('explicit_network_and_genesis_required');
  const { status, data } = await requestJson(origin, '/info');
  if (status !== 200 || (data.network ?? data.chainId) !== expectedNetwork || data.genesisHash !== expectedGenesisHash) throw Error('node_network_or_genesis_mismatch');
  return { version: 1, nodeUrl: origin, network: expectedNetwork, genesisHash: expectedGenesisHash, checkedAt: Date.now() };
}
export async function verifyPinnedNode(pin) {
  const current = await pinNode(pin.nodeUrl, pin.network, pin.genesisHash);
  if (current.genesisHash !== pin.genesisHash) throw Error('node_pin_changed');
  return current;
}
export async function getBalance(pin, address) {
  await verifyPinnedNode(pin);
  const { status, data } = await requestJson(pin.nodeUrl, '/balance', { method: 'POST', body: { address } });
  if (status !== 200 || data.address !== address) throw Error('balance_unavailable');
  const smallestUnits = apiBalanceToUnits(data.balance);
  return { address, amountAGT: data.balance, unit: data.unit || 'AGT', smallestUnits: smallestUnits.toString() };
}
export function amountToUnits(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(value)) throw Error('amount_must_be_plain_decimal_with_at_most_9_places');
  const [whole, frac = ''] = value.split('.');
  const units = BigInt(whole) * 1000000000n + BigInt(frac.padEnd(9, '0'));
  if (units < 1n || units > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('amount_out_of_range');
  return units;
}
/** Convert the node's numeric AGT balance by the consensus decimal parser, not float multiplication. */
export function apiBalanceToUnits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('api_balance_not_finite_number');
  if (value < 0 || Object.is(value, -0)) throw Error('api_balance_negative');
  let units;
  try { units = unitsOfAmountBigInt(value); }
  catch (cause) {
    const error = Error('api_balance_not_exact_mgnt'); error.cause = cause; throw error;
  }
  if (units < 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('api_balance_overflow');
  return units;
}
export function amountToNetworkNumber(value) {
  const units = amountToUnits(value);
  const number = Number(units) / 1e9;
  let roundTrip;
  try { roundTrip = unitsOfAmountBigInt(number); } catch { throw Error('amount_not_exact_in_network_format'); }
  if (!Number.isFinite(number) || roundTrip !== units) throw Error('amount_not_exact_in_network_format');
  return number;
}
export async function preflight(pin, tx) {
  await verifyPinnedNode(pin);
  const { status, data } = await requestJson(pin.nodeUrl, '/tx/preflight', { method: 'POST', body: tx });
  if (status !== 200 || data.network !== pin.network) throw Error('preflight_unavailable');
  // Preserve the node's detailed diagnostic response and the HTTP status for callers/tests.
  return { ...data, httpStatus: status };
}
export async function submitExact(pin, signed, { timeoutMs = 8000 } = {}) {
  await verifyPinnedNode(pin);
  const check = await preflight(pin, signed.tx);
  if (check.verdict !== 'preflight_pass' || !check.signature?.ok || !check.balance?.ok || !check.nonce?.ok || !check.fee || check.fee.amount !== 0) throw Error('preflight_rejected');
  let r;
  try { r = await requestJson(pin.nodeUrl, '/tx', { method: 'POST', body: signed.tx, timeoutMs }); }
  catch (error) {
    const lookup = await lookupTx(pin, signed.tx.txid).catch(() => null);
    if (lookup?.state === 'mempool' || lookup?.state === 'in_block') {
      return { state: lookup.state, txid: signed.tx.txid, resolution: 'found_after_http_error',
        diagnostic: { stage: error.stage || 'http_request', httpStatus: error.httpStatus ?? null,
          exception: safeException(error), lookup: lookup.state } };
    }
    return { state: 'status_unknown', txid: signed.tx.txid,
      diagnostic: { stage: error.stage || 'http_request', httpStatus: error.httpStatus ?? null,
        exception: safeException(error), lookup: lookup?.state || 'unavailable' },
      note: 'Исходная отправка не повторялась; проверьте тот же txid позднее.' };
  }
  const responseFields = safeNodeResponse(r.data);
  if (r.status >= 400 && r.status < 500) return { state: 'rejected', txid: signed.tx.txid,
    diagnostic: { stage: 'http_response', httpStatus: r.status, response: responseFields } };
  if (r.status >= 500) {
    const lookup = await lookupTx(pin, signed.tx.txid).catch(() => null);
    if (lookup?.state === 'mempool' || lookup?.state === 'in_block') return { state: lookup.state, txid: signed.tx.txid,
      resolution: 'found_after_http_error', diagnostic: { stage: 'http_response', httpStatus: r.status,
        response: responseFields, lookup: lookup.state } };
    return { state: 'status_unknown', txid: signed.tx.txid,
      diagnostic: { stage: 'http_response', httpStatus: r.status, response: responseFields, lookup: lookup?.state || 'unavailable' } };
  }
  // Current Agentcoin POST /tx contract: {accepted:true,mempool,gossipped:true},
  // with no txid in the response. The request body is the exact locally signed tx.
  if ((r.status === 200 || r.status === 201) && r.data?.accepted === true && Number.isSafeInteger(r.data.mempool)) {
    return { state: 'mempool', txid: signed.tx.txid, mempoolSize: r.data.mempool, gossipped: r.data.gossipped === true,
      diagnostic: { stage: 'accepted_response', httpStatus: r.status, response: responseFields } };
  }
  // Accept the earlier explicit txid response shape only when it names this exact request.
  if ((r.status === 200 || r.status === 201) && r.data?.txid === String(signed.tx.txid).slice(0, 16)) {
    return { state: 'mempool', txid: signed.tx.txid, shortTxid: r.data.txid,
      diagnostic: { stage: 'accepted_response', httpStatus: r.status, response: responseFields } };
  }
  if (r.data?.accepted === false || typeof r.data?.error === 'string') return { state: 'rejected', txid: signed.tx.txid,
    diagnostic: { stage: 'http_response', httpStatus: r.status, response: responseFields } };
  const lookup = await lookupTx(pin, signed.tx.txid).catch(() => null);
  if (lookup?.state === 'mempool' || lookup?.state === 'in_block') return { state: lookup.state, txid: signed.tx.txid,
    resolution: 'found_after_unrecognized_success_response', diagnostic: { stage: 'response_contract', httpStatus: r.status,
      response: responseFields, lookup: lookup.state } };
  return { state: 'status_unknown', txid: signed.tx.txid,
    diagnostic: { stage: 'response_contract', httpStatus: r.status, response: responseFields, lookup: lookup?.state || 'unavailable' } };
}
function safeException(error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : 'Error';
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(error.code) ? error.code : null;
  return { name, code };
}
function safeNodeResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { type: Array.isArray(data) ? 'array' : typeof data };
  const out = {};
  for (const key of ['accepted', 'error', 'mempool', 'gossipped', 'retryAfterSec']) {
    const value = data[key];
    if (typeof value === 'boolean' || Number.isSafeInteger(value)) out[key] = value;
    else if (key === 'error' && typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)) out[key] = value;
  }
  return out;
}
export async function lookupTx(pin, txid) {
  await verifyPinnedNode(pin);
  if (!/^[a-f0-9]{64}$/i.test(txid || '')) throw Error('invalid_txid');
  const [pool, proof] = await Promise.all([
    requestJson(pin.nodeUrl, '/mempool?full=1').catch(() => null),
    requestJson(pin.nodeUrl, '/txproof/' + txid).catch(() => null),
  ]);
  if (proof?.status === 200 && proof.data?.txid === txid) return { state: 'in_block', txid, height: proof.data.height ?? null };
  const poolTxs = pool?.data?.txs || pool?.data?.mempool || [];
  if (pool?.data?.complete !== false && poolTxs.some(x => x.txid === txid)) return { state: 'mempool', txid };
  if (pool?.status === 200 && pool.data?.complete === false) return { state: 'status_unknown', txid, note: 'mempool snapshot incomplete' };
  if (proof?.status === 404 || pool?.status === 200) return { state: 'not_found_or_pending', txid };
  return { state: 'status_unknown', txid };
}
export function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
