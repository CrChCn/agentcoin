'use strict';
const $ = (id) => document.getElementById(id);
const state = {
  summary: null,
  nodes: [],
  consensus: null,
  operators: [],
  history: null,
  indexers: [],
  events: [],
  lastSeq: 0,
  tab: 'overview',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (id) => (id ? String(id).slice(0, 6) + '…' + String(id).slice(-4) : '—');
const num = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('ru-RU') : '—');
const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}с`;
  if (s < 3600) return `${Math.round(s / 60)}м`;
  if (s < 86400) return `${Math.round(s / 3600)}ч`;
  return `${Math.round(s / 86400)}д`;
};
const statusPill = (s) => `<span class="pill ${s === 'online' ? 'ok' : s === 'stale' ? 'warn' : 'bad'}">${esc(s)}</span>`;

async function api(kind, query = '') {
  const res = await fetch(`/api/v1/network/${kind}${query}`, { cache: 'no-store' });
  const doc = await res.json();
  if (!doc || !doc.data) throw new Error(doc && doc.error ? doc.error : 'bad_response');
  return doc;
}

async function loadAll() {
  try {
    const [summary, nodes, consensus, operators, history, indexers] = await Promise.all([
      api('summary'), api('nodes'), api('consensus'), api('operators'), api('history', '?limit=120'), api('indexers'),
    ]);
    state.summary = summary.data;
    state.nodes = nodes.data.nodes || [];
    state.consensus = consensus.data;
    state.operators = operators.data.operators || [];
    state.history = history.data;
    state.indexers = indexers.data.indexers || [];
    state.lastSeq = summary.data.events ? summary.data.events.seq : state.lastSeq;
    render();
  } catch (e) {
    $('live').textContent = `API: ${e.message}`;
    $('live').className = 'bad';
  }
}

function render() {
  const s = state.summary || {};
  const nodes = state.nodes || [];
  const live = nodes.filter((n) => n.status === 'online');
  $('genesis').textContent = `genesis ${s.genesisHash ? short(s.genesisHash) : '—'}`;
  $('dot').style.background = s.consensus && s.consensus.status === 'CONSISTENT' ? '#3ddc97' : '#f2c14e';
  $('counters').innerHTML = [
    ['нод', num(s.nodes)], ['онлайн', num(s.online)], ['ready', num(s.ready)],
    ['публичных', num(s.publicReachable)], ['за NAT', num(s.behindNat)],
    ['операторов', num(s.operators)], ['регионов', num(s.regions)],
    ['блоков', num(s.height)], ['форков', num(s.forks)],
  ].map(([label, value]) => `<div class="counter"><b>${value}</b><span>${label}</span></div>`).join('');

  renderConsensus();
  renderSources();
  renderNodes();
  renderOperators();
  renderSync();
  renderVersions();
  renderForks();
  renderHistory();
  renderIncidents();
  renderMap();
  renderLog();

  const c = s.consensus || {};
  $('live').textContent = `SSE: ${state.events.length} событий · консенсус ${c.status || '—'} · обновлено ${new Date().toLocaleTimeString('ru-RU')}`;
  $('live').className = c.status === 'CONSISTENT' ? 'ok' : 'warn';
}

function renderConsensus() {
  const c = state.consensus || {};
  const s = state.summary || {};
  const counts = (s.versions || {});
  $('consensus').innerHTML = `
    <div class="row" style="margin-bottom:8px">
      <span class="pill ${c.status === 'CONSISTENT' ? 'ok' : 'warn'}">${esc(c.status || '—')}</span>
      <span class="dim">indexer-ов онлайн: ${num(c.indexers ? c.indexers.filter((i) => i.ok).length : 0)}/${num(c.indexers ? c.indexers.length : 0)}</span>
      <span class="dim">расхождений: ${num(c.disagreements ? c.disagreements.length : 0)}</span>
    </div>
    <table><thead><tr><th>Правило</th><th>Значение</th></tr></thead><tbody>
      <tr><td>Высота (max)</td><td class="mono">${num(s.height)}</td></tr>
      <tr><td>Версии</td><td class="mono">${Object.entries(counts).map(([v, n]) => `${esc(v)} × ${n}`).join(' · ') || '—'}</td></tr>
      <tr><td>Разные высоты</td><td>LAGGING / ADVANCED (не форк)</td></tr>
      <tr><td>Разный hash на одной высоте</td><td>DIVERGENT / FORK</td></tr>
      <tr><td>Готовность</td><td>${esc((c.rules && c.rules.ready || []).join(' · '))}</td></tr>
    </tbody></table>
    ${(c.widget === undefined && c.agreement) ? `<div class="dim" style="margin-top:8px;font-size:12px">multi-observed: ${num(c.agreement.multiObserved)} · public: ${num(c.agreement.publicReachable)} · ready: ${num(c.agreement.ready)}</div>` : ''}`;
}

function renderSources() {
  const list = state.indexers.length ? state.indexers : (state.summary && state.summary.indexers ? state.summary.indexers.sources : []);
  $('sources').innerHTML = list.length ? `<table><thead><tr><th>indexer</th><th>URL</th><th>наблюдений</th><th>статус</th></tr></thead><tbody>
    ${list.map((i) => `<tr><td class="mono">${short(i.indexerId || i.id)}</td><td class="mono">${esc(i.url)}</td>
      <td>${num(i.observations ?? i.observations)}</td><td>${i.ok ? '<span class="pill ok">ok</span>' : `<span class="pill bad">${esc(i.error || 'down')}</span>`}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">нет источников</div>';
}

function renderNodes() {
  const rows = state.nodes.map((n) => `<tr>
    <td class="mono" title="${esc(n.nodeId)}">${short(n.nodeId)}</td>
    <td>${statusPill(n.status)}</td>
    <td><span class="pill ${n.ready ? 'ok' : ''}">${n.ready ? 'ready' : 'no'}</span></td>
    <td class="mono">${esc(n.level)}</td>
    <td class="mono">${esc(n.version || '—')}</td>
    <td class="mono">${num(n.height)}</td>
    <td class="mono">${num(n.peers)}</td>
    <td class="mono">${esc(n.natStatus || '—')}</td>
    <td>${(n.observedBy || []).length}</td>
    <td class="dim">${ago(n.lastSeen)}</td>
  </tr>`).join('');
  $('nodes').innerHTML = state.nodes.length ? `<table><thead><tr><th>nodeId</th><th>статус</th><th>готовность</th><th>уровень</th><th>версия</th><th>высота</th><th>пиры</th><th>NAT</th><th>наблюдателей</th><th>тишина</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">пока никто не наблюдался</div>';
}

function renderOperators() {
  const rows = state.operators.map((o) => `<tr><td class="mono">${short(o.operatorId)}</td><td>${esc(o.name)}</td>
    <td>${o.nodeCount}</td><td>${esc(o.region || '—')}</td><td class="mono">${short(o.keyId)}</td></tr>`).join('');
  $('operators').innerHTML = state.operators.length ? `<table><thead><tr><th>оператор</th><th>имя</th><th>нод</th><th>регион</th><th>ключ</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">паспортов операторов нет — ноды остаются ниже уровня INDEPENDENT_OPERATOR</div>';
}

function renderSync() {
  const s = state.summary || {};
  const rows = state.nodes.map((n) => {
    const lag = s.height != null && n.height != null ? s.height - n.height : null;
    return `<tr><td class="mono">${short(n.nodeId)}</td><td class="mono">${num(n.height)}</td>
      <td class="mono ${lag > 0 ? 'warn' : 'ok'}">${lag == null ? '—' : lag}</td>
      <td class="mono">${esc(n.tipHash ? short(n.tipHash) : '—')}</td>
      <td>${statusPill(n.status)}</td><td>${(n.observedBy || []).length}</td></tr>`;
  }).join('');
  $('sync').innerHTML = `<div class="row" style="margin-bottom:8px"><span class="dim">Высота сети:</span> <b class="mono">${num(s.height)}</b>
    <span class="dim">· ready:</span> <b>${num(s.ready)}</b></div>
    <table><thead><tr><th>нода</th><th>высота</th><th>лаг</th><th>tip</th><th>статус</th><th>подтвердили</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderVersions() {
  const groups = {};
  for (const n of state.nodes) {
    const v = n.version || 'unknown';
    if (!groups[v]) groups[v] = { total: 0, outdated: 0 };
    groups[v].total++;
    if (n.outdated) groups[v].outdated++;
  }
  const latest = Object.keys(groups).sort().reverse()[0];
  const rows = Object.entries(groups).map(([v, g]) => `<tr><td class="mono">${esc(v)}</td><td>${g.total}</td>
    <td>${v === latest ? '<span class="pill ok">актуальна</span>' : '<span class="pill warn">устарела</span>'}</td></tr>`).join('');
  $('versions').innerHTML = `<table><thead><tr><th>версия</th><th>нод</th><th>статус</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="empty">нет данных</td></tr>'}</tbody></table>`;
}

function renderForks() {
  const forks = (state.consensus && state.consensus.forks) || [];
  $('forks').innerHTML = forks.length ? `<table><thead><tr><th>высота</th><th>ветки (hash × ноды)</th></tr></thead><tbody>
    ${forks.map((f) => `<tr><td class="mono">${num(f.height)}</td><td class="mono">${f.branches.map((b) => `${esc(short(b.hash))} × ${b.nodeIds.length}`).join(' · ')}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">активных форков нет</div>';
}

function renderHistory() {
  const timeline = (state.history && state.history.timeline) || [];
  const rows = timeline.slice(-80).reverse().map((e) => `<tr><td class="dim">${esc(new Date(e.at).toLocaleString('ru-RU'))}</td>
    <td class="mono">${short(e.nodeId)}</td><td class="mono">${num(e.height)}</td><td class="mono">${esc(e.version || '—')}</td>
    <td class="mono">${esc(e.level || '—')}</td><td>${statusPill(e.status || 'online')}</td></tr>`).join('');
  $('history').innerHTML = rows ? `<table><thead><tr><th>время</th><th>нода</th><th>высота</th><th>версия</th><th>уровень</th><th>статус</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">история пуста</div>';
}

function renderIncidents() {
  const list = (state.history && state.history.incidents) || [];
  $('incidents').innerHTML = list.length ? `<table><thead><tr><th>время</th><th>тип</th><th>детали</th></tr></thead><tbody>
    ${list.slice().reverse().map((i) => `<tr><td class="dim">${esc(new Date(i.at).toLocaleString('ru-RU'))}</td><td class="mono">${esc(i.incident || i.type)}</td><td class="mono">${esc(JSON.stringify(i.detail || {}).slice(0, 160))}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">инцидентов нет</div>';
}

function renderMap() {
  const svg = $('map');
  const W = svg.clientWidth || 900, H = 420, cx = W / 2, cy = H / 2;
  const nodes = state.nodes;
  const indexers = (state.consensus && state.consensus.indexers ? state.consensus.indexers.filter((i) => i.ok) : []);
  const parts = [];
  const idxPos = new Map();
  indexers.forEach((idx, i) => {
    const a = (Math.PI * 2 * i) / Math.max(1, indexers.length) - Math.PI / 2;
    const r = Math.min(W, H) * 0.13;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    idxPos.set(idx.indexerId, { x, y });
  });
  nodes.forEach((n, i) => {
    const a = (Math.PI * 2 * i) / Math.max(1, nodes.length) - Math.PI / 2;
    const r = Math.min(W, H) * 0.37;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    for (const obs of n.observedBy || []) {
      const p = idxPos.get(obs);
      if (p) parts.push(`<line x1="${p.x}" y1="${p.y}" x2="${x}" y2="${y}" stroke="#2b3d52" stroke-width="1"/>`);
    }
    const color = n.ready ? '#3ddc97' : n.status === 'online' ? '#f2c14e' : '#ff617e';
    const size = 5 + Math.min(5, (n.observedBy || []).length);
    parts.push(`<circle cx="${x}" cy="${y}" r="${size}" fill="${color}" opacity=".9"><title>${esc(n.nodeId)} · ${esc(n.level)} · h=${esc(n.height)}</title></circle>`);
    parts.push(`<text x="${x + size + 4}" y="${y + 3}" fill="#7f95aa" font-size="9" font-family="Consolas,monospace">${esc(short(n.nodeId))}</text>`);
  });
  for (const [id, p] of idxPos) {
    parts.push(`<rect x="${p.x - 6}" y="${p.y - 6}" width="12" height="12" rx="2" fill="#5aa2ff"><title>indexer ${esc(id)}</title></rect>`);
  }
  if (!nodes.length) parts.push(`<text x="${cx}" y="${cy}" fill="#7f95aa" font-size="13" text-anchor="middle">нет наблюдаемых нод</text>`);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join('');
}

function renderLog() {
  $('log').innerHTML = state.events.slice(-60).reverse().map((e) =>
    `<div><span class="dim">${esc(new Date(e.at).toLocaleTimeString('ru-RU'))}</span> <b>${esc(e.type)}</b> ${esc(JSON.stringify(e.data).slice(0, 180))}</div>`
  ).join('') || '<span class="dim">событий пока нет</span>';
}

let scheduled = null;
function schedule(event) {
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  if (scheduled) return;
  scheduled = setTimeout(() => { scheduled = null; loadAll(); }, 500);
}

function connectSse() {
  const es = new EventSource('/api/v1/network/events');
  es.addEventListener('snapshot', () => loadAll());
  const types = ['node.discovered', 'node.handshake', 'node.sync_progress', 'node.ready', 'node.stale', 'node.offline', 'peer.connected', 'peer.disconnected', 'fork.detected', 'fork.resolved', 'version.outdated', 'incident', 'indexer.online', 'indexer.offline', 'update.applied', 'update.rolled_back'];
  for (const type of types) {
    es.addEventListener(type, (ev) => {
      try {
        const data = JSON.parse(ev.data);
        state.events.push({ type, data, at: data.at || new Date().toISOString() });
        schedule({ type, data });
      } catch { /* ignore */ }
    });
  }
  es.onerror = () => {
    $('live').textContent = 'SSE: переподключение, запрос свежего snapshot…';
    es.close();
    setTimeout(() => { connectSse(); loadAll(); }, 2000);
  };
}

for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('on', x === b);
    for (const sec of document.querySelectorAll('section[id^="tab-"]')) sec.classList.toggle('hide', sec.id !== `tab-${b.dataset.tab}`);
    state.tab = b.dataset.tab;
    if (state.tab === 'map') renderMap();
  });
}
window.addEventListener('resize', () => { if (state.tab === 'map') renderMap(); });

loadAll();
connectSse();
setInterval(() => { if (!scheduled) loadAll(); }, 5000);
