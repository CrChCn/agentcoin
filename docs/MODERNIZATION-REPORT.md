# MODERNIZATION-REPORT — проход 1 (платежи), дерево 2026-11-18

Локальные проверки = подготовка, не сдача. Рабочая цель публикации — https://agentcoin.work/.
Консенсус/эмиссия/награды не менялись (`core.mjs` — только чтение денег; buildTransferTx — формат суммы, не консенсус).

## Что сделано в этом заходе
1. `sdk/js/money.mjs` — единое денежное ядро (parseAtomicStrict/formatAtomic, atomic строками, без Number*1e9). `node --check` OK.
2. `sdk/js/mainnet-settlement.mjs` — `buildTransferTx`: сумма decimal-строкой через `fromAtomic` (устранён Number*1e9). `node --check` OK.
3. `site/ecosphere/mainnet.js` (новый, внешний) + `site/ecosphere/mainnet.html` (урезан до `<script src>`):
   - строгий разбор сумм (лишние знаки — отказ), строгий разбор `tx.amount`, сверка `amountAtomic` строкой;
   - кнопки `bGo/pGo/sGo/cGo` disabled до `boot()=ok`; формы `novalidate`, без нормальной отправки (только preventDefault-handlers);
   - проверка Content-Type application/json (HTML catch-all → fail-closed ошибка, не «данные»);
   - баланс ноды помечен приближением, не используется как сумма заказа.
   - `node --check mainnet.js` OK.
4. `config/system-registry.json` + `config/action-registry.json` — внутренний реестр (без секретов), статусы implemented/locally_verified/published/limited.
5. `docs/SYSTEM-MAP.md` — карта пути, расхождения двух карт, деньги, маршруты к приёмке.

## Проверки (локально)
- `node --check`: money, mainnet-settlement, mainnet-node-api, mainnet-server, agentcoin-browser, mainnet.js — OK.
- `node --test test/money.mjs test/mainnet-amount-compat.mjs` — 9/9 PASS.
- `node --test test/mainnet-settlement.mjs test/mainnet-gateway.mjs test/mainnet-node-api.mjs test/mainnet-security-closeouts.mjs` — 25/25 PASS.
- Локальный HTTP-стенд (loopback): `/ecosphere/mainnet.html` 200 text/html (CSP-meta, абсолютный `src="/ecosphere/mainnet.js"`, 4× `onsubmit="return false;"`, 4× disabled-кнопки); `/ecosphere/mainnet.js` 200 text/javascript, без импортов и внешних URL.
- Совместимость суммы с консенсусом — НАЙДЕН И ИСПРАВЛЕН дефект: `buildTransferTx` отдавал `tx.amount` строкой, консенсус требует number (`tx_bad_fields`). Возвращено number-значение через строгий путь atomic→decimal-строка→Number→обратная сверка; `test/mainnet-amount-compat.mjs` доказывает: сборка→подпись→`verifyTransaction`→гейт изолированной ноды (`Blockchain.addTransaction`: строковый двойник — `bad_fields`, наш tx — гейт типа/точности проходит). `core.mjs` не менялся.
- Деньги: `parseAtomicStrict`/`toAtomic` теперь отвергают экспоненту в строковом вводе (fail-closed, как страница); ноль/отрицательные — отказ; граница `9007199.254740991` AGT = MAX_SAFE_INTEGER atomic; `amountToProtocol` возвращает number (консенсус) с проверкой представимости, строки — только отображение.

## Релиз прохода 1
- Коммит (см. git log): страница, деньги, шлюз, тесты, реестры, отчёт + комплект `release/pass1-settlement-20261118/` (HTML/JS/зависимости + SHA256SUMS + ROLLBACK.md).
- Откат — восстановлением файлов предыдущего комплекта и рестартом только `agt-settlement` (с явного слова владельца); общий `git checkout` рабочего дерева запрещён (может уничтожить незакоммиченные изменения); журнал платежей (`mainnet-settlements.json`) назад НЕ откатывать.
- Прод untouched до точечного деплоя по слову владельца.

## Не закрыто (честно)
- Публичная сверка `/settlement` (статус/CT/маркер/версия/браузер форм) — только после деплоя по слову владельца; прод untouched в этом заходе.
- Браузерная приёмка выполнена статически + локальным HTTP (без кликов по прод-формам и без серверной авторизационной проверки в проде — они обязательны перед публикацией и ждут деплоя).
- Обоснование глубины 6 для сети Agentcoin (время блока, реорги) — требуется отдельный разбор.
- browser-core: вынести money+Content-Type+схемы+статусы snapshot; миграция страниц по порядку (settlement→cabinet/wallet→ecosphere→terminal→dashboard/jobs) не начата.
- capabilities↔маршруты автопроверка; `/api/v1/queue/history|memory/state|compute/state` — владелец источника не назначен.
- Алиасы `/workspace`, лендинг-проверки `/ecosphere/`, `/robots.txt /sitemap.xml /app.webmanifest`, `/site/release` сверка hashes — проход 2.
- Сквозной сценарий MCP→заказ→артефакт→accept→подпись→нода→сайт/CLI/MCP→событие + потеря ответа/рестарт — приёмка прохода 5, не выполнялась.
- Нода под root, offsite-бэкап неполон, политика владельца не прислана — без изменений (требуют явного слова владельца).

## Следующий шаг
1. Добавить `test/money.mjs` (строгие суммы: 9 знаков ok, 10-й — отказ, экспонента, round-trip) и прогнать затронутые тесты.
2. Проход 2: реестр маршрутов из применяемой конфигурации + публичная приёмка каждого пути из списка п.5–6 ТЗ (только чтение, без нажатия финансовых кнопок в проде).
