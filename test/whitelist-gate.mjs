/* whitelist-gate.mjs — приёмка opt-in гейта AGIP-16 правило 3 (>100 AGT только верифицированным).
   По умолчанию флаг ВЫКЛЮЧЕН: крупные переводы проходят (факт мейннета 2026-11-10,
   whitelist пуст). С AGT_ENFORCE_WHITELIST=1 intake/mempool режут неверифицированные
   крупные переводы; валидация блоков НЕ меняется — частичное включение сеть не форкает.
   Запуск: node test/whitelist-gate.mjs. Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Blockchain, createWallet, signTransaction, whitelistEnforced } from '../core.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-wl-'));
const bc = new Blockchain(dir);

const rich = createWallet('rich');
const poor = createWallet('poor');
for (let i = 0; i < 5; i++) bc.mineOnce(rich.address); // 5x50 = 250 AGT
const bal = bc.balances()[rich.address] || 0;
if (!(bal >= 200)) fails.push(`не смогли нафармить баланс (bal=${bal})`);
else ok(`баланс rich: ${bal} AGT`);

function spend(w, to, amount, nonce) {
  const tx = { from: w.address, to, amount, nonce, ts: Date.now(), memo: 'wl-test' };
  tx.fromPub = w.pub;
  tx.signature = signTransaction(tx, w.privKey);
  return bc.addTransaction(tx);
}

/* --- 1. Флаг выключен: крупняк от неверифицированного проходит (факт мейннета) --- */
delete process.env.AGT_ENFORCE_WHITELIST;
if (whitelistEnforced()) fails.push('флаг должен быть выключен по умолчанию');
const r1 = spend(rich, poor.address, 150, 1001);
if (!r1.ok) fails.push(`default-off: 150 AGT отклонены (${r1.reason}), а должны проходить`);
else ok('default-off: 150 AGT неверифицированного — в мемпуле (факт мейннета)');
bc.mempool.length = 0;

/* --- 2. Флаг включён: крупняк режется, мелочь проходит --- */
process.env.AGT_ENFORCE_WHITELIST = '1';
if (!whitelistEnforced()) fails.push('флаг не включился');
const r2 = spend(rich, poor.address, 150, 1002);
if (r2.ok || r2.reason !== 'needs_whitelist') fails.push(`flag-on: 150 AGT прошли (${JSON.stringify(r2)}), ждали needs_whitelist`);
else ok('flag-on: 150 AGT неверифицированного — needs_whitelist');
const r3 = spend(rich, poor.address, 50, 1003);
if (!r3.ok) fails.push(`flag-on: 50 AGT отклонены (${r3.reason}), мелочь должна проходить`);
else ok('flag-on: 50 AGT — проходит');
bc.mempool.length = 0;

/* --- 3. Верифицированный крупняк проходит при флаге --- */
const v = bc.whitelist.verify('wltest', rich.address, 'test', 'gate-accept');
if (!v.ok) fails.push('verify не сработал: ' + JSON.stringify(v));
const r4 = spend(rich, poor.address, 150, 1004);
if (!r4.ok) fails.push(`flag-on+verified: 150 AGT отклонены (${r4.reason})`);
else ok('flag-on+verified: 150 AGT — проходит');
bc.mempool.length = 0;

/* --- 4. usableMempoolTxs тоже режет (флаг включили после приёма) --- */
// rich уже верифицирован в п.3 — берём свежего неверифицированного
const rich2 = createWallet('rich2');
for (let i = 0; i < 5; i++) bc.mineOnce(rich2.address);
delete process.env.AGT_ENFORCE_WHITELIST;
const r5 = spend(rich2, poor.address, 150, 1005);
if (!r5.ok) fails.push('не приняли 150 при выключенном флаге: ' + r5.reason);
process.env.AGT_ENFORCE_WHITELIST = '1';
const usable = bc.usableMempoolTxs();
if (usable.length !== 0) fails.push(`usableMempoolTxs отдал ${usable.length} gated-tx при флаге`);
else ok('usableMempoolTxs: gated-tx не попадает в блок при флаге');
delete process.env.AGT_ENFORCE_WHITELIST;

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('WHITELIST-GATE-OK');
