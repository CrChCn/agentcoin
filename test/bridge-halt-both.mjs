/* bridge-halt-both — остановка ОБОИХ направлений моста (изолированно).
   Проверяет: любая несвежесть/расхождение останавливает mint И release одновременно;
   дефицит burn-стороны (реорг EVM после release) зеркален mint-дефициту;
   halt встают аттестор И релиз; bridgeState сводит оба дефицита; авторезюм запрещён.
   Exit 0 = ok. */
import { observeBurns, detectPostReleaseDeficit, healthCheck, makeHaltState, recordHaltObservation, canAttest, canRelease, canRelay, clearHalt } from '../bridge/services.mjs';
import { bridgeState } from '../bridge/api.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

// 1. Здоровье: любой красный флаг — STOP обоих направлений
{
  const cases = [
    [{ policyMatch: false, reconcileOk: true, evmFinalized: true, agentcoinTipFresh: true }, 'POLICY_DIVERGENCE'],
    [{ policyMatch: true, reconcileOk: false, evmFinalized: true, agentcoinTipFresh: true }, 'RECONCILE_UNEXPLAINED'],
    [{ policyMatch: true, reconcileOk: true, evmFinalized: false, agentcoinTipFresh: true }, 'EVM_NOT_FINALIZED'],
    [{ policyMatch: true, reconcileOk: true, evmFinalized: true, agentcoinTipFresh: false }, 'AGT_TIP_STALE'],
  ];
  for (const [flags, reason] of cases) {
    const h = healthCheck(flags);
    eq(h.mint, 'STOP', `halt-both: mint STOP при ${reason}`);
    eq(h.release, 'STOP', `halt-both: release STOP при ${reason}`);
    eq(h.reason, reason, `halt-both: причина ${reason}`);
  }
  const hok = healthCheck({ policyMatch: true, reconcileOk: true, evmFinalized: true, agentcoinTipFresh: true });
  eq(hok.mint + '/' + hok.release, 'OK/OK', 'halt-both: всё зелено — оба OK');
}

// 2. Дефицит release-стороны: burn был, vault выплатил, burn исчез из канона EVM
{
  const burnsBefore = observeBurns([{ block: 5, txHash: '0xburn1', logIndex: 2, burner: '0xB', amountWei: 2000000000n, agentcoinRecipient: 'AGTu' }], 0);
  eq(burnsBefore.filter((b) => b.status === 'burn').length, 1, 'halt-both: burn наблюдаем до реорга');
  const released = [{ txHash: '0xburn1', logIndex: 2, agentcoinTx: 'agttx1' }];
  const burnsAfter = observeBurns([], 0); // реорг EVM выбил burn
  const def = detectPostReleaseDeficit({ releasedBurnRefs: released, currentBurns: burnsAfter });
  eq(def.deficit, true, 'halt-both: реорг EVM после release — дефицит');
  eq(def.stop.join(','), 'mint,release', 'halt-both: стоп затрагивает ОБА направления');
  eq(detectPostReleaseDeficit({ releasedBurnRefs: released, currentBurns: burnsBefore }).deficit || false, false, 'halt-both: до реорга дефицита нет');
  // мусорный burn (некратная сумма) выпуском/релизов не становится
  const junk = observeBurns([{ block: 6, txHash: '0xj', logIndex: 0, burner: '0xB', amountWei: 1500000001n, agentcoinRecipient: 'AGTu' }], 0);
  eq(junk[0].status, 'unclassified', 'halt-both: некратный burn — unclassified, без релиза');
}

// 3. Halt останавливает И аттестации, И релизы; снятие только вручную
{
  const st = makeHaltState();
  recordHaltObservation(st, 'POST_RELEASE_DEFICIT:0xburn1', { evm: { block: 6 }, agentcoin: { height: 11 } });
  eq(canAttest(st).error, 'HALT_ATTEST_STOP', 'halt-both: аттестор встал');
  eq(canRelay(st).error, 'HALT_RELAY_STOP', 'halt-both: релеер встал');
  eq(canRelease(st).error, 'HALT_RELEASE_STOP', 'halt-both: релизы встали (явное имя)');
  eq(clearHalt(st, {}).error, 'HALT_MANUAL_ONLY', 'halt-both: авторезюм запрещён');
  eq(st.halted, true, 'halt-both: halt держится');
  eq(clearHalt(st, { manual: true, deficitClosed: false }).error, 'HALT_DEFICIT_OPEN', 'halt-both: при открытом дефиците не снять');
  eq(clearHalt(st, { manual: true, deficitClosed: true }).ok, true, 'halt-both: ручное закрытие — ок');
  eq(canRelease(st).ok, true, 'halt-both: после снятия релизы снова разрешены');
}

// 4. bridgeState сводит оба дефицита и оба стопа
{
  const chain = [{ height: 10, txs: [] }];
  const stt = bridgeState({
    chain, minted: [], evmBurns: [], released: [{ txHash: '0xmissing', logIndex: 0 }],
    reconcileArgs: { lockedMgnt: 0n, wagtTotalSupplyWei: 0n, feesMgnt: 0n, checkpoints: { agentcoin: { height: 10, hash: 'a', at: Date.now() }, evm: { block: 1, hash: '0xb', finalized: true, at: Date.now() } } },
    flags: { policyMatch: true, reconcileOk: true, evmFinalized: true, agentcoinTipFresh: true },
  });
  eq(stt.deficit.missing, 1, 'halt-both: api видит release-дефицит');
  eq(stt.deficit.directions.join(','), 'release', 'halt-both: api указывает направление release');
  const stt2 = bridgeState({
    chain, minted: [], evmBurns: [], released: [],
    reconcileArgs: { lockedMgnt: 0n, wagtTotalSupplyWei: 0n, feesMgnt: 0n, checkpoints: { agentcoin: { height: 10, hash: 'a', at: Date.now() }, evm: { block: 1, hash: '0xb', finalized: true, at: Date.now() } } },
    flags: { policyMatch: true, reconcileOk: true, evmFinalized: false, agentcoinTipFresh: true },
  });
  eq(stt2.health.mint + '/' + stt2.health.release, 'STOP/STOP', 'halt-both: EVM несвежая — оба STOP в API');
}

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('bridge-halt-both: ALL GREEN');
