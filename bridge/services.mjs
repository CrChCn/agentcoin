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

/* Остановка моста (п.3): что блокируется автоматически, что — только транзакцией паузы.
   Автоматически (без цепи, в сервисах): наблюдатели фиксируют причину+контрольные точки,
   аттестор прекращает выдавать новые аттестации (canAttest→false), ретранслятор
   прекращает отправки (canRelay→false), API показывает STOP. Контракт при этом НЕ
   остановлен: ранее собранные аттестации ТЕХНИЧЕСКИ исполнимы через mintAttested
   напрямую до тех пор, пока не добыта setMintPaused(true) — это окно риска (см. тест).
   STOP в API НЕ выдавать за остановку контракта. Незавершённые mint/release при стопе
   сохраняются в pendingExec/pendingRelease (не автокансел, не авторетрай). Автоматическое
   возобновление ЗАПРЕЩЕНО: clearHalt требует manual:true и закрытый дефицит. */
export function makeHaltState() {
  return { halted: false, cause: null, checkpoints: null, at: null, manualResumeOnly: true };
}
export function haltBridge(state, cause, checkpoints) {
  state.halted = true; state.cause = String(cause); state.checkpoints = checkpoints || null; state.at = Date.now();
  return state;
}
export function clearHalt(state, { manual = false, deficitClosed = false } = {}) {
  if (!manual) return { ok: false, error: 'HALT_MANUAL_ONLY', note: 'автовозобновление запрещено' };
  if (!deficitClosed) return { ok: false, error: 'HALT_DEFICIT_OPEN' };
  state.halted = false; state.cause = null; state.checkpoints = null;
  return { ok: true };
}
// Наблюдатель фиксирует причину и контрольные точки (журнал без секретов).
export function recordHaltObservation(state, cause, checkpoints) {
  haltBridge(state, cause, checkpoints);
  return { halted: true, cause: state.cause, checkpoints: state.checkpoints };
}
export function canAttest(state) {
  if (state && state.halted) return { ok: false, error: 'HALT_ATTEST_STOP', cause: state.cause };
  return { ok: true };
}
export function canRelay(state) {
  if (state && state.halted) return { ok: false, error: 'HALT_RELAY_STOP', cause: state.cause };
  return { ok: true };
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
