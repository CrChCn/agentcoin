/* test-proto — приёмка каноники моста (У3, У5). Exit 0 = ok. */
import { agtToMagnets, magnetsToWei, weiToMagnetsExact, buildLockMemo, parseLockMemo, buildReleaseMemo, agentcoinLockEventId, evmBurnEventId, BRIDGE_ID } from './proto.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { const x = String(a), y = String(b); if (x !== y) fails.push(`${m}: ждали ${y}, получили ${x}`); else ok(m); };
const throws = (fn, m) => { try { fn(); fails.push(m + ': не бросил'); } catch { ok(m); } };

// У3: единицы точные, остаток запрещён
eq(agtToMagnets('1'), 1000000000n, '1 AGT = 1e9 магнет');
eq(agtToMagnets('0.000000001'), 1n, 'минимальная единица');
eq(magnetsToWei(1n), 1000000000n, '1 магнет = 1e9 wei');
eq(weiToMagnetsExact(1000000000n), 1n, 'обратное точное');
throws(() => agtToMagnets('0.0000000001'), '10-й знак отвергнут');
throws(() => agtToMagnets('1.5e3'), 'экспонента отвергнута');
throws(() => weiToMagnetsExact(1000000001n), 'некратный wei отвергнут');
throws(() => weiToMagnetsExact(999999999n), 'пыль <1 магнета отвергнута');
throws(() => weiToMagnetsExact(0n), 'ноль отвергнут');

// У5: memo строгое
const memo = buildLockMemo({ destChainId: '11155111', evmRecipient: '0xAbC1234567890123456789012345678901234567', amountMgnt: 2500000000n, nonce: 'n7x' });
eq(memo, 'bridge_lock:v1:AGT-WAGT-V1:11155111:0xAbC1234567890123456789012345678901234567:2500000000:n7x', 'lock memo каноничен');
const pr = parseLockMemo(memo);
eq(pr.ok, true, 'parse ok');
eq(pr.amountMgnt, 2500000000n, 'parse сумма BigInt');
eq(parseLockMemo(memo + ':x').ok, false, 'лишнее поле отвергнуто');
eq(parseLockMemo(memo.replace('bridge_lock', 'bridge_LOCK')).ok, false, 'регистр отвергнут');
eq(parseLockMemo('bridge_lock:v1:OTHER:11155111:0xAbC1234567890123456789012345678901234567:5:n').reason, 'bad_bridge', 'чужой мост отвергнут');
eq(parseLockMemo('просто текст').ok, false, 'мусор отвергнут');
throws(() => buildLockMemo({ destChainId: '1', evmRecipient: '0xshort', amountMgnt: 1n, nonce: 'n' }), 'короткий получатель отвергнут');
throws(() => buildLockMemo({ destChainId: '1:2', evmRecipient: '0xAbC1234567890123456789012345678901234567', amountMgnt: 1n, nonce: 'n' }), 'двоеточие в поле отвергнуто');

// release memo + eventId: привязка сетей, детерминизм, различие направлений
eq(buildReleaseMemo({ burnEventId: 'ab'.repeat(32) }), 'bridge_release:v1:AGT-WAGT-V1:' + 'ab'.repeat(32), 'release memo');
throws(() => buildReleaseMemo({ burnEventId: 'zzz' }), 'плохой eventId отвергнут');
const e1 = agentcoinLockEventId({ srcChainId: 'AGENTCOIN', destChainId: '11155111', txid: 't1', vault: 'AGTv', amountMgnt: 5n, sender: 'AGTs', evmRecipient: '0xR', nonce: 'n' });
const e2 = agentcoinLockEventId({ srcChainId: 'AGENTCOIN', destChainId: '11155111', txid: 't1', vault: 'AGTv', amountMgnt: 5n, sender: 'AGTs', evmRecipient: '0xR', nonce: 'n' });
eq(e1, e2, 'eventId детерминирован');
eq(e1.length, 64, 'eventId 32 байта hex');
const e3 = agentcoinLockEventId({ srcChainId: 'AGENTCOIN', destChainId: '1', txid: 't1', vault: 'AGTv', amountMgnt: 5n, sender: 'AGTs', evmRecipient: '0xR', nonce: 'n' });
if (e1 === e3) fails.push('eventId обязан различать сети'); else ok('eventId различает сети');
const eb = evmBurnEventId({ srcChainId: '11155111', destChainId: 'AGENTCOIN', txHash: '0xh', logIndex: 3, token: '0xT', amountWei: 7n, burner: '0xB', agentcoinRecipient: 'AGTr' });
if (eb === e1) fails.push('eventId обязан различать направления'); else ok('eventId различает направления');

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('test-proto: ALL GREEN');
