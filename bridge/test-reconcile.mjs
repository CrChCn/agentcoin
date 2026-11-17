/* test-reconcile — приёмка сверки. Exit 0 = ok. */
import { computeReserves } from './reconcile.mjs';

const CP = { agentcoin: { height: 47100, hash: '00ab', at: Date.now() }, evm: { block: 9000000, hash: '0xcd', finalized: true, at: Date.now() } };
const R = (o) => computeReserves({ ...o, checkpoints: CP });

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (String(a) !== String(b)) fails.push(`${m}: ждали ${b}, получили ${a}`); else ok(m); };

// Спокойное состояние: locked 10 AGT, обращение 9.5 wAGT, комиссии 0.5
let r = R({ lockedMgnt: 10n * 10n ** 9n, wagtTotalSupplyWei: 9500000000n * 10n ** 9n, feesMgnt: 500000000n });
eq(r.unexplained, 0n, 'спокойное состояние сходится');
eq(r.ok, true, 'ok=true');

// Переходные: lock в полёте +1 AGT, burn в полёте −0.2
r = R({
  lockedMgnt: 11n * 10n ** 9n, wagtTotalSupplyWei: 9300000000n * 10n ** 9n,
  lockedNotMintedMgnt: 10n ** 9n, burnedNotReleasedWei: 200000000n * 10n ** 9n, feesMgnt: 500000000n,
});
eq(r.unexplained, 0n, 'in-flight объяснены');
eq(r.lockedNotMinted, 10n ** 9n, 'lockedNotMinted');
eq(r.burnedNotReleased, 200000000n, 'burnedNotReleased в магнетах');

// Расхождение: пропал 1 магнет
r = R({ lockedMgnt: 10n * 10n ** 9n - 1n, wagtTotalSupplyWei: 9500000000n * 10n ** 9n, feesMgnt: 500000000n });
eq(r.unexplained, -1n, 'необъяснённое расхождение видно');
eq(r.ok, false, 'ok=false требует стоп выпусков');

throws2(() => computeReserves({ lockedMgnt: 1n }), 'без контрольных точек отказ');
throws2(() => R({ lockedMgnt: 10n, wagtTotalSupplyWei: 10n ** 18n, feesMgnt: 11n }), 'комиссии больше locked: двойной учёт');
function throws2(fn, m) { try { fn(); fails.push(m + ': не бросил'); } catch { ok(m); } }
if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('test-reconcile: ALL GREEN');
