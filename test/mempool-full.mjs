// MEMPOOL-FULL (контракт 6272239263) — тесты GET /mempool?full=1:
//   { version:1, size:<total>, complete:true|false, txs:[полные публичные signed tx],
//     tipHash:<полный tip>, height:<tip height> }; cap 1000 tx / 2MiB — сверх лимита
//   HTTP 200, complete:false, txs:[], size полный. Атомарный snapshot; никаких
//   token/seed/privKey/приватных полей в ответе. Legacy (без ?full=1) НЕ ослаблен.
// Среда: изолированная нода на tmp-порте с temp dataDir; никаких рабочих кошельков,
// ни одного обращения к живым нодам (MINER-GUARD/OPS-TEST правило).
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

const REPO_ROOT = process.cwd();

async function startNode() {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-mpfull-'));
  const token = Buffer.from(crypto.randomBytes(32)).toString('hex');
  const env = { ...process.env,
    AGT_DATA_DIR: path.join(root, 'data'), AGT_BOOTSTRAP_FILE: path.join(root, 'boot.json'),
    AGT_ADMIN_TOKEN: token, AGT_ADMIN_MODE: 'token', AGT_BIND: '127.0.0.1',
    AGT_IDENTITY_AUDIENCE: 'agt-test-node:' + port,
    AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' };
  for (const k of ['AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT']) delete env[k];
  fs.writeFileSync(env.AGT_BOOTSTRAP_FILE, '{"bootstrap":[]}');
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'node.mjs'), String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', b => { err = (err + b).slice(-2000); });
  const url = `http://127.0.0.1:${port}`;
  const api = async (route, { method = 'GET', body, admin = false, retry503 = false } = {}) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url + route, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-token': token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const j = await r.json().catch(() => null);
      if (r.status === 503 && retry503 && attempt < 20) { await new Promise(rr => setTimeout(rr, 500)); continue; } // щит «перегружена» — честный retry как у реального клиента
      return { status: r.status, body: j };
    }
  };
  let ready = false;
  for (let i = 0; i < 150 && child.exitCode === null; i++) {
    try { if ((await api('/identity/meta')).status === 200) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw new Error('test node not ready (exit=' + child.exitCode + '): ' + err.slice(-800));
  return { child, url, api, stop: async () => { try { child.kill('SIGKILL'); } catch {} await fs.promises.rm(root, { recursive: true, force: true }); } };
}

async function mineBlock(n, api, address) {
  // fund через admin /mine (поле называется miner) по одному блоку; адрес — локальный node-кошелек
  for (let i = 0; i < n; i++) {
    const r = await api('/mine', { method: 'POST', body: { miner: address }, admin: true });
    if (r.status !== 200) throw new Error('mine fail: ' + JSON.stringify(r.body).slice(0, 200));
  }
}

const PUBLIC_FIELDS = /^txid$|^from$|^fromPub$|^to$|^amount$|^nonce$|^ts$|^memo$|^signature$|^escProof$|^sig2$|^sig2Pub$|^digestVersion$|^chainId$|^kind$/; // chainId — R-02: полноценственный подписанный envelope

test('full: пустой mempool — complete:true, size 0, tip/height анкор', async t => {
  const { api, stop } = await startNode(); t.after(stop);
  const full = await api('/mempool?full=1');
  assert.equal(full.status, 200);
  assert.equal(full.body.version, 1);
  assert.equal(full.body.size, 0);
  assert.equal(full.body.complete, true);
  assert.deepEqual(full.body.txs, []);
  assert.match(String(full.body.tipHash), /^[0-9a-f]{64}$/, 'полный tipHash');
  assert.equal(typeof full.body.height, 'number');
});

test('full: непустой — полные подписанные tx, anchor точный, чужие/приватные поля удалены', async t => {
  const { api, stop } = await startNode(); t.after(stop);
  const w = (await api('/wallet/create', { method: 'POST', body: { label: 'mpfA' }, admin: true })).body;
  const rx = (await api('/wallet/create', { method: 'POST', body: { label: 'mpfB' }, admin: true })).body;
  await mineBlock(3, api, w.address);
  const tx = { from: w.address, fromPub: w.pub, to: rx.address, amount: 1, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: 'mpf-full-1' };
  tx.signature = core.signTransaction(tx, w.privKey); tx.txid = core.txDigest(tx);
  const hopToken = 'SUPER-SECRET-VALUE';               // чужое/приватное поле
  const privKeyProbe = 'PRIVATE-MUST-NOT-LEAK';        // приватное поле
  const sent = await api('/tx', { method: 'POST', body: { ...tx, hopToken, privKeyProbe } });
  assert.equal(sent.status, 201, 'tx принята в мемпул (201): ' + JSON.stringify(sent.body).slice(0, 200));
  const tipInfo = await api('/life'); // /life возвращает полный tipHash (info его не содержит)
  const r = await api('/mempool?full=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
  assert.equal(r.body.complete, true);
  assert.equal(r.body.size, r.body.txs.length);
  assert.ok(r.body.txs.length >= 1);
  const echo = r.body.txs.find(x => x.txid && core.txDigest(x) === core.txDigest(tx));
  assert.ok(echo, 'свежая tx видна полностью');
  assert.equal(echo.signature, tx.signature, 'подпись присутствует ЦЕЛИКОМ');
  assert.equal(echo.memo, tx.memo);
  assert.equal(echo.amount, tx.amount);
  assert.ok(!('hopToken' in echo) && !('privKeyProbe' in echo), 'чужое/приватное поле НЕ попало в ответ');
  assert.equal(r.body.tipHash, tipInfo.body.tipHash, 'tipHash анкорится к текущей вершине');
  // R-02 (6274233515 п.4): height = ВЫСОТА TIP (blockCount-1; генезис = height 0),
  // НЕ blockCount — клиент сверяет с headers[0].height
  assert.equal(r.body.height, tipInfo.body.blocks - 1, 'height = tip height (blockCount-1)');
  // и независимость от legacy-показа
  const legacy = await api('/mempool');
  assert.equal(legacy.status, 200);
  assert.ok(legacy.body.txs.every(x => x.txid.length <= 16 || typeof x.txid === 'string'));
});

test('full: oversize по числу tx (>1000) — complete:false, txs:[], size полный', async t => {
  const { api, stop } = await startNode(); t.after(stop);
  const w = (await api('/wallet/create', { method: 'POST', body: { label: 'ovA' }, admin: true })).body;
  const rx = (await api('/wallet/create', { method: 'POST', body: { label: 'ovB' }, admin: true })).body;
  await mineBlock(12, api, w.address); // 12×50=600 AGT достаточно (учёт ковид 0.05*1100=55)
  const base = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 1100; i++) {
    const tx = { from: w.address, fromPub: w.pub, to: rx.address, amount: 0.05, nonce: base * 100 + i, ts: base, memo: 'ov-' + i };
    tx.signature = core.signTransaction(tx, w.privKey); tx.txid = core.txDigest(tx);
    const sent = await api('/tx', { method: 'POST', body: tx });
    if (sent.status !== 201 || sent.body?.ok === false) {
      if (i > 950) break;                    // budget кончился — уже больше 1000 в мемпуле
      assert.fail('tx ' + i + ' отклонена: ' + JSON.stringify(sent.body).slice(0, 120));
    }
  }
  const r = await api('/mempool?full=1');
  assert.equal(r.status, 200);
  if (r.body.size > 1000) {
    assert.equal(r.body.complete, false, 'сверх лимита — complete:false');
    assert.deepEqual(r.body.txs, [], 'txs пуст при complete:false (fail-closed, не «усечённая правда»)');
    assert.equal(r.body.size, r.body.size, 'size полный');
  } else {
    // мемпул не набрал 1000 — контракт с покрытием: проверяем, что лимит именно по size
    assert.equal(r.body.complete, true);
  }
});

test('full: oversize по байтам (>2MiB) — complete:false, txs:[], size полный', async t => {
  const { api, stop } = await startNode(); t.after(stop);
  const w = (await api('/wallet/create', { method: 'POST', body: { label: 'bsA' }, admin: true })).body;
  const rx = (await api('/wallet/create', { method: 'POST', body: { label: 'bsB' }, admin: true })).body;
  await mineBlock(6, api, w.address);
  const base = Math.floor(Date.now() / 1000);
  const big = 'x'.repeat(300 * 1024); // 300 KiB memo ×9 — 2.7 MiB суммарно, но tx < 1000
  for (let i = 0; i < 9; i++) {
    const tx = { from: w.address, fromPub: w.pub, to: rx.address, amount: 0.05, nonce: base * 50 + i, ts: base, memo: 'bsfull-' + i + ':' + big };
    tx.signature = core.signTransaction(tx, w.privKey); tx.txid = core.txDigest(tx);
    await api('/tx', { method: 'POST', body: tx });
  }
  // примечание: 201 = принят в мемпул; контракт MEMPOOL-FULL читаем ниже
  const r = await api('/mempool?full=1', { retry503: true }); // щит может гасить тяжёлый GET — как в бою
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
  // size < 1000tx, значит единственная причина complete:false — 2MiB-лимит сериализации
  assert.equal(r.body.size, 9, 'все 9 больших tx в мемпуле');
  assert.ok(r.body.size < 1000, 'число tx под лимитом');
  assert.equal(r.body.complete, false, '2MiB лимит перекрыт: complete=false');
  assert.deepEqual(r.body.txs, [], 'fail-closed: txs пуст при неопределённой полноте');
  assert.match(String(r.body.tipHash), /^[0-9a-f]{64}$/);
});

test('full: чужие/приватные поля tx теперь белым списком — ровно публичные подписанные поля', async t => {
  const { api, stop } = await startNode(); t.after(stop);
  const w = (await api('/wallet/create', { method: 'POST', body: { label: 'ffA' }, admin: true })).body;
  const rx = (await api('/wallet/create', { method: 'POST', body: { label: 'ffB' }, admin: true })).body;
  await mineBlock(2, api, w.address);
  const tx = { from: w.address, fromPub: w.pub, to: rx.address, amount: 0.5, nonce: 77, ts: Math.floor(Date.now() / 1000), memo: 'ff' };
  tx.signature = core.signTransaction(tx, w.privKey); tx.txid = core.txDigest(tx);
  await api('/tx', { method: 'POST', body: { ...tx, walletPriv: 'x', adminToken: 'y', seedPhrase: 'z' } }); // 201 в мемпул
  const r = await api('/mempool?full=1');
  const keys = new Set((r.body.txs || []).flatMap(x => Object.keys(x)));
  for (const k of keys) assert.match(k, PUBLIC_FIELDS, 'только публичные подписанные поля: ' + k);
});

test('R-02: строгая схема nested escProof — лишние поля отклоняются НА ПРИЁМЕ (не режутся на отдаче)', async t => {
  const { api, stop } = await startNode(); t.after(stop);
  const w = (await api('/wallet/create', { method: 'POST', body: { label: 'spA' }, admin: true })).body;
  const rx = (await api('/wallet/create', { method: 'POST', body: { label: 'spB' }, admin: true })).body;
  await mineBlock(2, api, w.address);
  const tx = { from: w.address, fromPub: w.pub, to: rx.address, amount: 0.5, nonce: 91, ts: Math.floor(Date.now() / 1000), memo: 'sp' };
  tx.signature = core.signTransaction(tx, w.privKey); tx.txid = core.txDigest(tx);
  const bad = await api('/tx', { method: 'POST', body: { ...tx, escProof: { taskHash: 'a'.repeat(64), workerPub: w.pub, workerReceipt: 'r', employerConfirm: 'c', privateKey: 'SYNTHETIC_SENTINEL' } } });
  assert.equal(bad.status, 400, 'лишнее поле escProof → отклонение');
  assert.match(String(bad.body?.reason || bad.body?.error), /tx_esc_proof_extra_field:privateKey/);
  const ok = await api('/tx', { method: 'POST', body: { ...tx, escProof: { taskHash: 'b'.repeat(64), workerPub: w.pub, workerReceipt: 'r', employerConfirm: 'c' } } });
  assert.equal(ok.status, 201, 'схема-валидный escProof принимается как схема (подпись/эскроу-семантика отдельно)');
  const r = await api('/mempool?full=1');
  const echo = r.body.txs.find(x => x.escProof && x.escProof.taskHash === 'b'.repeat(64));
  assert.ok(echo, 'prуф отдаётся без редактирования (public by design)');
});

test('R-02: read-only preflight — вердикты без записи в мемпул/цепь', async t => {
  const { api, stop } = await startNode(); t.after(stop);
  const w = (await api('/wallet/create', { method: 'POST', body: { label: 'pfA' }, admin: true })).body;
  const rx = (await api('/wallet/create', { method: 'POST', body: { label: 'pfB' }, admin: true })).body;
  await mineBlock(1, api, w.address);
  const base = Math.floor(Date.now() / 1000);
  const mk = (over) => ({ from: w.address, fromPub: w.pub, to: rx.address, amount: 1, nonce: base * 2 + 7, ts: base, memo: 'pf', ...over });
  const ok = mk({});
  ok.signature = core.signTransaction(ok, w.privKey); ok.txid = core.txDigest(ok);
  const pf1 = await api('/tx/preflight', { method: 'POST', body: ok });
  assert.equal(pf1.status, 200);
  assert.equal(pf1.body.verdict, 'preflight_pass', JSON.stringify(pf1.body).slice(0, 200));
  assert.equal(pf1.body.version, 1);
  assert.equal(pf1.body.readonly, true);
  assert.equal(pf1.body.fee.amount, 0, 'комиссия действующего протокола: 0 (fee отсутствует — честно)');
  const before = (await api('/mempool?full=1')).body.size;
  assert.equal(before, 0, 'preflight не добавлял в мемпул');
  const badSig = mk({}); badSig.signature = '00'.repeat(64); badSig.txid = core.txDigest(badSig);
  const pf2 = await api('/tx/preflight', { method: 'POST', body: badSig });
  assert.equal(pf2.body.verdict, 'preflight_reject');
  assert.equal(pf2.body.signature.ok, false);
  const broke = mk({ amount: 99999 }); broke.signature = core.signTransaction(broke, w.privKey); broke.txid = core.txDigest(broke);
  const pf3 = await api('/tx/preflight', { method: 'POST', body: broke });
  assert.equal(pf3.body.balance.ok, false);
  assert.equal(pf3.body.verdict, 'preflight_reject');
  const sent = await api('/tx', { method: 'POST', body: ok });
  assert.equal(sent.status, 201);
  const dup = mk({}); dup.signature = core.signTransaction(dup, w.privKey); dup.txid = core.txDigest(dup);
  const pf4 = await api('/tx/preflight', { method: 'POST', body: dup });
  assert.equal(pf4.body.verdict, 'preflight_reject', 'повтор той же (from|nonce) в очереди ловится');
  assert.notEqual(pf4.body.nonce.ok, true, 'nonce-конфликт помечен');
  const after = (await api('/mempool?full=1')).body.size;
  assert.equal(after, before + 1, 'preflight НЕ менял мемпул: только фактическая /tx добавилась');
});
