#!/usr/bin/env node
/* pilot.mjs — пилотные контуры серверной ноды: кран (A3) и выплаты (A4).
   Каждый контур включается ОТДЕЛЬНО своим env; без env контур выключен.
   AGT_PILOT_FAUCET_FUND    — адрес фонда крана (ключ в кошельках ноды).
   AGT_PILOT_REVOKED_FILE   — необязательный JSON-массив отозванных адресов.
   AGT_PILOT_PAYOUT_FUND    — адрес фонда операторских выплат (ключ в ноде).
   AGT_PILOT_PAYOUT_REGISTRY— абсолютный путь к JSON-массиву утверждённых начислений
                              [{operatorId, period(понедельник UTC), address, amountMinor}].
   Журнал: pilot-payments.sqlite в DATA_DIR (node:sqlite). Состояния платежей:
   recorded (намерение+подпись до отправки) → pending (отправлено) → confirmed;
   denied/failed — в лимиты НЕ входят. Повторная подача — всегда исходной подписью.
   1 AGT = 1_000_000_000 минорных. Суммы в реестре/запросах — целые minor.
   Лимиты крана: 0.5/адрес, 5/сутки UTC, 20/пилот. Лимиты выплат: 10/оператор, 20/неделя UTC.
   Высота активации формата tx здесь не применяется: payout/faucet всегда строят
   текущий формат ноды; reconcile лишь перечитывает журнал и цепь.
*/
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { signTransaction } from './core.mjs';

export const MINOR_PER_AGT = 1_000_000_000;
export const FAUCET_PER_ADDRESS_MINOR = 500_000_000;   // 0.5 AGT один раз на адрес
export const FAUCET_DAY_MINOR = 5_000_000_000;        // 5 AGT за сутки UTC
export const FAUCET_PILOT_MINOR = 20_000_000_000;     // 20 AGT на весь пилот
export const PAYOUT_PER_OP_MINOR = 10_000_000_000;    // 10 AGT на оператора
export const PAYOUT_WEEK_MINOR = 20_000_000_000;      // 20 AGT на неделю UTC
const CHALLENGE_TTL_MS = 10 * 60_000;
export const COUNTED = ['recorded', 'pending', 'confirmed']; // входят в лимиты

const dayUTC = (ts) => new Date(ts).toISOString().slice(0, 10);
const mondayUTC = (ts) => { const d = new Date(ts); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10); };
const isMonday = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && mondayUTC(new Date(s + 'T00:00:00Z').getTime()) === s;

