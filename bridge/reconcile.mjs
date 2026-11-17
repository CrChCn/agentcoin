/* reconcile — чистая сверка обеспечения (без сети). Все суммы BigInt.
   Инвариант: locked == circulating + lockedNotMinted + burnedNotReleased + fees.
   (сожжённые-но-не-разблокированные AGT всё ещё лежат в vault).
   Ненулевое unexplained = стоп новых выпусков. */
import { WEI_PER_MAGNET } from './proto.mjs';

const b = (x) => BigInt(x);

export function computeReserves({
  lockedMgnt, wagtTotalSupplyWei, lockedNotMintedMgnt = 0n,
  burnedNotReleasedWei = 0n, feesMgnt = 0n,
}) {
  const locked = b(lockedMgnt);
  const supplyWei = b(wagtTotalSupplyWei);
  if (supplyWei % WEI_PER_MAGNET !== 0n) throw new Error('reconcile_supply_not_magnet_exact');
  const circulating = supplyWei / WEI_PER_MAGNET;
  const burns = b(burnedNotReleasedWei);
  if (burns % WEI_PER_MAGNET !== 0n) throw new Error('reconcile_burns_not_magnet_exact');
  const burnedMgnt = burns / WEI_PER_MAGNET;
  const notMinted = b(lockedNotMintedMgnt);
  const fees = b(feesMgnt);
  const unexplained = locked - circulating - notMinted - burnedMgnt - fees;
  return { locked, circulating, lockedNotMinted: notMinted, burnedNotReleased: burnedMgnt, fees, unexplained, ok: unexplained === 0n };
}
