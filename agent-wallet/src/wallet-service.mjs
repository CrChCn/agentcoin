import crypto from 'node:crypto';
import { amountToNetworkNumber, amountToUnits, verifyPinnedNode, getBalance, preflight, submitExact } from './agent-client.mjs';

export function prepareTransfer({ pin, from, to, amount, memo = '', now = Date.now(), nonce = Date.now() * 1000 + crypto.randomInt(1000) }) {
  if (!/^AGT[0-9a-f]{40}$/.test(from || '') || !/^AGT[0-9a-f]{40}$/.test(to || '') || from === to) throw Error('invalid_or_same_address');
  const units = amountToUnits(amount);
  amountToNetworkNumber(amount);
  if (typeof memo !== 'string' || Buffer.byteLength(memo, 'utf8') > 512 || /[\u0000-\u001f\u007f]/.test(memo)) throw Error('invalid_memo');
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw Error('invalid_nonce');
  const createdAt = Math.floor(now / 1000);
  const intent = { from, to, amount, memo, createdAt, expiresAt: createdAt + 300, nonce };
  return { schema: 'agentcoin.wallet.intent.v1', network: pin.network, genesisHash: pin.genesisHash, intent,
    fee: { amount: '0', unit: 'AGT', supportedBy: 'GET /info and POST /tx/preflight', note: 'Current Agentcoin protocol fee is zero.' },
    display: { amountAGT: amount, smallestUnits: units.toString(), recipient: to } };
}
export async function checkTransfer(pin, signed) {
  await verifyPinnedNode(pin);
  if (!signed || signed.schema !== 'agentcoin.wallet.signed.v1' || signed.network !== pin.network || signed.genesisHash !== pin.genesisHash) throw Error('signed_network_mismatch');
  const { intent, tx } = signed;
  if (!intent || Object.keys(intent).sort().join('|') !== 'amount|createdAt|expiresAt|from|memo|nonce|to' ||
      !Number.isSafeInteger(intent.createdAt) || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt - intent.createdAt > 300 ||
      intent.expiresAt <= Math.floor(Date.now() / 1000)) throw Error('transfer_request_expired_or_invalid');
  if (!intent || !tx || tx.from !== intent.from || tx.to !== intent.to || tx.amount !== amountToNetworkNumber(intent.amount) || tx.memo !== intent.memo || tx.nonce !== intent.nonce || tx.ts !== intent.createdAt) throw Error('signed_intent_mismatch');
  const { verifyTransaction, addressFromPub } = await import('../../core.mjs');
  if (addressFromPub(tx.fromPub) !== intent.from || !verifyTransaction(tx)) throw Error('signed_transaction_invalid');
  return preflight(pin, tx);
}
export { getBalance, submitExact };
