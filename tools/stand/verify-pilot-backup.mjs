#!/usr/bin/env node
// verify-pilot-backup.mjs — проверка процедуры бэкапа/отката журнала пилота
// на локальной копии, реальным кодом pilot.mjs (без сети, без служб):
//  A) первый запуск: базы нет → faucetChallenge создаёт pilot-payments.sqlite;
//  B) существующая база: claim → pending; согласованная копия (cp при закрытых
//     handle — withDb открывает sqlite на операцию) → integrity_check → tar →
//     проверка архива → снос каталога → восстановление → сверка находит запись
//     и тот же challenge для второго адреса, reconcile возвращает pending.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWallet } from '../../core.mjs';
import { createPilot } from '../../pilot.mjs';

const out = [];
const step = (name, ok, detail = '') => { out.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const root = mkdtempSync(join(tmpdir(), 'agt-pilot-backup-'));
const dataDir = join(root, 'data-vps'); // зеркало /opt/agentcoin/data-vps
const backupDir = join(root, 'backup');
mkdirSync(backupDir, { recursive: true });
const fund = createWallet();
const agent = createWallet();
const other = createWallet();
for (const [k, v] of Object.entries({ AGT_PILOT_FAUCET_FUND: fund.address, AGT_PILOT_PAYOUT_FUND: '', AGT_PILOT_REVOKED_FILE: '', AGT_PILOT_PAYOUT_REGISTRY: '', AGT_FAUCET_FUND: '' })) process.env[k] = v;

const realMempool = [];
const bc = {
  chain: [], mempool: realMempool, knownChainTxids: () => new Set(),
  balances: () => ({ [fund.address]: 100 }),
  addTransaction(tx) { this.mempool.push(tx); return { ok: true }; },
};
const start = () => createPilot({ dataDir, bc, announce() {},
  loadWallets: () => ({ [fund.address]: fund }),
  identity: { find: (a) => [agent, other].find((w) => w.address === a), verify: () => ({ ok: true }) },
  isBanned: () => false,
});
const dbFile = join(dataDir, 'pilot-payments.sqlite');

// A) первый запуск: файла нет
step('A1 базы до запуска нет', !existsSync(dbFile));
let pilot = start();
const chAgent = pilot.faucetChallenge(agent.address);
step('A2 challenge выдан', chAgent.ok === true, (chAgent.challengeId || chAgent.error || ''));
step('A3 pilot-payments.sqlite создан первым запуском', existsSync(dbFile), dbFile);
// challenge для второго адреса — переживёт бэкап/восстановление как есть
const chOther = pilot.faucetChallenge(other.address);
step('A4 второй challenge выдан', chOther.ok === true, (chOther.challengeId || ''));
const claim = pilot.faucetClaim(chAgent.challengeId, sign(null, Buffer.from(chAgent.message), agent.privKey).toString('hex'));
step('A5 claim → pending', claim.status === 'pending', `${claim.status || claim.error} txid=${(claim.txid || '').slice(0, 12)}`);

// B) согласованная копия: handle закрыты (withDb), обычный cp
const copyFile = join(backupDir, 'pilot-payments.sqlite');
cpSync(dbFile, copyFile);
step('B1 копия снята', existsSync(copyFile), `${statSync(copyFile).size} байт`);
const chk = new DatabaseSync(copyFile);
let integrity = '';
try { integrity = chk.prepare('PRAGMA integrity_check').get()?.integrity_check || ''; } finally { chk.close(); }
step('B2 integrity_check копии', integrity === 'ok', integrity);
const stray = readdirSync(dataDir).filter((f) => /-(wal|shm|journal)$/.test(f));
step('B2b нет WAL/journal-файлов (withDb закрывает соединение)', stray.length === 0, stray.join(',') || 'чисто');
const sumBefore = createHash('sha256').update(readFileSync(copyFile)).digest('hex');
const archiveName = `agt-pilot-${new Date().toISOString().slice(0, 10)}.tgz`;
const archive = join(backupDir, archiveName);
// относительные пути: на Windows двоеточие диска в -f/-C tar читает как хост;
// на сервере (Ubuntu) та же команда работает с абсолютными путями.
execFileSync('tar', ['-czf', archiveName, 'pilot-payments.sqlite'], { cwd: backupDir });
const listing = execFileSync('tar', ['-tzf', archiveName], { cwd: backupDir, encoding: 'utf8' }).trim();
step('B3 архив создан и содержит журнал', existsSync(archive) && listing.includes('pilot-payments.sqlite'), `${statSync(archive).size} байт / ${listing}`);
chmodSync(archive, 0o600); // на сервере (Ubuntu) даёт 600; на Windows chmod — no-op
const amode = (statSync(archive).mode & 0o777).toString(8);
const modeOk = process.platform === 'win32' ? true : amode === '600';
step('B3b права архива ограничены, sha256 зафиксирована', modeOk, `${amode}${process.platform === 'win32' ? ' (windows: chmod no-op, на сервере 600)' : ''} sha256=${sumBefore.slice(0, 16)}…`);

// снос каталога (имитация потери) → восстановление из архива
rmSync(dataDir, { recursive: true, force: true });
step('B4 каталог данных снесён', !existsSync(dbFile));
mkdirSync(dataDir, { recursive: true });
execFileSync('tar', ['-xzf', join('backup', archiveName)], { cwd: root });
mkdirSync(dataDir, { recursive: true });
renameSync(join(root, 'pilot-payments.sqlite'), dbFile);
step('B5 журнал восстановлен из архива', existsSync(dbFile));
pilot = start();
const st = pilot.status();
step('B6 счётчик журнала пережил восстановление', st.counts?.faucet === 1, JSON.stringify(st.counts));
const chOther2 = pilot.faucetChallenge(other.address);
step('B7 challenge второго адреса тот же (таблица challenges цела)', chOther2.challengeId === chOther.challengeId, (chOther2.challengeId || '').slice(0, 12));
const rec = pilot.reconcile();
const still = (rec.faucet || []).find((r) => r.challengeId === chAgent.challengeId);
step('B8 reconcile после восстановления → pending, тот же txid', still?.action === 'pending' && still?.txid === claim.txid, `${still?.action} ${(still?.txid || '').slice(0, 12)}`);
const sumAfter = createHash('sha256').update(readFileSync(dbFile)).digest('hex');
step('B8b контрольная сумма восстановленного журнала совпала', sumAfter === sumBefore, sumAfter.slice(0, 16));

// C) дефект отката: новая pending-запись ПОСЛЕ бэкапа.
// C1: вторая выплата (новый txid) в живом каталоге.
const claim2 = pilot.faucetClaim(chOther2.challengeId, sign(null, Buffer.from(chOther2.message), other.privKey).toString('hex'));
step('C1 вторая запись → pending, новый txid', claim2.status === 'pending' && claim2.txid !== claim.txid, `${claim2.status || claim2.error} txid=${(claim2.txid || '').slice(0, 12)}`);
// C2: откат КОНФИГУРАЦИИ сохраняет текущий журнал: снимаем актуальную копию до любых изменений.
const liveCopy = join(backupDir, 'pilot-payments-live.sqlite');
cpSync(dbFile, liveCopy);
const liveDb = new DatabaseSync(liveCopy);
let liveRows = [];
try { liveRows = liveDb.prepare('SELECT challenge_id, txid, state FROM faucet_payments ORDER BY id').all(); } finally { liveDb.close(); }
step('C2 актуальный журнал сохранён: обе записи с исходными txid', liveRows.length === 2 && liveRows.every((r) => r.txid), liveRows.map((r) => `${(r.txid || '').slice(0, 8)}:${r.state}`).join(','));
// C3: восстановление СТАРОГО архива — только в отдельный каталог: новая запись там отсутствует.
const sepDir = join(root, 'restore-check'); mkdirSync(sepDir, { recursive: true });
execFileSync('tar', ['-xzf', join('backup', archiveName)], { cwd: root });
renameSync(join(root, 'pilot-payments.sqlite'), join(sepDir, 'pilot-payments.sqlite'));
const sepDb = new DatabaseSync(join(sepDir, 'pilot-payments.sqlite'));
let sepRows = [];
try { sepRows = sepDb.prepare('SELECT txid FROM faucet_payments').all(); } finally { sepDb.close(); }
step('C3 старый архив проверен отдельно: новая запись там ОТСУТСТВУЕТ (перезапись вживую потеряла бы её)',
  sepRows.length === 1 && !sepRows.some((r) => r.txid === claim2.txid) && existsSync(dbFile),
  `архив: ${sepRows.length} запись; живой каталог цел`);
step('C4 живой каталог цел после всех операций', existsSync(dbFile), '');
const st2 = pilot.status();
step('C5 счётчик живого журнала = 2', st2.counts?.faucet === 2, JSON.stringify(st2.counts));
const submitsBefore = bc.mempool.length;
const rec2 = pilot.reconcile();
const both = (rec2.faucet || []).filter((r) => r.action === 'pending');
step('C6 повторная сверка: обе pending с исходными txid, новых отправок нет', both.length === 2 && bc.mempool.length === submitsBefore &&
  both.some((r) => r.txid === claim.txid) && both.some((r) => r.txid === claim2.txid),
  both.map((r) => (r.txid || '').slice(0, 8)).join(','));

const failed = out.filter((s) => !s.ok).length;
console.log(`ИТОГ backup-verify: ${out.length - failed} pass / ${failed} fail`);
rmSync(root, { recursive: true, force: true });
if (failed) process.exit(1);
