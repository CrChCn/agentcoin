// AGENTCOIN math unit tests — zero-dependency, run: node math.test.mjs
// Covers: Jacobi eigendecomposition, Markov forecast, SVD anomalies (Q + T²).
import assert from 'node:assert/strict';
import { jacobiEigen33, markovForecast, svdAnomalies, shannonEntropy } from './analytics.mjs';

const T0 = 1794100000;
const mk = (h, ts, txs) => ({ height: h, header: { timestamp: ts }, txs });

// 1. Jacobi: [[2,1,0],[1,2,0],[0,0,3]] → eigenvalues 3,3,1.
{
  const { values } = jacobiEigen33([[2, 1, 0], [1, 2, 0], [0, 0, 3]]);
  assert.deepEqual(values.map(v => Math.round(v * 1e9) / 1e9), [3, 3, 1]);
  console.log('ok jacobi eigenvalues 3,3,1');
}

// 2. Markov: 20 steady + stall gap + busy spike → current=busy, rows sum to 1.
{
  const chain = [];
  for (let h = 1; h <= 20; h++) chain.push(mk(h, T0 + h * 60, Array.from({ length: 1 + (h % 4) }, (_, i) => ({ from: 'A' + i, to: 'B', amount: 1 }))));
  chain.push(mk(21, T0 + 20 * 60 + 3600, [{ from: 'A', to: 'B', amount: 1 }]));
  chain.push(mk(22, T0 + 20 * 60 + 3660, Array.from({ length: 50 }, (_, i) => ({ from: 'A' + i, to: 'B', amount: 1 }))));
  const M = markovForecast(chain, 64);
  assert.equal(M.current, 'busy');
  for (const row of M.matrix) assert(Math.abs(row[0] + row[1] + row[2] - 1) < 1e-12);
  assert(M.forecast.steady + M.forecast.busy + M.forecast.stalled - 1 < 1e-12);
  console.log('ok markov current=busy risk=' + M.risk.toFixed(3));
}

// 3. SVD: whale block must be top anomaly; entropy sanity on uniform/skewed.
{
  const chain = [];
  for (let h = 1; h <= 15; h++) {
    const ntx = 2 + (h % 4), extra = (h * h) % 3;
    const txs = Array.from({ length: ntx }, (_, i) => ({ from: 'P' + ((h + i) % 7), to: 'Q' + ((h * 3 + i) % 4), amount: 1 + ((h * 7 + i) % 9) }));
    for (let k = 0; k < extra; k++) txs.push({ from: 'P' + ((h + k) % 7), to: 'Q' + ((h * 3 + k) % 4), amount: 1 });
    chain.push(mk(h, T0 + h * 60, txs));
  }
  chain.push(mk(16, T0 + 16 * 60, [{ from: 'W', to: 'X', amount: 1000000 }, { from: 'Y', to: 'Z', amount: 500000 }, { from: 'W', to: 'Q', amount: 250000 }]));
  const S = svdAnomalies(chain, 32);
  assert(S.anomalies.length > 0 && S.anomalies[0].height === 16, 'whale must be top anomaly');
  assert(S.explained > 0.5 && S.explained <= 1);
  assert(Math.abs(shannonEntropy([10, 10, 10, 10]) - 1) < 1e-12);
  assert(shannonEntropy([100, 1, 1, 1]) < 0.5);
  console.log('ok svd whale-top score=' + S.anomalies[0].score + ' explained=' + S.explained);
}

console.log('ALL MATH TESTS PASSED');
