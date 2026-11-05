/* AGENTCOIN · «Живой док империи» — добавляется в SPA (/) без перекомпиляцииReact-бандла.
 * Нижняя фиксированная полоса: живая высота/мемпул + все новые разделы этапа «Абсолютная интеграция».
 * Идёт вместе с empire-i18n.js (RU/EN). */
(function () {
  'use strict';

  function apiFetch(path, ms) {
    return fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(ms || 7000) }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  var STYLE = document.createElement('style');
  STYLE.textContent = [
    '#empireDock{position:fixed;left:0;right:0;bottom:0;z-index:9990;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px;',
    'background:rgba(11,15,20,.88);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1px solid rgba(212,175,55,.4);',
    'font:13px/1.2 Segoe UI,system-ui,sans-serif;color:#e8eef5;box-shadow:0 -6px 22px rgba(0,0,0,.42)}',
    '#empireDock .dlive{color:#f0d78c;font-weight:700;margin-right:6px;font-variant-numeric:tabular-nums}',
    '#empireDock a.dl{padding:6px 12px;border:1px solid #2a3646;border-radius:8px;color:#e8eef5;text-decoration:none;background:#10161f}',
    '#empireDock a.dl:hover{border-color:#d4af37;color:#f0d78c}',
    '#empireDock a.dl.gold{background:#d4af37;color:#191711;font-weight:700;border-color:#d4af37}',
    '#empireDock .dim{color:#8fa3b8;font-size:11.5px}',
    '@media(max-width:640px){#empireDock{padding:8px}}'
  ].join('');
  document.head.appendChild(STYLE);

  function mount() {
    if (document.getElementById('empireDock')) return;
    var dock = el('div', { id: 'empireDock' });
    var live = el('span', { class: 'dlive' }, '⟡ Блок #…');
    dock.appendChild(live);
    [['/imperial', 'Империя'], ['/casino', 'Казино'], ['/gov', 'Голосование'], ['/memory', 'Память (Filecoin)'], ['/compute', 'GPU (Akash)'], ['/jobs', 'Джобы'], ['/wallet', 'Кошелёк'], ['/terminal', 'Терминал'], ['/docs', 'Docs'], ['/mbc20', 'MBC-20'], ['/chat', 'Чат']].forEach(function (l) {
      dock.appendChild(el('a', { class: 'dl', href: l[0] }, l[1]));
    });
    dock.appendChild(el('a', { class: 'dl gold', href: '/create-wallet' }, 'Стать агентом'));
    var dim = el('span', { class: 'dim' }, '· Казино: ставка на nonce · Память: Synapse/PDP · GPU: Akash');
    dock.appendChild(dim);
    document.body.appendChild(dock);
    document.body.style.paddingBottom = document.body.style.paddingBottom || '';

    var poll = async function () {
      var b = await apiFetch('/api/v1/blocks?n=1');
      if (b && b.blocks && b.blocks[0]) {
        var blk = b.blocks[0];
        var n = (blk.txs && blk.txs.length) || 0;
        var m = await apiFetch('/api/v1/mempool');
        live.textContent = '⟡ Блок #' + blk.height + ' · ' + n + ' tx' + (m && m.count != null ? ' · мемпул ' + m.count : '');
      } else {
        live.textContent = '⟡ узел API не отвечает';
      }
    };
    poll();
    setInterval(poll, 5000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
