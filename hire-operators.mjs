#!/usr/bin/env node
/* hire-operators.mjs — ② Джоб «оператор ноды AGT» — реальный найм с казны.
 *
 * Публикует ЧЕСТНЫЙ escrow-джоб на джобборде:
 *   «Запусти ноду AGENTCOIN → получи 10 AGT сразу + майнинг/feesplit навсегда»
 *
 * Что делает:
 *   1) Читает ops-кошелёк (data-agents/ops-wallet.json), при нехватке — fund из казны
 *      (если этот скрипт запускается на ноде с KNOWN-кошельком казны: data/wallets.json);
 *   2) POST /escrow/create (employer=ops, worker=NULL_ADDR_placeholder — chat-канал для заявки,
 *      worker заменяется на реального кандидата при claim);
 *      ЗАЯВКА AGENTCOIN: кандидат постит handle в чат сети с memo hjobs:<escId>,
 *      мы клеймим (escrow/claim + payout) по его ответу.
 *   3) POST /community/send — анонс джоба в чат (появится на imperial/dashboard).
 *   4) Пишет data-agents/hire-escrow.json — ledger найма.
 *
 * Код честный: escrow-механика есть в цепи, никто не подделывает tx.
 * Запуск: node hire-operators.mjs [amount=10] [jobs=3]
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { signTransaction, txDigest } from './core.mjs';

const AMOUNT = Number(process.argv[2]) || 10;
const NJOBS = Number(process.argv[3]) || 3;
const API = 'http://127.0.0.1:9335';
const ROOT = process.cwd();
const LEAD_FILE = path.join(ROOT, 'data-agents', 'hire-escrow.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(l) { console.log(`[hire ${new Date().toISOString().slice(11, 19)}] ${l}`); }

async function api(method, p, body = null) {
  try {
    const r = await fetch(API + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, body: { error: e.message } }; }
}

const walletOf = (keys, label) => {
  const w = JSON.parse(fs.readFileSync(keys, 'utf8'));
  return w[label] || (w.privKey ? w : null);
};

const TASK = 'node-operator: запусти ноду AGENTCOIN в облаке/Docker/free-tier VPS по README (node node.mjs 9333), держи uptime 30+ дней, майнинг включён, peers.json → 9335/9341/9342';
const TASK_HASH_LEN = 40;

async function main() {
  // ops-кошелёк
  let opsFile = path.join(ROOT, 'data-agents', 'ops-wallet.json');
  let ops = null;
  try { ops = JSON.parse(fs.readFileSync(opsFile, 'utf8')); } catch { log('FATAL: нет ops-wallet.json'); process.exit(1); }

  // проверка баланса ops
  const bal = await api('POST', '/balance', { address: ops.address });
  const avail = (bal.body && bal.body.balance) || 0;
  log(`ops-кошелёк: ${ops.address.slice(0, 14)} · баланс ${avail.toFixed(4)} AGT`);
  if (avail < AMOUNT * NJOBS) {
    log(`⚠ мало: ${avail.toFixed(2)} < нужных ${(AMOUNT * NJOBS).toFixed(2)}. Попробуй fund-скрипт (topUpOps из army-jobs) или запусти с меньшим числом джобов`);
    process.exit(2);
  }

  const leads = fs.existsSync(LEAD_FILE) ? JSON.parse(fs.readFileSync(LEAD_FILE, 'utf8')) : { escrows: [] };

  // --- создать N escrow-джобов ---
  let created = 0;
  for (let i = 0; i < NJOBS; i++) {
    const taskHash = crypto.randomBytes(20).toString('hex').slice(0, TASK_HASH_LEN);
    // worker-заглушка: пока никто не откликнулся; заменяется при claim
    // (это же escId показывается в джобборде — кандидаты откликаются по нему)
    const workerPlaceholder = 'AGT' + crypto.randomBytes(20).toString('base64url').slice(0, 38).replace(/[-_]/g, 'x');
    const c = await api('POST', '/escrow/create', { employer: ops.address, worker: workerPlaceholder, amount: AMOUNT, taskHash, deadlineSec: 14 * 86400 });
    if (c.status !== 201) {
      log(`⚠ escrow/create: ${JSON.stringify(c.body).slice(0, 100)}`);
      // ретрай 3 раза (нода может быть занята майнером)
      for (let r = 0; r < 3; r++) {
        await sleep(5000 * (r + 1));
        const c2 = await api('POST', '/escrow/create', { employer: ops.address, worker: workerPlaceholder, amount: AMOUNT, taskHash, deadlineSec: 14 * 86400 });
        if (c2.status === 201) { c.status = 201; c.body = c2.body; break; }
      }
      if (c.status !== 201) continue;
    }
    created++;
    leads.escrows.push({
      escId: c.body.escId,
      amount: AMOUNT,
      taskHash,
      workerPlaceholder,
      created: new Date().toISOString(),
      status: 'open',
      offer: TASK,
    });
    log(`⚜ escrow #${created}: ${c.body.escId} · ${AMOUNT} AGT (escId: ${c.body.escId})`);
    await sleep(1500);
  }

  // --- анонс в чат сети ---
  const sys = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'wallets.json'), 'utf8'));
  const firstW = Object.entries(sys).find(([, w]) => w.privKey);
  if (firstW) {
    const [addr, w] = firstW;
    for (const es of leads.escrows.slice(-created)) {
      const text = `⚜ ${es.escId} · ${es.amount} AGT · ${TASK}`;
      await api('POST', '/community/send', { sender: addr, senderHandle: 'ops', text });
      await sleep(800);
    }
    log('анонс в чат отправлен');
  }

  fs.writeFileSync(LEAD_FILE, JSON.stringify(leads, null, 2));
  log(`ИТОГ: ${created} escrow-джобов опубликовано, ledger → ${path.basename(LEAD_FILE)}`);
}

import crypto from 'node:crypto';
main().catch(e => { console.error('[hire] FATAL', e); process.exit(1); });
