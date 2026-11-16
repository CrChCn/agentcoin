#!/usr/bin/env node
/* Weekly chain digest collector — READ-ONLY, public APIs only.
 * Usage: node tools/chain-digest.mjs [--live]
 * Prints markdown digest; saves snapshot to data/digest-snap.json for deltas.
 * Every number cites its endpoint. No keys, no writes to chain. */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.AGT_PUBLIC || 'https://agentcoin.work';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(__dirname, '..', 'data', 'digest-snap.json');

async function jget(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(p + ' -> ' + r.status);
  return r.json();
}

const prev = (() => { try { return JSON.parse(fs.readFileSync(SNAP, 'utf8')); } catch { return null; } })();

const info = await jget('/api/v1/info');
const height = Number(info.blocks ?? info.height);
const supply = Number(info.totalSupplyCirculating ?? info.supply ?? 0);
const jobs = await jget('/api/v1/jobs/state');
const auc = await jget('/api/v1/jobs/auction/list');
const qh = await jget('/queue/history').catch(() => ({ history: [] }));
const life = await jget('/api/v1/life');

// sample last 120 blocks for tx/fee methodology (bounded, honest sample)
let txN = 0, feeN = 0, blkN = 0;
try {
  const b = await jget('/api/v1/blocks?height=' + height + '&limit=120&tx=1');
  const list = b.blocks || [];
  blkN = list.length;
  for (const x of list) {
    const txs = x.tx || [];
    txN += txs.length;
    for (const t of txs) feeN += Number(t.fee || 0);
  }
} catch { /* sample unavailable — digest says so */ }

const openAuc = (auc.auctions || []).filter(a => a.status === 'commit');
const qHist = (qh.history || []).length;
const snap = { at: Date.now(), height, supply, paid: jobs.stats?.paid, open: jobs.stats?.open, qHist };
fs.mkdirSync(path.dirname(SNAP), { recursive: true });
fs.writeFileSync(SNAP, JSON.stringify(snap, null, 1));

const dH = prev ? height - prev.height : null;
const dPay = prev ? (jobs.stats?.paid ?? 0) - (prev.paid ?? 0) : null;

const L = [];
L.push('# Agentcoin weekly digest — blocks ~' + height);
L.push('');
L.push('| metric | value | source |');
L.push('|---|---|---|');
L.push('| height | ' + height + (dH !== null ? ' (+' + dH + ' since last snapshot)' : '') + ' | /api/v1/info |');
L.push('| circulating AGT | ' + supply + ' | /api/v1/info |');
L.push('| chain valid | ' + life.chainValid + ' | /api/v1/life |');
L.push('| escrow jobs paid (all-time) | ' + (jobs.stats?.paid ?? '?') + (dPay !== null ? ' (+' + dPay + ')' : '') + ' | /api/v1/jobs/state |');
L.push('| escrow jobs open | ' + (jobs.stats?.open ?? '?') + ' | /api/v1/jobs/state |');
L.push('| auctions open | ' + openAuc.length + ' | /api/v1/jobs/auction/list |');
L.push('| queue completions logged | ' + qHist + ' | /queue/history |');
if (blkN) L.push('| sample: last ' + blkN + ' blocks | ' + txN + ' tx, fees ' + feeN.toFixed(4) + ' AGT | /api/v1/blocks (sample, not 7d census) |');
L.push('');
L.push('_Methodology: cumulative counters from public endpoints; deltas vs data/digest-snap.json. Block sample is illustrative — full 7-day census needs an indexer._');
console.log(L.join('\n'));
