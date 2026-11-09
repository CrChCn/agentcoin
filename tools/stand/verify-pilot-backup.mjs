#!/usr/bin/env node
// verify-pilot-backup.mjs — проверка процедуры бэкапа/отката журнала пилота
// на локальной копии, реальным кодом pilot.mjs (без сети, без служб):
//  A) первый запуск: базы нет → faucetChallenge создаёт pilot-payments.sqlite;
//  B) существующая база: claim → pending; согласованная копия (cp при закрытых
//     handle — withDb открывает sqlite на операцию) → integrity_check → tar →
//     проверка архива → снос каталога → восстановление → сверка находит запись
//     и тот же challenge для второго адреса, reconcile возвращает pending.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { sign } from 'node:crypto';
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
const archiveName = `agt-pilot-${new Date().toISOString().slice(0, 10)}.tgz`;
const archive = join(backupDir, archiveName);
// относительные пути: на Windows двоеточие диска в -f/-C tar читает как хост;
// на сервере (Ubuntu) та же команда работает с абсолютными путями.
execFileSync('tar', ['-czf', archiveName, 'pilot-payments.sqlite'], { cwd: backupDir });
const listing = execFileSync('tar', ['-tzf', archiveName], { cwd: backupDir, encoding: 'utf8' }).trim();
step('B3 архив создан и содержит журнал', existsSync(archive) && listing.includes('pilot-payments.sqlite'), `${statSync(archive).size} байт / ${listing}`);

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

const failed = out.filter((s) => !s.ok).length;
console.log(`ИТОГ backup-verify: ${out.length - failed} pass / ${failed} fail`);
rmSync(root, { recursive: true, force: true });
if (failed) process.exit(1);
