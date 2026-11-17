/* bridge services — наблюдатель/аттестор/ретранслятор/здоровье/дефицит (стенд v1, изолированно).
   Чистые функции + файловый журнал executed (рестартобезопасно); сеть и секреты —
   на вызывающем уровне. Реальные подписи EVM — в hardhat-тесте full-local. */
import { parseLockMemo } from './proto.mjs';

// Наблюдатель Agentcoin: все lock-события с высоты fromHeight (каноника строгая).
export function observeLocks(chain, fromHeight = 0) {
  const out = [];
  for (const b of chain || []) {
    if (b.height < fromHeight) continue;
    for (const [idx, tx] of (b.txs || []).entries()) {
      if (!tx || typeof tx.memo !== 'string' || !tx.memo.startsWith('bridge_lock:')) continue;
      const p = parseLockMemo(tx.memo);
      if (!p.ok) { out.push({ height: b.height, txid: tx.txid, status: 'unclassified', reason: p.reason }); continue; }
      out.push({ height: b.height, txid: tx.txid, logIndex: idx, status: 'lock', ...p, sender: tx.from, vault: tx.to });
    }
  }
  return out;
}

// Здоровье направлений: любое расхождение политик/сверки/финализации — стоп.
export function healthCheck({ policyMatch, reconcileOk, evmFinalized, agentcoinTipFresh }) {
  if (!policyMatch) return { mint: 'STOP', release: 'STOP', reason: 'POLICY_DIVERGENCE' };
  if (!reconcileOk) return { mint: 'STOP', release: 'STOP', reason: 'RECONCILE_UNEXPLAINED' };
  if (!evmFinalized) return { mint: 'STOP', release: 'OK', reason: 'EVM_NOT_FINALIZED' };
  if (!agentcoinTipFresh) return { mint: 'OK', release: 'STOP', reason: 'AGT_TIP_STALE' };
  return { mint: 'OK', release: 'OK', reason: 'ALL_OK' };
}

// Дефицит после реорга: lock был, mint выполнен, а lock из канонической цепи исчез.
// Автоматически отменённым НЕ считается: выпуск остаётся, фиксируется дефицит,
// остановка затронутых операций и ручное урегулирование (доплата vault / сжигание
// необеспеченных / компенсация по журналу). Возвращает план урегулирования.
export function detectPostMintDeficit({ mintedEventIds, currentLocks }) {
  const live = new Set((currentLocks || []).filter((l) => l.status === 'lock').map((l) => l.txid));
  const missing = [];
  for (const m of mintedEventIds || []) {
    if (!live.has(m.lockTxid)) missing.push(m);
  }
  if (!missing.length) return { deficit: false };
  return {
    deficit: true,
    missing,
    stop: ['mint', 'release'],
    // процедура: пауза выпуска, инвентаризация, ручное решение владельцев
    settlement: [
      '1. setMintPaused(true) + стоп релизов (health STOP).',
      '2. Инвентаризация: сверка locked/circulating по reconcile (unexplained != 0).',
      '3. Ручное урегулирование: довнесение обеспечения ИЛИ сжигание необеспеченных wAGT ИЛИ компенсация по журналу. Автокансел запрещён.',
      '4. Запись в журнал + честный статус на /bridge/health до снятия стопа.',
    ],
  };
}
