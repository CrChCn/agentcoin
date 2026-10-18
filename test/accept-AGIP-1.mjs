/* accept-AGIP-1.mjs — исполняемый критерий приёмки AGIP-1 (docs/AGIP-1.md).
   Запуск: node test/accept-AGIP-1.mjs http://127.0.0.1:9343
   Green, если: 1) 200; 2) bootstrap — массив явно настроенных http(s) origin; пустой допустим; 3) peers — массив; height — число.
   Exit-код: 0 = приёмка пройдена; 1 = FAIL. */
const BASE = process.argv[2] || 'http://127.0.0.1:9335';

const j = await (async () => {
  const r = await fetch(BASE + '/peers/bootstrap', { signal: AbortSignal.timeout(8000), redirect: 'error' });
  let body = {};
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
})();

const fails = [];
if (j.status !== 200) fails.push(`status=${j.status} (ожидали 200)`);
if (!Array.isArray(j.body.bootstrap)) fails.push('bootstrap: не массив');
else for (const peer of j.body.bootstrap) {
  try { const u = new URL(peer); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error(); }
  catch { fails.push('bootstrap: неверный http(s) origin'); }
}
if (!Array.isArray(j.body.peers)) fails.push('peers: не массив');
if (typeof j.body.height !== 'number') fails.push('height: не число');

if (fails.length) {
  console.error('AGIP-1 ACCEPT: FAIL на ' + BASE + ' → ' + fails.join('; '));
  process.exit(1);
}
console.log(`AGIP-1 ACCEPT: OK на ${BASE} (bootstrap=${j.body.bootstrap.length} пиров, height=${j.body.height})`);
process.exitCode = 0;
