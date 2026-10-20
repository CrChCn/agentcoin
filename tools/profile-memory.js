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
