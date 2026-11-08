// AGENTCOIN chain analytics — pure functions, zero-dependency.
// Home for network math: Shannon entropy (now), Markov/Lyapunov/SVD later.
import { sanitizeClock, total as vclockTotal } from './vclock.mjs';

// Normalized Shannon entropy of a distribution, 0..1.
// counts: array of non-negative numbers (e.g. blocks per miner).
// 1 = perfectly uniform (or no data), 0 = single source (full concentration).
export function shannonEntropy(counts) {
  const xs = (counts || []).filter(n => typeof n === 'number' && n > 0);
  const sum = xs.reduce((s, n) => s + n, 0);
  if (sum <= 0) return 1;
  if (xs.length <= 1) return 0;
  let h = 0;
  for (const n of xs) {
    const p = n / sum;
    h -= p * Math.log2(p);
  }
  return h / Math.log2(xs.length);
}

// Miner of a block: explicit field, else coinbase recipient, else 'unknown'.
export function blockMiner(b) {
  if (b && typeof b.miner === 'string' && b.miner) return b.miner;
  try {
    const txs = (b && b.txs) || [];
    for (const t of txs) {
      if (t && t.from === 'COINBASE' && typeof t.to === 'string' && t.to) return t.to;
    }
  } catch { /* ignore */ }
  return 'unknown';
}

// Distribution of block producers over the last `window` blocks.
export function miningDistribution(chain, window = 256) {
  const arr = Array.isArray(chain) ? chain : [];
  const w = Math.min(Math.max(window | 0 || 256, 1), arr.length || 1);
  const slice = arr.slice(-w);
  const counts = {};
  for (const b of slice) {
    const m = blockMiner(b);
    counts[m] = (counts[m] || 0) + 1;
  }
  return { window: slice.length, counts };
}

// Full shield snapshot for GET /shield.
export function shieldSnapshot(chain, vclock, window = 256) {
  const dist = miningDistribution(chain, window);
  const entropy = shannonEntropy(Object.values(dist.counts));
  const top = Object.entries(dist.counts).sort((a, b) => b[1] - a[1])[0] || null;
  const topShare = top && dist.window ? top[1] / dist.window : 0;
  const alert = entropy < 0.5 ? 'mining_concentration' : null;
  const tip = (Array.isArray(chain) && chain.length ? chain[chain.length - 1] : null) || null;
  return {
    height: Array.isArray(chain) ? chain.length : 0,
    tipHash: tip ? tip.hash || null : null,
    window: dist.window,
    miners: dist.counts,
    topMiner: top ? { address: top[0], blocks: top[1], share: topShare } : null,
    miningEntropy: entropy,
    alert,
    vclock: vclock || {},
    vclockEvents: vclockTotal(vclock),
    checkedAt: new Date().toISOString(),
  };
}
