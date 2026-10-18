/* ============================================================
   audit-lib.mjs — общий сэмплер сверки балансов
   Потребители: auto-miner.mjs, health-check.mjs (до этого логика дублировалась
   в двух файлах и копии могли расходиться — инцидент аудита 2026-10-15).
   Правила сверки:
     1. Пересчёт из chain.json НЕ доверяет ноде — сам суммирует транзакции;
        служебные записи без amount раскрываются как metadataSkipped;
        заданные нечисловые/нефинитные суммы делают сверку неполной.
     2. permabanned, 503/429, нечисловые ответы и ошибки источника означают
        НЕПОЛНУЮ проверку и никогда не дают ok=true.
     3. Любое числовое расхождение (включая got > expected) фиксируется.
        API не привязывает ответ к высоте/хешу: причину нельзя угадать.
     4. Это последовательный health-сэмплер с допуском AUDIT_EPS, а не
        атомарный точный аудит. Точный offline-аудит: tools/ledger-audit.mjs.
   Запуск: см. функции ниже (импортируют только node stdlib).
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AUDIT_EPS = 1e-6;
export const AUDIT_ATTEMPTS = 4;
export const AUDIT_RETRY_PAUSE_MS_BASE = 250;

// Независимый пересчёт балансов из файла цепи
export function recalcFromChainFile(dataDir) {
  const chainPath = path.join(dataDir, 'chain.json');
  const sourceText = fs.readFileSync(chainPath, 'utf8');
  const d = JSON.parse(sourceText);
  if (!Array.isArray(d.chain)) throw new Error('chain.json must contain chain[]');
  const balances = Object.create(null), snapshotIssues = [];
  let metadataSkipped = 0;
  for (const [blockIndex, blk] of d.chain.entries()) {
    if (!blk || !Array.isArray(blk.txs)) { snapshotIssues.push({ blockIndex, error: 'invalid_transaction_array' }); continue; }
    for (const [txIndex, tx] of blk.txs.entries()) {
      if (!tx || typeof tx !== 'object') { snapshotIssues.push({ blockIndex, txIndex, error: 'invalid_transaction' }); continue; }
      if (tx.amount === undefined) { metadataSkipped++; continue; }
      if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount)) {
        snapshotIssues.push({ blockIndex, txIndex, error: 'invalid_amount', amount: String(tx.amount) }); continue;
      }
      if (tx.from && tx.from !== 'COINBASE') balances[tx.from] = (balances[tx.from] ?? 0) - tx.amount;
      if (tx.to) balances[tx.to] = (balances[tx.to] ?? 0) + tx.amount;
    }
  }
  if (Object.keys(balances).length === 0) snapshotIssues.push({ error: 'no_numeric_balances' });
  for (const [addr, balance] of Object.entries(balances)) if (!Number.isFinite(balance)) snapshotIssues.push({ addr, error: 'expected_balance_not_finite', expected: String(balance) });
  return { balances, height: d.chain.length, snapshotHash: crypto.createHash('sha256').update(sourceText).digest('hex'), snapshotIssues, metadataSkipped };
}

// Последовательная сверка файла против POST /balance на указанном baseUrl.
// Legacy fields remain; complete/status/compared/matched distinguish a partial
// sampler from successful finite comparisons. This does not attest a shared tip.
// C-4 (Codex-ревью): в token-режиме ноды /balance требует x-admin-token; токен —
// Explicit null disables auth, including env fallback (remote health-check).
// Implicit env auth is allowed only for loopback; other nodes need an explicit
// token supplied by a caller that has established ownership of that endpoint.
export async function auditBalances({ dataDir, baseUrl, adminToken = undefined, attempts = AUDIT_ATTEMPTS,
  fetchFn = fetch, signal = null, timeoutMs = 8000 }) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('attempts must be a positive integer');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
  signal?.throwIfAborted();
  let loopback = false;
  try { loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(baseUrl).hostname); } catch {}
  const token = adminToken === undefined ? (loopback ? process.env.AGT_ADMIN_TOKEN || null : null) : adminToken;
  const authHeaders = token ? { 'x-admin-token': token } : {};
  const { balances, height, snapshotHash, snapshotIssues, metadataSkipped } = recalcFromChainFile(dataDir);
  const mismatches = snapshotIssues.map(issue => ({ ...issue, error: 'snapshot_' + issue.error, kind: 'unverifiable' }));
  let bannedSkipped = 0, transientSkipped = 0, compared = 0, matched = 0, unverifiable = snapshotIssues.length;

  for (const [addr, expected] of Object.entries(balances)) {
    signal?.throwIfAborted();
    if (!Number.isFinite(expected)) continue; // already diagnosed above
    let r = null;
    for (let i = 0; i < attempts; i++) {
      signal?.throwIfAborted();
      if (i > 0) await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, AUDIT_RETRY_PAUSE_MS_BASE * (i + 1));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      try {
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const resp = await fetchFn(baseUrl + '/balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ address: addr }),
          signal: requestSignal,
          redirect: 'error',
        });
        let body = {};
        try { body = await resp.json(); } catch { body = {}; }
        signal?.throwIfAborted();
        if (resp.status !== 503 && resp.status !== 429) { r = { status: resp.status, body }; break; }
        r = { status: resp.status, body }; // последний 503/429 запоминаем
      } catch (e) {
        signal?.throwIfAborted();
        r = { status: 0, body: {}, error: e.message };
      }
    }

    if (r && (r.status === 503 || r.status === 429)) {
      transientSkipped++; unverifiable++;
      mismatches.push({ addr, expected, error: 'balance_api_' + r.status, kind: 'unverifiable' }); continue;
    }
    if (!r || r.status !== 200) {
      unverifiable++;
      mismatches.push({ addr, expected, error: 'balance_api_' + (r ? r.status : 'conn'), kind: 'unverifiable' });
      continue;
    }
    if (r.body && r.body.opinion === 'permabanned') {
      bannedSkipped++; unverifiable++;
      mismatches.push({ addr, expected, error: 'balance_opinion_permabanned_unverified', kind: 'unverifiable' }); continue;
    }
    const got = r.body ? r.body.balance : undefined;
    if (typeof got !== 'number' || !Number.isFinite(got)) {
      unverifiable++;
      mismatches.push({ addr, expected, got: got === undefined ? 'absent' : String(got), error: 'balance_not_finite_number', kind: 'unverifiable' }); continue;
    }
    compared++;
    if (Math.abs(got - expected) > AUDIT_EPS) mismatches.push({ addr, expected, got, error: 'balance_mismatch', kind: 'mismatch' });
    else matched++;
  }

  return {
    checked: Object.keys(balances).length,
    height,
    snapshotHash,
    mode: 'sequential_live_balance_sampler',
    sharedSnapshotVerified: false,
    tolerance: AUDIT_EPS,
    compared,
    matched,
    metadataSkipped,
    snapshotIssues,
    bannedSkipped,
    rewardDrift: 0, // compatibility only: unverified drift is never excused
    transientSkipped,
    unverifiable,
    mismatches,
    complete: unverifiable === 0,
    status: unverifiable > 0 ? 'incomplete' : mismatches.length ? 'mismatch' : 'matched',
    ok: unverifiable === 0 && mismatches.length === 0,
  };
}
