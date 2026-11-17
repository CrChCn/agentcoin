/* bridge proto — канонический memo-протокол и единицы моста (стенд v1).
   Чистые функции, без сети и секретов. Проверки строгие: неоднозначный ввод —
   отказ, а не округление (У3, У5).
   Единицы: 1 AGT = 1e9 магнет; 1 магнет = 1e9 wei wAGT. Только BigInt. */
import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const BRIDGE_ID = 'AGT-WAGT-V1';
export const WEI_PER_MAGNET = 1000000000n;
export const MAGNETS_PER_AGT = 1000000000n;

const sha256dHex = (s) => {
  const h = (x) => crypto.createHash('sha256').update(x).digest();
  return h(h(Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8'))).toString('hex');
};

// --- суммы: exact decimal (mirror core: ≤9 знаков) -> магнеты BigInt ---
export function agtToMagnets(value) {
  let s = typeof value === 'string' ? value.trim() : String(value);
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error('bridge_amount_not_exact_mgnt');
  const [i, f = ''] = s.split('.');
  return BigInt(i) * MAGNETS_PER_AGT + BigInt((f + '000000000').slice(0, 9));
}

export function magnetsToWei(mgnt) {
  const m = BigInt(mgnt);
  if (m <= 0n) throw new Error('bridge_amount_not_positive');
  return m * WEI_PER_MAGNET;
}

// Обратное сжигание: только кратные 1e9 wei, иначе отказ (У3). Остатка нет.
export function weiToMagnetsExact(wei) {
  const w = BigInt(wei);
  if (w <= 0n || w % WEI_PER_MAGNET !== 0n) throw new Error('bridge_wei_not_magnet_exact');
  return w / WEI_PER_MAGNET;
}

// --- lock memo: bridge_lock:v1:{bridgeId}:{destChainId}:{evmRecipient}:{amountMgnt}:{nonce} ---
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export function buildLockMemo({ bridgeId = BRIDGE_ID, destChainId, evmRecipient, amountMgnt, nonce }) {
  for (const [k, v] of Object.entries({ bridgeId, destChainId, evmRecipient, nonce })) {
    if (typeof v !== 'string' || !v || v.includes(':')) throw new Error('bridge_memo_bad_field:' + k);
  }
  if (!EVM_ADDR_RE.test(evmRecipient)) throw new Error('bridge_memo_bad_recipient');
  const m = BigInt(amountMgnt);
  if (m <= 0n) throw new Error('bridge_memo_bad_amount');
  return `bridge_lock:v${PROTOCOL_VERSION}:${bridgeId}:${destChainId}:${evmRecipient}:${m.toString()}:${nonce}`;
}

export function parseLockMemo(memo) {
  // Строгий разбор: любое отклонение = {ok:false}, выпуск запрещён (У5).
  if (typeof memo !== 'string') return { ok: false, reason: 'not_a_string' };
  const p = memo.split(':');
  if (p.length !== 7 || p[0] !== 'bridge_lock' || p[1] !== 'v' + PROTOCOL_VERSION) return { ok: false, reason: 'bad_shape' };
  const [, , bridgeId, destChainId, evmRecipient, amountStr, nonce] = p;
  if (!bridgeId || bridgeId !== BRIDGE_ID) return { ok: false, reason: 'bad_bridge' };
  if (!destChainId) return { ok: false, reason: 'bad_chain' };
  if (!EVM_ADDR_RE.test(evmRecipient)) return { ok: false, reason: 'bad_recipient' };
  if (!/^\d+$/.test(amountStr) || BigInt(amountStr) <= 0n) return { ok: false, reason: 'bad_amount' };
  if (!nonce) return { ok: false, reason: 'bad_nonce' };
  return { ok: true, bridgeId, destChainId, evmRecipient, amountMgnt: BigInt(amountStr), nonce };
}

export function buildReleaseMemo({ bridgeId = BRIDGE_ID, burnEventId }) {
  if (typeof burnEventId !== 'string' || !/^[0-9a-f]{64}$/.test(burnEventId)) throw new Error('bridge_release_bad_event');
  return `bridge_release:v${PROTOCOL_VERSION}:${bridgeId}:${burnEventId}`;
}

// --- eventId: каноническая сериализация, привязка сетей/моста/версии (защита от replay) ---
function canon(o) {
  return JSON.stringify(o, Object.keys(o).sort());
}
// Lock в Agentcoin: событие = подтверждённый перевод на vault.
export function agentcoinLockEventId({ srcChainId, destChainId, bridgeId = BRIDGE_ID, txid, vault, amountMgnt, sender, evmRecipient, nonce }) {
  return sha256dHex(canon({ v: PROTOCOL_VERSION, bridgeId, dir: 'AGT-LOCK', srcChainId, destChainId, txid, vault, amountMgnt: String(amountMgnt), sender, evmRecipient, nonce }));
}
// Burn в EVM: событие = (txHash, logIndex) контракта токена.
export function evmBurnEventId({ srcChainId, destChainId, bridgeId = BRIDGE_ID, txHash, logIndex, token, amountWei, burner, agentcoinRecipient }) {
  return sha256dHex(canon({ v: PROTOCOL_VERSION, bridgeId, dir: 'WAGT-BURN', srcChainId, destChainId, txHash, logIndex: String(logIndex), token, amountWei: String(amountWei), burner, agentcoinRecipient }));
}

// Авторизация релиза для ed25519-подписи аттестора (вариант А У1): 32 байта hex.
export function releaseAuthDigest({ bridgeId = BRIDGE_ID, burnEventId, vault, recipient, amountMgnt }) {
  return sha256dHex(canon({ v: PROTOCOL_VERSION, bridgeId, op: 'AGT-RELEASE', burnEventId, vault, recipient, amountMgnt: String(amountMgnt) }));
}
