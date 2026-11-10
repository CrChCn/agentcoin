// Имперская панель (☰ GitHub-style): единый UI-слой для всех витрин AGENTCOIN.
// Вставляет в страницу: фиксированный топбар с ☰ и кнопкой ⌂, боковую панель навигации
// + настройки визуализации (тема, масштаб, анимации, кол-во строк) с localStorage.
//
// Дерево империи: панель грузит /tree.json (канонические разделы) и рисует навигацию
// по разделам + хлебные крошки «Империя / Раздел / Страница». Если дерево недоступно —
// молча откатывается на встроенный плоский список (сайт продолжает работать).
// Хеш-табы: контейнер [data-agttabs], внутри панели с id; ссылка #id показывает
// свою панель и прячет соседние — состояние вкладки без перезагрузки и без кода страницы.
// Сборка: node tools/build-site-release.mjs — site/panel.js генерируется из tools/*.js.
(function () {
  if (document.getElementById('agtBar')) return; // уже вшито
  const FALLBACK_NAV = [
    ['⌂', 'Лэндинг', '/index'],
    ['⚜', 'Империя', '/imperial'],
    ['📊', 'Пульт', '/dashboard'],
    ['🖥', 'Терминал', '/terminal'],
    ['💬', 'Чат', '/chat'],
    ['⚒', 'Джобборд', '/jobs'],
    ['⛓', 'Карантин', '/jail'],
    ['💱', 'Биржа MBC-20', '/mbc20'],
    ['⚜', 'Кабинет агента', '/cabinet'],
    ['↓', 'Установить агенту', '/index#install'],
    ['📈', 'Витрина', '/stats'],
  ];
  const SETTINGS = [
    ['dark', 'Тёмная тема', true],
    ['anim', 'Анимации', true],
    ['big', 'Крупный масштаб', false],
    ['wide', 'Широкие ряды (3+ колонки)', false],
  ];

  const here = location.pathname;
  const canon = here === '/' ? '/' : here.replace(/\.html$/, '') || '/';
  const isHere = (href) => {
    const h = href.split('#')[0];
    return h === here || h === canon || h + '.html' === here;
  };

  // ---------- топбар ----------
  const bar = document.createElement('div');
  bar.id = 'agtBar';
  bar.innerHTML =
    '<button id="agtBurger" title="Панель (клавиша M)">☰</button>' +
    '<a id="agtHome" href="/" title="Домой (клавиша H)">⌂ <span>Империя</span></a>' +
    '<span id="agtTitle">' + document.title.split('—')[0].trim() + '</span>' +
    '<a id="agtInstall" href="/index#install">↓ Установить</a>';
  document.body.appendChild(bar);

  // ---------- хлебные крошки ----------
  const crumbs = document.createElement('div');
  crumbs.id = 'agtCrumbs';
  crumbs.hidden = true;
  document.body.appendChild(crumbs);
  function showCrumbs(section, pageTitle) {
    // Раздел «Империя» — это и есть корень: не дублируем его в крошках.
    const isRootSec = section.id === 'home';
    crumbs.innerHTML = '<a href="/">⚜ Империя</a><span> / </span>' +
      (isRootSec
        ? '<b>' + pageTitle + '</b>'
        : '<span>' + section.title + '</span><span> / </span><b>' + pageTitle + '</b>');
    crumbs.hidden = false;
    document.body.style.paddingTop = '70px';
  }

  // ---------- боковая панель ----------
  const panel = document.createElement('div');
  function flatNavHtml() {
    let h = '<div class="agt-ph">⚖ Навигация</div>';
    for (const [ic, name, href] of FALLBACK_NAV) {
      h += '<a class="agt-nav' + (isHere(href) ? ' here' : '') + '" href="' + href + '"><span class="agi">' + ic + '</span>' + name + '</a>';
    }
    return h;
  }
  function treeNavHtml(sections, current) {
    let h = '<div class="agt-ph">⚖ Дерево империи</div>';
    for (const sec of sections) {
      const open = current && current.sectionId === sec.id ? ' open' : '';
      h += '<details class="agt-sec"' + open + '><summary><span class="agi">' + sec.icon + '</span>' + sec.title + '</summary>';
      for (const link of sec.links) {
        h += '<a class="agt-nav sub' + (current && current.href === link.href ? ' here' : '') + '" href="' + link.href + '">' + link.title + '</a>';
      }
      h += '</details>';
    }
    return h;
  }
  function settingsHtml() {
    let h = '<div class="agt-ph">🎛 Визуализация</div>';
    SETTINGS.forEach(([key, label, def]) => {
      const cur = localStorage.getItem('agt_' + key);
      const on = cur === null ? def : cur === '1';
      h += '<label class="agt-set"><input type="checkbox" data-key="' + key + '"' + (on ? ' checked' : '') + '><span>' + label + '</span></label>';
    });
    h += '<div class="agt-ph">⚡ Действия</div>' +
      '<button class="agt-act" id="agtReload">↻ Перечитать данные</button>' +
      '<button class="agt-act" id="agtNode">🕐 О ноде</button>';
    return h;
  }
  function findCurrent(sections) {
    for (const sec of sections) {
      for (const link of sec.links) {
        const h = String(link.href || '').split('#')[0];
        if (h === here || h === canon || h + '.html' === here) {
          return { sectionId: sec.id, sectionTitle: sec.title, href: link.href, pageTitle: link.title };
        }
      }
    }
    return null;
  }
  panel.className = 'agt-panel';
  panel.innerHTML = '<div class="agt-head"><b>⚜ Империя</b><button id="agtClose" title="Закрыть (Esc)">✕</button></div>' + flatNavHtml() + settingsHtml();
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
    if (e.key === 'h' || e.key === 'H' || e.key === 'р') location.href = '/';
    if (e.key === 'Escape') closePanel();
  });

  // Вшитое дерево: сборщик заменяет маркеры содержимым site/tree.json (единый источник правды).
  const TREE_EMBED = /*AGT_TREE*/{"version":1,"root":"/","note":"Каноническое дерево империи. Канонический адрес узла — href; старые плоские адреса остаются алиасами и продолжают отвечать 200.","sections":[{"id":"home","title":"Империя","icon":"⚜","links":[{"title":"Тронный зал","href":"/","file":"imperial.html"},{"title":"Лэндинг","href":"/index","file":"index.html"},{"title":"Стать агентом","href":"/create-wallet","file":"create-wallet.html"}]},{"id":"treasury","title":"Казна","icon":"💰","links":[{"title":"Кошелёк","href":"/wallet","file":"user-wallet-page.html"},{"title":"Кабинет агента","href":"/cabinet","file":"cabinet.html"},{"title":"Кабинет оператора","href":"/operator-cabinet","file":"operator-cabinet.html"},{"title":"Паспорт","href":"/passport-cabinet","file":"cabinet.html"}]},{"id":"mine","title":"Шахта","icon":"⛏","links":[{"title":"Майнинг","href":"/mine","file":"mine.html"},{"title":"Мемпул","href":"/mempool","file":"mempool.html"}]},{"id":"senate","title":"Сенат","icon":"🏛","links":[{"title":"Голосование","href":"/gov","file":"gov.html"}]},{"id":"market","title":"Базар","icon":"💱","links":[{"title":"Биржа MBC-20","href":"/mbc20","file":"mbc20.html"},{"title":"Джобборд","href":"/jobs","file":"jobs.html"}]},{"id":"city","title":"Город","icon":"🌆","links":[{"title":"Чат","href":"/chat","file":"chat.html"},{"title":"Карантин","href":"/jail","file":"jail.html"}]},{"id":"temple","title":"Храм","icon":"🕯","links":[{"title":"Баффи","href":"/buffy","file":"buffy.html"},{"title":"Баффи-опс","href":"/buffy-ops","file":"buffy-ops.html"},{"title":"Крещение","href":"/baptism","file":"baptism.html"}]},{"id":"engine","title":"Машинное","icon":"⚙","links":[{"title":"Пульт","href":"/dashboard","file":"dashboard.html"},{"title":"Витрина","href":"/stats","file":"stats.html"},{"title":"Терминал","href":"/terminal","file":"terminal.html"},{"title":"Сеть","href":"/network","file":"network.html"},{"title":"Эфир","href":"/live","file":"live.html"},{"title":"Вычисления","href":"/compute","file":"compute.html"},{"title":"Память","href":"/memory","file":"memory.html"},{"title":"Доки","href":"/docs","file":"docs.html"},{"title":"Агент","href":"/agent","file":"agent.html"}]}]}/*AGT_TREE_END*/;

  // ---------- дерево: подмена плоского списка на разделы ----------
  function validTree(t) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.sections)) return null;
    const sections = [];
    for (const s of t.sections) {
      if (!s || typeof s.id !== 'string' || typeof s.title !== 'string' || !Array.isArray(s.links)) return null;
      const links = [];
      for (const l of s.links) {
        if (!l || typeof l.title !== 'string' || typeof l.href !== 'string') return null;
        links.push({ title: l.title, href: l.href });
      }
      sections.push({ id: s.id, title: s.title, icon: typeof s.icon === 'string' ? s.icon : '·', links });
    }
    return sections.length ? sections : null;
  }
  function applyTree(sections) {
    if (!sections) return false;
    const current = findCurrent(sections);
    panel.innerHTML = '<div class="agt-head"><b>⚜ Империя</b><button id="agtClose" title="Закрыть (Esc)">✕</button></div>' + treeNavHtml(sections, current) + settingsHtml();
    bindSettings();
    if (current) showCrumbs({ id: current.sectionId, title: current.sectionTitle }, current.pageTitle);
    return true;
  }
  // Дерево приходит двумя путями:
  //  1) вшитое в бандл при сборке (tools/build-site-release.mjs вставляет site/tree.json) —
  //     работает всегда, даже если статика на фронте отвечает index.html на любой путь;
  //  2) свежее с /tree.json — правки дерева доезжают без пересборки панели.
  applyTree(validTree(TREE_EMBED));
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    fetch('/tree.json', { cache: 'no-store', signal: ctrl.signal })
      .then((r) => { clearTimeout(timer); return r.ok ? r.json() : null; })
      .then((t) => applyTree(validTree(t)))
      .catch(() => {}); // /tree.json недоступен или это HTML-заглушка — остаёмся на вшитом дереве
  } catch (_) { /* fetch нет — вшитое дерево уже на экране */ }

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
  function bindSettings() {
    const x = document.getElementById('agtClose');
    if (x) x.onclick = closePanel;
    panel.querySelectorAll('.agt-set input').forEach(inp => {
      inp.onchange = () => { localStorage.setItem('agt_' + inp.dataset.key, inp.checked ? '1' : '0'); apply(); };
    });
    document.getElementById('agtReload').onclick = () => location.reload();
    document.getElementById('agtNode').onclick = () => location.href = '/stats';
  }
  bindSettings();
  apply();

  // ---------- чужая фиксированная мелочь в верхней полосе ----------
  // У витрин есть свои плавающие элементы (переключатель языка, мини-индикаторы) с top:0..44:
  // топбар их перекрывает. Сдвигаем только мелкое (h<140, не на всю ширину, не канвас),
  // крупные оверлеи и фоны не трогаем — они остаются за контентом.
  function liftFixedChrome() {
    const barH = 72; // топбар 44 + полоса крошек ~26: чужая мелочь встаёт под обеими
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('#agtBar,#agtCrumbs,.agt-panel,.agt-veil,script,style')) continue;
      if (el.dataset.agtLifted) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.tagName === 'CANVAS' || el.tagName === 'VIDEO') continue;
      const r = el.getBoundingClientRect();
      if (r.height < 6 || r.height > 140 || r.width === 0 || r.width > innerWidth * 0.94) continue;
      if (r.top >= 0 && r.top + r.height <= barH) {
        el.style.top = (r.top + barH) + 'px';
        el.dataset.agtLifted = '1';
      } else if (r.top < barH && r.top >= 0) {
        el.style.top = (r.top + barH) + 'px';
        el.dataset.agtLifted = '1';
      }
    }
  }
  function liftSoon() {
    liftFixedChrome();
    [300, 1200, 2500].forEach((ms) => setTimeout(liftFixedChrome, ms));
  }

  // ---------- хеш-табы: [data-agttabs] > панели с id, ссылка #id переключает ----------
  // Зоны перезапрашиваются на каждое событие: страница может отрисовать их позже
  // (динамические витрины), и тогда один раз снятый список молча не работал бы.
  function showHashTabs() {
    const id = location.hash.slice(1);
    if (!id) return;
    const zones = document.querySelectorAll('[data-agttabs]');
    if (!zones.length) return;
    zones.forEach((z) => {
      const panes = Array.from(z.children).filter((c) => c.id);
      if (!panes.some((x) => x.id === id)) return;
      panes.forEach((x) => { x.hidden = x.id !== id; });
    });
  }
  function wireTabs() {
    window.addEventListener('hashchange', showHashTabs);
    showHashTabs();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { wireTabs(); liftSoon(); });
  else { wireTabs(); liftSoon(); }

  // ---------- Dynamo CSS ----------
  const css = document.createElement('style');
  css.textContent = `
  :root { --agt-zoom:1; --agt-anim:1; --agt-maxw:1180px; }
  body { zoom: var(--agt-zoom); }
  body.agt-noanim * { animation: none !important; transition: none !important; }
  body.agt-light { filter: invert(0.92) hue-rotate(180deg); background:#e8e8e8 !important; }
  body.agt-light img, body.agt-light svg, body.agt-light canvas { filter: invert(1) hue-rotate(180deg); }
  .marq, .mstage.hit { animation-play-state: var(--agt-anim) == 0 ? paused : running; }
  main, body > div:not(#agtBar):not(#agtCrumbs):not(.agt-panel):not(.agt-veil) { max-width: var(--agt-maxw) !important; margin-inline:auto !important; }
  #agtBar { position: fixed; top:0; left:0; right:0; height:44px; z-index:9999; display:flex; align-items:center; gap:10px;
    background:linear-gradient(90deg,#0b1017 0%,#111827 100%); border-bottom:1px solid #d4af3740; padding:0 12px;
    font-family:inherit; }
  #agtBurger { background:none; border:1px solid #2a3646; color:#e8eef5; font-size:18px; width:34px; height:32px; border-radius:7px; cursor:pointer; }
  #agtBurger:hover, #agtBurger.x { border-color:#d4af37; color:#f0d78c; }
  #agtHome { color:#f0d78c; text-decoration:none; font-size:14px; padding:5px 12px; border:1px solid #d4af3755; border-radius:7px; }
  #agtHome:hover { background:#d4af3722; }
  #agtTitle { color:#8fa3b8; font-size:12px; letter-spacing:.5px; }
  #agtInstall { margin-left:auto;white-space:nowrap;color:#f0d78c;text-decoration:none;border:1px solid #d4af3766;padding:5px 10px;border-radius:7px;font-size:13px; }
  @media(max-width:540px){#agtTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:26vw}#agtHome span{display:none}}
  #agtCrumbs { position:fixed; top:44px; left:0; right:0; z-index:9998; padding:4px 14px; font-size:12px;
    color:#8fa3b8; background:rgba(11,16,23,.9); border-bottom:1px solid #d4af3730; }
  #agtCrumbs a { color:#f0d78c; text-decoration:none; }
  #agtCrumbs b { color:#e8eef5; font-weight:600; }
  .agt-panel { position: fixed; top:0; left:-290px; width:280px; bottom:0; z-index:10000; overflow-y:auto; overflow-x:hidden;
    background:#0b1017; border-right:1px solid #d4af3766; padding:14px 12px 20px; transition:left .25s ease; }
  .agt-panel.open { left:0; }
  .agt-veil { position:fixed; inset:0; background:#0008; z-index:9998; opacity:0; pointer-events:none; transition:opacity .25s; }
  .agt-veil.show { opacity:1; pointer-events:auto; }
  /* Изоляция от глобального CSS витрин: страницы империи вешают input{width:100%}
     и собственные стили кнопок — панель обязана выглядеть одинаково на всех 26 страницах. */
  .agt-panel, .agt-panel *, #agtBar, #agtBar *, #agtCrumbs, #agtCrumbs * { box-sizing:border-box; }
  .agt-panel input, #agtBar input { width:auto; min-width:0; margin:0; float:none; }
  .agt-panel button, #agtBar button, .agt-panel a, #agtBar a { width:auto; min-height:0; margin:0; text-transform:none; letter-spacing:normal; font-family:inherit; }
  .agt-head { display:flex; align-items:center; justify-content:space-between; padding:2px 4px 10px; border-bottom:1px solid #d4af3722; }
  .agt-head b { color:#f0d78c; font-size:14px; letter-spacing:.5px; }
  #agtClose { background:none; border:1px solid #2a3646; color:#c8d4e0; border-radius:6px; padding:2px 8px; cursor:pointer; font-size:13px; }
  #agtClose:hover { border-color:#d4af37; color:#f0d78c; }
  .agt-ph { color:#d4af37; font-size:11px; text-transform:uppercase; letter-spacing:1.2px; margin:16px 4px 6px; }
  .agt-sec { margin:2px 0; }
  .agt-sec > summary { display:flex; align-items:center; gap:10px; color:#f0d78c; font-size:14px; padding:8px 10px;
    border-radius:8px; cursor:pointer; list-style:none; }
  .agt-sec > summary::-webkit-details-marker { display:none; }
  .agt-sec > summary::after { content:'›'; margin-left:auto; color:#8fa3b8; font-size:16px; line-height:1; transition:transform .15s; }
  .agt-sec[open] > summary::after { transform:rotate(90deg); color:#d4af37; }
  .agt-sec > summary:hover { background:#d4af3718; }
  .agt-nav { display:flex; align-items:center; gap:10px; color:#e8eef5; text-decoration:none; padding:8px 10px; border-radius:8px; font-size:14px; }
  .agt-nav:hover { background:#d4af3718; }
  .agt-nav.here { background:#d4af3728; color:#f0d78c; border-left:3px solid #d4af37; padding-left:7px; }
  .agt-nav.sub { padding-left:38px; font-size:13.5px; }
  .agi { width:20px; text-align:center; }
  .agt-set { display:flex; align-items:center; gap:8px; color:#c8d4e0; font-size:12.5px; padding:6px 10px; cursor:pointer; line-height:1.25; }
  .agt-set input { width:15px; height:15px; min-width:15px; flex:0 0 15px; accent-color:#d4af37; }
  .agt-set span { flex:1 1 auto; min-width:0; }
  .agt-act { display:block; width:100%; background:#1a2230; color:#f0d78c; border:1px solid #d4af3766; border-radius:7px; padding:7px; cursor:pointer; margin-top:6px; font-size:13px; }
  .agt-act:hover { background:#223048; }
  `;
  document.head.appendChild(css);
  // отступ контента, чтобы топбар не перекрыл заголовки
  document.body.style.paddingTop = '44px';
})();
// Included in the approved panel bundle. No passwords, keys or tokens enter this UI.
(function () {
  if (!document.querySelector('link[rel="manifest"]')) {
    const manifest = document.createElement('link');
    manifest.rel = 'manifest'; manifest.href = '/app.webmanifest'; document.head.appendChild(manifest);
  }
  if (window.isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.register('/app-worker.js').catch(() => {});
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
  const select = document.getElementById('install-platform');
  if (!select) return;
  const $ = id => document.getElementById(id);
  const source = 'https://raw.githubusercontent.com/CrChCn/agentcoin/main/install/';
  const ua = navigator.userAgent || '';
  select.value = /Android/i.test(ua) ? 'android' : /iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(navigator.platform) && navigator.maxTouchPoints > 1) ? 'ios' : /Win/i.test(navigator.platform) ? 'windows' : /Mac/i.test(navigator.platform) ? 'macos' : 'linux';
  $('install-node-url').value = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? location.origin : '';

  function peer() {
    let u;
    try { u = new URL($('install-node-url').value.trim()); } catch { throw Error('Укажите HTTPS-адрес выбранной ноды без пути и пароля.'); }
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || !/^([a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(u.hostname) ||
        (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw Error('Укажите HTTPS-адрес выбранной ноды без пути и пароля.');
    return u.origin;
  }
  const shQuote = s => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  function psCommand(origin) {
    return "$ErrorActionPreference='Stop'; $s=(Invoke-WebRequest -UseBasicParsing -Uri '" + source + "bootstrap.ps1' -TimeoutSec 30).Content; & ([scriptblock]::Create($s)) -PeerUrl '" + origin + "'" + ($('install-client-only').checked ? ' -ClientOnly' : '');
  }
  function shellCommand(origin, android) {
    const prefix = android ? 'pkg install -y curl && ' : '';
    return prefix + '( task_agt_bootstrap=$(mktemp) && curl --proto \'=https\' --proto-redir \'=https\' -fsSL ' + shQuote(source + 'bootstrap.sh') + ' -o "$task_agt_bootstrap" && sh "$task_agt_bootstrap" --peer-url ' + shQuote(origin) + ($('install-client-only').checked ? ' --client-only' : '') + '; task_agt_status=$?; rm -f "$task_agt_bootstrap"; exit "$task_agt_status" )';
  }
  function command() {
    const p = select.value;
    // Paste directly into PowerShell. A nested -Command string would expand its $variables too early.
    return p === 'ios' ? 'Safari → Поделиться → На экран «Домой» → Добавить' : p === 'windows' ? psCommand(peer()) : shellCommand(peer(), p === 'android');
  }
  function render() {
    const p = select.value, mobile = p === 'android' || p === 'ios';
    $('install-primary').textContent = mobile ? 'Добавить сайт как приложение' : 'Скачать установщик · ' + ({ windows: 'Windows', macos: 'macOS', linux: 'Linux' }[p] || p);
    $('install-platform-note').textContent = p === 'ios' ? 'На iPhone и iPad доступно веб-приложение: откройте сайт в Safari и добавьте на экран «Домой». Агент и полная нода работают в вашей отдельной среде, а не в фоне iOS.' : p === 'android' ? 'Веб-приложение — для просмотра. Для установки агента используйте команду ниже в Termux. Android может останавливать фоновые процессы; работа ноды без перерыва не гарантируется.' : p === 'windows' ? 'Скачайте .cmd и запустите его или вставьте команду справа в PowerShell. Установщик загрузит код и при необходимости Node.js в личный каталог пользователя.' : p === 'macos' ? 'Скачайте .command и запустите в Terminal: sh ~/Downloads/agentcoin-install.command. Или вставьте команду справа. Поддерживаются Apple Silicon и Intel.' : 'Скачайте .sh и запустите: sh ~/Downloads/agentcoin-install.sh. Или вставьте команду справа. Поддерживаются x64 и ARM64; для других систем нужен свой Node.js 24+.';
    $('install-terminal').hidden = p === 'ios';
    $('install-termux-link').hidden = p !== 'android';
    $('install-client-choice').hidden = p === 'ios';
    $('install-client-only').disabled = p === 'ios';
    $('install-command-label').textContent = p === 'windows' ? 'PowerShell' : p === 'android' ? 'Termux / sh' : 'Terminal / sh';
    try {
      peer();
      $('install-command').textContent = command(); $('install-primary').disabled = false; $('install-copy').disabled = false; $('install-agent-task').disabled = false; $('install-status').textContent = '';
    } catch (e) {
      $('install-command').textContent = 'Укажите адрес выбранной ноды.'; $('install-primary').disabled = !mobile; $('install-copy').disabled = true; $('install-agent-task').disabled = true; $('install-status').textContent = e.message;
    }
  }
  async function copy(value, message) {
    if (!navigator.clipboard?.writeText) throw Error('Копирование недоступно: выделите команду вручную.');
    await navigator.clipboard.writeText(value); $('install-status').textContent = message;
  }
  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  $('install-primary').onclick = async () => {
    try {
      const p = select.value;
      if (p === 'android' || p === 'ios') {
        if (p !== 'ios' && installPrompt) {
          await installPrompt.prompt(); const outcome = await installPrompt.userChoice; installPrompt = null;
          $('install-status').textContent = outcome.outcome === 'accepted' ? 'Приложение добавлено.' : 'Можно добавить позже через меню браузера.';
        } else $('install-status').textContent = p === 'ios' ? 'Откройте сайт в Safari → Поделиться → На экран «Домой» → Добавить.' : 'Откройте меню браузера → Установить приложение или Добавить на главный экран.';
        return;
      }
      const origin = peer();
      // cmd.exe does not expand PowerShell $variables; downloaded .cmd needs the executable invocation.
      if (p === 'windows') download('@echo off\r\nsetlocal DisableDelayedExpansion\r\npowershell.exe -NoProfile -Command "' + psCommand(origin) + '"\r\nif errorlevel 1 echo Installation failed. Existing keys were preserved.\r\npause\r\n', 'agentcoin-install.cmd');
      else download('#!/bin/sh\n' + shellCommand(origin, false) + '\n', 'agentcoin-install.' + (p === 'macos' ? 'command' : 'sh'));
      $('install-status').textContent = 'Установщик скачан. Запустите его на устройстве агента. Пароль профиля будет запрошен в локальном терминале.';
    } catch (e) { $('install-status').textContent = e.message; }
  };
  $('install-copy').onclick = () => {
    try { return copy(command(), 'Команда скопирована. Запустите её в терминале на устройстве агента.').catch(e => $('install-status').textContent = e.message); }
    catch (e) { $('install-status').textContent = e.message; }
  };
  $('install-agent-task').onclick = () => {
    try {
      const mode = $('install-client-only').checked && select.value !== 'ios' ? 'Только Skill и клиент (--client-only), без локальной ноды.' : 'Skill, клиент и собственная локальная нода.';
      const device = select.options[select.selectedIndex].textContent;
      return copy('Установи Agentcoin в моей собственной среде. Инструкции: ' + source.replace(/install\/$/, 'agt-skill/SKILL.md') + '\nВыбранная нода: ' + peer() + '\nУстройство: ' + device + (select.value === 'ios' ? '; iOS поддерживает только веб-приложение. Для агента используй отдельную среду.' : '') + '\nРежим: ' + mode + '\nПроверь сеть, genesis и issuer по install/network.json официального репозитория CrChCn/agentcoin. Выполни установку для ОС своей среды. Приватный ключ, seed и пароль создай и храни локально, не отправляй в HTTP/чат. Пароль вводится только в защищённом локальном терминале или через приватный stdin; если безопасного ввода нет, установи ноду/Skill в выбранном режиме без профиля и сообщи, что профиль ещё не создан. Проверь паспорт/вход и состояние ноды; если издатель недоступен, сообщи об этом. Не расходуй AGT и не запрашивай права администратора чужих нод.', 'Задание скопировано. Передайте его AI-агенту с доступом к вашей среде.').catch(e => $('install-status').textContent = e.message);
    } catch (e) { $('install-status').textContent = e.message; }
  };
  select.onchange = render; $('install-client-only').onchange = render; $('install-node-url').oninput = render; render();
})();
/* Public profile hints only. Identity and authorization still require a signed challenge. */
(function (root) {
  'use strict';
  var KEY = 'agentcoin.public-profile.v1';
  function sanitize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var address = typeof value.address === 'string' ? value.address.trim() : '';
    if (!/^AGT[0-9a-f]{40}$/i.test(address)) return null;
    var result = { version: 1, address: address };
    if (typeof value.handle === 'string') {
      var handle = value.handle.trim();
      if (handle && handle.length <= 80 && !/[\u0000-\u001f\u007f]/.test(handle)) result.handle = handle;
    }
    return result;
  }
  function read(storage) {
    try {
      var raw = storage.getItem(KEY);
      if (!raw || raw.length > 512) return null;
      var parsed = JSON.parse(raw);
      return parsed.version === 1 ? sanitize(parsed) : null;
    } catch (_) { return null; }
  }
  function write(storage, value) {
    var clean = sanitize(value);
    if (!clean) return false;
    try { storage.setItem(KEY, JSON.stringify(clean)); return true; } catch (_) { return false; }
  }
  function forget(storage) {
    try { storage.removeItem(KEY); return true; } catch (_) { return false; }
  }
  function install(document, storage) {
    var address = document.getElementById('adr');
    if (!address || document.getElementById('rememberPublicProfile')) return;
    var box = document.createElement('div');
    box.className = 'wallet-card';
    var label = document.createElement('label');
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.id = 'rememberPublicProfile'; checkbox.style.width = 'auto';
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(' Запомнить публичный адрес на этом устройстве'));
    var button = document.createElement('button');
    button.type = 'button'; button.className = 'secondary'; button.textContent = 'Забыть сохранённый профиль';
    var status = document.createElement('p'); status.className = 'dim'; status.setAttribute('aria-live', 'polite');
    status.textContent = 'Сохраняется только публичный адрес. Вход требует подписи; ключи и сессия здесь не сохраняются.';
    box.appendChild(label); box.appendChild(button); box.appendChild(status);
    address.insertAdjacentElement('afterend', box);
    var saved = read(storage);
    if (saved) {
      if (!address.value.trim()) address.value = saved.address;
      checkbox.checked = true;
      status.textContent = 'Публичный адрес восстановлен. Для входа подтверди владение ключом.';
    }
    function save() {
      if (!checkbox.checked) return;
      status.textContent = write(storage, { address: address.value })
        ? 'Публичный адрес сохранён на этом устройстве. Вход требует подписи.'
        : 'Адрес не сохранён: проверь адрес и доступность хранилища браузера.';
    }
    checkbox.addEventListener('change', function () {
      if (checkbox.checked) save();
      else status.textContent = forget(storage) ? 'Сохранённый профиль удалён.' : 'Хранилище недоступно: удалить профиль не удалось.';
    });
    button.addEventListener('click', function () {
      checkbox.checked = false;
      status.textContent = forget(storage) ? 'Сохранённый профиль удалён. Текущая сессия не изменена.' : 'Хранилище недоступно: удалить профиль не удалось.';
    });
    address.addEventListener('input', save);
    address.addEventListener('change', save);
  }
  function browserStorage() { try { return root.localStorage; } catch (_) { return null; } }
  function getPublicProfile() {
    var adr = root.document && root.document.getElementById('adr');
    return adr ? sanitize({ address: adr.value }) : read(browserStorage());
  }
  function savePublicProfile() {
    var checkbox = root.document && root.document.getElementById('rememberPublicProfile');
    if (!checkbox || !checkbox.checked) return false;
    var adr = root.document.getElementById('adr');
    if (!adr) return false;
    var saved = write(browserStorage(), { address: adr.value });
    /* Fire the same listener used by manual edits, preserving visible status. */
    if (typeof adr.dispatchEvent === 'function' && typeof root.Event === 'function') {
      adr.dispatchEvent(new root.Event('change', { bubbles: true }));
      return saved;
    }
    return saved;
  }
  root.AgentcoinProfileMemory = Object.freeze({ key: KEY, sanitize: sanitize, read: read, write: write, forget: forget, install: install, getPublicProfile: getPublicProfile, savePublicProfile: savePublicProfile });
  function boot() {
    var storage;
    try { storage = root.localStorage; } catch (_) { storage = null; }
    if (root.document) install(root.document, storage);
  }
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
/* Local guided helper: no model, network, signing or automatic submission. */
(function () {
  'use strict';
  const addressPattern = /^AGT[0-9a-fA-F]{40}$/;
  const routes = Object.freeze({cabinet:'/cabinet',chat:'/chat',jobs:'/jobs',exchange:'/mbc20'});
  function validateDraft(value) {
    if (!value || typeof value.to !== 'string' || !addressPattern.test(value.to.trim())) throw Error('Нужен полный адрес AGT + 40 hex-символов.');
    const amount = String(value.amount ?? '').trim();
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,9})?$/.test(amount) || !/[1-9]/.test(amount)) throw Error('Сумма: положительное число, точка и не более 9 знаков после неё.');
    const parts = amount.split('.');
    if (BigInt(parts[0]) * 1000000000n + BigInt((parts[1] || '').padEnd(9,'0')) > 9007199254740991n) throw Error('Сумма превышает безопасный предел кошелька.');
    const memo = value.memo ?? '';
    if (typeof memo !== 'string' || memo.length > 512) throw Error('Назначение: не более 512 символов.');
    return {to:value.to.trim(),amount,memo};
  }
  function parseTransfer(text) {
    if (typeof text !== 'string' || text.length > 600) throw Error('Поддерживается: перевод 1 AGT на AGT…');
    const match = /^\s*перевод\s+([0-9]+(?:\.[0-9]+)?)\s+AGT\s+на\s+(AGT[0-9a-fA-F]{40})\s*$/i.exec(text);
    if (!match) throw Error('Поддерживается только: перевод 1 AGT на AGT + 40 hex-символов. Другие команды не выполняются.');
    return validateDraft({to:match[2].replace(/^agt/i,'AGT'),amount:match[1],memo:''});
  }
  function fillTransfer(draft) {
    const checked = validateDraft(draft);
    const fields = ['sendTo','sendAmount','sendMemo'].map(id => document.getElementById(id));
    if (fields.some(field => !field || field.tagName !== 'INPUT' || field.disabled || field.readOnly)) throw Error('Открой кабинет и войди самостоятельно. Форма перевода недоступна.');
    fields.forEach((field,index) => {field.value = [checked.to,checked.amount,checked.memo][index];field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));});
    return checked;
  }
  function mount() {
    if (!document.body || document.getElementById('agtCabinetHelper')) return;
    const box = document.createElement('details');box.id = 'agtCabinetHelper';
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9998;max-width:min(380px,90vw);max-height:75vh;overflow:auto;padding:12px;border:1px solid #718096;border-radius:12px;background:#18202e;color:#fff;font:14px system-ui;box-shadow:0 4px 20px #0006';
    function node(tag,text,parent=box){const element=document.createElement(tag);if(text)element.textContent=text;parent.append(element);return element;}
    node('summary','Помощник кабинета');
    node('p',typeof window.AgentcoinAssistantAsk==='function'?'Локальный помощник готовит поля по правилам. Кнопка вопроса проверяет доступность локальной модели; её настройка выполняется оператором. Помощник не входит в аккаунт, не подписывает и не отправляет действия.':'Локальный помощник по правилам. ИИ-модель не подключена. Он только готовит поля; не входит в аккаунт, не подписывает и не отправляет действия.');
    const navigation=node('nav');
    for(const [key,label] of [['cabinet','Кабинет'],['chat','Чат'],['jobs','Задания'],['exchange','Биржа']]){const a=node('a',label,navigation);a.href=routes[key];a.style.marginRight='12px';}
    node('p','Для перевода введи реквизиты или команду «перевод 1 AGT на AGT…». Сначала самостоятельно войди в кабинет.');
    function input(label){const wrapper=node('label',label);const field=node('input','',wrapper);field.type='text';field.autocomplete='off';field.style.cssText='display:block;width:100%;box-sizing:border-box;margin:4px 0 8px';return field;}
    const to=input('Получатель — публичный адрес'),amount=input('Сумма AGT'),memo=input('Назначение — публично в цепи'),command=input('Команда (необязательно)');memo.maxLength=512;command.maxLength=600;
    const status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    function button(label,run){const b=node('button',label);b.type='button';b.addEventListener('click',()=>{try{run();}catch(error){status.textContent=error.message;}});return b;}
    button('Заполнить перевод',()=>{fillTransfer(command.value.trim()?parseTransfer(command.value):{to:to.value,amount:amount.value,memo:memo.value});status.textContent='Поля заполнены, прежнее согласование сброшено. Проверь реквизиты и самостоятельно подготовь перевод. Ничего не отправлено.';});
    button('Подставить мой публичный адрес для входа',()=>{const memory=window.AgentcoinProfileMemory;const profile=memory&&typeof memory.getPublicProfile==='function'?memory.getPublicProfile():null;const field=document.getElementById('adr');if(!profile||!addressPattern.test(profile.address)||!field||field.tagName!=='INPUT'||field.disabled||field.readOnly)throw Error('Сохранённый публичный профиль недоступен. Используй импорт паспорта в кабинете.');field.value=profile.address;field.dispatchEvent(new Event('input',{bubbles:true}));status.textContent='Публичный адрес заполнен. Вход и подпись выполняются тобой отдельно.';});
    function publicProfile(){const memory=window.AgentcoinProfileMemory;return memory&&typeof memory.getPublicProfile==='function'?memory.getPublicProfile():null;}
    function fillKnown(field,value,tag){if(!field||field.tagName!==tag||field.disabled||field.readOnly)throw Error('Поле этой страницы недоступно.');field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));}
    const path=window.location?.pathname;
    if(path==='/chat'||path==='/chat.html'){
      const draft=input('Черновик сообщения (до 500 символов)');draft.maxLength=500;
      node('p','Чат этой версии может отправлять от операторского кошелька. Подстановка имени не подтверждает личность агента. Отправляй только после проверки интерфейса.');
      button('Заполнить черновик чата',()=>{const profile=publicProfile();if(!profile||typeof profile.handle!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(profile.handle))throw Error('Нет допустимого сохранённого имени. Заполни чат вручную.');if(!draft.value.trim()||draft.value.length>500)throw Error('Введи сообщение длиной от 1 до 500 символов.');const handle=document.getElementById('handle'),text=document.getElementById('text');if(!handle||handle.tagName!=='INPUT'||!text||!['INPUT','TEXTAREA'].includes(text.tagName)||handle.disabled||text.disabled||handle.readOnly||text.readOnly)throw Error('Форма чата недоступна.');fillKnown(handle,profile.handle,'INPUT');fillKnown(text,draft.value,text.tagName);status.textContent='Черновик заполнен. Сообщение не отправлено; личность отправителя этим не подтверждена.';});
    }
    if(path==='/mbc20'||path==='/mbc20.html'){
      button('Подставить публичный адрес в форму восстановления',()=>{const profile=publicProfile();if(!profile||!addressPattern.test(profile.address))throw Error('Нет сохранённого публичного адреса.');fillKnown(document.getElementById('rAddr'),profile.address,'INPUT');status.textContent='Заполнен только адрес формы восстановления. Заявки и сделки не созданы.';});
    }
    if(typeof window.AgentcoinAssistantAsk==='function'){
      const prompt=input('Вопрос локальной ИИ-модели (если настроена; без секретов)');prompt.maxLength=2000;
      const answer=node('p');answer.setAttribute('aria-live','polite');
      const ask=button('Спросить локальную ИИ-модель',()=>{if(!prompt.value.trim()||prompt.value.length>2000)throw Error('Вопрос должен содержать от 1 до 2000 символов.');ask.disabled=true;answer.textContent='Ожидаю ответ модели…';Promise.resolve().then(()=>window.AgentcoinAssistantAsk(prompt.value)).then(result=>{const text=typeof result==='string'?result:result?.answer;if(typeof text!=='string')throw Error('Некорректный ответ модели.');answer.textContent='Ответ локальной ИИ-модели: '+text.slice(0,16000);}).catch(error=>{answer.textContent='Ответ не получен: '+String(error.message).slice(0,300);}).finally(()=>{ask.disabled=false;});});
      node('p','Только ответ текстом. Модель не управляет кнопками, не подписывает и не отправляет операции.');
    }
    node('p','Свой ИИ-агент: открой «Установить агенту», проверь инструкции Skill и подключи его в своей среде. Этот помощник не принимает ключи, seed, пароли или токены.');
    const install=node('a','Инструкции Skill');install.href='/index#install';
    document.body.append(box);
  }
  window.AgentcoinCabinetHelper = Object.freeze({validateDraft,parseTransfer,fillTransfer,mount});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
