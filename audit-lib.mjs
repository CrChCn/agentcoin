/* ============================================================
   audit-lib.mjs —ingle источник аудита балансов (ТЗ-2 из аудита 2026-10-15)
   Потребители: auto-miner.mjs, health-check.mjs (до этого логика дублировалась
   в двух файлах и копии могли расходиться — инцидент аудита 2026-10-15).
   Правила аудита (финальные, доказанные живьём):
     1. Пересчёт из chain.json НЕ доверяет ноде — сам суммирует транзакции;
        tx с нечисловым amount (паспорт/genesis-служебные записи) скипается —
        иначе NaN-призраки порождают ложные FAIL.
     2. permabanned-адреса нода по протоколу показывает как balance=0
        (opinion=permabanned) — such addresses скипаются по ответу САМОЙ ноды,
        потому что ban-листы разных нод могут отличаться.
     3. 503/429 (shedding ноды под бурстом) — не несоответствие: ретраи
        с паузами, после исчерпания — transient-скип.
     4. got > expected — rewardDrift (нода богаче диска: свежая награда/tx
        ещё не доехала до chain.json) — не коррупция.
   Запуск: см. функции ниже (импортируют только node stdlib).
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_EPS = 1e-6;
export const AUDIT_ATTEMPTS = 4;
export const AUDIT_RETRY_PAUSE_MS_BASE = 250;

// Независимый пересчёт балансов из файла цепи
export function recalcFromChainFile(dataDir) {
  const chainPath = path.join(dataDir, 'chain.json');
  const d = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
  const balances = {};
  for (const blk of d.chain || []) {
    for (const tx of blk.txs || []) {
      if (typeof tx.amount !== 'number') continue; // служебные записи без суммы
      if (tx.from && tx.from !== 'COINBASE') balances[tx.from] = (balances[tx.from] || 0) - tx.amount;
      if (tx.to) balances[tx.to] = (balances[tx.to] || 0) + tx.amount;
    }
  }
  return { balances, height: (d.chain || []).length };
}

// Полный аудит: пересчёт из файла против POST /balance на указанном baseUrl.
// Возвращает { checked, height, bannedSkipped, rewardDrift, transientSkipped, mismatches, ok }
// C-4 (Codex-ревью): в token-режиме ноды /balance требует x-admin-token; токен —
// Explicit null disables auth, including env fallback (remote health-check).
// Implicit env auth is allowed only for loopback; other nodes need an explicit
// token supplied by a caller that has established ownership of that endpoint.
export async function auditBalances({ dataDir, baseUrl, adminToken = undefined, attempts = AUDIT_ATTEMPTS,
  fetchFn = fetch, signal = null, timeoutMs = 8000 }) {
  let loopback = false;
  try { loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(baseUrl).hostname); } catch {}
  const token = adminToken === undefined ? (loopback ? process.env.AGT_ADMIN_TOKEN || null : null) : adminToken;
  const authHeaders = token ? { 'x-admin-token': token } : {};
  const { balances, height } = recalcFromChainFile(dataDir);
  const mismatches = [];
  let bannedSkipped = 0, rewardDrift = 0, transientSkipped = 0;

  for (const [addr, expected] of Object.entries(balances)) {
    signal?.throwIfAborted();
    let r = null;
    for (let i = 0; i < attempts; i++) {
      signal?.throwIfAborted();
      if (i > 0) await new Promise(res => setTimeout(res, AUDIT_RETRY_PAUSE_MS_BASE * (i + 1)));
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

    if (r && (r.status === 503 || r.status === 429)) { transientSkipped++; continue; }
    if (!r || r.status !== 200) {
      mismatches.push({ addr: addr.slice(0, 16), expected, error: 'balance_api_' + (r ? r.status : 'conn') });
      continue;
    }
    if (r.body && r.body.opinion === 'permabanned') { bannedSkipped++; continue; }
    const got = r.body ? r.body.balance : undefined;
    if (typeof got !== 'number' || Math.abs(got - expected) > AUDIT_EPS) {
      if (typeof got === 'number' && got > expected) { rewardDrift++; continue; }
      mismatches.push({ addr: addr.slice(0, 16), expected, got: got === undefined ? 'absent' : got });
    }
  }

  return {
    checked: Object.keys(balances).length,
    height,
    bannedSkipped,
    rewardDrift,
    transientSkipped,
    mismatches,
    ok: mismatches.length === 0,
  };
}
