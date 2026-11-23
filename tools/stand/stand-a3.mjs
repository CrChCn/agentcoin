#!/usr/bin/env node
/* stand-a3.mjs — A3: кран AGT с паспортом, лимитами и защитой от двойной выдачи.
   Лимиты (целые минорные единицы, 1 AGT = 1e9): агент 0.5 / сутки UTC 5 / пилот 20.
   Узкий интерфейс заявки: challenge → claim{challengeId,address,amountMinor,signature}.
   Журнал (write-ahead): issued → reserved → submitted → paid | denied | failed.
   Фазы: g1 базовые+ретраи, g2 краш-перезапуск (дочерний процесс), g3 пустой резерв,
   g4 суточный лимит, g5 граница пилота (41 агент). Итог: stand-a3-results.json. */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createWallet, addressFromPub, signTransaction, txDigest } from '../../core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const MGNT = 1_000_000_000;
const CAP_AGENT = 500_000_000, CAP_DAY = 5_000_000_000, CAP_PILOT = 20_000_000_000;
const CHALLENGE_TTL_MS = 5 * 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pickPort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

// ---------- claim-сервис (закрытый контур: ключ фонда только здесь) ----------
function makeService({ journalPath, fund, nodeApi, nowFn }) {
  const now = () => (nowFn ? nowFn() : Date.now());
  const load = () => { try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch { return { claims: {}, challenges: {}, daySpent: {}, pilotSpentMinor: 0 }; } };
  const save = j => fs.writeFileSync(journalPath, JSON.stringify(j, null, 1));
  const j = load();
  const agents = new Map(); // address -> {pub, passport:'valid'|'revoked'}
  const canon = (challengeId, address, amountMinor) => `agt-faucet-claim-v1|${challengeId}|${address}|${amountMinor}`;
  const dayKey = () => new Date(now()).toISOString().slice(0, 10);

  function registerAgent(address, pub) {
    if (addressFromPub(pub) !== address) return { ok: false, error: 'pub_address_mismatch' };
    agents.set(address, { pub, passport: 'valid' });
    return { ok: true };
  }
  const revoke = address => { const a = agents.get(address); if (!a) return false; a.passport = 'revoked'; return true; };
  function issueChallenge(address, amountMinor) {
    const a = agents.get(address);
    if (!a) return { ok: false, error: 'unknown_agent' };
    const challengeId = 'ch-' + crypto.randomBytes(8).toString('hex');
    j.challenges[challengeId] = { address, amountMinor, nonce: crypto.randomBytes(8).toString('hex'), issuedAt: now(), used: false };
    save(j);
    return { ok: true, challengeId };
  }
  const spentFor = (pred) => Object.values(j.claims).filter(c => (c.status === 'reserved' || c.status === 'submitted' || c.status === 'paid') && pred(c)).reduce((s, c) => s + c.amountMinor, 0);
  function deny(claimId, address, amountMinor, reason) {
    // отказ НЕ затирает исходную запись (повтор того же challengeId идёт отдельным ключом)
    let key = claimId;
    if (j.claims[key] && j.claims[key].status !== 'denied') key = claimId + '#deny-' + Object.keys(j.claims).length;
    j.claims[key] = { claimId: key, address, amountMinor, status: 'denied', reason, at: now(), day: dayKey() }; save(j);
    return { ok: false, error: reason };
  }
  async function submitClaim({ challengeId, address, amountMinor, signature }) {
    const claimId = 'claim-' + challengeId;
    const ch = j.challenges[challengeId];
    if (!ch || ch.used) return deny(claimId, address, amountMinor, 'challenge_reused_or_unknown');
    if (now() - ch.issuedAt > CHALLENGE_TTL_MS) return deny(claimId, address, amountMinor, 'challenge_expired');
    if (ch.address !== address || ch.amountMinor !== amountMinor) return deny(claimId, address, amountMinor, 'challenge_mismatch');
    const a = agents.get(address);
    if (!a) return deny(claimId, address, amountMinor, 'unknown_agent');
    if (a.passport !== 'valid') return deny(claimId, address, amountMinor, 'passport_revoked');
    let sigOk = false;
    try { sigOk = crypto.verify(null, Buffer.from(canon(challengeId, address, amountMinor)), a.pub, Buffer.from(signature, 'hex')); } catch { sigOk = false; }
    if (!sigOk) return deny(claimId, address, amountMinor, 'bad_signature');
    ch.used = true;
    // лимиты: считаем зарезервированные+отправленные+выплаченные
    const agentSpent = spentFor(c => c.address === address);
    if (agentSpent + amountMinor > CAP_AGENT) { save(j); return deny(claimId, address, amountMinor, 'agent_cap_reached'); }
    const todayPaidReserved = spentFor(c => (c.day || new Date(c.at || now()).toISOString().slice(0, 10)) === dayKey());
    if (todayPaidReserved + amountMinor > CAP_DAY) { save(j); return deny(claimId, address, amountMinor, 'daily_exhausted'); }
    const pilot = spentFor(() => true);
    if (pilot + amountMinor > CAP_PILOT) { save(j); return deny(claimId, address, amountMinor, 'pilot_exhausted'); }
    // резерв + журнал ДО отправки
    const tx = { from: fund.address, fromPub: fund.pub, to: address, amount: amountMinor / MGNT, nonce: Date.now() + Object.keys(j.claims).length, ts: Math.floor(Date.now() / 1000), memo: `faucet-stand:${claimId}` };
    tx.txid = txDigest(tx); tx.signature = signTransaction(tx, fund.priv);
    j.claims[claimId] = { claimId, address, amountMinor, status: 'reserved', txid: tx.txid, tx, at: now(), day: dayKey() };
    save(j);
    const r = await nodeApi('/tx', { method: 'POST', body: tx });
    if (r.status !== 200 && r.status !== 201) {
      j.claims[claimId].status = 'failed'; j.claims[claimId].reason = 'fund_tx_rejected:' + (r.body?.error || r.status); save(j);
      return { ok: false, error: 'fund_tx_rejected' };
    }
    j.claims[claimId].status = 'submitted'; save(j);
    return { ok: true, claimId, txid: tx.txid };
  }
  async function recover() {
    // сверка журнала с цепью: submitted/reserved без ончейн-следа → повторить ТУ ЖЕ tx (тот же txid);
    // создание новой txid для той же заявки ЗАПРЕЩЕНО (тест это проверяет аудитом).
    const out = [];
    const blocks = (await nodeApi('/blocks?from=0').then(r => r.body.blocks || []));
    const onchain = new Set();
    for (const b of blocks) for (const t of (b.txs || [])) if (t?.txid) onchain.add(t.txid);
    for (const c of Object.values(j.claims)) {
      if (c.status !== 'submitted' && c.status !== 'reserved') continue;
      if (onchain.has(c.txid)) {
        const blk = blocks.find(b => (b.txs || []).some(t => t.txid === c.txid));
        c.status = 'paid'; c.block = blk.height ?? blk.header?.height; save(j);
        out.push({ claimId: c.claimId, action: 'marked_paid', block: c.block });
      } else if (c.status === 'submitted') {
        const r = await nodeApi('/tx', { method: 'POST', body: c.tx }); // та же tx, тот же txid
        out.push({ claimId: c.claimId, action: 'resubmitted_same_txid', status: r.status });
      }
    }
    save(j);
    return out;
  }
  async function audit() {
    // независимый аудит: ровно 1 ончейн-выплата на оплаченную заявку; 0 — на отклонённую
    const blocks = (await nodeApi('/blocks?from=0').then(r => r.body.blocks || []));
    const byClaim = {};
    for (const b of blocks) for (const t of (b.txs || [])) {
      const m = /^faucet-stand:(.+)$/.exec(t.memo || '');
      if (m && t.from === fund.address) { byClaim[m[1]] = byClaim[m[1]] || []; byClaim[m[1]].push(t.txid); }
    }
    const viol = [];
    for (const [id, c] of Object.entries(j.claims)) {
      const n = (byClaim[id] || []).length;
      if ((c.status === 'paid' || c.status === 'submitted') && n !== 1) viol.push(`${id}: ожидалась 1 выплата, найдено ${n}`);
      if ((c.status === 'denied' || c.status === 'failed') && n !== 0) viol.push(`${id}: отказ, но ончейн-выплат ${n}`);
    }
    // дубли: два разных txid на один claimId
    for (const [id, txids] of Object.entries(byClaim)) if (new Set(txids).size > 1) viol.push(`${id}: РАЗНЫЕ txid на одну заявку: ${txids.join(',')}`);
    return { viol, byClaim };
  }
  return { registerAgent, revoke, issueChallenge, submitClaim, recover, audit, canon, journalPath,
    stats: () => ({ paid: spentFor(c => c.status === 'paid'), claims: Object.keys(j.claims).length }) };
}

