#!/usr/bin/env node
/* stand-a5.mjs — A3/A4 в API серверной ноды (пилотные контуры).
   Одна нода, постоянный DATADIR, журнал pilot-payments.sqlite.
   t0 контуры включены, /pilot/* без токена → 401, faucet публичен
   t1 паспорт агента в локальном реестре (identity/challenge+register)
   t2 challenge→claim→pending→mine→+0.5; повтор → agent_cap_reached
   t3 отозванный адрес → passport_revoked
   t4 сутки: 10×0.5 принято, 11-й → daily_exhausted; ончейн ровно 10 выплат
   t5 payout: dry-run eligible → execute pending → повтор тот же txid →
      смена суммы → payout_conflict; вне реестра → not_in_registry;
      сверх недели → over_weekly_budget; reconcile → confirmed
   t6 рестарт на том же DATADIR → reconcile находит всё, новых tx нет
   t7 faucet==payout fund → контуры НЕ включаются (fail-closed)
   Итог: stand-a5-results.json */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createWallet } from '../../core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'docs', 'a-topology', 'stand-a5-results.json');
const R = { startedAt: new Date().toISOString(), steps: [] };
const step = (n, ok, d) => { R.steps.push({ name: n, ok, detail: d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pickPort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const mondayUTC = (ts) => { const d = new Date(ts); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10); };

const ADMIN = crypto.randomBytes(24).toString('hex');
let node = null;
const api = (route, { method = 'GET', body, token = ADMIN } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  return fetch(node.url + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
};
const signMsg = (privPem, message) => crypto.sign(null, Buffer.from(message, 'utf8'), crypto.createPrivateKey(privPem)).toString('hex');

async function boot(extraEnv = {}) {
  const port = await pickPort();
  const root = node?.root || fs.mkdtempSync(path.join(os.tmpdir(), 'agt-a5-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, AGT_DATA_DIR: dataDir,
    AGT_BOOTSTRAP_FILE: path.join(root, 'boot.json'),
    AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: ADMIN, AGT_BIND: '127.0.0.1',
    AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', ...extraEnv };
  for (const k of ['AGT_CORE_P0_HEIGHT', 'AGT_TX_DIGEST_V2_HEIGHT', 'AGT_MGNT_HEIGHT', 'AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT']) if (!(k in extraEnv)) delete env[k];
  try { fs.writeFileSync(path.join(root, 'boot.json'), '{"bootstrap":[]}'); } catch {}
  const proc = spawn(process.execPath, [path.join(REPO, 'node.mjs'), String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = `http://127.0.0.1:${port}`;
  node = { url, child: proc, root };
  for (let i = 0; i < 200 && proc.exitCode === null; i++) {
    try { const r = await fetch(url + '/identity/meta', { signal: AbortSignal.timeout(2000) }); if (r.status === 200) return; } catch {}
    await sleep(150);
  }
  throw new Error('node not ready');
}
const stop = () => { try { node.child.kill('SIGKILL'); } catch {} };

// регистрация паспорта агента в локальном реестре
async function registerAgent(w, handle) {
  const ch = await api('/identity/challenge', { method: 'POST', body: { address: w.address, pub: w.pub, handle } });
  if (ch.status !== 200 || !ch.body.ok) return { ok: false, detail: JSON.stringify(ch.body).slice(0, 120) };
  const sig = signMsg(w.privKey, ch.body.message);
  const reg = await api('/identity/register', { method: 'POST', body: { challengeId: ch.body.challengeId, signature: sig } });
  return { ok: reg.status === 201 && reg.body.ok, detail: JSON.stringify(reg.body).slice(0, 120) };
}
async function faucetPay(w) {
  const ch = await api('/faucet/pilot/challenge', { method: 'POST', body: { address: w.address }, token: null });
  if (ch.status !== 200 || !ch.body.ok) return { ok: false, error: ch.body.error, status: ch.status };
  const sig = signMsg(w.privKey, ch.body.message);
  const cl = await api('/faucet/pilot/claim', { method: 'POST', body: { challengeId: ch.body.challengeId, signature: sig }, token: null });
  return { ok: cl.status === 200 && cl.body.ok, error: cl.body.error, txid: cl.body.txid, status: cl.status };
}

async function main() {
  try {
    // --- подготовка: фонды, реестр, revoked ---
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-a5-'));
    const faucetF = createWallet('pilot-faucet-fund');
    const payoutF = createWallet('pilot-payout-fund');
    const wallets = {};
    for (const w of [faucetF, payoutF]) wallets[w.address] = { label: w.label, pub: w.pub, privKey: w.privKey, createdAt: w.createdAt };
    const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'wallets.json'), JSON.stringify(wallets, null, 1));
    const PERIOD = mondayUTC(Date.now());
    const op1 = createWallet('op1'), op2 = createWallet('op2'), op3 = createWallet('op3'), op4 = createWallet('op4');
    const registry = [
      { operatorId: 'node2-operator', period: PERIOD, address: op1.address, amountMinor: 10_000_000_000 },
      { operatorId: 'node2-operator-2', period: PERIOD, address: op2.address, amountMinor: 6_000_000_000 },
      { operatorId: 'node2-operator-3', period: PERIOD, address: op3.address, amountMinor: 10_000_000_000 },
      { operatorId: 'node2-operator-4', period: PERIOD, address: op4.address, amountMinor: 1_000_000_000 },
    ];
    const regFile = path.join(tmp, 'registry.json'); fs.writeFileSync(regFile, JSON.stringify(registry, null, 1));
    const revFile = path.join(tmp, 'revoked.json'); fs.writeFileSync(revFile, '[]');
    await boot({ AGT_DATA_DIR: dataDir,
      AGT_PILOT_FAUCET_FUND: faucetF.address, AGT_PILOT_PAYOUT_FUND: payoutF.address,
      AGT_PILOT_REVOKED_FILE: revFile, AGT_PILOT_PAYOUT_REGISTRY: regFile });
    // фонды пополнить майнингом
    for (let i = 0; i < 4; i++) await api('/mine', { method: 'POST', body: { miner: faucetF.address } });
    for (let i = 0; i < 2; i++) await api('/mine', { method: 'POST', body: { miner: payoutF.address } });

    // t0
    {
      const st = await api('/pilot/status');
      step('t0 контуры включены', st.status === 200 && st.body.faucetEnabled && st.body.payoutEnabled, JSON.stringify(st.body.counts || st.body));
      const noTok = await api('/pilot/payout', { method: 'POST', body: {}, token: null });
      const noTok2 = await api('/pilot/reconcile', { method: 'POST', body: {}, token: null });
      step('t0 /pilot/* без токена → закрыто (403)', noTok.status === 403 && noTok2.status === 403, `${noTok.status}/${noTok2.status}`);
      const chPub = await api('/faucet/pilot/challenge', { method: 'POST', body: { address: 'AGTX' }, token: null });
      step('t0 faucet публичен (ответ без токена, не 403)', chPub.status !== 403, `status=${chPub.status}`);
    }

    // t1: паспорт
    const agent = createWallet('agent-1');
    {
      const r = await registerAgent(agent, 'agent-1');
      step('t1 паспорт агента в локальном реестре', r.ok, r.detail);
    }

    // t2: claim
    let faucetTxid = null;
    {
      const ch0 = await api('/faucet/pilot/challenge', { method: 'POST', body: { address: agent.address }, token: null });
      let mOk = false;
      try {
        const m = JSON.parse(ch0.body.message);
        const aud = (await api('/identity/meta')).body.audience;
        const cid = (await api('/info')).body.chainId;
        mOk = Array.isArray(m) && m[0] === 'agentcoin:faucet:v1' && m[1] === cid &&
          m[2] === aud && m[3] === agent.address && m[4] === 500_000_000 &&
          m[5] === ch0.body.challengeId && m[6] === ch0.body.expiresAt;
      } catch {}
      step('t2.0 challenge привязан к сети и аудитории', ch0.status === 200 && mOk, (ch0.body.message || '').slice(0, 90));
      const r = await faucetPay(agent);
      faucetTxid = r.txid;
      step('t2 claim → pending txid', r.ok && !!r.txid, `txid=${(r.txid || '').slice(0, 16)} err=${r.error || ''}`);
      await api('/mine', { method: 'POST', body: { miner: faucetF.address } });
      const bal = Number((await api('/balance', { method: 'POST', body: { address: agent.address } })).body.balance);
      step('t2.2 баланс +0.5 после блока', bal === 0.5, `bal=${bal}`);
      const r2 = await faucetPay(agent);
      step('t2.3 повтор → agent_cap_reached', !r2.ok && r2.error === 'agent_cap_reached', r2.error);
    }

    // t3: revoked
    {
      const a2 = createWallet('agent-2'); const rr = await registerAgent(a2, 'agent-2');
      const tmpF = revFile + '.tmp'; fs.writeFileSync(tmpF, JSON.stringify([a2.address])); fs.renameSync(tmpF, revFile);
      const r = await faucetPay(a2);
      step('t3 отозванный адрес → passport_revoked', rr.ok && !r.ok && r.error === 'passport_revoked', r.error);
      fs.writeFileSync(revFile, '[]');
      const r2 = await faucetPay(a2);
      step('t3.2 после снятия отзыва — pending', r2.ok, r2.error || r2.txid?.slice(0, 12));
    }

    // t4: сутки (уже 2 выплаты по 0.5; добить до 5.0, 11-й лишний)
    {
      const res = [];
      for (let i = 3; i <= 11; i++) {
        const w = createWallet('agent-' + i); await registerAgent(w, 'agent-' + i);
        res.push(await faucetPay(w));
      }
      const okN = res.filter(r => r.ok).length;
      const lastErr = res[res.length - 1].error;
      step('t4 сутки: 8 принято (=5.0 с учётом t2–t3), 9-й → daily_exhausted', okN === 8 && lastErr === 'daily_exhausted', `ok=${okN} last=${lastErr}`);
      for (let i = 0; i < 3; i++) await api('/mine', { method: 'POST', body: { miner: faucetF.address } });
      const blocks = (await api('/blocks?from=0')).body.blocks || [];
      const cnt = blocks.flatMap(b => b.txs || []).filter(t => (t.memo || '').startsWith('pilot-faucet:')).length;
      step('t4.2 ончейн ровно 10 выплат крана', cnt === 10, `cnt=${cnt}`);
    }

    // t5: выплаты
    const req1 = { operatorId: 'node2-operator', period: PERIOD, address: op1.address, amountMinor: 10_000_000_000 };
    let payTxid = null;
    {
      const dry = await api('/pilot/payout', { method: 'POST', body: { ...req1, execute: false } });
      step('t5 dry-run eligible', dry.status === 200 && dry.body.eligible === true, JSON.stringify(dry.body).slice(0, 120));
      const exe = await api('/pilot/payout', { method: 'POST', body: { ...req1, execute: true } });
      payTxid = exe.body.txid;
      step('t5.2 execute → pending txid', exe.status === 200 && !!payTxid, `txid=${(payTxid || '').slice(0, 16)}`);
      const rep = await api('/pilot/payout', { method: 'POST', body: { ...req1, execute: true } });
      step('t5.3 повтор → тот же txid', rep.status === 200 && rep.body.txid === payTxid, (rep.body.txid || '').slice(0, 16));
      const chg = await api('/pilot/payout', { method: 'POST', body: { ...req1, amountMinor: 11_000_000_000, execute: true } });
      step('t5.4 смена суммы → payout_conflict', chg.status === 409 && chg.body.error === 'payout_conflict', chg.body.error);
      const unk = await api('/pilot/payout', { method: 'POST', body: { operatorId: 'nope', period: PERIOD, address: op1.address, amountMinor: 1_000_000_000, execute: false } });
      step('t5.5 вне реестра → not_in_registry', unk.status === 403 && unk.body.error === 'not_in_registry', unk.body.error);
      const req2 = { operatorId: 'node2-operator-2', period: PERIOD, address: op2.address, amountMinor: 6_000_000_000 };
      const e2 = await api('/pilot/payout', { method: 'POST', body: { ...req2, execute: true } });
      step('t5.6 второй оператор 6 AGT → pending', e2.status === 200 && !!e2.body.txid, (e2.body.txid || '').slice(0, 16));
      const req3 = { operatorId: 'node2-operator-3', period: PERIOD, address: op3.address, amountMinor: 10_000_000_000 };
      const d3 = await api('/pilot/payout', { method: 'POST', body: { ...req3, execute: false } });
      step('t5.7 16+10>20 → over_weekly_budget', d3.status === 409 && d3.body.error === 'over_weekly_budget', d3.body.error);
      for (let i = 0; i < 2; i++) await api('/mine', { method: 'POST', body: { miner: payoutF.address } });
      const rec = await api('/pilot/reconcile', { method: 'POST', body: {} });
      const conf = (rec.body.payouts || []).filter(x => x.action === 'confirmed').length;
      step('t5.8 reconcile → обе confirmed', rec.status === 200 && conf === 2, JSON.stringify(rec.body.payouts).slice(0, 160));
      const b1 = Number((await api('/balance', { method: 'POST', body: { address: op1.address } })).body.balance);
      step('t5.9 баланс op1 = 10', b1 === 10, `bal=${b1}`);
    }

    // t6: рестарт на том же DATADIR
    {
      stop(); await sleep(500);
      await boot({ AGT_DATA_DIR: dataDir,
        AGT_PILOT_FAUCET_FUND: faucetF.address, AGT_PILOT_PAYOUT_FUND: payoutF.address,
        AGT_PILOT_REVOKED_FILE: revFile, AGT_PILOT_PAYOUT_REGISTRY: regFile });
      const rec = await api('/pilot/reconcile', { method: 'POST', body: {} });
      const newSubmits = [...(rec.body.faucet || []), ...(rec.body.payouts || [])].filter(x => x.action === 'pending');
      const conf = (rec.body.payouts || []).filter(x => x.action === 'confirmed').length;
      step('t6 рестарт: журнал на месте, новых отправок нет', rec.status === 200 && newSubmits.length === 0, `pending=${newSubmits.length} payouts=${JSON.stringify(rec.body.payouts).slice(0, 120)}`);
      const st = await api('/pilot/status');
      step('t6.2 счётчики журнала пережили рестарт', st.body.counts.faucet === 10 && st.body.counts.payouts === 2, JSON.stringify(st.body.counts));
      void conf;
    }

    // t8: порог v2 — пилот строит v2-tx (подпись поверх digestVersion=2 с chainId)
    {
      stop(); await sleep(500);
      await boot({ AGT_DATA_DIR: dataDir,
        AGT_PILOT_FAUCET_FUND: faucetF.address, AGT_PILOT_PAYOUT_FUND: payoutF.address,
        AGT_PILOT_REVOKED_FILE: revFile, AGT_PILOT_PAYOUT_REGISTRY: regFile,
        AGT_TX_DIGEST_V2_HEIGHT: '1' });
      for (let i = 0; i < 2; i++) await api('/mine', { method: 'POST', body: { miner: payoutF.address } });
      const req4 = { operatorId: 'node2-operator-4', period: PERIOD, address: op4.address, amountMinor: 1_000_000_000 };
      const exe = await api('/pilot/payout', { method: 'POST', body: { ...req4, execute: true } });
      step('t8 v2-порог: execute → pending', exe.status === 200 && !!exe.body.txid, (exe.body.txid || '').slice(0, 16));
      const mp = await api('/mempool?full=1');
      const list = mp.body.txs || mp.body.mempool || [];
      const found = (Array.isArray(list) ? list : []).find(t => t && t.txid === exe.body.txid);
      step('t8.2 tx в mempool с digestVersion=2 и chainId', !!found && found.digestVersion === 2 && typeof found.chainId === 'string',
        found ? `v${found.digestVersion} ${found.chainId}` : 'not found');
      await api('/mine', { method: 'POST', body: { miner: payoutF.address } });
      const rec = await api('/pilot/reconcile', { method: 'POST', body: {} });
      const done = (rec.body.payouts || []).find(x => x.key === 'node2-operator-4|' + PERIOD);
      const b4 = Number((await api('/balance', { method: 'POST', body: { address: op4.address } })).body.balance);
      step('t8.3 v2-tx в блоке: confirmed + баланс 1', done?.action === 'confirmed' && b4 === 1, `${done?.action} bal=${b4}`);
    }

    // t7: общий фонд → контуры не включаются
    {
      stop(); await sleep(500);
      await boot({ AGT_DATA_DIR: path.join(tmp, 'data-bad'),
        AGT_PILOT_FAUCET_FUND: faucetF.address, AGT_PILOT_PAYOUT_FUND: faucetF.address,
        AGT_PILOT_PAYOUT_REGISTRY: regFile });
      const st = await api('/pilot/status');
      step('t7 faucet==payout fund → оба контура выключены', st.status === 200 && !st.body.faucetEnabled && !st.body.payoutEnabled, st.body.problems?.join(','));
    }
  } catch (e) {
    step('harness', false, String(e.message || e).slice(0, 300));
    R.error = String(e.stack || e).slice(0, 800);
  } finally { stop(); }
  R.finishedAt = new Date().toISOString();
  R.passed = R.steps.filter(s => s.ok).length; R.failed = R.steps.filter(s => !s.ok).length;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
  console.log(`ИТОГ A5: ${R.passed} pass / ${R.failed} fail → ${OUT}`);
  process.exit(R.failed ? 1 : 0);
}

main();