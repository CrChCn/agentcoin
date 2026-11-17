/* bridge api — состояние стенда для /bridge/* (изолированно, без прод-ноды).
   Источник истины: цепь Agentcoin + executed gateway + сверка + здоровье. */
import { observeLocks, observeBurns, healthCheck, detectPostMintDeficit, detectPostReleaseDeficit } from './services.mjs';
import { computeReserves } from './reconcile.mjs';

export function bridgeState({ chain, minted, evmBurns, released, reconcileArgs, flags }) {
  const locks = observeLocks(chain, 0);
  const burns = observeBurns(evmBurns || [], 0);
  const health = healthCheck(flags);
  const dMint = detectPostMintDeficit({ mintedEventIds: minted, currentLocks: locks });
  const dRel = detectPostReleaseDeficit({ releasedBurnRefs: released || [], currentBurns: burns });
  const deficit = (dMint.deficit || dRel.deficit)
    ? { missing: (dMint.missing || []).length + (dRel.missing || []).length, directions: [(dMint.deficit ? 'mint' : null), (dRel.deficit ? 'release' : null)].filter(Boolean), settlement: (dMint.deficit ? dMint.settlement : dRel.settlement) }
    : { missing: 0, directions: [] };
  let recon = null;
  try { recon = computeReserves(reconcileArgs); } catch (e) { recon = { ok: false, error: String(e && e.message || e) }; }
  return { locks: locks.length, burns: burns.filter((b) => b.status === 'burn').length, health, deficit, reconOk: recon && recon.ok === true };
}
