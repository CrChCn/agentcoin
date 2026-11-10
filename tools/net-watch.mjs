/* net-watch.mjs — сторож мейннета: tip/lag/пиры/сложность/мемпул трёх нод + крон.
   Читает только публичные GET, ничего не пишет в цепь. Для cron каждые 5–10 мин:
     node tools/net-watch.mjs [--json]
   Exit 0 — всё в норме; exit 2 — есть ALERT (и строка ALERT: ... в выводе).
   Порог лага — AGT_LAG_ALERT=2 блока, diff-пол — информативно. */
const NODES = (process.env.AGT_WATCH_NODES || 'https://node1.agentcoin.work,https://agentcoin.work').split(',').map(s => s.trim()).filter(Boolean);
const LAG_ALERT = Number(process.env.AGT_LAG_ALERT || 2);
const JSON_OUT = process.argv.includes('--json');

async function get(base, p, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(base + p, { signal: c.signal });
    if (!r.ok) return { _err: 'http_' + r.status };
    return await r.json();
  } catch (e) { return { _err: String(e.message || e).slice(0, 80) }; }
  finally { clearTimeout(t); }
}

const rows = [];
for (const base of NODES) {
  const [life, info] = await Promise.all([get(base, '/life'), get(base, '/info')]);
  rows.push({
    node: base,
    height: life?.blocks ?? info?.blocks ?? null,
    tip: (life?.tipHash || '?') + '',
    peers: life?.peers?.peer_count ?? null,
    diff: info?.difficultyBits ?? null,
    mempool: info?.mempool ?? null,
    err: life?._err || info?._err || null,
  });
}
const heights = rows.map(r => r.height).filter(Number.isInteger);
const maxH = heights.length ? Math.max(...heights) : null;
const alerts = [];
for (const r of rows) {
  if (r.err) { alerts.push(`${r.node}: недоступна (${r.err})`); continue; }
  if (maxH !== null && Number.isInteger(r.height) && maxH - r.height > LAG_ALERT) alerts.push(`${r.node}: лаг ${maxH - r.height} блоков (tip ${maxH})`);
  if (r.peers !== null && Number(r.peers) < 2) alerts.push(`${r.node}: мало пиров (${r.peers})`);
}
if (maxH === null) alerts.push('ни одна нода не отдала высоту');
const tips = new Set(rows.filter(r => !r.err).map(r => r.tip));
if (tips.size > 1) alerts.push(`tip разошёлся: ${[...tips].map(t => t.slice(0, 12)).join(' vs ')}`);

if (JSON_OUT) console.log(JSON.stringify({ ok: !alerts.length, maxHeight: maxH, nodes: rows, alerts }, null, 1));
else {
  for (const r of rows) console.log(`${r.err ? 'DOWN ' : 'ok    '} ${r.node} h=${r.height ?? '?'} tip=${String(r.tip).slice(0, 12)} peers=${r.peers ?? '?'} diff=${r.diff ?? '?'} mempool=${r.mempool ?? '?'}`);
  if (alerts.length) console.log('ALERT: ' + alerts.join(' | '));
  else console.log(`NET-OK (tip ${maxH})`);
}
process.exitCode = alerts.length ? 2 : 0; // без process.exit: иначе win/libuv роняет рантайм на открытых хендлах