export function createPilot({ dataDir, bc, loadWallets, announce, identity, isBanned }) {
  const faucetFund = (process.env.AGT_PILOT_FAUCET_FUND || '').trim();
  const payoutFund = (process.env.AGT_PILOT_PAYOUT_FUND || '').trim();
  const revokedFile = (process.env.AGT_PILOT_REVOKED_FILE || '').trim();
  const registryFile = (process.env.AGT_PILOT_PAYOUT_REGISTRY || '').trim();
  const oldFaucet = (process.env.AGT_FAUCET_FUND || '').trim();
  const problems = [];
  if (faucetFund && payoutFund && faucetFund === payoutFund) problems.push('faucet_fund_is_payout_fund');
  if (faucetFund && oldFaucet && faucetFund === oldFaucet) problems.push('faucet_fund_is_old_faucet');
  if (registryFile && !path.isAbsolute(registryFile)) problems.push('registry_not_absolute');
  const faucetEnabled = Boolean(faucetFund) && problems.length === 0;
  const payoutEnabled = Boolean(payoutFund && registryFile) && problems.length === 0;
  if ((faucetFund || payoutFund) && problems.length) console.error('[pilot] контур НЕ включён:', problems.join(','));

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, 'pilot-payments.sqlite');
  // Соединение открываем на время операции и сразу закрываем: без висячих
  // блокировок файл можно бэкапить/переносить после остановки службы и нет
  // гонок с удалением каталога (SIGKILL не даёт закрыть долгоживущий handle).
  const withDb = (fn) => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, address TEXT NOT NULL, amount_minor INTEGER NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS faucet_payments(id INTEGER PRIMARY KEY AUTOINCREMENT, challenge_id TEXT UNIQUE NOT NULL, address TEXT NOT NULL, amount_minor INTEGER NOT NULL, txid TEXT, tx_json TEXT, state TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, day TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payouts(key TEXT PRIMARY KEY, operator_id TEXT NOT NULL, period TEXT NOT NULL, address TEXT NOT NULL, amount_minor INTEGER NOT NULL, txid TEXT, tx_json TEXT, state TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_faucet_state ON faucet_payments(state); CREATE INDEX IF NOT EXISTS idx_payout_state ON payouts(state);`);
      return fn(mkQ(db));
    } finally { db.close(); }
  };
  const mkQ = (db) => ({
    addChallenge: db.prepare('INSERT INTO challenges(id,address,amount_minor,message,expires_at) VALUES(?,?,?,?,?)'),
    getChallenge: db.prepare('SELECT * FROM challenges WHERE id=?'),
    delChallenge: db.prepare('DELETE FROM challenges WHERE id=?'),
    faucetSum: db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM faucet_payments WHERE state IN (${COUNTED.map(s => `'${s}'`).join(',')})`),
    faucetSumAddr: db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM faucet_payments WHERE address=? AND state IN (${COUNTED.map(s => `'${s}'`).join(',')})`),
    faucetSumDay: db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM faucet_payments WHERE day=? AND state IN (${COUNTED.map(s => `'${s}'`).join(',')})`),
    addFaucet: db.prepare('INSERT INTO faucet_payments(challenge_id,address,amount_minor,txid,tx_json,state,reason,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)'),
    setFaucet: db.prepare('UPDATE faucet_payments SET state=?, reason=COALESCE(?,reason), txid=COALESCE(?,txid), tx_json=COALESCE(?,tx_json) WHERE challenge_id=?'),
    openFaucet: db.prepare(`SELECT * FROM faucet_payments WHERE state IN ('recorded','pending')`),
    getPayout: db.prepare('SELECT * FROM payouts WHERE key=?'),
    addPayout: db.prepare('INSERT INTO payouts(key,operator_id,period,address,amount_minor,txid,tx_json,state,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'),
    setPayout: db.prepare('UPDATE payouts SET state=?, reason=COALESCE(?,reason), txid=COALESCE(?,txid), tx_json=COALESCE(?,tx_json) WHERE key=?'),
    openPayouts: db.prepare(`SELECT * FROM payouts WHERE state IN ('recorded','pending')`),
    payoutSumWeek: db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM payouts WHERE period=? AND state IN (${COUNTED.map(s => `'${s}'`).join(',')})`),
    payoutSumOp: db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM payouts WHERE operator_id=? AND period=? AND state IN (${COUNTED.map(s => `'${s}'`).join(',')})`),
    counts: db.prepare(`SELECT (SELECT COUNT(*) FROM faucet_payments) AS faucet, (SELECT COUNT(*) FROM payouts) AS payouts`),
  });

  const nowMs = () => Date.now();
  const readRevoked = () => {
    if (!revokedFile) return [];
    try { const v = JSON.parse(fs.readFileSync(revokedFile, 'utf8')); return Array.isArray(v) ? v : []; }
    catch { return null; }
  };
  const readRegistry = () => {
    try { const v = JSON.parse(fs.readFileSync(registryFile, 'utf8')); return Array.isArray(v) ? v : null; }
    catch { return null; }
  };
  const chainTxids = () => {
    const s = new Set();
    for (const b of (bc.chain || [])) for (const t of (b.txs || [])) if (t && t.txid) s.add(t.txid);
    for (const t of (bc.mempool || [])) if (t && t.txid) s.add(t.txid);
    return s;
  };
  const fundWallet = (addr) => { const w = loadWallets()[addr]; return w && w.privKey ? w : null; };
  // tx строит текущий формат ноды (v1, как остальной код ноды); подпись — ключом фонда.
  const buildSignedTx = (fundAddr, to, amountMinor, memo) => {
    const w = fundWallet(fundAddr);
    if (!w) return { error: 'fund_key_missing' };
    const tx = { from: fundAddr, fromPub: w.pub, to, amount: amountMinor / MINOR_PER_AGT,
      nonce: Date.now() * 1000 + Math.floor(Math.random() * 1000), ts: Math.floor(Date.now() / 1000), memo };
    tx.signature = signTransaction(tx, w.privKey);
    return { tx };
  };
  const submitTx = (tx) => {
    const r = bc.addTransaction(tx);
    if (r.ok) { announce(tx); return { ok: true }; }
    // already_in_chain/duplicate_tx: платёж уже виден — не ошибка журнала, а подтверждение
    if (r.reason === 'already_in_chain' || r.reason === 'duplicate_tx') return { ok: true, already: true };
    return { ok: false, reason: r.reason || 'fund_tx_rejected' };
  };

  // ---------- A3 кран ----------
  function faucetChallenge(address) {
    if (!faucetEnabled) return { ok: false, error: 'pilot_faucet_disabled' };
    if (!/^AGT[A-Za-z0-9]+$/.test(String(address || ''))) return { ok: false, error: 'bad_address' };
    const ident = identity.find(address);
    if (!ident) return { ok: false, error: 'passport_not_found', hint: 'паспорт агента должен быть в локальном реестре идентификации' };
    const id = crypto.randomBytes(16).toString('hex');
    const expiresAt = nowMs() + CHALLENGE_TTL_MS;
    const message = `AGT-PILOT-FAUCET|${address}|${FAUCET_PER_ADDRESS_MINOR}|${id}|${expiresAt}`;
    return withDb((q) => {
      q.addChallenge.run(id, address, FAUCET_PER_ADDRESS_MINOR, message, expiresAt);
      return { ok: true, challengeId: id, message, amountMinor: FAUCET_PER_ADDRESS_MINOR, expiresAt };
    });
  }
  function faucetClaim(challengeId, signature) {
    if (!faucetEnabled) return { ok: false, error: 'pilot_faucet_disabled' };
    if (typeof challengeId !== 'string' || typeof signature !== 'string') return { ok: false, error: 'bad_params' };
    const deny = (reason) => ({ ok: false, error: reason });
    return withDb((q) => {
      const ch = q.getChallenge.get(challengeId);
      if (!ch || ch.expires_at <= nowMs()) { if (ch) q.delChallenge.run(challengeId); return deny('challenge_unknown_or_expired'); }
      q.delChallenge.run(challengeId); // одноразовый
      const ident = identity.find(ch.address);
      if (!ident) return deny('passport_not_found');
      const v = identity.verify(ident.certificate);
      if (!v.ok) return deny('passport_untrusted');
      try {
        const okSig = crypto.verify(null, Buffer.from(ch.message, 'utf8'), ident.pub, Buffer.from(String(signature), 'hex'));
        if (!okSig) return deny('bad_signature');
      } catch { return deny('bad_signature'); }
      if (isBanned(ch.address)) return deny('address_banned');
      const revoked = readRevoked();
      if (revoked === null) return deny('revoked_list_unreadable');
      if (revoked.includes(ch.address)) return deny('passport_revoked');
      // лимиты: записанные + ожидающие + подтверждённые
      if (Number(q.faucetSumAddr.get(ch.address).s) + ch.amount_minor > FAUCET_PER_ADDRESS_MINOR) return deny('agent_cap_reached');
      const day = dayUTC(nowMs());
      if (Number(q.faucetSumDay.get(day).s) + ch.amount_minor > FAUCET_DAY_MINOR) return deny('daily_exhausted');
      if (Number(q.faucetSum.get().s) + ch.amount_minor > FAUCET_PILOT_MINOR) return deny('pilot_exhausted');
      const { tx, error } = buildSignedTx(faucetFund, ch.address, ch.amount_minor, `pilot-faucet:${ch.address}`);
      if (error) return deny(error);
      const created = nowMs();
      q.addFaucet.run(challengeId, ch.address, ch.amount_minor, tx.txid || null, JSON.stringify(tx), 'recorded', null, created, day);
      const s = submitTx(tx);
      if (!s.ok) { q.setFaucet.run('failed', s.reason, tx.txid || null, JSON.stringify(tx), challengeId); return deny('fund_tx_rejected'); }
      q.setFaucet.run('pending', null, tx.txid || null, JSON.stringify(tx), challengeId);
      return { ok: true, status: 'pending', txid: tx.txid, amountMinor: ch.amount_minor };
    });
  }

  // ---------- A4 выплаты ----------
  const payoutKey = (operatorId, period) => `${operatorId}|${period}`;
  function payoutRequest(input, execute) {
    if (!payoutEnabled) return { ok: false, error: 'pilot_payout_disabled' };
    const { operatorId, period, address, amountMinor } = input || {};
    if (typeof operatorId !== 'string' || !operatorId || !isMonday(period) ||
        !/^AGT[A-Za-z0-9]+$/.test(String(address || '')) ||
        !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return { ok: false, error: 'bad_params' };
    const key = payoutKey(operatorId, period);
    if (!execute) return withDb((q) => {
      const existing = q.getPayout.get(key);
      if (existing && (existing.address !== address || existing.amount_minor !== amountMinor))
        return { ok: false, error: 'payout_conflict', hint: 'адрес/сумма записанной пары оператор/неделя не меняются' };
      if (existing)
        return { ok: true, eligible: true, already: existing.state, txid: existing.txid, amountMinor };
      const reg = readRegistry();
      const approved = Array.isArray(reg) && reg.some(e => e.operatorId === operatorId && e.period === period && e.address === address && e.amountMinor === amountMinor);
      if (!approved) return { ok: false, error: 'not_in_registry', eligible: false };
      if (amountMinor > PAYOUT_PER_OP_MINOR) return { ok: false, error: 'per_op_over_limit', eligible: false };
      if (Number(q.payoutSumOp.get(operatorId, period).s) + amountMinor > PAYOUT_PER_OP_MINOR) return { ok: false, error: 'per_op_over_limit', eligible: false };
      if (Number(q.payoutSumWeek.get(period).s) + amountMinor > PAYOUT_WEEK_MINOR) return { ok: false, error: 'over_weekly_budget', eligible: false };
      const balances = bc.balances();
      const outgoing = (bc.mempool || []).filter(t => t.from === payoutFund).reduce((s, t) => s + t.amount, 0);
      if ((balances[payoutFund] || 0) - outgoing < amountMinor / MINOR_PER_AGT) return { ok: false, error: 'fund_insufficient', eligible: false };
      return { ok: true, eligible: true, amountMinor };
    });
    // execute:true — та же проверка + запись намерения до отправки
    const dry = payoutRequest(input, false);
    if (!dry.ok) return dry;
    if (dry.already) return { ok: true, status: dry.already, txid: dry.txid, amountMinor, note: 'повтор: тот же txid' };
    return withDb((q) => {
      const again = q.getPayout.get(key);
      if (again) {
        if (again.address !== address || again.amount_minor !== amountMinor)
          return { ok: false, error: 'payout_conflict', hint: 'адрес/сумма записанной пары оператор/неделя не меняются' };
        return { ok: true, status: again.state, txid: again.txid, amountMinor, note: 'повтор: тот же txid' };
      }
      const { tx, error } = buildSignedTx(payoutFund, address, amountMinor, `pilot-payout:${key}`);
      if (error) return { ok: false, error };
      q.addPayout.run(key, operatorId, period, address, amountMinor, tx.txid || null, JSON.stringify(tx), 'recorded', null, nowMs());
      const s = submitTx(tx);
      if (!s.ok) { q.setPayout.run('recorded', s.reason, tx.txid || null, JSON.stringify(tx), key); return { ok: false, error: 'fund_tx_rejected', recorded: true, txid: tx.txid }; }
      q.setPayout.run('pending', null, tx.txid || null, JSON.stringify(tx), key);
      return { ok: true, status: 'pending', txid: tx.txid, amountMinor };
    });
  }

  // ---------- восстановление ----------
  function reconcile() {
    if (!faucetEnabled && !payoutEnabled) return { ok: false, error: 'pilot_disabled' };
    return withDb((q) => {
    const out = { faucet: [], payouts: [] };
    const settle = (row, markConfirmed, ref) => {
      if (row.txid && chainTxids().has(row.txid)) { markConfirmed(); return { ...ref, action: 'confirmed', txid: row.txid }; }
      if (row.state === 'pending') {
        const tx = JSON.parse(row.tx_json);
        submitTx(tx); // исходная подпись; already_in_chain/duplicate_tx = уже видна
        if (chainTxids().has(tx.txid)) { markConfirmed(); return { ...ref, action: 'confirmed', txid: tx.txid }; }
        return { ...ref, action: 'pending', txid: tx.txid, note: 'в mempool/ожидает блока' };
      }
      return { ...ref, action: 'recorded', reason: row.reason || 'needs_review' };
    };
    for (const row of q.openFaucet.all())
      out.faucet.push(settle(row, () => q.setFaucet.run('confirmed', null, null, null, row.challenge_id), { challengeId: row.challenge_id }));
    for (const row of q.openPayouts.all())
      out.payouts.push(settle(row, () => q.setPayout.run('confirmed', null, null, null, row.key), { key: row.key }));
    return { ok: true, ...out };
    });
  }

  return {
    faucetEnabled, payoutEnabled, faucetProblems: problems,
    faucetChallenge, faucetClaim, payoutRequest, reconcile,
    status: () => withDb((q) => ({ faucetEnabled, payoutEnabled, problems,
      counts: q.counts.get(), funds: { faucetFund: faucetFund || null, payoutFund: payoutFund || null } })),
  };
}
