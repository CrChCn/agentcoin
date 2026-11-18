# ECOSPHERE staging — запуск, деплой, откат (проход 1)

Базовый коммит прохода: см. `git log --oneline -3`. Релиз собирается скриптом ниже, без mainnet-ключей.

## Локальный запуск (стенд + UI)

```
node scripts/agentcoin-stand.mjs        # стенд A+B, порт в выводе (STAND_URL)
# UI: открой site/ecosphere/index.html через тот же origin (прокси / -> STAND_URL),
# либо python -m http.server в site/ и укажи apiBase стенда в app.js
node test/agentcoin-ecosphere.mjs        # ядро UI: блокировки, stale, XSS
```

## Релиз-артефакт

```
tar -czf dist/ecosphere-pass1-<ts>.tar.gz site/ecosphere sdk/js/agentcoin-browser.mjs sdk/js/schemas.mjs docs/ECOSPHERE-DELIVERY.md docs/ECOSPHERE-STAGING.md
sha256sum dist/ecosphere-pass1-<ts>.tar.gz
```

Содержимое релиза: только `site/ecosphere/*`, общее ядро, схемы. Кошельки, `.env`, базы, журналы — не паковать.

## Staging-чек (факт на 2026-11-18)

Ориентиры из ТЗ (`agentcoin-staging`, `globe2.31.145.160`, `a01:4f8:c0c:717d::/64`) не подтверждены как доступный SSH/API endpoint:
подсеть /64 — не адрес хоста, строка globe2 — не проверенный адрес. Перед переключением зафиксировать
фактический host, каталог приложения, способ запуска (systemd/docker/caddy), домен и TLS, затем:

1. бэкап заменяемых файлов/конфига; 2. отдельный релиз-каталог + отдельное хранилище/тест-ключи;
3. `GET /info` + `GET /queue/auth-capabilities` показывают тестовый genesis (не mainnet);
4. health: `/info`, `/queue/status`, `/catalog/offers` 200; мутация с чужой сетью — `wrong_network`;
5. браузерная приёмка по матрице ТЗ п.10; 6. зафиксировать URL/commit/версию/откат.

**Недостающий доступ:** SSH/API endpoint staging, пользователь, путь деплоя, домен/TLS. До его получения —
релиз готов локально (этот каталог + tar.gz), публикация не выполнена. Ключи в чат не передавать.

## Откат

Держать предыдущий релиз-каталог; откат = переключение symlink/route на него + проверка `/info` и главной.
Данные отдельного staging-хранилища сохраняются.
