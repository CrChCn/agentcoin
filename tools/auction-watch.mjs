#!/usr/bin/env node
// auction-watch: read-only sweep of chain + auctions. Handles both {data:[]} and {auctions:[]} shapes.
// Usage: node tools/auction-watch.mjs
const get = async (u) => (await fetch(u)).json();
const life = await get('https://agentcoin.work/api/v1/life').catch(() => ({}));
console.log('chain blocks:', life.blocks ?? '?', 'valid:', life.chainValid ?? '?');
const a = await get('https://agentcoin.work/api/v1/jobs/auction/list').catch(() => ({}));
const l = a.data || a.auctions || [];
console.log('auctions total:', l.length);
for (const y of l) console.log(' ', (y.id || '').slice(0, 8), y.status, 'c:' + y.commits, 'r:' + y.reveals);
