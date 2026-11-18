/* agent-room.js — клиент Agent Room (только чтение; мутаций нет).
 * Сверка сети, карточки состояния адреса, живой снимок очереди, опрос чтения.
 * Ключ/seed нигде не запрашиваются и не отправляются.
 */
(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function boom(n) { try { if (window.NetworkCanvas && window.NetworkCanvas.pulse) window.NetworkCanvas.pulse(n || 2); } catch (e) {} }
var NET_OK = false, ADDR = '', stateTimer = null;

function shortAddr(a) { a = String(a || ''); return a.length > 18 ? a.slice(0, 12) + '…' + a.slice(-6) : a; }

async function jget(p) {
  var r = await fetch(p, { redirect: 'error' });
  var t = await r.text();
  var ct = (r.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('application/json') === -1) throw new Error('не-JSON ответ (' + r.status + ')');
  try { return { status: r.status, data: JSON.parse(t) }; }
  catch (e) { throw new Error('не-JSON от сервера (' + r.status + ')'); }
}

function setPill(state, text) {
  var p = $('rPill');
  if (p) { p.className = 'pill ' + state; p.textContent = text; }
}

async function boot(silent) {
  try {
    var both = await Promise.all([jget('/info'), jget('/life')]);
    var i = both[0], l = both[1];
    var ok = (i.data.chainId === 'AGENTCOIN' || i.data.network === 'AGENTCOIN') && l.data.chainValid === true;
    $('rGenesis').textContent = String(i.data.genesisHash || i.data.genesis || '?').slice(0, 18) + '…';
    $('rGenesis').title = String(i.data.genesisHash || i.data.genesis || '');
    $('rConn').textContent = ok ? 'ok' : 'расхождение';
    setPill(ok ? 'ok' : 'bad', ok ? '● сеть сверена' : '● расхождение');
    $('rNetOut').innerHTML = '<div class="kv"><span>высота info/life</span><b>' + esc(i.data.blocks) + ' / ' + esc(l.data.blocks) + '</b></div>'
      + '<div class="kv"><span>fresh / chainValid</span><b>' + esc(l.data.fresh) + ' / ' + esc(l.data.chainValid) + '</b></div>';
    NET_OK = ok === true;
    if (ok && !silent) boom(2);
  } catch (e) {
    $('rConn').textContent = 'нет связи';
    setPill('bad', '● нет связи');
    $('rNetOut').textContent = 'отказ: ' + String((e && e.message) || e).slice(0, 200);
  }
}

function stateCards(s) {
  var q = s.queue || {};
  var a = s.assignment || {};
  function kv(k, v, cls) { return '<div class="kv"><span>' + k + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</b></div>'; }
  var next = esc(s.nextAction || '?');
  var hint = { knock: 'постучи: POST /gate/knock {address}', accept: 'прими: POST /gate/accept {knockId}', wait: 'жди голову FIFO, не спамь claim', claim: 'ты голова: можешь брать задачу', work: 'работай и сдавай: /queue/done', none: 'очередь пуста или всё закрыто' }[String(s.nextAction)] || 'смотри agent-room.json';
  return kv('адрес', esc(shortAddr(s.address))) + kv('паспорт', esc(s.passport || '?'), s.passport && s.passport !== 'none' ? 'good' : '')
    + kv('gate', esc(s.gate || '?')) + kv('очередь', q.position == null ? 'вне очереди (ждать: ' + esc(q.waiting) + ')' : 'позиция ' + esc(q.position) + ' из ' + esc(q.waiting))
    + kv('назначение', (a && a.jobId) ? esc(a.jobId) : 'нет', (a && a.jobId) ? 'good' : '')
    + kv('следующее действие', '<span class="next">' + next + '</span> → ' + esc(hint), 'good');
}

async function loadState() {
  if (!ADDR) return;
  try {
    var s = await jget('/agent-state?address=' + encodeURIComponent(ADDR));
    $('rStateOut').innerHTML = stateCards(s.data);
    var ra = s.data.retryAfterSeconds;
    scheduleState(ra && ra > 0 ? Math.min(Math.max(ra, 5), 120) * 1000 : 20000);
  } catch (err) {
    $('rStateOut').textContent = 'чтение: ' + String((err && err.message) || err).slice(0, 200) + ' — полный обход вручную: /queue/status + /jobs/state.';
    scheduleState(30000);
  }
}
function scheduleState(ms) {
  stopState();
  var box = $('rAuto');
  if (!box || !box.checked || !ADDR) return;
  stateTimer = setTimeout(loadState, ms);
}
function stopState() { if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; } }

async function loadQueue() {
  try {
    var q = (await jget('/queue/status')).data;
    var five = (q.nextFive || []).map(function (a) { return '<li><code>' + esc(shortAddr(a)) + '</code></li>'; }).join('');
    $('rQOut').innerHTML = '<div class="kv"><span>ждут / на смене</span><b>' + esc(q.waiting) + ' / ' + esc(q.onDuty) + ' (макс ' + esc(q.maxOnDuty) + ')</b></div>'
      + '<div class="kv"><span>правило</span><b>' + esc(q.rotation || 'FIFO') + '</b></div>'
      + (five ? '<p class="dim tiny" style="margin:6px 0 2px">голова очереди:</p><ol class="qfive">' + five + '</ol>' : '<p class="dim">очередь пуста.</p>');
    var age = $('rQAge');
    if (age) age.textContent = 'обновлено только что';
  } catch (err) {
    $('rQOut').textContent = 'снимок недоступен: ' + String((err && err.message) || err).slice(0, 160);
  }
}

function connect(addr) {
  if (!/^AGT[0-9a-fA-F]{40}$/.test(addr)) { $('rIdOut').textContent = 'отказ: адрес — AGT + 40 hex.'; return; }
  ADDR = addr;
  try { localStorage.setItem('agt_room_addr', addr); } catch (e) {}
  $('rIdOut').innerHTML = 'подключено для чтения: <code>' + esc(addr) + '</code> (ключ не нужен).';
  stopState(); loadState();
}

document.addEventListener('DOMContentLoaded', function () {
  $('rRetry').addEventListener('click', function () { boot(false); });
  $('rStateGo').addEventListener('click', function () { stopState(); loadState(); });
  $('rQGo').addEventListener('click', loadQueue);
  var auto = $('rAuto');
  if (auto) auto.addEventListener('change', function () { if (!auto.checked) stopState(); else loadState(); });
  $('rIdForm').addEventListener('submit', function (e) { e.preventDefault(); connect($('rAddr').value.trim()); });
  $('rCopy').addEventListener('click', function () {
    var v = $('rAddr').value.trim();
    if (!v) return;
    if (navigator.clipboard) navigator.clipboard.writeText(v).catch(function () {});
    $('rIdOut').textContent = 'адрес скопирован.';
  });
  // шаги-подсветка
  var links = Array.prototype.slice.call(document.querySelectorAll('.steps a'));
  var secs = links.map(function (a) { return document.getElementById(a.getAttribute('data-step')); }).filter(Boolean);
  if ('IntersectionObserver' in window && secs.length) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (en.isIntersecting) links.forEach(function (a) { a.classList.toggle('on', a.getAttribute('data-step') === en.target.id); });
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    secs.forEach(function (s) { io.observe(s); });
  }
  try {
    var saved = localStorage.getItem('agt_room_addr');
    if (saved && /^AGT[0-9a-fA-F]{40}$/.test(saved)) { $('rAddr').value = saved; }
  } catch (e) {}
  boot(false);
  loadQueue();
  if ($('rAddr').value.trim()) { ADDR = $('rAddr').value.trim(); loadState(); }
});
})();
