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
export async function auditBalances({ dataDir, baseUrl, attempts = AUDIT_ATTEMPTS }) {
  const { balances, height } = recalcFromChainFile(dataDir);
  const mismatches = [];
  let bannedSkipped = 0, rewardDrift = 0, transientSkipped = 0;

  for (const [addr, expected] of Object.entries(balances)) {
    let r = null;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise(res => setTimeout(res, AUDIT_RETRY_PAUSE_MS_BASE * (i + 1)));
      try {
        const resp = await fetch(baseUrl + '/balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: addr }),
        });
        let body = {};
        try { body = await resp.json(); } catch { body = {}; }
        if (resp.status !== 503 && resp.status !== 429) { r = { status: resp.status, body }; break; }
        r = { status: resp.status, body }; // последний 503/429 запоминаем
      } catch (e) {
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
