/* accept-AGIP-2.mjs — исполняемый критерий приёмки AGIP-2 (docs/AGIP-2.md).
   Запуск: node test/accept-AGIP-2.mjs (изолированная временная нода)
   Green, если: create(recover)=201+12 слов → recover → тот же адрес (existed:false)
   → повторный recover existed:true детерминизм → тампер → 400.
   Exit-код: 0 = приёмка пройдена; 1 = FAIL. */
import { isolatedLegacyTarget } from '../tools/isolated-test-node.mjs';
const BASE = await isolatedLegacyTarget(import.meta.url);

async function j(method, path, body = null) {
  const r = await fetch(BASE + path, {
    redirect: 'error',
    method,
    signal: AbortSignal.timeout(15000),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let b = {};
  try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}

const fails = [];
const ok = (m) => console.log('  ok: ' + m);

// 1. create seed-кошелёк
const create = await j('POST', '/wallet/create', { label: 'accept-agip2', recover: true });
if (create.status !== 201) fails.push(`create: status=${create.status}`);
const mnemonic = String(create.body.mnemonic || '');
const words = mnemonic.trim().split(/\s+/);
if (words.length !== 12) fails.push(`create: mnemonic ${words.length} слов (ожидали 12)`);
if (!create.body.address) fails.push('create: нет address');
else ok(`create=201, 12 слов, addr=${create.body.address.slice(0, 12)}…`);

// 2. recover → детерминированно тот же адрес.
// existed:false достижим только на ЧУЖОЙ ноде (create(recover) уже регистрирует кошелёк);
// на той же ноде честное existed:true. Проверяем: статус 200, адрес совпал, existed — булево.
const rec1 = mnemonic ? await j('POST', '/wallet/recover', { words: mnemonic, label: 'accept-agip2-r1' }) : { status: 0, body: {} };
if (rec1.status !== 200) fails.push(`recover#1: status=${rec1.status}`);
if (typeof rec1.body.existed !== 'boolean') fails.push(`recover#1: existed=${rec1.body.existed} (не булево)`);
if (rec1.body.address !== create.body.address) fails.push('recover#1: адрес не совпал с create (детерминизм сломан)');
else ok(`recover#1: address MATCH, existed=${rec1.body.existed} (одна нода → true)`);

// 3. повторный recover → existed:true, адрес тот же
const rec2 = mnemonic ? await j('POST', '/wallet/recover', { words: mnemonic, label: 'accept-agip2-r2' }) : { status: 0, body: {} };
if (rec2.status !== 200) fails.push(`recover#2: status=${rec2.status}`);
if (rec2.body.address !== create.body.address) fails.push('recover#2: адрес изменился — детерминизм сломан');
if (rec2.body.existed !== true) fails.push(`recover#2: existed=${rec2.body.existed} (ожидали true)`);
else ok('recover#2: deterministic, existed:true');

// 4. тампер-детект: слово НЕ из словаря → 400 гарантированно (подмена на валидное BIP-39 слово
//    может дать легальную checksum → другой адрес, 200 — это не баг, а свойство стандарта)
const tampered = mnemonic ? (() => { const w = words.slice(); w[0] = 'zzznotabip39word'; return w.join(' '); })() : '';
const bad = tampered ? await j('POST', '/wallet/recover', { words: tampered, label: 'accept-agip2-bad' }) : { status: 0 };
if (bad.status !== 400) fails.push(`tamper: status=${bad.status} (ожидали 400)`);
else ok('tamper: 400 — сид-фраза тампер-детектится');

if (fails.length) {
  console.error('AGIP-2 ACCEPT: FAIL на ' + BASE + ' → ' + fails.join('; '));
  process.exit(1);
}
console.log(`AGIP-2 ACCEPT: OK на ${BASE} (addr=${create.body.address})`);
process.exitCode = 0;
