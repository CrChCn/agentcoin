#!/usr/bin/env node
// sign-op — локальная проверка и подпись операции кабинета (AGIP-46).
// Страница /wallet готовит пакет (/cabinet/op-request), оператор сверяет его
// глазами, а ПОДПИСЬ ставит только этот CLI — после собственной проверки.
//
// Использование:
//   echo '{"password":"..."}' | node agt-skill/sign-op.mjs \
//     --profile /private/agent/profile.json \
//     --op agentcoin-op-<opId>.json \
//     --to AGT... --amount 1.25 [--memo текст] [--network AGENTCOIN]
//
// Что проверяет ДО подписи (несоответствие = отказ, код выхода 1):
//   сеть профиля, from пакета == адресу профиля, привязка fromPub->from,
//   to/amount/memo == переданным ожиданиям, точный пересчёт txid по core.mjs.
// Подписываются БАЙТЫ txid (как требует /cabinet/op-submit: подпись над дайджестом).
// В stdout — только {"opId","txid","signature"}; ключ в вывод не попадает.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { txDigest, addressFromPub, unitsOfAmountBigInt } from '../core.mjs';
import { readPrivateKey } from './agent-profile.mjs';

function fail(code, detail) {
  process.stderr.write(code + (detail ? ': ' + String(detail).slice(0, 200) : '') + '\n');
  process.exitCode = 1;
  throw new Error(code);
}
function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0 || i + 1 >= process.argv.length) fail('usage_sign_op_missing_' + name);
  return process.argv[i + 1];
}
async function stdinJSON() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('stdin_json_object_required');
    return v;
  } catch (e) { if (e && e.message && e.message.startsWith('stdin_')) throw e; fail('stdin_invalid_json'); }
}

try {
  const profilePath = arg('profile'), opPath = arg('op');
  const expectTo = arg('to'), expectAmount = arg('amount');
  const expectMemo = process.argv.includes('--memo') ? arg('memo') : '';
  const expectNetwork = process.argv.includes('--network') ? arg('network') : 'AGENTCOIN';
  const { password } = await stdinJSON();
  if (typeof password !== 'string' || !password) fail('password_required');

  let raw;
  try { raw = JSON.parse(fs.readFileSync(opPath, 'utf8')); }
  catch { fail('op_file_unreadable', opPath); }
  // Принимаем и полный ответ сервера {ok,opId,payload}, и сохранённый payload.
  const opId = raw.opId || (raw.payload && raw.payload.opId) || null;
  const payload = raw.payload || raw;
  if (!opId || typeof opId !== 'string') fail('op_id_missing');
  if (!payload || payload.kind !== 'send' || !payload.tx || typeof payload.tx !== 'object') fail('op_not_send_package');
  if (typeof payload.txidHex !== 'string' || !/^[0-9a-f]{64}$/i.test(payload.txidHex)) fail('op_txid_hex_missing');
  const tx = payload.tx;

  const ident = await readPrivateKey({ profilePath, password });
  if (ident.network !== expectNetwork) fail('profile_network_mismatch', ident.network);
  if (tx.from !== ident.address) fail('op_from_foreign', tx.from);
  if (!tx.fromPub || addressFromPub(tx.fromPub) !== tx.from) fail('op_frompub_not_bound');
  if (tx.to !== expectTo) fail('op_to_mismatch', tx.to);
  const memo = tx.memo || '';
  if (memo !== expectMemo) fail('op_memo_mismatch');
  let wantMinor, gotMinor;
  try { wantMinor = unitsOfAmountBigInt(expectAmount); } catch { fail('expect_amount_not_exact'); }
  try { gotMinor = unitsOfAmountBigInt(tx.amount); } catch { fail('op_amount_not_exact'); }
  if (wantMinor !== gotMinor || wantMinor <= 0n) fail('op_amount_mismatch');

  // Точный пересчёт идентификатора теми же байтами, что сервер: подпись обязана
  // относиться именно к показанному пакету, а не к чужому txid из файла.
  const recomputed = txDigest({ from: tx.from, to: tx.to, amount: tx.amount,
    nonce: tx.nonce, ts: tx.ts, memo: tx.memo || '' });
  if (recomputed !== payload.txidHex.toLowerCase()) fail('op_txid_mismatch');

  const signature = crypto.sign(null, Buffer.from(payload.txidHex, 'hex'), ident.privKey).toString('hex');
  if (!/^[0-9a-f]{128}$/i.test(signature)) fail('signer_error');
  if (!crypto.verify(null, Buffer.from(payload.txidHex, 'hex'), ident.pub, Buffer.from(signature, 'hex')))
    fail('signature_selfcheck_failed');
  process.stdout.write(JSON.stringify({ opId, txid: payload.txidHex.toLowerCase(), signature }) + '\n');
} catch (e) {
  if (!process.exitCode) { process.stderr.write('sign_op_failed\n'); process.exitCode = 1; }
}