// ---------- агентская сторона (только свой ключ; ключа фонда здесь нет) ----------
function agentSign(privPem, challengeId, address, amountMinor) {
  const msg = `agt-faucet-claim-v1|${challengeId}|${address}|${amountMinor}`;
  return crypto.sign(null, Buffer.from(msg), privPem).toString('hex');
}

const R = { startedAt: new Date().toISOString(), limits: { CAP_AGENT, CAP_DAY, CAP_PILOT, unit: 'minor(1 AGT=1e9)' }, steps: [] };
const step = (n, ok, d) => { R.steps.push({ name: n, ok, detail: d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };

async function bootNode() {
  const port = await pickPort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-a3-'));
  const dataDir = path.join(root, 'data');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(root, 'boot.json'), '{"bootstrap":[]}');
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BOOTSTRAP_FILE: path.join(root, 'boot.json'),
    AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: token, AGT_BIND: '127.0.0.1', AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' };
  for (const k of ['AGT_CORE_P0_HEIGHT', 'AGT_TX_DIGEST_V2_HEIGHT', 'AGT_MGNT_HEIGHT', 'AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT']) delete env[k];
  const child = spawn(process.execPath, [path.join(REPO, 'node.mjs'), String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', b => { err = (err + b).slice(-800); });
  const url = `http://127.0.0.1:${port}`;
  const api = async (route, { method = 'GET', body } = {}) => {
    const r = await fetch(url + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  for (let i = 0; i < 200 && child.exitCode === null; i++) {
    try { if ((await api('/identity/meta')).status === 200) return { url, api, child, root }; } catch {}
    await sleep(150);
  }
  throw new Error('node not ready: ' + err.slice(-300));
}

async function main() {
  const mode = process.argv[2] || 'run';
  if (mode === '--crash-submit') {
    // дочерний: подать заявку, отправить tx, упасть ДО отметки paid
    const [journalPath, nodeUrl, fundJson] = [process.argv[3], process.argv[4], process.argv[5]];
    const fund = JSON.parse(fundJson);
    const api = async (route, { method = 'GET', body } = {}) => {
      const r = await fetch(nodeUrl + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const svc = makeService({ journalPath, fund, nodeApi: api });
    const w = createWallet('crash-agent');
    svc.registerAgent(w.address, w.pub);
    const { challengeId } = svc.issueChallenge(w.address, CAP_AGENT);
    const sig = agentSign(w.privKey, challengeId, w.address, CAP_AGENT);
    const r = await svc.submitClaim({ challengeId, address: w.address, amountMinor: CAP_AGENT, signature: sig });
    console.log('crash-child submitted:', JSON.stringify(r));
    process.exit(1); // падение после отправки, до paid
  }

  let node;
  try {
    node = await bootNode();
    const { api } = node;
    const newFund = async (label, blocks = 1) => {
      const w = (await api('/wallet/create', { method: 'POST', body: { label } })).body;
      for (let i = 0; i < blocks; i++) await api('/mine', { method: 'POST', body: { miner: w.address } });
      return { address: w.address, pub: w.pub, priv: w.privKey };
    };
    const bal = async a => Number((await api('/balance', { method: 'POST', body: { address: a } })).body.balance);

    // ---- g1: базовые + ретраи (свой фонд F1) ----
    {
      const F = await newFund('faucet-F1');
      const J = path.join(node.root, 'j1.json');
      const svc = makeService({ journalPath: J, fund: F, nodeApi: (r, o) => api(r, o) });
      const A = createWallet('A1');
      step('g1.0 привязка pub→адрес при регистрации', svc.registerAgent(A.address, A.pub).ok && !svc.registerAgent(A.address, createWallet('x').pub).ok, '');
      let ch = svc.issueChallenge(A.address, CAP_AGENT).challengeId;
      let r = await svc.submitClaim({ challengeId: ch, address: A.address, amountMinor: CAP_AGENT, signature: agentSign(A.privKey, ch, A.address, CAP_AGENT) });
      step('g1.1 валидная заявка принята', r.ok === true, `txid=${String(r.txid).slice(0, 12)}`);
      const wrong = svc.issueChallenge(A.address, CAP_AGENT).challengeId;
      const B = createWallet('B1'); svc.registerAgent(B.address, B.pub);
      r = await svc.submitClaim({ challengeId: wrong, address: B.address, amountMinor: CAP_AGENT, signature: agentSign(A.privKey, wrong, B.address, CAP_AGENT) });
      step('g1.2 чужой адрес/подпись отклонены', !r.ok && r.error === 'challenge_mismatch', r.error);
      const bad = svc.issueChallenge(B.address, CAP_AGENT).challengeId;
      r = await svc.submitClaim({ challengeId: bad, address: B.address, amountMinor: CAP_AGENT, signature: '00'.repeat(64) });
      step('g1.3 неверная подпись отклонена', !r.ok && r.error === 'bad_signature', r.error);
      r = await svc.submitClaim({ challengeId: ch, address: A.address, amountMinor: CAP_AGENT, signature: agentSign(A.privKey, ch, A.address, CAP_AGENT) });
      step('g1.4 повтор запроса отклонён', !r.ok && r.error === 'challenge_reused_or_unknown', r.error);
      svc.revoke(B.address);
      const rv = svc.issueChallenge(B.address, CAP_AGENT).challengeId;
      r = await svc.submitClaim({ challengeId: rv, address: B.address, amountMinor: CAP_AGENT, signature: agentSign(B.privKey, rv, B.address, CAP_AGENT) });
      step('g1.5 отозванный паспорт отклонён', !r.ok && r.error === 'passport_revoked', r.error);
      // параллельные заявки одного агента
      const C = createWallet('C1'); svc.registerAgent(C.address, C.pub);
      const c1 = svc.issueChallenge(C.address, CAP_AGENT).challengeId, c2 = svc.issueChallenge(C.address, CAP_AGENT).challengeId;
      const [r1, r2] = await Promise.all([
        svc.submitClaim({ challengeId: c1, address: C.address, amountMinor: CAP_AGENT, signature: agentSign(C.privKey, c1, C.address, CAP_AGENT) }),
        svc.submitClaim({ challengeId: c2, address: C.address, amountMinor: CAP_AGENT, signature: agentSign(C.privKey, c2, C.address, CAP_AGENT) }),
      ]);
      step('g1.6 параллельные заявки: ровно одна принята', (r1.ok ? 1 : 0) + (r2.ok ? 1 : 0) === 1, `${r1.ok ? 'ok' : r1.error} / ${r2.ok ? 'ok' : r2.error}`);
      // повтор с новым челленджем после выплаты-лимита
      await api('/mine', { method: 'POST', body: { miner: F.address } });
      const c3 = svc.issueChallenge(A.address, CAP_AGENT).challengeId;
      r = await svc.submitClaim({ challengeId: c3, address: A.address, amountMinor: CAP_AGENT, signature: agentSign(A.privKey, c3, A.address, CAP_AGENT) });
      step('g1.7 повтор после лимита агента отклонён', !r.ok && r.error === 'agent_cap_reached', r.error);
      await api('/mine', { method: 'POST', body: { miner: F.address } });
      const aud = await svc.audit();
      step('g1.8 аудит: выплат ровно по числу принятых, без дублей', aud.viol.length === 0, aud.viol.join('; ') || `выплат=${Object.keys(aud.byClaim).length}`);
      const bA = await bal(A.address), bC = await bal(C.address);
      step('g1.9 балансы: A=0.5 C=0.5', bA === 0.5 && bC === 0.5, `${bA}/${bC}`);
      R.g1 = { journal: J };
    }

    // ---- g2: краш после отправки ----
    {
      const F = await newFund('faucet-F2');
      const J = path.join(node.root, 'j2.json');
      const child = spawnSync(process.execPath, [process.argv[1], '--crash-submit', J, node.url, JSON.stringify(F)], { encoding: 'utf8', timeout: 60000 });
      step('g2.0 дочерний процесс упал после отправки', child.status !== 0, `exit=${child.status} out=${(child.stdout || '').slice(0, 120)}`);
      await api('/mine', { method: 'POST', body: { miner: F.address } });
      const svc = makeService({ journalPath: J, fund: F, nodeApi: (r, o) => api(r, o) });
      const rec = await svc.recover();
      const markedPaid = rec.filter(x => x.action === 'marked_paid').length;
      const resub = rec.filter(x => x.action === 'resubmitted_same_txid').length;
      step('g2.1 восстановление нашло отправленную tx, новой не создал', markedPaid === 1 && resub === 0, JSON.stringify(rec).slice(0, 160));
      const aud = await svc.audit();
      step('g2.2 аудит: ровно 1 выплата, дублей txid нет', aud.viol.length === 0, aud.viol.join('; ') || 'ok');
    }

    // ---- g3: пустой резерв ----
    {
      const w = (await api('/wallet/create', { method: 'POST', body: { label: 'faucet-F3-empty' } })).body;
      const F = { address: w.address, pub: w.pub, priv: w.privKey }; // без майнинга: баланс 0
      const svc = makeService({ journalPath: path.join(node.root, 'j3.json'), fund: F, nodeApi: (r, o) => api(r, o) });
      const D = createWallet('D3'); svc.registerAgent(D.address, D.pub);
      const ch = svc.issueChallenge(D.address, CAP_AGENT).challengeId;
      const r = await svc.submitClaim({ challengeId: ch, address: D.address, amountMinor: CAP_AGENT, signature: agentSign(D.privKey, ch, D.address, CAP_AGENT) });
      await api('/mine', { method: 'POST', body: { miner: F.address } });
      const aud = await svc.audit();
      step('g3 пустой резерв: отказ с причиной, лишних tx нет', !r.ok && aud.viol.length === 0, `${r.error} / viol=${aud.viol.length}`);
    }

    // ---- g4: суточный лимит 5 (11 агентов × 0.5) ----
    {
      const F = await newFund('faucet-F4');
      const svc = makeService({ journalPath: path.join(node.root, 'j4.json'), fund: F, nodeApi: (r, o) => api(r, o) });
      const res = [];
      for (let i = 0; i < 11; i++) {
        const w = createWallet('D4-' + i); svc.registerAgent(w.address, w.pub);
        const ch = svc.issueChallenge(w.address, CAP_AGENT).challengeId;
        res.push(await svc.submitClaim({ challengeId: ch, address: w.address, amountMinor: CAP_AGENT, signature: agentSign(w.privKey, ch, w.address, CAP_AGENT) }));
      }
      const okN = res.filter(r => r.ok).length, denyN = res.filter(r => !r.ok && r.error === 'daily_exhausted').length;
      step('g4.1 сутки: 10 принято, 11-й отклонён daily_exhausted', okN === 10 && denyN === 1, `ok=${okN} deny=${denyN}`);
      await api('/mine', { method: 'POST', body: { miner: F.address } });
      await api('/mine', { method: 'POST', body: { miner: F.address } });
      const aud = await svc.audit();
      const paidMinor = Object.values(aud.byClaim).length * CAP_AGENT;
      step('g4.2 ончейн ровно 10 выплат = 5.0 AGT', aud.viol.length === 0 && paidMinor === CAP_DAY, `выплат=${Object.keys(aud.byClaim).length}`);
    }

    // ---- g5: граница пилота 20 — суточный лимит 5 не даёт достичь 20 за день,
    // поэтому 4 условных суток × 10 агентов × 0.5 = 20.0, на 5-е сутки — отказ pilot_exhausted ----
    {
      const F = await newFund('faucet-F5');
      const base = Date.now(); let dayOffset = 0;
      const svc = makeService({ journalPath: path.join(node.root, 'j5.json'), fund: F, nodeApi: (r, o) => api(r, o), nowFn: () => base + dayOffset * 86400_000 });
      const res = [];
      for (let d = 0; d < 4; d++) {
        dayOffset = d;
        for (let i = 0; i < 10; i++) {
          const w = createWallet(`P5d${d}-${i}`); svc.registerAgent(w.address, w.pub);
          const ch = svc.issueChallenge(w.address, CAP_AGENT).challengeId;
          res.push(await svc.submitClaim({ challengeId: ch, address: w.address, amountMinor: CAP_AGENT, signature: agentSign(w.privKey, ch, w.address, CAP_AGENT) }));
        }
      }
      const okN = res.filter(r => r.ok).length;
      dayOffset = 4;
      const wLast = createWallet('P5-last'); svc.registerAgent(wLast.address, wLast.pub);
      const chLast = svc.issueChallenge(wLast.address, CAP_AGENT).challengeId;
      const last = await svc.submitClaim({ challengeId: chLast, address: wLast.address, amountMinor: CAP_AGENT, signature: agentSign(wLast.privKey, chLast, wLast.address, CAP_AGENT) });
      step('g5.1 пилот: 40 принято за 4 суток, на 5-е — pilot_exhausted', okN === 40 && !last.ok && last.error === 'pilot_exhausted', `ok=${okN} last=${last.error}`);
      await api('/mine', { method: 'POST', body: { miner: F.address } });
      await api('/mine', { method: 'POST', body: { miner: F.address } });
      await api('/mine', { method: 'POST', body: { miner: F.address } });
      const aud = await svc.audit();
      step('g5.2 ончейн ровно 40 выплат = 20.0 AGT, дублей нет', aud.viol.length === 0 && Object.keys(aud.byClaim).length === 40, `выплат=${Object.keys(aud.byClaim).length} viol=${aud.viol.length}`);
    }
  } catch (e) {
    step('harness', false, String(e.message || e).slice(0, 300));
    R.error = String(e.stack || e).slice(0, 800);
  } finally {
    try { node.child.kill('SIGKILL'); } catch {}
  }
  R.finishedAt = new Date().toISOString();
  R.passed = R.steps.filter(s => s.ok).length; R.failed = R.steps.filter(s => !s.ok).length;
  const OUT = path.join(REPO, 'docs', 'a-topology', 'stand-a3-results.json');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
  console.log(`ИТОГ A3: ${R.passed} pass / ${R.failed} fail → ${OUT}`);
  process.exit(R.failed ? 1 : 0);
}

main();
