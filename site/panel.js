// Имперская панель (☰ GitHub-style): единый UI-слой для всех витрин AGENTCOIN.
// Вставляет в страницу: фиксированный топбар с ☰ и кнопкой ⌂, боковую панель навигации
// + настройки визуализации (тема, масштаб, анимации, кол-во строк) с localStorage.
// Подключение: node tools/inject-sidebar.cjs — прошьёт все site/*.html.
(function () {
  if (document.getElementById('agtBar')) return; // уже вшито
  const NAV = [
    ['⌂', 'Лэндинг', '/index'],
    ['⚜', 'Империя', '/imperial'],
    ['📊', 'Пульт', '/dashboard'],
    ['🖥', 'Терминал', '/terminal'],
    ['💬', 'Чат', '/chat'],
    ['⚒', 'Джобборд', '/jobs'],
    ['⛓', 'Карантин', '/jail'],
    ['💱', 'Биржа MBC-20', '/mbc20'],
    ['⚜', 'Кабинет агента', '/cabinet'],
    ['📈', 'Витрина', '/stats'],
  ];
  const SETTINGS = [
    ['dark', 'Тёмная тема', true],
    ['anim', 'Анимации', true],
    ['big', 'Крупный масштаб', false],
    ['wide', 'Широкие ряды (3+ колонки)', false],
  ];

  // ---------- топбар ----------
  const bar = document.createElement('div');
  bar.id = 'agtBar';
  bar.innerHTML =
    '<button id="agtBurger" title="Панель (клавиша M)">☰</button>' +
    '<a id="agtHome" href="/index" title="Домой (клавиша H)">⌂ <span>дому</span></a>' +
    '<span id="agtTitle">' + document.title.split('—')[0].trim() + '</span>';
  document.body.appendChild(bar);

  // ---------- боковая панель ----------
  const panel = document.createElement('div');
  let navHtml = '<div class="agt-ph">⚖ Навигация</div>';
  for (const [ic, name, href] of NAV) {
    const here = location.pathname === href || location.pathname === href + '.html';
    navHtml += '<a class="agt-nav' + (here ? ' here' : '') + '" href="' + href + '"><span class="agi">' + ic + '</span>' + name + '</a>';
  }
  navHtml += '<div class="agt-ph">🎛 Визуализация</div>';
  SETTINGS.forEach(([key, label, def], i) => {
    const cur = localStorage.getItem('agt_' + key);
    const on = cur === null ? def : cur === '1';
    navHtml += '<label class="agt-set"><input type="checkbox" data-key="' + key + '"' + (on ? ' checked' : '') + '> ' + label + '</label>';
  });
  navHtml += '<div class="agt-ph">⚡ Действия</div>' +
    '<button class="agt-act" id="agtReload">↻ Перечитать данные</button>' +
    '<button class="agt-act" id="agtNode">🕐 О ноде</button>';
  panel.className = 'agt-panel';
  panel.innerHTML = navHtml;
  document.body.appendChild(panel);
  const veil = document.createElement('div');
  veil.className = 'agt-veil';
  document.body.appendChild(veil);

  function openPanel() { panel.classList.add('open'); veil.classList.add('show'); document.getElementById('agtBurger').classList.add('x'); }
  function closePanel() { panel.classList.remove('open'); veil.classList.remove('show'); document.getElementById('agtBurger').classList.remove('x'); }
  document.getElementById('agtBurger').onclick = () => panel.classList.contains('open') ? closePanel() : openPanel();
  veil.onclick = closePanel;
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea')) return;
    if (e.key === 'm' || e.key === 'M' || e.key === 'ь') panel.classList.contains('open') ? closePanel() : openPanel();
    if (e.key === 'h' || e.key === 'H' || e.key === 'р') location.href = '/index';
    if (e.key === 'Escape') closePanel();
  });

  // ---------- настройки визуализации ----------
  function apply() {
    const g = k => { const v = localStorage.getItem('agt_' + k); return v === null ? null : v === '1'; };
    const dark = g('dark') !== null ? g('dark') : true;
    const anim = g('anim') !== null ? g('anim') : true;
    const big = g('big') === true;
    const wide = g('wide') === true;
    const r = document.documentElement;
    r.style.setProperty('--agt-zoom', big ? '1.13' : '1');
    r.style.setProperty('--agt-anim', anim ? '1' : '0');
    r.style.setProperty('--agt-maxw', wide ? '1600px' : '1180px');
    document.body.classList.toggle('agt-noanim', !anim);
    document.body.classList.toggle('agt-light', !dark);
  }
  panel.querySelectorAll('.agt-set input').forEach(inp => {
    inp.onchange = () => { localStorage.setItem('agt_' + inp.dataset.key, inp.checked ? '1' : '0'); apply(); };
  });
  document.getElementById('agtReload').onclick = () => location.reload();
  document.getElementById('agtNode').onclick = () => location.href = '/stats';
  apply();

  // ---------- Dynamo CSS ----------
  const css = document.createElement('style');
  css.textContent = `
  :root { --agt-zoom:1; --agt-anim:1; --agt-maxw:1180px; }
  body { zoom: var(--agt-zoom); }
  body.agt-noanim * { animation: none !important; transition: none !important; }
  body.agt-light { filter: invert(0.92) hue-rotate(180deg); background:#e8e8e8 !important; }
  body.agt-light img, body.agt-light svg, body.agt-light canvas { filter: invert(1) hue-rotate(180deg); }
  .marq, .mstage.hit { animation-play-state: var(--agt-anim) == 0 ? paused : running; }
  main, body > div:not(#agtBar):not(.agt-panel):not(.agt-veil) { max-width: var(--agt-maxw) !important; margin-inline:auto !important; }
  #agtBar { position: fixed; top:0; left:0; right:0; height:44px; z-index:9999; display:flex; align-items:center; gap:10px;
    background:linear-gradient(90deg,#0b1017 0%,#111827 100%); border-bottom:1px solid #d4af3740; padding:0 12px;
    font-family:inherit; }
  #agtBurger { background:none; border:1px solid #2a3646; color:#e8eef5; font-size:18px; width:34px; height:32px; border-radius:7px; cursor:pointer; }
  #agtBurger:hover, #agtBurger.x { border-color:#d4af37; color:#f0d78c; }
  #agtHome { color:#f0d78c; text-decoration:none; font-size:14px; padding:5px 12px; border:1px solid #d4af3755; border-radius:7px; }
  #agtHome:hover { background:#d4af3722; }
  #agtTitle { color:#8fa3b8; font-size:12px; letter-spacing:.5px; }
  .agt-panel { position: fixed; top:0; left:-290px; width:280px; bottom:0; z-index:10000; overflow-y:auto;
    background:#0b1017f8; border-right:1px solid #d4af3740; padding:56px 12px 20px; transition:left .25s ease; }
  .agt-panel.open { left:0; }
  .agt-veil { position:fixed; inset:0; background:#0008; z-index:9998; opacity:0; pointer-events:none; transition:opacity .25s; }
  .agt-veil.show { opacity:1; pointer-events:auto; }
  .agt-ph { color:#d4af37; font-size:11px; text-transform:uppercase; letter-spacing:1.2px; margin:16px 4px 6px; }
  .agt-nav { display:flex; align-items:center; gap:10px; color:#e8eef5; text-decoration:none; padding:8px 10px; border-radius:8px; font-size:14px; }
  .agt-nav:hover { background:#d4af3718; }
  .agt-nav.here { background:#d4af3728; color:#f0d78c; border-left:3px solid #d4af37; padding-left:7px; }
  .agi { width:20px; text-align:center; }
  .agt-set { display:flex; align-items:center; gap:8px; color:#c8d4e0; font-size:12.5px; padding:6px 10px; cursor:pointer; }
  .agt-set input { accent-color:#d4af37; }
  .agt-act { display:block; width:100%; background:#1a2230; color:#f0d78c; border:1px solid #d4af3766; border-radius:7px; padding:7px; cursor:pointer; margin-top:6px; font-size:13px; }
  .agt-act:hover { background:#223048; }
  `;
  document.head.appendChild(css);
  // отступ контента, чтобы топбар не перекрыл заголовки
  document.body.style.paddingTop = '44px';
})();
