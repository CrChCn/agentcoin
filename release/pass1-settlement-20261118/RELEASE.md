# Релиз прохода 1 — платёжная страница Settlement (2026-11-18)

Комплект: HTML/JS страницы + денежные и шлюзовые зависимости + тесты.
Целостность: `sha256sum -c SHA256SUMS` из этого каталога.

## Состав
- `site/ecosphere/mainnet.html` — страница (абсолютный `/ecosphere/mainnet.js`,
  все формы `novalidate` + `onsubmit="return false;"`, кнопки disabled, CSP-meta, noscript)
- `site/ecosphere/mainnet.js` — внешний модуль (строгие суммы, gated-кнопки, Content-Type check)
- `sdk/js/money.mjs` — денежное ядро (`parseAtomicStrict`/`formatAtomic`/`amountToProtocol`)
- `sdk/js/mainnet-settlement.mjs` — `buildTransferTx` (tx.amount — number, требование консенсуса)
- `sdk/js/mainnet-node-api.mjs`, `sdk/js/mainnet-server.mjs` — шлюз `/mainnet/*`
- `sdk/js/agentcoin-browser.mjs` — общее клиентское ядро
- `scripts/ecosphere-settlement-gateway.mjs` — standalone-шлюз :18745
- `config/system-registry.json`, `config/action-registry.json` — реестры
- `test/money.mjs`, `test/mainnet-amount-compat.mjs` — тесты

## Проверки (локально, до публикации)
- `node --test test/money.mjs test/mainnet-amount-compat.mjs` — 9/9 PASS
- `node --test test/mainnet-settlement.mjs test/mainnet-gateway.mjs test/mainnet-node-api.mjs test/mainnet-security-closeouts.mjs` — 25/25 PASS
- Локальный HTTP: html 200 text/html, js 200 text/javascript
- Прод untouched; деплой — только точечный, с явного слова владельца
