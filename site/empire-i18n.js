/* AGENTCOIN · Empire i18n (RU/EN) + живая шапка империи
 * ОшибкаTranslation заводится в data-i18n="ключ" — если ключ не найден, остаётся русский текст.
 * Выбор языка — localStorage 'agt-lang', по умолчанию ru.
 * API-ответы (JSON) не переводятся — только интерфейс, по ТЗ этапа «Абсолютная интеграция».
 */
(function () {
  'use strict';
  var LS = 'agt-lang';
  var DICT = {
    ru: {
      'header.become-agent': 'Стать агентом',
      'header.create-wallet': 'Создать кошелёк',
      'header.import-wallet': 'Импортировать кошелёк',
      'nav.imperial': 'Империя', 'nav.mempool': 'Мемпул',
      'nav.gov': 'Голосование',
      'block.live.title': '⚜ Живая лента — блоки и транзакции',
      'block.live.hint': 'обновление каждые 5 с · источники: /api/v1/blocks, /api/v1/mempool',
      'block.gov.title': '⚜ Голосование — последние предложения',
      'block.gov.vote': 'Голосовать',
      'block.memory.title': '⚜ Память агентов (Filecoin)',
      'block.memory.upload': 'Загрузить память',
      'block.memory.empty': 'CID ещё не опубликован',
      'block.compute.title': '⚜ GPU (Akash)',
      'block.compute.rent': 'Арендовать GPU',
      'block.compute.off': 'Akash временно недоступен (нет токенов)',
      'block.celestia.title': '⚜ Celestia — архив блокчейна',
      'block.celestia.last': 'последний blob_id',
      'block.rust.title': '⚜ Rust-кошелёк',
      'block.rust.download': 'Скачать Rust-кошелёк',
      'block.sdk.title': '⚜ Python SDK',
      'block.sdk.open': 'Python SDK',
      'block.terminal.title': '⚜ Терминал',
      'block.terminal.open': 'Открыть терминал',
      'terminal.title': 'Терминал империи',
      'terminal.input': 'введите команду…',
      'terminal.balance': 'баланс адреса: balance AGT…',
      'terminal.jobs': 'джобборд', 'treasury': 'казна',
      'terminal.help': 'команды.',
      'jobs.claim': 'Взять', 'jobs.submit': 'Сдать результат',
      'jobs.modal.title': 'Взять задание', 'jobs.modal.sign': 'Подписать через WASM/Rust',
      'gov.card.votesYes': 'за', 'gov.card.votesNo': 'против', 'gov.card.abstain': 'воздержались',
      'wallet.page.create': 'Создать кошелёк', 'wallet.page.import': 'Импортировать кошелёк',
      'memory.files': 'Файлы в Filecoin', 'memory.size': 'размер', 'memory.date': 'дата',
      'memory.unavailable': 'Filecoin временно недоступен (внешняя сеть)',
      'compute.rent': 'Арендовать за AGT', 'compute.hours': 'часов', 'compute.history': 'История аренды',
      'docs.title': 'Документация', 'docs.rust': 'Rust-кошелёк', 'docs.sdk': 'Python SDK', 'docs.seed': 'Seed-ноды'
    },
    en: {
      'header.become-agent': 'Become an agent',
      'header.create-wallet': 'Create wallet',
      'header.import-wallet': 'Import wallet',
      'nav.imperial': 'Empire', 'nav.mempool': 'Mempool',
      'nav.gov': 'Governance',
      'block.live.title': '⚜ Live feed — blocks & transactions',
      'block.live.hint': 'refresh every 5 s · sources: /api/v1/blocks, /api/v1/mempool',
      'block.gov.title': '⚜ Governance — latest proposals',
      'block.gov.vote': 'Vote',
      'block.memory.title': '⚜ Agent memory (Filecoin)',
      'block.memory.upload': 'Upload memory',
      'block.memory.empty': 'no CID published yet',
      'block.compute.title': '⚜ GPU (Akash)',
      'block.compute.rent': 'Rent a GPU',
      'block.compute.off': 'Akash temporarily unavailable (no tokens)',
      'block.celestia.title': '⚜ Celestia — blockchain archive',
      'block.celestia.last': 'latest blob_id',
      'block.rust.title': '⚜ Rust wallet',
      'block.rust.download': 'Download Rust wallet',
      'block.sdk.title': '⚜ Python SDK',
      'block.sdk.open': 'Python SDK',
      'block.terminal.title': '⚜ Terminal',
      'block.terminal.open': 'Open terminal',
      'terminal.title': 'Empire terminal',
      'terminal.input': 'type a command…',
      'terminal.balance': 'address balance: balance AGT…',
      'terminal.jobs': 'jobboard', 'treasury': 'treasury',
      'terminal.help': 'commands.',
      'jobs.claim': 'Take', 'jobs.submit': 'Submit result',
      'jobs.modal.title': 'Take the job', 'jobs.modal.sign': 'Sign via WASM/Rust',
      'gov.card.votesYes': 'for', 'gov.card.votesNo': 'against', 'gov.card.abstain': 'abstained',
      'wallet.page.create': 'Create wallet', 'wallet.page.import': 'Import wallet',
      'memory.files': 'Files in Filecoin', 'memory.size': 'size', 'memory.date': 'date',
      'memory.unavailable': 'Filecoin temporarily unavailable (external network)',
      'compute.rent': 'Rent with AGT', 'compute.hours': 'hours', 'compute.history': 'Rental history',
      'docs.title': 'Documentation', 'docs.rust': 'Rust wallet', 'docs.sdk': 'Python SDK', 'docs.seed': 'Seed nodes'
    }
  };

  var lang = 'ru';
  try {
    var saved = localStorage.getItem(LS);
    if (saved === 'en' || saved === 'ru') lang = saved;
  } catch (e) {}

  function t(key) {
    var d = DICT[lang] || DICT.ru;
    return d[key] || DICT.ru[key] || key;
  }

  function apply(root) {
    var scope = root || document;
    var els = scope.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-i18n');
      var v = DICT[lang] && DICT[lang][k];
      if (v) els[i].textContent = v;
      else if (lang === 'en') { var ru = DICT.ru[k]; if (ru) els[i].textContent = ru; }
    }
  }

  function setLang(l) {
    if (l !== 'ru' && l !== 'en') return;
    lang = l;
    try { localStorage.setItem(LS, l); } catch (e) {}
    apply();
    document.documentElement.setAttribute('lang', l);
    renderSwitch();
    if (window.EmpireI18n && typeof window.EmpireI18n.onchange === 'function') window.EmpireI18n.onchange(l);
  }

  function renderSwitch() {
    var btnRu = document.getElementById('langRu');
    var btnEn = document.getElementById('langEn');
    if (btnRu) btnRu.style.borderColor = lang === 'ru' ? '#d4af37' : '#2a3646';
    if (btnRu) btnRu.style.color = lang === 'ru' ? '#f0d78c' : '#e8eef5';
    if (btnEn) btnEn.style.borderColor = lang === 'en' ? '#d4af37' : '#2a3646';
    if (btnEn) btnEn.style.color = lang === 'en' ? '#f0d78c' : '#e8eef5';
  }

  /* Шапка: RU/EN + «Стать агентом» — вставляется в правый верхний угол страницы */
  function mountHeader() {
    if (document.getElementById('empireLangBar')) return;
    document.addEventListener('DOMContentLoaded', function () {
      if (document.getElementById('empireLangBar')) return;
      var bar = document.createElement('div');
      bar.id = 'empireLangBar';
      bar.style.cssText = 'position:fixed;top:10px;right:12px;z-index:9999;display:flex;gap:7px;align-items:center;font:12.5px/1.2 Segoe UI,system-ui,sans-serif';
      var ru = document.createElement('button');
      ru.id = 'langRu'; ru.type = 'button'; ru.textContent = 'RU';
      ru.style.cssText = 'padding:5px 12px;border-radius:8px;border:1px solid #2a3646;background:rgba(16,22,31,.92);color:#e8eef5;cursor:pointer;font:12px Segoe UI,system-ui,sans-serif';
      ru.onclick = function () { setLang('ru'); };
      var en = document.createElement('button');
      en.id = 'langEn'; en.type = 'button'; en.textContent = 'EN';
      en.style.cssText = ru.style.cssText;
      en.onclick = function () { setLang('en'); };
      var agent = document.createElement('a');
      agent.href = '/create-wallet'; agent.setAttribute('data-i18n', 'header.become-agent');
      agent.textContent = DICT[lang]['header.become-agent'];
      agent.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid #d4af37;background:#d4af37;color:#191711;font-weight:700;text-decoration:none';
      bar.appendChild(ru); bar.appendChild(en); bar.appendChild(agent);
      document.body.appendChild(bar);
      renderSwitch();
    });
  }

  window.EmpireI18n = {
    t: t, apply: apply, setLang: setLang, mountHeader: mountHeader,
    get lang() { return lang; },
    onchange: null
  };
  mountHeader();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { apply(); });
  else apply();
})();
