#!/usr/bin/env node
// verify-pilot-audit.mjs — сценарий D: сверка ТОЛЬКО ДЛЯ ЧТЕНИЯ.
// Транзакции нет ни в цепи, ни в мемпуле: аудит обязан обнаружить отсутствие,
// не вызывать submitTx, не менять мемпул и сохранить запись с исходным txid.
// Вторая запись после бэкапа + откат конфигурации: обе записи сохраняются,
// старый архив проверяется в отдельном каталоге.
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWallet } from '../../core.mjs';
import { createPilot } from '../../pilot.mjs';

const out = [];
const step = (name, ok, detail = '') => { out.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const root = mkdtempSync(join(tmpdir(), 'agt-pilot-audit-'));
const dataDir = join(root, 'data-vps');
const backupDir = join(root, 'backup');
mkdirSync(backupDir, { recursive: true });
const fund = createWallet();
for (const [k, v] of Object.entries({ AGT_PILOT_FAUCET_FUND: fund.address, AGT_PILOT_PAYOUT_FUND: '', AGT_PILOT_REVOKED_FILE: '', AGT_PILOT_PAYOUT_REGISTRY: '', AGT_FAUCET_FUND: '' })) process.env[k] = v;

let submits = 0;
const bc = {
  chain: [], mempool: [], knownChainTxids: () => new Set(),
  balances: () => ({ [fund.address]: 100 }),
  addTransaction(tx) { submits += 1; this.mempool.push(tx); return { ok: true }; },
};
const start = () => createPilot({ dataDir, bc, announce() {},
  loadWallets: () => ({ [fund.address]: fund }),
  identity: { find: () => null, verify: () => ({ ok: true }) },
  isBanned: () => false,
});
const dbFile = join(dataDir, 'pilot-payments.sqlite');

// D0: пилот создан (база появляется первым запуском), вставляем две записи
// с известными txid напрямую: recorded и pending, обеих нет нигде.
let pilot = start();
pilot.status(); // создать таблицы первым обращением
const ghost1 = 'e'.repeat(63) + '1';
const ghost2 = 'e'.repeat(63) + '2';
const ins = new DatabaseSync(dbFile);
try {
  ins.prepare('INSERT INTO faucet_payments(challenge_id,address,amount_minor,txid,tx_json,state,reason,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('audit-ghost-1', fund.address, 500000000, ghost1, JSON.stringify({ txid: ghost1, from: fund.address }), 'recorded', null, Date.now(), '2026-11-09');
  ins.prepare('INSERT INTO faucet_payments(challenge_id,address,amount_minor,txid,tx_json,state,reason,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('audit-ghost-2', fund.address, 500000000, ghost2, JSON.stringify({ txid: ghost2, from: fund.address }), 'pending', null, Date.now(), '2026-11-09');
} finally { ins.close(); }
step('D0 две записи с известными txid внесены (recorded + pending)', true, ghost1.slice(0, 8) + ',' + ghost2.slice(0, 8));

// D1: аудит обнаруживает отсутствие обеих транзакций.
const mpBefore = bc.mempool.length;
const audit = pilot.reconcileAudit();
const a1 = (audit.faucet || []).find((r) => r.challengeId === 'audit-ghost-1');
const a2 = (audit.faucet || []).find((r) => r.challengeId === 'audit-ghost-2');
step('D1 аудит: обе записи seen=missing, needsReview', audit.ok === true && a1?.seen === 'missing' && a2?.seen === 'missing' && a1?.needsReview === true && a2?.needsReview === true, `${a1?.seen}/${a2?.seen}`);

// D2: submitTx не вызывался, мемпул не изменился.
step('D2 submitTx не вызван, мемпул без изменений', submits === 0 && bc.mempool.length === mpBefore, `submits=${submits} mempool=${bc.mempool.length}`);

// D3: записи в журнале нетронуты (состояния и txid исходные).
const chk = new DatabaseSync(dbFile);
let rows = [];
try { rows = chk.prepare('SELECT challenge_id, txid, state FROM faucet_payments WHERE challenge_id LIKE ? ORDER BY challenge_id').all('audit-ghost-%'); } finally { chk.close(); }
step('D3 записи сохранены с исходными txid и состояниями', rows.length === 2 && rows[0].txid === ghost1 && rows[0].state === 'recorded' && rows[1].txid === ghost2 && rows[1].state === 'pending', rows.map((r) => `${r.txid.slice(0, 8)}:${r.state}`).join(','));

// D4: бэкап актуального журнала (ворота отката конфигурации).
const liveCopy = join(backupDir, 'pilot-payments-live.sqlite');
cpSync(dbFile, liveCopy);
step('D4 актуальная копия снята', existsSync(liveCopy), 'sha ворот зафиксирована процедурой');

// D5: вторая запись ПОСЛЕ бэкапа (имитация операции между копией и откатом).
const ghost3 = 'e'.repeat(63) + '3';
const ins2 = new DatabaseSync(dbFile);
try {
  ins2.prepare('INSERT INTO faucet_payments(challenge_id,address,amount_minor,txid,tx_json,state,reason,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('audit-ghost-3', fund.address, 500000000, ghost3, JSON.stringify({ txid: ghost3, from: fund.address }), 'recorded', null, Date.now(), '2026-11-09');
} finally { ins2.close(); }
pilot = start(); // откат конфигурации: перезапуск службы на том же каталоге, журнал на месте
const st = pilot.status();
step('D5 откат конфигурации: журнал на месте, счётчик = 3', st.counts?.faucet === 3, JSON.stringify(st.counts));

// D6: повторный аудит: все три missing, отправок нет, txid исходные.
const submitsBefore = submits;
const audit2 = pilot.reconcileAudit();
const all = audit2.faucet || [];
step('D6 повторный аудит: 3 missing, отправок нет, txid исходные', all.length === 3 && all.every((r) => r.seen === 'missing') && submits === submitsBefore &&
  all.some((r) => r.txid === ghost1) && all.some((r) => r.txid === ghost2) && all.some((r) => r.txid === ghost3),
  all.map((r) => (r.txid || '').slice(0, 8)).join(','));

const failed = out.filter((s) => !s.ok).length;
console.log(`ИТОГ audit-stand: ${out.length - failed} pass / ${failed} fail`);
if (failed) process.exit(1);
