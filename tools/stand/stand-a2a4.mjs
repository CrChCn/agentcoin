#!/usr/bin/env node
/* stand-a2a4.mjs — изолированный стенд A2–A4: три ноды, партиция, кран, выплаты.
   A2: mesh из 3 нод → доставка новых блоков при потере одного соединения (стоп C,
       майнинг на A, B догоняет; рестарт C с тем же datadir → догоняет всех).
   A3: кран /faucet/drip на стенде (фонд = свежесозданный кошелёк, профинансирован
       майнингом): drip 0.5 → 200, повтор → 429, второй адрес → 200.
   A4: выплаты 0.5 / 5 / 20 AGT трём операторам + защита от повторов (ресubmit того же
       txid отклонён, балансы и ончейн-след проверены).
   Итог: tools/stand печатает таблицу + пишет docs/a-topology/stand-a2a4-results.json.
   Запуск из корня репо: node tools/stand/stand-a2a4.mjs  (чистит tmp, KEEP=1 оставить) */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { signTransaction, txDigest } from '../../core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'docs', 'a-topology', 'stand-a2a4-results.json');
const results = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, ok, detail) => { results.steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

async function pickPort() {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(name, port, dataDir, faucetFund) {
  const token = crypto.randomBytes(32).toString('hex');
  const boot = path.join(path.dirname(dataDir), 'boot.json');
  if (!fs.existsSync(boot)) fs.writeFileSync(boot, '{"bootstrap":[]}');
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BOOTSTRAP_FILE: boot,
    AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: token,
    AGT_BIND: '127.0.0.1', AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' };
  for (const k of ['AGT_CORE_P0_HEIGHT','AGT_TX_DIGEST_V2_HEIGHT','AGT_MGNT_HEIGHT','AGT_TRUSTED_ISSUERS_FILE','AGT_PASSPORT_ISSUER_FINGERPRINT']) delete env[k];
  if (faucetFund) env.AGT_FAUCET_FUND = faucetFund;
  const child = spawn(process.execPath, [path.join(REPO, 'node.mjs'), String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', b => { err = (err + b).slice(-1500); });
  const url = `http://127.0.0.1:${port}`;
  const api = async (route, { method = 'GET', body } = {}) => {
    const r = await fetch(url + route, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  for (let i = 0; i < 200 && child.exitCode === null; i++) {
    try { if ((await api('/identity/meta')).status === 200) return { name, port, url, api, child, dataDir, token, stop: async (keep) => { try { child.kill('SIGKILL'); } catch {} await sleep(500); if (!keep) await fs.promises.rm(path.dirname(dataDir), { recursive: true, force: true }); } }; } catch {}
    await sleep(150);
  }
  throw new Error(name + ' not ready: ' + err.slice(-400));
}
const life = async n => (await n.api('/life')).body;
// Доставка блоков в mesh — pull: явный /sync-now (на проде плюс периодический syncAll 90с, AGIP-25)
async function pullAll(list) { for (const n of list) await n.api('/sync-now', { method: 'POST', body: {} }).catch(() => {}); }
const tip = async n => { const l = await life(n); return { blocks: l.blocks, tip: l.tipHash }; };
async function waitTip(n, blocks, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const t = await tip(n).catch(() => null); if (t && t.blocks >= blocks) return t; await sleep(1000); }
  return await tip(n).catch(() => ({ blocks: -1 }));
}

const nodes = [];
const KEEP = process.env.KEEP === '1';
try {
  // ---- 0) три ноды, один генезис
  const ports = [await pickPort(), await pickPort(), await pickPort()];
  for (let i = 0; i < 3; i++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-stand-'));
    nodes.push(await boot('ABC'[i], ports[i], path.join(root, 'data')));
  }
  const gens = new Set((await Promise.all(nodes.map(async n => (await n.api('/ws/status')).body.genesisHash))));
  step('A2.0 один генезис у трёх нод', gens.size === 1, [...gens][0]?.slice(0, 16));

  // ---- 1) mesh + доставка
  for (const [a, b] of [[0, 1], [1, 0], [1, 2], [2, 1], [0, 2], [2, 0]]) {
    const r = await nodes[a].api('/peer/add', { method: 'POST', body: { peer: nodes[b].url } });
    if (![200, 201, 409].includes(r.status)) throw new Error(`peer/add ${a}->${b}: ${r.status}`);
  }
  for (const n of nodes) await n.api('/sync-now', { method: 'POST', body: {} });
  const w0 = (await nodes[0].api('/wallet/create', { method: 'POST', body: { label: 'miner' } })).body;
  await nodes[0].api('/mine', { method: 'POST', body: { miner: w0.address } });
  await nodes[0].api('/mine', { method: 'POST', body: { miner: w0.address } });
  await pullAll([nodes[1], nodes[2]]);
  const tA = await tip(nodes[0]);
  const tB = await waitTip(nodes[1], tA.blocks), tC = await waitTip(nodes[2], tA.blocks);
  step('A2.1 mesh: блоки A доставлены B и C', tB.tip === tA.tip && tC.tip === tA.tip, `A:h=${tA.blocks} B:h=${tB.blocks} C:h=${tC.blocks} sameTip=${tB.tip === tA.tip && tC.tip === tA.tip}`);

  // ---- 2) партиция: C мёртв, A майнит, B должен получить
  const cPort = nodes[2].port, cDir = nodes[2].dataDir;
  await nodes[2].stop(true);
  nodes.splice(2, 1);
  await sleep(1000);
  await nodes[0].api('/mine', { method: 'POST', body: { miner: w0.address } });
  await nodes[0].api('/mine', { method: 'POST', body: { miner: w0.address } });
  await pullAll([nodes[1]]);
  const tA2 = await tip(nodes[0]);
  const tB2 = await waitTip(nodes[1], tA2.blocks);
  step('A2.2 партиция: при потере C новые блоки A доставлены B', tB2.blocks === tA2.blocks && tB2.tip === tA2.tip, `A:h=${tA2.blocks} B:h=${tB2.blocks} sameTip=${tB2.tip === tA2.tip}`);
  let cGone = false;
  try { await fetch(nodes[2]?.url ?? `http://127.0.0.1:${cPort}/life`, { signal: AbortSignal.timeout(3000) }); } catch { cGone = true; }
  step('A2.3 C действительно недоступен', cGone, `порт ${cPort} молчит`);

  // ---- 3) рестарт C с тем же datadir → догоняет
  const rootC = path.dirname(cDir);
  const C = await boot('C', cPort, cDir);
  nodes.push(C);
  for (const n of nodes) { try { await n.api('/peer/add', { method: 'POST', body: { peer: C.url } }); } catch {} try { await C.api('/peer/add', { method: 'POST', body: { peer: n.url } }); } catch {} }
  await C.api('/sync-now', { method: 'POST', body: {} });
  const tC2 = await waitTip(C, tA2.blocks, 90000);
  step('A2.4 healing: C после рестарта догнал цепь', tC2.blocks === tA2.blocks && tC2.tip === tA2.tip, `h=${tC2.blocks}`);

  // ---- 4) кран: фонд + рестарт A с AGT_FAUCET_FUND
  const fund = (await nodes[0].api('/wallet/create', { method: 'POST', body: { label: 'faucet-fund' } })).body;
  for (let i = 0; i < 3; i++) await nodes[0].api('/mine', { method: 'POST', body: { miner: fund.address } });
  const aPort = nodes[0].port, aDir = nodes[0].dataDir;
  await nodes[0].stop(true);
  const A2 = await boot('A', aPort, aDir, fund.address);
  nodes[0] = A2;
  for (const n of nodes) for (const m of nodes) { if (n !== m) { try { await n.api('/peer/add', { method: 'POST', body: { peer: m.url } }); } catch {} } }
  await A2.api('/sync-now', { method: 'POST', body: {} });
  const newcomer = 'AGT' + crypto.randomBytes(20).toString('hex');
  const d1 = await A2.api('/faucet/drip', { method: 'POST', body: { address: newcomer } });
  const d2 = await A2.api('/faucet/drip', { method: 'POST', body: { address: newcomer } });
  const newcomer2 = 'AGT' + crypto.randomBytes(20).toString('hex');
  const d3 = await A2.api('/faucet/drip', { method: 'POST', body: { address: newcomer2 } });
  step('A3.1 кран: drip 0.5 новому адресу', d1.status === 200 && d1.body.dripped === 0.5, JSON.stringify(d1.body).slice(0, 90));
  step('A3.2 кран: повтор тому же адресу отклонён (24ч)', d2.status === 429, JSON.stringify(d2.body).slice(0, 90));
  step('A3.3 кран: второй адрес обслужен', d3.status === 200, `dripped=${d3.body.dripped}`);
  await A2.api('/mine', { method: 'POST', body: { miner: w0.address } });
  const bal1 = await A2.api('/balance', { method: 'POST', body: { address: newcomer } });
  step('A3.4 кран: 0.5 ончейн после блока', Number(bal1.body.balance) === 0.5, `balance=${bal1.body.balance}`);

  // ---- 5) выплаты 0.5/5/20 + защита от повторов
  const ops = [];
  for (let i = 0; i < 3; i++) ops.push((await A2.api('/wallet/create', { method: 'POST', body: { label: 'op' + (i + 1) } })).body);
  const budgets = [0.5, 5, 20];
  const signed = budgets.map((amt, i) => {
    const tx = { from: fund.address, fromPub: fund.pub, to: ops[i].address, amount: amt, nonce: Date.now() + i, ts: Math.floor(Date.now() / 1000), memo: `payout:stand-op${i + 1}:${amt}AGT` };
    tx.txid = txDigest(tx); tx.signature = signTransaction(tx, fund.privKey); return tx;
  });
  for (let i = 0; i < 3; i++) {
    const r = await A2.api('/tx', { method: 'POST', body: signed[i] });
    if (![200, 201].includes(r.status)) throw new Error(`payout ${budgets[i]}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  await A2.api('/mine', { method: 'POST', body: { miner: w0.address } });
  await A2.api('/mine', { method: 'POST', body: { miner: w0.address } });
  const bals = [];
  for (let i = 0; i < 3; i++) bals.push(Number((await A2.api('/balance', { method: 'POST', body: { address: ops[i].address } })).body.balance));
  step('A4.1 выплаты 0.5/5/20 ончейн', bals[0] === 0.5 && bals[1] === 5 && bals[2] === 20, `балансы=${bals.join('/')}`);
  const replay = [];
  for (let i = 0; i < 3; i++) replay.push(await A2.api('/tx', { method: 'POST', body: signed[i] }));
  step('A4.2 повтор тех же txid отклонён', replay.every(r => ![200, 201].includes(r.status)), replay.map(r => r.status + ':' + JSON.stringify(r.body).slice(0, 60)).join(' | '));
  const blocks = (await A2.api('/blocks', { method: 'GET' })).body.blocks ?? [];
  const chain = Array.isArray(blocks) ? blocks.slice().reverse() : [];
  const hits = signed.map(s => chain.filter(b => (b.txs || []).some(t => t.txid === s.txid)).length);
  step('A4.3 каждая выплата в цепи ровно 1 раз', hits.every(h => h === 1), `вхождений=${hits.join('/')}`);

  // ---- 6) финальный mesh после всех рестартов
  for (const n of nodes) await n.api('/sync-now', { method: 'POST', body: {} }).catch(() => {});
  const tips = await Promise.all(nodes.map(tip));
  step('A2.5 финал: все три на одном tip', new Set(tips.map(t => t.tip)).size === 1, `h=${tips[0].blocks}`);
} catch (e) {
  step('harness', false, String(e.message || e).slice(0, 300));
  results.error = String(e.stack || e).slice(0, 800);
} finally {
  for (const n of nodes) { try { await n.stop(!KEEP); } catch {} }
}
results.finishedAt = new Date().toISOString();
results.passed = results.steps.filter(s => s.ok).length;
results.failed = results.steps.filter(s => !s.ok).length;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log(`\nИТОГ: ${results.passed} pass / ${results.failed} fail → ${OUT}`);
process.exit(results.failed ? 1 : 0);
