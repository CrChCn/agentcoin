/* bridge api — состояние стенда для /bridge/* (изолированно, без прод-ноды).
   Источник истины: цепь Agentcoin + executed gateway + сверка + здоровье. */
import { observeLocks, healthCheck, detectPostMintDeficit } from './services.mjs';
import { computeReserves } from './reconcile.mjs';

export function bridgeState({ chain, minted, reconcileArgs, flags }) {
  const locks = observeLocks(chain, 0);
  const health = healthCheck(flags);
  const deficit = detectPostMintDeficit({ mintedEventIds: minted, currentLocks: locks });
  let recon = null;
  try { recon = computeReserves(reconcileArgs); } catch (e) { recon = { ok: false, error: String(e && e.message || e) }; }
  return { locks: locks.length, health, deficit: deficit.deficit ? { missing: deficit.missing.length, settlement: deficit.settlement } : { missing: 0 }, reconOk: recon && recon.ok === true };
}
