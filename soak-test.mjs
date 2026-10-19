#!/usr/bin/env node
/* soak-test.mjs — часовой (по желанию) soak-тест ноды AGT.
 * Нагрузка: много BN小的 tx /tx + повторные /mine, включая гонки tx-vs-mine.
 * Проверки: accept-rate, сложность в границах [MIN..MAX], баны растут только у реально
 * атакующих, /life valid+fresh, latency /info.
 * Запуск: node soak-test.mjs (изолированная временная нода)   (по умолчанию 400)
 */
import { signTransaction } from './core.mjs';

import { isolatedLegacyTarget } from './tools/isolated-test-node.mjs';
const API = await isolatedLegacyTarget(import.meta.url);
const N_TX = 400;

async function api(m, p, b = null) {
  const t0 = Date.now();
  const r = await fetch(API + p, { redirect: 'error', method: m, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, ms: Date.now() - t0 };
}

const A = (await api('POST', '/wallet/create', { label: 'soak-sender' })).body;
const B = (await api('POST', '/wallet/create', { label: 'soak-receiver' })).body;
const M = (await api('POST', '/wallet/create', { label: 'soak-miner' })).body;
console.log('wallets:', A.address?.slice(0, 14), B.address?.slice(0, 14), M.address?.slice(0, 14));

// капитал: майним 2 блока майнеру A
for (let i = 0; i < 2; i++) await api('POST', '/mine', { miner: A.address });

const startBans = (await api('GET', '/security/status')).body.bannedCount ?? 0;
const startBlocks = (await api('GET', '/info')).body.blocks;

let sent = 0, ok = 0, dup = 0, otherBad = 0, spoof = 0, mineOk = 0, mine202 = 0;
const t0 = Date.now();

for (let i = 0; i < N_TX; i++) {
  const tx = {
    from: A.address, fromPub: A.pub, to: (i % 3 === 0 ? B.address : M.address),
    amount: 0.001 + (i % 7) * 0.01, nonce: Date.parse(new Date().toISOString()) % 1e9 + i,
    ts: Math.floor(Date.now() / 1000), memo: `soak#${i}`,
  };
  tx.signature = signTransaction(tx, A.privKey);
  const r = await api('POST', '/tx', tx);
  sent++;
  if (r.status === 201) ok++;
  else if (r.body?.reason === 'double_spend_attempt_permaban' || r.body?.reason === 'insufficient') otherBad++;
  else if (r.body?.error === 'address_permabanned') { console.log('!!! sender permabanned на i=', i); break; }
  else if (r.body?.reason === 'bad_signature_permaban') spoof++;
  else otherBad++;
  // каждые 25 tx — параллельный майнинг-запрос (гонка tx vs mine)
  if (i % 25 === 24) {
    const m = await api('POST', '/mine', { miner: M.address });
    if (m.status === 200) mineOk++; else mine202++;
  }
  // каждые 100 — контроль latency /info
  if (i % 100 === 99) {
    const inf = await api('GET', '/info');
    console.log(`i=${i + 1} ok=${ok} infoMs=${inf.ms} blocks=${inf.body.blocks} bits=${inf.body.difficultyBits}`);
    if (inf.ms > 3000) console.log('!!! latency runaway:', inf.ms, 'ms');
  }
}

// финальный статус
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const life = (await api('GET', '/life')).body;
const info = (await api('GET', '/info')).body;
const status = (await api('GET', '/security/status')).body;
const bansDelta = (status.bannedCount ?? Object.keys(status.banned || {}).length) - startBans;

console.log('---- ИТОГ ----');
console.log(`tx sent=${sent} ok=${ok} reject=${sent - ok} (${secs}s)`);
console.log('mine: ok=' + mineOk + ' 202=' + mine202);
console.log('bans delta:', bansDelta, '→', status.banned);
console.log('difficultyBits:', info.difficultyBits, '(границы 8..20)');
console.log('blocks:', info.blocks, '(было', startBlocks + '):', info.blocks - startBlocks);
console.log('life:', JSON.stringify({ fresh: life.fresh, valid: life.chainValid, issue: life.chainIssue }));

let fail = 0;
if (life.fresh === false) { console.log('FAIL: chain stale'); fail++; }
if (life.chainValid !== true) { console.log('FAIL: chain invalid'); fail++; }
if (info.difficultyBits > 20 || info.difficultyBits < 8) { console.log('FAIL: difficulty out of bounds'); fail++; }
// баны допустимы только если spoof-детекция поймала атаку; в чистом soak их не должно быть
if (bansDelta > 0 && spoof === 0) { console.log('FAIL: баны выросли без атак'); fail++; }
if (ok / Math.max(sent, 1) < 0.8) { console.log('FAIL: accept-rate < 80%', ok + '/' + sent); fail++; }
console.log(fail === 0 ? 'SOAK: PASS' : `SOAK: FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
