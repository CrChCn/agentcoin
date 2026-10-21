// Resolve public material only. A cabinet session never authorizes signing.
import { addressFromPub } from './core.mjs';
import { canonicalAgentPublicKey } from './agent-identity.mjs';

export function resolveOperationPublicKey(cabinet, address) {
  const record = cabinet.findPassportByAddress(address);
  // A missing/revoked passport must not be bypassed by a local wallet entry.
  if (!record || record.revoked) return null;
  // Legacy records may omit pub; never replace an explicit invalid passport key.
  const candidate = record.pub ?? cabinet.wallets()[address]?.pub;
  if (candidate == null || candidate === '') return null;
  let pub;
  try { pub = canonicalAgentPublicKey(candidate); }
  catch { throw new Error('passport_pub_invalid'); }
  if (addressFromPub(pub) !== address) throw new Error('passport_pub_address_mismatch');
  return pub;
}
