// watch-overnight.mjs — внешнее наблюдение на ночь. ТОЛЬКО публичные GET,
// без секретов, без записи на сервер. Пишет лог локально.
//
//   node tools/watch-overnight.mjs --base https://agentcoin.work --interval 60 --hours 10 --out watch.log
//
// Раздельно: SERVER (доступность сайта/API) и CHAIN (высота/hash/возраст блока,
// продвижение цепи). Ошибки — отдельным счётчиком, цепь «стоит» — отдельно.
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = (opt('base', 'https://agentcoin.work') || '').replace(/\/$/, '');
const INTERVAL = Number(opt('interval', '60')) || 60;
const HOURS = Number(opt('hours', '10')) || 10;
const OUT = opt('out', 'watch.log');
const fs = await import('node:fs');

async function get(path, ms = 15000) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { cache: 'no-store', signal: AbortSignal.timeout(ms) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    return { ok: r.ok, code: r.status, ms: Date.now() - t0, json: j };
  } catch (e) { return { ok: false, code: 'ERR', ms: Date.now() - t0, err: String(e.message || e).slice(0, 120) }; }
}
const line = (s) => { const t = new Date().toISOString(); fs.appendFileSync(OUT, `[${t}] ${s}\n`); console.log(`[${t}] ${s}`); };
const deadline = Date.now() + HOURS * 3600 * 1000;
let prevH = null, prevHash = null, srvFails = 0, apiFails = 0, stalledSince = null;
line(`START base=${BASE} interval=${INTERVAL}s hours=${HOURS} (SERVER vs CHAIN tracked separately)`);
while (Date.now() < deadline) {
  const site = await get('/', 15000);
  const info = site.ok ? await get('/api/v1/info').then(r => r.ok ? r : get('/info')) : { ok: false, code: 'SKIP' };
  const life = await get('/api/v1/life').then(r => r.ok ? r : get('/life'));
  // --- SERVER: доступность ---
  const srvUp = site.ok ? 1 : 0, apiUp = info.ok ? 1 : 0;
  if (!site.ok) srvFails++;
  if (!info.ok) apiFails++;
  // --- CHAIN: высота/hash/возраст ---
  const d = info.json || {};
  const h = Number.isSafeInteger(d.blocks) ? d.blocks : null;
  const tip = d.tipHash || d.headHash || null;
  const age = life.json && Number.isFinite(Number(life.json.tipAgeSec)) ? Number(life.json.tipAgeSec) : null;
  let move = 'n/a';
  if (h != null && prevH != null) {
    if (h > prevH) { move = `ADVANCED +${h - prevH}`; stalledSince = null; }
    else if (h === prevH) { if (!stalledSince) stalledSince = new Date().toISOString(); move = `STALLED since ${stalledSince}`; }
    else move = `REORG? ${prevH}->${h}`;
  } else if (h != null) stalledSince = null;
  if (h != null) { prevH = h; prevHash = tip; }
  line(`SERVER site=${site.ok ? 'UP' : 'DOWN(' + site.code + ')'} ${site.ms}ms api=${info.ok ? 'UP' : 'DOWN(' + (info.code || info.err || '?') + ')'} fails(site/api)=${srvFails}/${apiFails} | CHAIN height=${h ?? '?'} tip=${tip ? String(tip).slice(0, 12) : '?'} age=${age ?? '?'}s ${move}`);
  const wait = Math.min(INTERVAL * 1000, Math.max(0, deadline - Date.now()));
  if (wait <= 0) break;
  await new Promise(r => setTimeout(r, wait));
}
line(`END fails(site/api)=${srvFails}/${apiFails} lastHeight=${prevH ?? '?'} lastTip=${prevHash ? String(prevHash).slice(0, 12) : '?'}`);
