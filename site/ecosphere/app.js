import { makeBrowserClient, escHtml, shortAddr } from '../../sdk/js/agentcoin-browser.mjs';
const $ = (id) => document.getElementById(id);
const client = makeBrowserClient({ apiBase: '', signer: window.AgentcoinSigner || null });
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let ADDR = '', EXPECTED_GENESIS = 'unknown', LAST = {};
function logFeed(html, meta) {
  const li = document.createElement('li');
  li.innerHTML = html + (meta ? ` <span class="dim">${escHtml(meta)}</span>` : '');
  $('feed').prepend(li);
}
async function boot() {
  try {
    const net = await client.netInfo();
    $('netChain').textContent = net.chain; $('netGenesis').textContent = net.genesis;
    EXPECTED_GENESIS = net.genesis;
    $('netConn').textContent = 'ok';
    logFeed('подключено: ' + escHtml(net.chain) + ' / ' + escHtml(String(net.genesis).slice(0, 18)), 'источник /info+capabilities · подтверждение: http 200');
  } catch { $('netConn').textContent = 'нет связи'; }
  drawSphere([]);
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', 'false'));
    b.setAttribute('aria-selected', 'true');
    ['overview', 'work', 'services', 'orders', 'settle', 'events'].forEach((t) => { $('tab-' + t).hidden = t !== b.dataset.tab; });
  }));
  $('refresh').addEventListener('click', refresh);
  $('q').addEventListener('submit', (e) => { e.preventDefault(); search(); });
  $('mkOrder').addEventListener('submit', onCreate);
}
async function refresh() {
  ADDR = $('addr').value.trim();
  if (!ADDR) { $('myState').textContent = 'введите адрес — ключ не нужен.'; return; }
  const s = await client.status(ADDR);
  const t = await client.myTask(ADDR);
  LAST = { s, t, at: new Date(s.at).toLocaleTimeString() };
  $('fresh').textContent = 'данные: ' + LAST.at + (s.stale ? ' · УСТАРЕЛИ (API отказал после чтения)' : '');
  const pos = (s.queue?.waiting || []).indexOf(ADDR);
  const taskTxt = t?.unknown ? 'назначение не установлено по доступным источникам' : (t ? `назначение ${t.jobId} (via ${t.via})` : 'назначения нет');
  $('myState').innerHTML =
    `<div>адрес: <b>${escHtml(ADDR)}</b> · сеть ${escHtml(EXPECTED_GENESIS.slice(0, 18))}</div>` +
    `<div>позиция в очереди: ${pos >= 0 ? '#' + (pos + 1) : 'вне очереди'} · задача: ${escHtml(taskTxt)}</div>` +
    `<div>очередь/история: ${escHtml(JSON.stringify(s.queue).slice(0, 220))}</div>`;
  const next = !t ? (pos >= 0 ? 'Следующее действие: дождитесь claim (кнопка claim — только с подписантом).' : 'Следующее действие: join в очередь (нужен подписант).')
    : t.unknown ? 'Следующее действие: уточните назначение чтением /queue/status.' : 'Следующее действие: выполнить и сдать задачу.'
    + (s.stale ? ' Данные устарели — действия заблокированы до свежего чтения.' : '');
  $('nextAction').textContent = next;
  $('work').innerHTML = `<p>${escHtml(taskTxt)}</p><p class="dim">Чужая задача не сдаётся. Legacy done и V2 submit→review различаются: стенд показывает submit→review только при signed.</p>`;
  $('settle').innerHTML = `<p>Результат принят ≠ оплата подтверждена. Стадии: принят → обязательство → отправлен → подтверждён → сверка.</p><p class="dim">Для заказов api-check-v1: «Результат принят. Расчёт в AGT для этого типа заказа пока не подключён.» Локальные счётчики выплатой не считаются.</p>`;
  logFeed(`обновлено состояние ${escHtml(shortAddr(ADDR))}`, 'источник /queue/status · подтверждение: http 200');
  drawSphere([{ k: 'agent', label: ADDR }, ...(s.queue?.waiting || []).slice(0, 6).map((a) => ({ k: 'queue', label: a }))]);
  search();
}
async function search() {
  const r = await client.searchOffers({ skill: $('qSkill').value.trim() || undefined, maxPriceAtomic: $('qMax').value ? Number($('qMax').value) : undefined, format: $('qFmt').value.trim() || undefined });
  const list = r.offers || [];
  $('offers').innerHTML = list.length ? list.map((o) => `<div class="card"><b>${escHtml(o.title)}</b> · ${escHtml(o.offerId)} v${escHtml(o.version)} · ${escHtml(String(o.priceAtomic))} atomic<br><span class="dim">навыки заявлены исполнителем (не проверены): ${escHtml((o.skills || []).join(','))} · приёмка: ${escHtml(o.acceptance?.method || '?')}</span></div>`).join('') : '<p>ничего не найдено.</p>';
  $('ov').innerHTML = `<p>услуг: ${list.length} · сеть ${escHtml(EXPECTED_GENESIS.slice(0, 18))}</p>`;
  const ul = $('objList'); ul.innerHTML = '';
  list.slice(0, 12).forEach((o) => { const li = document.createElement('li'); const b = document.createElement('button'); b.type = 'button'; b.textContent = `услуга ${o.offerId} v${o.version} — ${o.title}`; b.addEventListener('click', () => { $('oOffer').value = o.offerId; }); li.append(b); ul.append(li); });
}
async function onCreate(e) {
  e.preventDefault();
  const r = await client.createOrder(ADDR, $('oOffer').value.trim(), (() => { try { return JSON.parse($('oInput').value || '{}'); } catch { return {}; } })(), $('oIdem').value.trim() || ('ui-' + Date.now()), undefined, { expectedGenesis: EXPECTED_GENESIS });
  $('orderRes').innerHTML = r.ok ? `<p>заказ создан: ${escHtml(r.result.assignment.assignmentId)} (приёмка ≠ оплата)</p>` : `<p>отказ: ${escHtml(r.error || '')} — ${escHtml(r.hint || '')}</p>`;
  logFeed(r.ok ? `заказ ${escHtml(r.result.assignment.assignmentId)} создан` : `заказ отклонён: ${escHtml(r.error || '')}`, 'источник /orders/create');
}
function drawSphere(items) {
  const cv = $('sphere'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = 'rgba(94,230,255,.4)';
  for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(150, 210, i * 50, 0, 7); ctx.stroke(); }
  ctx.fillStyle = '#e8b923'; ctx.beginPath(); ctx.arc(150, 210, 14, 0, 7); ctx.fill();
  ctx.fillStyle = '#e8ecf1'; ctx.font = '12px monospace';
  items.slice(0, 10).forEach((it, i) => {
    const a = (i / 10) * Math.PI * 2 + (reduced ? 0 : Date.now() / 4000);
    const x = 150 + Math.cos(a) * 110, y = 210 + Math.sin(a) * 80;
    ctx.fillStyle = it.k === 'agent' ? '#5ee6ff' : '#e8b923';
    ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill();
    ctx.fillStyle = '#9aa4b2'; ctx.fillText(shortAddr(it.label), x + 9, y + 4);
  });
  if (!reduced) requestAnimationFrame(() => { if (LAST.s) drawSphere(items); });
}
boot();
