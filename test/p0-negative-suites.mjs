// ============================================================
// EMPIRE-PILOT-01 / P0-FOUNDATION: негативные suite'ы на disposable-нодах.
// Две/несколько временных нод (tmp dataDir, admin-token, 127.0.0.1), которые
// переживают SIGKILL (каталог данных сохраняется), затем рестарт с тем же dir.
// «Двойная сверка балансов» = (1) POST /balance живой ноды, (2) независимый
// пересчёт всей chain.json через audit-lib.recalcFromChainFile.
// Ничего операторского не трогается: порты случайные, data-каталоги в /tmp.
// Запуск: node --test test/p0-negative-suites.mjs
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as core from '../core.mjs';
import { recalcFromChainFile } from '../audit-lib.mjs';

const REPO_ROOT = process.cwd();

async function pickPort() {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r));
  return port;
}

// start() — disposable нода с ОПЦИОНАЛЬНО persistence: reuse {root} открывает
// тот же dataDir (для crash/restart-сценария). Возвращает node-объект:
// { root, url, api, mine, wallet, balance, recalc, child, kill, close }
async function start({ prefix = 'agt-p0-', root = null } = {}) {
  const port = await pickPort();
  if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const bootFile = path.join(root, 'boot.json');
  fs.writeFileSync(bootFile, '{"bootstrap":[]}');
  const env = { ...process.env,
    AGT_DATA_DIR: path.join(root, 'data'), AGT_BOOTSTRAP_FILE: bootFile,
    AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: Buffer.from(crypto.randomBytes(32)).toString('hex'),
    AGT_BIND: '127.0.0.1', AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' };
  for (const k of ['AGT_CORE_P0_HEIGHT', 'AGT_TX_DIGEST_V2_HEIGHT', 'AGT_MGNT_HEIGHT', 'AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT']) delete env[k];
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'node.mjs'), String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', b => { err = (err + b).slice(-1500); });
  const url = `http://127.0.0.1:${port}`;
  const api = async (route, { method = 'GET', body, admin = true, retry503 = false } = {}) => {
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(url + route, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-token': env.AGT_ADMIN_TOKEN } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (e) {
        if (retry503 && attempt < 20) { await new Promise(rr => setTimeout(rr, 400)); continue; }
        return { status: 0, body: null, error: e.message };
      }
      const j = await r.json().catch(() => null);
      if (r.status === 503 && retry503 && attempt < 20) { await new Promise(rr => setTimeout(rr, 400)); continue; }
      return { status: r.status, body: j };
    }
  };
  let ready = false;
  for (let i = 0; i < 150 && child.exitCode === null; i++) {
    try { if ((await api('/identity/meta')).status === 200) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw new Error('node not ready (exit=' + child.exitCode + '): ' + err.slice(-600));
  const node = {
    root, url, child, adminToken: env.AGT_ADMIN_TOKEN,
    api,
    wallet: async (label) => (await api('/wallet/create', { method: 'POST', body: { label } })).body,
    mine: async (miner) => await api('/mine', { method: 'POST', body: { miner }, retry503: true }),
    balance: async (a) => Number(((await api('/balance', { method: 'POST', body: { address: a } })).body || {}).balance ?? null),
    recalc: () => recalcFromChainFile(path.join(root, 'data')).balances, // чужой heel: независимый пересчёт
    send: async (w, to, amount, nonce, memo) => {
      const tx = { from: w.address, fromPub: w.pub, to, amount, nonce, ts: Math.floor(Date.now() / 1000), memo: memo || 'p0' };
      tx.signature = core.signTransaction(tx, w.privKey);
      tx.txid = core.txDigest(tx);
      const r = await api('/tx', { method: 'POST', body: tx });
      return { ...r, txid: tx.txid }; // /tx 201-ответ может не включать txid — берём из своей подписи
    },
    kill: () => { try { child.kill('SIGKILL'); } catch {} },
    close: () => { node.kill(); return fs.promises.rm(root, { recursive: true, force: true }); },
  };
  return node;
}

function countTxidInChain(blocks, txid) {
  return (blocks || []).reduce((sum, b) => sum + (((b.txs || []).find(t => t.txid === txid)) ? 1 : 0), 0);
}

test('P0-1 replay: один txid не может быть зачислен дважды (мемпул + цепь)', async t => {
  const n = await start({ prefix: 'agt-p01-' }); t.after(n.close);
  const w = await n.wallet('p01-w'), b = await n.wallet('p01-b'), m = await n.wallet('p01-m');
  assert.equal((await n.mine(w.address)).status, 200, 'фандинг W: блок майнится (50 AGT)');
  const r1 = await n.send(w, b.address, 10, 1001, 'p01-replay');
  const r2 = await n.send(w, b.address, 10, 1001, 'p01-replay'); // та же пара (from,nonce), тот же txid
  assert.equal(r1.status, 201, 'tx принят в mempool');
  assert.notEqual(r2.status, 201, 'повтор tx отклонён мемпулом: ' + JSON.stringify(r2.body));
  assert.equal((await n.mine(m.address)).status, 200, 'пакующий блок майнится');
  const blocks = (await n.api('/blocks?n=50')).body;
  const chainBlocks = Array.isArray(blocks) ? blocks : (blocks.blocks || []);
  assert.equal(countTxidInChain(chainBlocks, r1.txid), 1, 'txid в цепи ровно один раз');
  // двойная сверка балансов: нода + независимый пересчёт из chain.json
  const apiBal = await n.balance(b.address);
  const recalcBal = n.recalc()[b.address] ?? 0;
  assert.equal(apiBal, 10, 'нода: B = 10 (не 20)');
  assert.equal(recalcBal, 10, 'recalc из chain.json: B = 10 — сходится с нодой');
});

test('P0-2 double-spend: одна пара (from,nonce) не кредитует двух получателей', async t => {
  const n = await start({ prefix: 'agt-p02-' }); t.after(n.close);
  const w = await n.wallet('p02-w'), a = await n.wallet('p02-a'), b = await n.wallet('p02-b'), m = await n.wallet('p02-m');
  assert.equal((await n.mine(w.address)).status, 200, 'у W ровно 50 AGT');
  const nonce = 2001;
  const ra = await n.send(w, a.address, 40, nonce, 'p02-ds-A');
  const rb = await n.send(w, b.address, 40, nonce, 'p02-ds-B'); // конфликт: тот же nonce
  assert.equal(ra.status, 201, 'первый член пары принят в mempool');
  assert.notEqual(rb.status, 201, 'второй с тем же (from,nonce) не принят: ' + JSON.stringify(rb.body));
  assert.equal((await n.mine(m.address)).status, 200, 'блок с одним членом пары майнится');
  const blocks = (await n.api('/blocks?n=50')).body;
  const chainBlocks = Array.isArray(blocks) ? blocks : (blocks.blocks || []);
  const inA = countTxidInChain(chainBlocks, ra.txid);
  const inB = countTxidInChain(chainBlocks, rb.txid);
  assert.ok(inA + inB <= 1, 'конфликтная пара не попала в блок целиком (A=' + inA + ', B=' + inB + ')');
  // двойная сверка: ровно один получатель получил свои 40
  const apiA = await n.balance(a.address), apiB = await n.balance(b.address);
  const rec = n.recalc();
  assert.ok(apiA + apiB === 40, 'сумма кредитов A+B = 40 (A=' + apiA + ', B=' + apiB + '), не 80');
  assert.equal((rec[a.address] ?? 0) + (rec[b.address] ?? 0), 40, 'recalc сходится с нодой для A+B');
  assert.equal(apiA, rec[a.address] ?? 0, 'A: нода == recalc');
  assert.equal(apiB, rec[b.address] ?? 0, 'B: нода == recalc');
});

test('P0-3 tamper: подмена суммы после подписи отклоняется нодой', async t => {
  const n = await start({ prefix: 'agt-p03-' }); t.after(n.close);
  const w = await n.wallet('p03-w'), to = await n.wallet('p03-to'), m = await n.wallet('p03-m');
  assert.equal((await n.mine(w.address)).status, 200);
  const tx = { from: w.address, fromPub: w.pub, to: to.address, amount: 5, nonce: 3001, ts: Math.floor(Date.now() / 1000), memo: 'p03' };
  tx.signature = core.signTransaction(tx, w.privKey);
  tx.txid = core.txDigest(tx);
  const tampered = { ...tx, amount: 500 }; // пересобрано ПОСЛЕ подписи
  const r = await n.api('/tx', { method: 'POST', body: tampered });
  assert.notEqual(r.status, 201, 'подпись не покрывает подмену → отказ: ' + JSON.stringify(r.body));
});

test('P0-4 crash: SIGKILL → рестарт на том же dataDir → двойная сверка балансов сошлась', { timeout: 120_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-p04-'));
  const pool = []; // трекинг ВСЕХ инстансов: рестарт-нода тоже обязана умереть (по-другому pайпы держат event loop и node --test не завершается)
  t.after(async () => { for (const p of pool) { try { p.kill(); } catch {} } await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {}); });
  let n = await start({ prefix: 'unused-', root }); pool.push(n);
  const w = await n.wallet('p04-w'), b = await n.wallet('p04-b'), m = await n.wallet('p04-m');
  await n.mine(w.address); // 50
  const r = await n.send(w, b.address, 10, 4001, 'p04-crash');
  assert.equal(r.status, 201);
  await n.mine(m.address); // подтверждение признака отдельным майнером (не W)
  const before = await n.balance(b.address);
  assert.equal(before, 10);
  // >>> SIGKILL и рестарт на ТОМ же каталоге данных
  n.kill(); await new Promise(res => setTimeout(res, 700));
  n = await start({ root }); pool.push(n);
  const life = (await n.api('/life')).body;
  assert.equal(life.chainValid, true, 'после рестарта chainValid=true');
  const apiAfter = await n.balance(b.address);
  const recAfter = n.recalc()[b.address] ?? 0;
  assert.equal(apiAfter, 10, 'рестарт: /balance B = 10');
  assert.equal(recAfter, 10, 'рестарт: recalc chain.json B = 10 (двойная сверка сошлась)');
  const wallAfter = await n.balance(w.address);
  assert.equal((n.recalc()[w.address] ?? 0), wallAfter, 'W нода == recalc после рестарта');
  // txid выжил в цепи ровно один раз
  const blocks = (await n.api('/blocks?n=50')).body;
  const chainBlocks = Array.isArray(blocks) ? blocks : (blocks.blocks || []);
  assert.equal(countTxidInChain(chainBlocks, r.txid), 1, 'txid не сдублировался за рестарт');
});

