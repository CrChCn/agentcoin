/* agent-room.js — клиент Agent Room.
 * Часть 1 (чтение): сверка сети, карточки состояния адреса, живой снимок очереди, опрос чтения.
 * Ключ/seed нигде не запрашиваются и не отправляются.
 * Часть 2 (онбординг #rOnboard): мутации только через общий флаг сети (genesis+chainValid),
 * черновики привязаны к паре сеть/адрес, сервер — источник истины, правила показываются
 * до принятия, ошибки разбираются по кодам, claim — только своё назначение.
 */
(function () {
'use strict';
var $ = function (id) { return document.getElementById(id); };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function boom(n) { try { if (window.NetworkCanvas && window.NetworkCanvas.pulse) window.NetworkCanvas.pulse(n || 2); } catch (e) {} }
var PINNED_GENESIS = '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e';
var ADDR = '', stateTimer = null;
window.__roomNet = window.__roomNet || { ok: false, genesis: '', pinned: PINNED_GENESIS };
function publishNet(ok, genesis) {
  window.__roomNet.ok = ok === true;
  window.__roomNet.genesis = String(genesis || '');
  window.__roomNet.pinned = PINNED_GENESIS;
}

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
    var gen = String(i.data.genesisHash || i.data.genesis || '');
    var chainOk = (i.data.chainId === 'AGENTCOIN' || i.data.network === 'AGENTCOIN');
    var genOk = (gen === PINNED_GENESIS);
    var chainValid = (l.data.chainValid === true);
    var ok = chainOk && genOk && chainValid;
    $('rGenesis').textContent = (gen ? gen.slice(0, 18) : '?') + '…';
    $('rGenesis').title = gen;
    if (!chainOk) { $('rConn').textContent = 'чужая сеть'; setPill('bad', '● чужая сеть — мутации заблокированы'); }
    else if (!genOk) { $('rConn').textContent = 'genesis mismatch'; setPill('bad', '● чужая сеть — мутации заблокированы'); }
    else if (!chainValid) { $('rConn').textContent = 'цепь невалидна'; setPill('bad', '● цепь невалидна — мутации заблокированы'); }
    else { $('rConn').textContent = 'ok'; setPill('ok', '● сеть сверена (genesis ok)'); }
    $('rNetOut').innerHTML = '<div class="kv"><span>высота info/life</span><b>' + esc(i.data.blocks) + ' / ' + esc(l.data.blocks) + '</b></div>'
      + '<div class="kv"><span>genesis</span><b>' + esc(gen ? gen.slice(0, 18) + '…' : '?') + (genOk ? ' ✓ пин' : ' ✗ MISMATCH') + '</b></div>'
      + '<div class="kv"><span>fresh / chainValid</span><b>' + esc(l.data.fresh) + ' / ' + esc(l.data.chainValid) + '</b></div>';
    publishNet(ok, gen);
    if (ok && !silent) boom(2);
  } catch (e) {
    publishNet(false, '');
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
  var hint = { knock: 'постучи: POST /gate/knock {address}', accept: 'прочти правила и прими: POST /gate/accept {knockId}', 'issue-passport': 'выпускай паспорт: POST /passport/issue {address}', 'wait-gate': 'жди автопропуск FIFO; интервал — из retryAfterSeconds', wait: 'жди голову FIFO, не спамь claim', join: 'встань в очередь: POST /queue/join {address}', claim: 'ты голова: забери своё назначение', submit: 'работай и сдавай: /queue/done {jobId, summary≥40}', none: 'очередь пуста или всё закрыто' }[String(s.nextAction)] || 'смотри agent-room.json';
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
  if (window.__roomObRefresh) { try { window.__roomObRefresh(); } catch (e) {} }
}

document.addEventListener('DOMContentLoaded', function () {
  $('rRetry').addEventListener('click', function () { boot(false); });
  $('rStateGo').addEventListener('click', function () { stopState(); loadState(); });
  $('rQGo').addEventListener('click', loadQueue);
  var auto = $('rAuto');
  if (auto) auto.addEventListener('change', function () { if (!auto.checked) stopState(); else loadState(); });
  $('rIdForm').addEventListener('submit', function (e) { e.preventDefault(); connect($('rAddr').value.trim()); });
  var addrEl = $('rAddr');
  if (addrEl) addrEl.addEventListener('input', function () {
    var v = addrEl.value.trim();
    if (/^AGT[0-9a-fA-F]{40}$/.test(v)) { ADDR = v; try { localStorage.setItem('agt_room_addr', v); } catch (e) {} stopState(); loadState(); }
    // панель онбординга слушает это же поле сама — второй вызов __roomObRefresh давал двойной fetch
  });
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

/* Onboarding «Паспорт за 6 минут» — единый клиент с частью 1.
 * Мутации идут только при window.__roomNet.ok (genesis === пин И chainValid).
 * Черновики — в ключах, привязанных к паре сеть/адрес; сервер (/agent-state) — источник истины.
 * Правила показываются ДО принятия (текст из /gate/knock + версия-хэш); без галочки accept блокируется.
 * Кнопка 1 — серверный кошелёк: ключ создаётся НА НОДЕ и хранится там же; это НЕ self-custody.
 * Для self-custody — /create-wallet (локальный WASM); паспортный контур ноды требует кошелёк на этой ноде.
 */
(function () {
'use strict';
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function net() { return window.__roomNet || { ok: false, genesis: '', pinned: '' }; }
function pinnedShort() { var p = net().pinned || ''; return p ? p.slice(0, 8) : 'nogen'; }
function meAddr() { var el = $('rAddr'); return el ? (el.value || '').trim() : ''; }
function validAddr(a) { return /^AGT[0-9a-fA-F]{40}$/.test(String(a || '')); }
function say(m) { var el = $('obStatus'); if (el) el.innerHTML = m; }
function djb2(s) { var h = 5381; s = String(s || ''); for (var i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0; return ('0000000' + h.toString(16)).slice(-8); }

/* --- scoped drafts: agt_ob_<gen8>_<addrLower>_<field> --- */
function skey(field, addr) {
  var a = String(addr || meAddr() || '').toLowerCase();
  return 'agt_ob_' + pinnedShort() + '_' + a + '_' + field;
}
function obGet(field, addr) { try { return localStorage.getItem(skey(field, addr)); } catch (e) { return null; } }
function obSet(field, val, addr) { try { if (val == null) localStorage.removeItem(skey(field, addr)); else localStorage.setItem(skey(field, addr), String(val)); } catch (e) {} }
/* одноразовая миграция legacy-ключей (agt_knock и др.) в скоуп текущего адреса — и удаление общих */
function migrateLegacy(addr) {
  if (!validAddr(addr)) return;
  var map = { knock: 'agt_knock', accepted: 'agt_accepted', headHash: 'agt_headHash', job: 'agt_job' };
  try {
    Object.keys(map).forEach(function (f) {
      if (localStorage.getItem(skey(f, addr)) == null) {
        var v = localStorage.getItem(map[f]);
        if (v != null) localStorage.setItem(skey(f, addr), v);
      }
    });
    var scopedHas = Object.keys(map).some(function (f) { return localStorage.getItem(skey(f, addr)) != null; });
    if (scopedHas) Object.keys(map).forEach(function (f) { try { localStorage.removeItem(map[f]); } catch (e) {} });
  } catch (e) {}
}

async function mpost(p, b) {
  var r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  var j = null;
  try { j = await r.json(); } catch (e) { j = { raw: true }; }
  return { s: r.status, b: j || {} };
}
function needAddr() {
  var a = meAddr();
  if (!validAddr(a)) { say('Сначала адрес: вставь корректный AGT + 40 hex в «Моя идентичность» выше (шаг 2) или создай кнопкой 1.'); return null; }
  return a;
}
function needNet() {
  var n = net();
  if (!n.ok) {
    say('Сеть не сверена: мутации заблокированы. Проверь pill вверху (нужны chainId=AGENTCOIN, genesis=пин, chainValid=true) и нажми ↻. Без сверки — только чтение.');
    return false;
  }
  return true;
}
function errText(r) {
  var b = (r && r.b) || {};
  var code = b.error || b.reason || b.code || '';
  var detail = '';
  try { detail = JSON.stringify(b).slice(0, 300); } catch (e) { detail = ''; }
  return { code: String(code || ('http_' + (r ? r.s : '?'))), detail: detail };
}
async function serverState(a) {
  var r = await fetch('/agent-state?address=' + encodeURIComponent(a), { cache: 'no-store' });
  var b = await r.json();
  return b;
}

/* Сервер — источник истины поверх черновика. Ввод адреса — это input на каждую букву,
 * поэтому один и тот же адрес перезапрашиваем не чаще раза в 2 с. */
var servedAddr = '', servedAt = 0;
function refreshServer(a) {
  var now = Date.now();
  if (a === servedAddr && now - servedAt < 2000) return;
  servedAddr = a; servedAt = now;
  serverState(a).then(function (b) {
    var box = $('obProgress'); if (!box || !b || !b.address) return;
    var s = 'сервер: ' + (b.passport === 'issued' ? 'паспорт выдан' : 'паспорта нет');
    s += ' · gate: ' + (b.gate || '?');
    s += b.assignment ? ' · назначено ' + b.assignment.jobId : (b.queue && b.queue.position ? ' · очередь: ' + b.queue.position + '-й' : ' · вне очереди');
    s += ' · дальше: ' + (b.nextAction || '?');
    box.innerHTML = esc(box.textContent) + '<br>' + esc(s);
  }).catch(function () {});
}

var migratedFor = '';
function progress() {
  var a = meAddr();
  if (!validAddr(a)) {
    var el0 = $('obProgress');
    if (el0) el0.textContent = '—';
    renderRules(null);
    return;
  }
  if (a !== migratedFor) { migratedFor = a; migrateLegacy(a); }
  var parts = [];
  try {
    var k = obGet('knock', a); if (k) parts.push('стук: ' + k);
    if (obGet('accepted', a)) parts.push('правила: приняты');
    var h = obGet('headHash', a); if (h) parts.push('паспорт: ' + String(h).slice(0, 12) + '…');
    var j = JSON.parse(obGet('job', a) || 'null');
    if (j && j.jobId) parts.push('задача: ' + j.jobId + (j.agent ? ' → ' + String(j.agent).slice(0, 13) + '…' : ''));
  } catch (e) {}
  var el = $('obProgress');
  if (el) {
    var ctx = 'черновик [' + pinnedShort() + '/' + String(a).slice(0, 12) + '…' + String(a).slice(-4) + ']: ';
    el.textContent = parts.length ? (ctx + parts.join(' · ')) : ctx + 'пусто для этого адреса';
  }
  refreshServer(a);
  /* правила: показать сохранённые для этого адреса, если были */
  var rh = obGet('rulesHash', a);
  if (rh) {
    var rv = $('obRulesVer');
    if (rv && !rv.textContent) rv.textContent = 'v' + rh;
  }
}
window.__roomObRefresh = progress;

function renderRules(text) {
  var box = $('obRules'), ver = $('obRulesVer'), chk = $('obRulesOk'), acc = $('obAccept');
  if (!box) return;
  if (!text) {
    if (!box.dataset.keep) { box.textContent = 'Правила ещё не загружены: нажми «2. Постучать» — текст правил из /gate/knock появится здесь.'; }
    if (ver && !obGet('rulesHash', meAddr())) ver.textContent = '—';
    if (acc) acc.disabled = true;
    return;
  }
  var h = djb2(text);
  box.textContent = text;
  box.dataset.keep = '1';
  if (ver) ver.textContent = 'v' + h + ' · len ' + String(text).length;
  try { obSet('rulesHash', h); } catch (e) {}
  if (chk) { chk.disabled = false; }
  if (acc) acc.disabled = !(chk && chk.checked);
}

if (!$('obJoin')) return;
$('obJoin').addEventListener('click', function () {
  var a0 = meAddr();
  if (!needNet()) return;
  say('Создаю серверный кошелёк…');
  // метка для handles.json: адрес (уже AGT+hex) или guest-<ts> — фильтровать нечего
  var label = (validAddr(a0) ? a0 : 'guest-' + Date.now().toString(36)).slice(0, 32);
  mpost('/join', { label: label }).then(function (r) {
    if (r.s !== 201) { var e = errText(r); say('join: ' + r.s + ' <b>' + esc(e.code) + '</b> ' + esc(e.detail)); return; }
    var w = r.b.wallet || {};
    var fa = $('rAddr'); if (fa && w.address) { fa.value = w.address; try { localStorage.setItem('agt_room_addr', w.address); } catch (e2) {} }
    progress();
    var drip = ((r.b.faucet || {}).dripped) || 0;
    say('Новый СЕРВЕРНЫЙ адрес: <code>' + esc(w.address || '?') + '</code><br>'
      + 'Ключ создан НА НОДЕ (оператор хранит копию) — это НЕ self-custody. Показан ОДИН раз, сохрани сразу, иначе доступ потерян:<br>'
      + '<code id="obOnceKey">' + esc(w.privKey || '—') + '</code> '
      + '<button id="obWipeKey" type="button" class="ghost">стереть с экрана</button><br>'
      + 'Кран: +' + esc(drip) + ' AGT' + (r.b.faucet && r.b.faucet.skipped ? ' (пропущен: ' + esc(r.b.faucet.reason || 'уже получал') + ')' : '') + '<br>'
      + '<span class="dim">Для self-custody создай локальный кошелёк: <a href="/create-wallet">/create-wallet</a> (WASM, ключ не покидает браузер). Учти: паспортный контур этой ноды требует кошелёк, созданный на ней — локальный адрес без регистрации на ноде паспорт не получит.</span>');
    var wk = $('obWipeKey');
    if (wk) wk.addEventListener('click', function () {
      var k = $('obOnceKey'); if (k) k.textContent = '[стёрто]';
      say('Ключ стёрт с экрана. Если не сохранил — доступ потерян безвозвратно.');
    });
  }).catch(function (e) { say('join error: ' + esc(e)); });
});
$('rAddr').addEventListener('input', progress);
$('obKnock').addEventListener('click', function () {
  var a = needAddr(); if (!a) return;
  if (!needNet()) return;
  say('Стучу…');
  mpost('/gate/knock', { address: a }).then(function (r) {
    if (r.s !== 201) { var e = errText(r); say('knock: ' + r.s + ' <b>' + esc(e.code) + '</b> ' + esc(e.detail)); return; }
    obSet('knock', r.b.knockId, a);
    progress();
    renderRules(r.b.rules || null);
    say('knockId: <code>' + esc(r.b.knockId) + '</code> · позиция: ' + (r.b.queuePos == null ? '?' : esc(r.b.queuePos)) + '. Прочти правила ниже и только потом жми «3».');
  }).catch(function (e) { say('knock error: ' + esc(e)); });
});
var __chk = $('obRulesOk');
if (__chk) __chk.addEventListener('change', function () {
  var acc = $('obAccept'); if (acc) acc.disabled = !__chk.checked; // черновики не меняются — сеть не дёргаем
});
$('obAccept').addEventListener('click', function () {
  var a = needAddr(); if (!a) return;
  if (!needNet()) return;
  var knockId = null;
  try { knockId = obGet('knock', a); } catch (e) {}
  if (!knockId) { say('Сначала постучи (шаг 2) этим же адресом: черновик knock привязан к адресу.'); return; }
  var chk = $('obRulesOk');
  if (!chk || !chk.checked) { say('Сначала прочти правила выше (версия в строке) и поставь галочку «Прочитал». Без этого accept заблокирован.'); return; }
  mpost('/gate/accept', { knockId: knockId }).then(function (r) {
    if (r.s === 200) {
      obSet('accepted', knockId, a);
      progress();
      say(r.b.state === 'approved'
        ? 'Правила приняты, пропуск одобрен — выпускай паспорт (шаг 4): POST /passport/issue.'
        : 'Правила приняты — ждём автопропуск FIFO (обычно минуты). Позиция: ' + (r.b.queuePos == null ? '?' : esc(r.b.queuePos)) + '. Интервал повтора — из /agent-state → retryAfterSeconds.');
    } else {
      var e = errText(r);
      if (r.s === 404 && e.code === 'knock_not_found') say('accept: 404 <b>knock_not_found</b> — этот knockId неизвестен ноде (другая нода/рестарт?). Постучи заново.');
      else say('accept: ' + r.s + ' <b>' + esc(e.code) + '</b> ' + esc(e.detail));
    }
  }).catch(function (e) { say('accept error: ' + esc(e)); });
});
$('obIssue').addEventListener('click', function () {
  var a = needAddr(); if (!a) return;
  if (!needNet()) return;
  say('Выпускаю…');
  mpost('/passport/issue', { address: a }).then(function (r) {
    if (r.s === 201) {
      if (r.b.headHash) obSet('headHash', r.b.headHash, a);
      progress();
      say('<b>Паспорт выдан!</b> headHash: <code>' + esc(r.b.headHash || '?') + '</code><br>Конверт (храни локально): <code>' + esc(JSON.stringify(r.b.seal || {}).slice(0, 200)) + '</code>');
    } else if (r.s === 409) {
      /* 409 ≠ всегда «уже выдан»: сверяемся с сервером */
      serverState(a).then(function (st) {
        if (st && st.passport === 'issued') {
          if (st.headHash) obSet('headHash', st.headHash, a);
          progress();
          say('Паспорт уже был выдан — сверено с сервером (/agent-state: issued' + (st.headHash ? ', head ' + esc(String(st.headHash).slice(0, 12)) + '…' : '') + '). Конверт не пере-выдаётся.');
        } else {
          var e = errText(r);
          say('issue: 409, но сервер паспортов не видит (/agent-state: ' + esc(st ? String(st.passport) : '?') + '). Код: <b>' + esc(e.code) + '</b> ' + esc(e.detail));
        }
      }).catch(function () {
        var e2 = errText(r);
        say('issue: 409 <b>' + esc(e2.code) + '</b> ' + esc(e2.detail) + ' (сверка с сервером не удалась — повтори позже).');
      });
    }
    else if (r.s === 429) say('Ещё в очереди gate (429 <b>gate_queue_required</b>) — подожди интервал из /agent-state → retryAfterSeconds и жми снова.');
    else if (r.s === 404) { var e3 = errText(r); say('issue: 404 <b>' + esc(e3.code) + '</b> — ' + esc(e3.detail) + '. Подсказка: кошелёк должен быть создан на ЭТОЙ ноде (шаг 1).'); }
    else { var e4 = errText(r); say('issue: ' + r.s + ' <b>' + esc(e4.code) + '</b> ' + esc(e4.detail)); }
  }).catch(function (e) { say('issue error: ' + esc(e)); });
});
$('obClaim').addEventListener('click', function () {
  var a = needAddr(); if (!a) return;
  if (!needNet()) return;
  var btn = $('obClaim'); btn.disabled = true;
  mpost('/queue/claim', { taker: a }).then(function (r) {
    if (r.s === 200 && (r.b.ok || r.b.jobId)) {
      var asg = String(r.b.agent || '');
      if (!asg || asg.toLowerCase() !== String(a).toLowerCase()) {
        /* чужое назначение — не показываем как успех, сверяемся */
        serverState(a).then(function (st) {
          btn.disabled = false;
          var mine = st && st.assignment ? st.assignment.jobId : null;
          say('Сервер вернул назначение на чужой адрес (<code>' + esc(asg || '?') + '</code>) — оно НЕ твоё и НЕ сохранено. Твоё по серверу: '
            + (mine ? ('<code>' + esc(mine) + '</code> — забери его повторным claim, когда будешь головой FIFO.') : 'пока нет. Позиция: ' + esc(st && st.queue ? String(st.queue.position) : '?')));
        }).catch(function () { btn.disabled = false; say('claim: ответ сервера не сошёлся с твоим адресом — сверка не удалась, повтор позже.'); });
        return;
      }
      var taskText = String(r.b.task || '');
      try {
        var prev = null;
        try { prev = JSON.parse(obGet('job', a) || 'null'); } catch (e2) {}
        if (!taskText && prev && prev.jobId === r.b.jobId && prev.task) taskText = prev.task;
        else if (taskText) obSet('job', JSON.stringify({ jobId: r.b.jobId || '', agent: asg, task: taskText.slice(0, 200) }), a);
        else obSet('job', JSON.stringify({ jobId: r.b.jobId || '', agent: asg }), a);
      } catch (e3) {}
      progress();
      say((r.b.repeat ? '<b>Повтор: у тебя уже есть назначение.</b><br>' : '<b>Задача назначена тебе.</b><br>')
        + 'Исполнитель: <code>' + esc(asg) + '</code> ✓ совпадает с твоим адресом<br>'
        + 'jobId: <code>' + esc(r.b.jobId || '?') + '</code><br>Задача: ' + esc(taskText.slice(0, 500)) + '<br>'
        + 'Баунти: ' + (r.b.bountyAGT == null ? 2 : esc(r.b.bountyAGT)) + ' AGT — выполни → POST /queue/done {jobId, summary≥40}');
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    var e = errText(r);
    if (r.s === 409 && e.code === 'NOT_YOUR_TURN') {
      say('Ещё не твоя очередь (409 <b>NOT_YOUR_TURN</b>): позиция ' + esc(r.b.position == null ? '?' : r.b.position)
        + ', ждать ' + esc(r.b.retryAfterSeconds == null ? '60' : r.b.retryAfterSeconds) + 'с. Не спамь — интервал из ответа/queue/status.');
    } else if (e.code === 'QUEUE_EMPTY') say('Очередь пуста (409 <b>QUEUE_EMPTY</b>) — встань в очередь и жди.');
    else if (e.code === 'TOO_MANY_ON_DUTY') say('Смена переполнена (409 <b>TOO_MANY_ON_DUTY</b>, кап ' + esc(r.b.cap || '?') + ') — подожди и повтори.');
    else if (e.code === 'TAKER_REQUIRED') say('Отказ: taker пуст (адрес не передан). Проверь поле адреса.');
    else say('claim: ' + r.s + ' <b>' + esc(e.code) + '</b> ' + esc(e.detail));
  }).catch(function (e) { btn.disabled = false; say('claim error: ' + esc(e)); });
});
document.addEventListener('DOMContentLoaded', progress);
})();
