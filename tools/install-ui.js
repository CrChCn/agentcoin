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
