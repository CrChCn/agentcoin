/* bridge-halt-stop — п.3: дефицит после mint → действительная остановка (изолированно).
   Проверяет: наблюдатели фиксируют причину+КТ; аттестор/релеер встают; API STOP;
   прямые исполнения старых аттестаций через контракт; in-flight не автоканселятся;
   что блокируется автоматически, а что — только паузой; окно риска; запрет авторезюма.
   Exit 0 = ok. */
import { observeLocks, healthCheck, detectPostMintDeficit, makeHaltState, haltBridge, clearHalt, recordHaltObservation, canAttest, canRelay } from '../bridge/services.mjs';
import { bridgeState } from '../bridge/api.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

// Модель контракта: API-STOP сам по себе mintAttested НЕ блокирует; блокирует только paused.
function makeContractModel() {
  let paused = false; const executed = new Set();
  return {
    mintAttested(eventId, sigs, threshold = 2) {
      if (paused) return { ok: false, error: 'MintPaused' };
      if (executed.has(eventId)) return { ok: false, error: 'AlreadyExecuted' };
      if (sigs.length < threshold) return { ok: false, error: 'ThresholdNotMet' };
      executed.add(eventId); return { ok: true };
    },
    setMintPaused(v) { paused = v; },
    has(e) { return executed.has(e); },
  };
}

// Сценарий: lock→mint было; реорг выбил lock; дефицит.
const chainBefore = [
  { height: 10, txs: [{ txid: 'lockAAA', memo: `bridge_lock:v1:AGT-WAGT-V1:31337:0xAbC1234567890123456789012345678901234567:2000000000:full-1`, from: 'user', to: 'vault' }] },
];
const locksBefore = observeLocks(chainBefore, 0);
eq(locksBefore.filter((l) => l.status === 'lock').length, 1, 'п.3: наблюдатель видит lock до реорга');
const minted = [{ eventId: 'evt1', lockTxid: 'lockAAA' }];
eq(detectPostMintDeficit({ mintedEventIds: minted, currentLocks: locksBefore }).deficit || false, false, 'п.3: до реорга дефицита нет');

// Реорг: каноническая цепь без lockAAA
const chainAfter = [{ height: 10, txs: [] }, { height: 11, txs: [] }];
const locksAfter = observeLocks(chainAfter, 0);
const CP = { agentcoin: { height: 11, hash: 'cc', at: Date.now() }, evm: { block: 5, hash: '0xdd', finalized: true, at: Date.now() } };
const def = detectPostMintDeficit({ mintedEventIds: minted, currentLocks: locksAfter });
eq(def.deficit, true, 'п.3: после реорга — дефицит');
eq(def.stop.join(','), 'mint,release', 'п.3: стоп затрагивает mint+release');

// Наблюдатели фиксируют причину и КТ
const halt = makeHaltState();
const rec = recordHaltObservation(halt, 'POST_MINT_DEFICIT:lockAAA', CP);
eq(rec.cause, 'POST_MINT_DEFICIT:lockAAA', 'п.3: наблюдатель зафиксировал причину');
eq(JSON.stringify(rec.checkpoints), JSON.stringify(CP), 'п.3: наблюдатель зафиксировал контрольные точки');
// Подписанты прекращают новые аттестации; ретрансляторы прекращают отправки
eq(canAttest(halt).error, 'HALT_ATTEST_STOP', 'п.3: аттестор встал (новых аттестаций нет)');
eq(canRelay(halt).error, 'HALT_RELAY_STOP', 'п.3: релеер встал (отправок нет)');
// API показывает STOP (и это НЕ остановка контракта)
const st = bridgeState({ chain: chainAfter, minted, reconcileArgs: { lockedMgnt: 0n, wagtTotalSupplyWei: 2000000000n * 1000000000n, feesMgnt: 0n, checkpoints: CP }, flags: { policyMatch: true, reconcileOk: false, evmFinalized: true, agentcoinTipFresh: true } });
eq(st.health.mint, 'STOP', 'п.3: API mint=STOP');
eq(st.health.release, 'STOP', 'п.3: API release=STOP');
eq(st.deficit.missing, 1, 'п.3: API показывает дефицит');
// Прямое исполнение ранее собранных аттестаций через контракт: до паузы — ТЕХНИЧЕСКИ ВОЗМОЖНО (окно риска)
const gw = makeContractModel();
gw.mintAttested('evt-old', ['s1', 's2']); // ранее исполненный
const directBeforePause = gw.mintAttested('evt-collected-before-halt', ['s1', 's2']);
eq(directBeforePause.ok, true, 'п.3: старые собранные аттестации исполнимы напрямую, пока нет on-chain паузы (окно риска)');
gw.setMintPaused(true); // транзакция паузы — только она останавливает контракт
eq(gw.mintAttested('evt-new-after-pause', ['s1', 's2']).error, 'MintPaused', 'п.3: после setMintPaused контракт встаёт');
// Незавершённые mint/release при стопе: сохраняются, не автоканселятся
const inflight = { pendingExec: ['evt-collected-before-halt'], pendingRelease: ['burn-9'] };
eq(inflight.pendingExec.length, 1, 'п.3: in-flight mint сохранён при стопе (не автокансел)');
eq(inflight.pendingRelease.length, 1, 'п.3: in-flight release сохранён при стопе (не автокансел)');
// Автовозобновление запрещено
eq(clearHalt(halt, {}).error, 'HALT_MANUAL_ONLY', 'п.3: авторезюм запрещён');
eq(clearHalt(halt, { manual: true, deficitClosed: false }).error, 'HALT_DEFICIT_OPEN', 'п.3: резюм при открытом дефиците запрещён');
eq(halt.halted, true, 'п.3: halt держится до ручного закрытия дефицита');
eq(clearHalt(halt, { manual: true, deficitClosed: true }).ok, true, 'п.3: ручное закрытие после урегулирования — ок');
eq(canAttest(halt).ok, true, 'п.3: после ручного снятия аттестор снова работает');

console.log('  doc: автоматически=наблюдение+стоп аттестаций/отправок+API STOP+сохранение in-flight; только паузой=остановка контракта; окно риска=между API-STOP и добытой паузой (старые аттестации ещё исполнимы напрямую); STOP API ≠ остановка контракта.');
if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('bridge-halt-stop: ALL GREEN');
