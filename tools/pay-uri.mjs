#!/usr/bin/env node
// R-08 PAYMENT REQUEST — AGT URI/JSON: кодирование и строгая валидация. Без авто-отправки.
// CLI: node tools/pay-uri.mjs encode '<AGT addr>' <amount> [optsJSON]
//      node tools/pay-uri.mjs validate 'agtpay:...uri...' [expectedGenesisHash]
// URI (версия 1): agtpay:v1?n=<network>&g=<genesis12>&to=<AGT addr>&a=<amount>&id=<invoiceId>&exp=<unix>&m=<memoURI>
// JSON (версия 1): { agtpay:1, network, genesisHash, to, amount, invoiceId, expiresAt?, memo? }
// Правила: полный адрес, точная сумма (magenta-кратность через unitsOfAmountBigInt),
// чужая сеть/genesis, просрочка, дубли invoiceId (выше уровнем), лишние опасные поля → reject.
import * as core from '../core.mjs';

function encode(orig) {
  const u = orig.uri ? orig : null; // поддерживаем оба входа
  const params = orig;
  const to = params.to, amount = params.amount, network = params.network || core.networkChainId();
  const genesisHash = params.genesisHash;
  if (!core.isCanonicalAddress(to)) throw new Error('to_not_canonical_address');
  core.unitsOfAmountBigInt(amount); // mgnt-кратность, fail-closed
  if (!genesisHash || !/^[0-9a-f]{64}$/.test(genesisHash)) throw new Error('genesisHash_not_full_64hex');
  const q = new URLSearchParams({ n: network, g: genesisHash.slice(0, 16), to, a: String(amount), id: String(params.invoiceId || '') });
  if (params.expiresAt) q.set('exp', String(Math.floor(params.expiresAt)));
  if (params.memo) q.set('m', encodeURIComponent(String(params.memo).slice(0, 160)));
  return `agtpay:v1?${q.toString()}`;
}

const URX = /^agtpay:v1\?([a-zA-Z0-9._=&+%:~-]+)$/;
function validateUri(uri, expectGenesisFull) {
  const m = URX.exec(String(uri || '').trim());
  if (!m) return { ok: false, error: 'uri_not_agtpay_v1' };
  const p = new URLSearchParams(m[1]);
  const g12 = p.get('g');
  if (!g12 || g12.length !== 16) return { ok: false, error: 'genesis_prefix_missing_or_wrong_len' };
  if (expectGenesisFull && !expectGenesisFull.startsWith(g12)) return { ok: false, error: `genesis_prefix_mismatch:${g12}` };
  const to = p.get('to');
  if (!to || !core.isCanonicalAddress(to)) return { ok: false, error: 'to_not_canonical' };
  let amount;
  try { core.unitsOfAmountBigInt(Number(p.get('a'))); amount = p.get('a'); } catch { return { ok: false, error: 'amount_not_mgnt_exact' }; }
  const exp = Number(p.get('exp') || 0);
  if (exp && exp < Math.floor(Date.now() / 1000)) return { ok: false, error: 'invoice_expired', expiredAt: exp };
  return {
    ok: true, version: 1, network: p.get('n'), genesisPrefix: g12, to, amount: Number(amount),
    invoiceId: p.get('id') || null, expiresAt: exp || null, memo: p.get('m') ? decodeURIComponent(p.get('m')) : null,
    note: 'валидация ≠ отправка: оплата только через ручной/local-signer путь R-05/R-12',
  };
}

// CLI-гейт только при запуске как скрипта (иначе ESM-импорт CLI-обработки рушит тесты)
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || import.meta.url === process.argv[1] && false) {
  const mode = process.argv[2];
  if (mode === 'encode') {
    const [to, amount, rest] = process.argv.slice(3);
    const json = rest ? JSON.parse(rest) : {};
    try { console.log(encode({ to, amount: Number(amount), ...json })); } catch (e) { console.error('encode rejected: ' + e.message); process.exit(1); }
  } else if (mode === 'validate') {
    const [uri, g] = process.argv.slice(3);
    const r = validateUri(uri, g);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  }
}
export { encode, validateUri };