test('P0-5 fork choice: сближение двух нод; tx, подтверждённый только на откинутой ветке, не теряет средства', { timeout: 180_000 }, async t => {
  const N4 = await start({ prefix: 'agt-p04f-' });
  const N5 = await start({ prefix: 'agt-p05-' });
  t.after(N4.close); t.after(N5.close);
  // Обе ноды независимо, СВОЯ цепь по 2 блока: tips расходятся, генезис общий
  const g4 = (await N4.api('/info')).body.genesisHash, g5 = (await N5.api('/info')).body.genesisHash;
  assert.equal(g4, g5, 'общий генезис (одна сеть AGENTCOIN)');
  const w4 = await N4.wallet('f-w');
  // fork A (N4): 2 блока (майнится w4)
  await N4.mine(w4.address); await N4.mine(w4.address);
  // fork B (N5): 2 блока + подтверждённая пожертвование 10 → будет отброшена
  const w5 = await N5.wallet('f-w5'), pay5 = await N5.wallet('f-pay5'), b5 = await N5.wallet('f-b5');
  await N5.mine(w5.address); await N5.mine(w5.address);
  const r5 = await N5.send(w5, b5.address, 10, 5001, 'p05-fork-tx');
  assert.equal(r5.status, 201);
  await N5.mine(w5.address); // fork B теперь ВЫШЕ (3)
  // N4 синхается с N5 (higher wins): N4 → adopt fork B
  await N4.api('/peer/add', { method: 'POST', body: { peer: N5.url } });
  await N4.api('/sync-now', { method: 'POST', body: {}, retry503: true });
  const h4 = (await N4.api('/info')).body.blocks, h5b = (await N5.api('/info')).body.blocks;
  assert.ok(h4 >= h5b, 'fork choice: N4 поднялся до (или выше) N5 (h4=' + h4 + ', h5=' + h5b + ')');
  const v4 = (await N4.api('/life')).body;
  assert.equal(v4.chainValid, true, 'после adopt chainValid=true');
  // Санкция честная: txid с откинутой ветки НИГДЕ не продублирован, средства у b5 ровно один раз
  const blocks4 = (await N4.api('/blocks?n=50')).body;
  const cb4 = Array.isArray(blocks4) ? blocks4 : (blocks4.blocks || []);
  assert.equal(countTxidInChain(cb4, r5.txid), 1, 'txid fork B — ровно один в единой цепи');
  const apiB = await N4.balance(b5.address);
  const recB = (await N4.recalc())[b5.address] ?? 0;
  assert.equal(apiB, 10, 'double-spend-негатив: b5 получил 10 (нода N4)');
  assert.equal(recB, 10, 'двойная сверка: recalc N4 = 10');
});
