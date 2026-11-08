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

// ---- Markov: network-state forecast ----
// State per block (adaptive thresholds, no magic constants):
//   stalled — interval > 3x median interval of the window (chain hiccup);
//   busy    — tx count >= 75th percentile (load spike);
//   steady  — otherwise.
// Transitions over consecutive blocks + Laplace smoothing → 3x3 matrix.
// risk = P(next != steady | current) — honest single number for the vitrine.
export const MARKOV_STATES = ['steady', 'busy', 'stalled'];
function blockIntervalMs(b, prev) {
  const t = b && b.header && typeof b.header.timestamp === 'number' ? b.header.timestamp : null;
  const p = prev && prev.header && typeof prev.header.timestamp === 'number' ? prev.header.timestamp : null;
  if (t === null || p === null) return null;
  return Math.max(0, (t - p) * 1000);
}
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}
export function markovForecast(chain, window = 64) {
  const arr = Array.isArray(chain) ? chain : [];
  const w = Math.min(Math.max(window | 0 || 64, 4), arr.length);
  if (arr.length < 4) return { window: arr.length, degraded: true, current: null, matrix: null, forecast: null, risk: null };
  const slice = arr.slice(-(w + 1));
  const intervals = [];
  const loads = [];
  for (let i = 1; i < slice.length; i++) {
    const dt = blockIntervalMs(slice[i], slice[i - 1]);
    if (dt !== null) intervals.push(dt);
    loads.push(((slice[i] && slice[i].txs) || []).length);
  }
  const med = quantile([...intervals].sort((a, b) => a - b), 0.5) || 1;
  const p75 = quantile([...loads].sort((a, b) => a - b), 0.75);
  const states = slice.slice(1).map((b, i) => {
    const dt = blockIntervalMs(b, slice[i]);
    const load = ((b && b.txs) || []).length;
    if (dt !== null && dt > 3 * med) return 'stalled';
    if (load > p75) return 'busy';
    return 'steady';
  });
  const idx = { steady: 0, busy: 1, stalled: 2 };
  const m = [[1, 1, 1], [1, 1, 1], [1, 1, 1]]; // Laplace smoothing
  for (let i = 1; i < states.length; i++) m[idx[states[i - 1]]][idx[states[i]]]++;
  const matrix = m.map(row => { const s = row[0] + row[1] + row[2]; return row.map(x => x / s); });
  const current = states[states.length - 1];
  const fr = matrix[idx[current]];
  const forecast = { steady: fr[0], busy: fr[1], stalled: fr[2] };
  return { window: states.length, current, matrix, forecast, risk: 1 - fr[0] };
}

// ---- SVD: anomaly detection over block-feature rows ----
// Rows: last W blocks × [txCount, volume, uniqueActors], standardized.
// C = XᵀX/(W−1) is 3×3 symmetric → cyclic Jacobi eigendecomposition.
// Anomaly score = Q/meanQ + T²/meanT² (каждый ~1 в среднем, порог 3):
// остаток ловит выбросы ВНЕ модели, T² — китов ВДОЛЬ главной оси.
export function jacobiEigen33(A) {
  const a = [A[0].slice(), A[1].slice(), A[2].slice()];
  let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      const apq = a[p][q];
      if (Math.abs(apq) < 1e-18) continue;
      const phi = 0.5 * Math.atan2(2 * apq, a[q][q] - a[p][p]);
      const c = Math.cos(phi), s = Math.sin(phi);
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return { values: order.map(i => Math.max(0, a[i][i])), vectors: order.map(i => [v[0][i], v[1][i], v[2][i]]) };
}
function blockFeatures(b) {
  const txs = (b && b.txs) || [];
  let vol = 0;
  const actors = new Set();
  for (const t of txs) {
    if (t && typeof t.amount === 'number' && t.amount > 0) vol += t.amount;
    if (t && typeof t.from === 'string') actors.add(t.from);
    if (t && typeof t.to === 'string') actors.add(t.to);
  }
  return [txs.length, vol, actors.size];
}
export function svdAnomalies(chain, window = 32, threshold = 3) {
  const arr = Array.isArray(chain) ? chain : [];
  if (arr.length < 4) return { window: arr.length, degraded: true, explained: null, anomalies: [] };
  const w = Math.min(Math.max(window | 0 || 32, 4), arr.length);
  const slice = arr.slice(-w);
  const X = slice.map(blockFeatures);
  const mean = [0, 1, 2].map(j => X.reduce((s, r) => s + r[j], 0) / X.length);
  const std = [0, 1, 2].map(j => Math.sqrt(X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / Math.max(1, X.length - 1)) || 1);
  const Z = X.map(r => r.map((x, j) => (x - mean[j]) / std[j]));
  const C = [0, 1, 2].map(p => [0, 1, 2].map(q => Z.reduce((s, r) => s + r[p] * r[q], 0) / Math.max(1, Z.length - 1)));
  const { values, vectors } = jacobiEigen33(C);
  const total = values[0] + values[1] + values[2] || 1;
  const [v0, v1] = vectors;
  const l0 = values[0] > 1e-12 ? values[0] : 0, l1 = values[1] > 1e-12 ? values[1] : 0;
  const stats = Z.map((r, i) => {
    const c0 = r[0] * v0[0] + r[1] * v0[1] + r[2] * v0[2];
    const c1 = r[0] * v1[0] + r[1] * v1[1] + r[2] * v1[2];
    const q = (r[0] - c0 * v0[0] - c1 * v1[0]) ** 2 + (r[1] - c0 * v0[1] - c1 * v1[1]) ** 2 + (r[2] - c0 * v0[2] - c1 * v1[2]) ** 2;
    const t2 = (l0 ? (c0 * c0) / l0 : 0) + (l1 ? (c1 * c1) / l1 : 0);
    return { height: slice[i] && slice[i].height, q, t2 };
  });
  const meanQ = stats.reduce((s, r) => s + r.q, 0) / stats.length;
  const meanT = stats.reduce((s, r) => s + r.t2, 0) / stats.length;
  const scored = stats.map(r => ({
    height: r.height,
    score: (meanQ > 1e-12 ? r.q / meanQ : 0) + (meanT > 1e-12 ? r.t2 / meanT : 0),
  }));
  const anomalies = scored.filter(r => r.score >= threshold).sort((a, b) => b.score - a.score).slice(0, 3)
    .map(r => ({ height: r.height, score: Math.round(r.score * 100) / 100 }));
  return { window: Z.length, explained: Math.round(((values[0] + values[1]) / total) * 1000) / 1000, threshold, anomalies };
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
    markov: markovForecast(chain, 64),
    svd: svdAnomalies(chain, 32),
    alert,
    vclock: vclock || {},
    vclockEvents: vclockTotal(vclock),
    checkedAt: new Date().toISOString(),
  };
}
