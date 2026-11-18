# SYSTEM-MAP — Agentcoin как единый организм (2026-11-18)

Навигация: публичная — существующая структура сайта (без конкурирующего дерева).
Внутренний реестр: `config/system-registry.json` (компоненты), `config/action-registry.json` (действия).
Денежное ядро: `sdk/js/money.mjs` + `core.mjs decimalToScaledUnits`.

## Путь запроса
```
Пользователь / ИИ-агент
  → Сайт (site/*.html 35 шт + site/ecosphere/*) / SDK (sdk/js/*) / CLI / MCP
  → Общий контракт действий и авторизации (capabilities + signer-only mutate, запрет fallback signed→legacy)
  → Доменные сервисы: задания, заказы, артефакты, расчёты (queue.mjs/stand-server.mjs; каталог/заказы — серверное состояние, НЕ блокчейн)
  → Проверенный результат и события (/events, settlement.sent/confirmed)
  → Обновление всех представлений (статусы loading/fresh/stale/unknown/unavailable/unsupported/wrong-network)
```
Блокчейн — источник состояния только нативных AGT. Каталог/заказы/модерация — серверное состояние.

## Компонент → файлы → маршруты → процесс → статус
См. `config/system-registry.json`. Кратко:
- settlement-ui: `site/ecosphere/mainnet.html+mainnet.js` → `/settlement` → static → implemented (v0.3: внешний JS, строгие суммы, gated-кнопки).
- money-core: `sdk/js/money.mjs` → library → implemented.
- mainnet-node-api: `sdk/js/mainnet-node-api.mjs` → live node → locally_verified.
- settlement-gateway: `sdk/js/mainnet-server.mjs` + `scripts/ecosphere-settlement-gateway.mjs` → `:18745 /mainnet/*` → implemented (деплой только по слову владельца).
- browser-core: `sdk/js/agentcoin-browser.mjs` → implemented (требуется: Content-Type check + money + схемы ответов — следующий шаг прохода 3).
- ecosphere-app: `site/ecosphere/index.html+app.js` → `/ecosphere/ /workspace` → implemented (алиас /workspace проверить публично).
- panel-ui: `site/panel.js` → limited (подключён не везде).
- queue-orders-catalog: signed-only, legacy 410 → limited (прод-очереди без аудита каждого маршрута не открывать).
- site-static (35 HTML) → published; web-next (7 маршрутов) → published (сверить каждый: статус+CT+маркер+версия).

## Расхождения двух карт (сверка, не перенос дефектов)
| Карта Буффи | Публичный аудит | Статус на 2026-11-18 |
|---|---|---|
| Settlement защищён | /settlement содержал прямые /balance /tx + SyntaxError | Исправлено в дереве: внешний `mainnet.js` (node --check OK), строгие суммы, gated-кнопки, Content-Type check. Публичная сверка — после деплоя по слову владельца |
| Ecosphere реализован | /ecosphere/ отдавал лендинг | В дереве модуль есть (`index.html+app.js`); приёмка `/workspace /ecosphere/ /ecosphere/index.html` — в проходе 2 публично |
| Единый визуальный слой | panel.js не везде | Зафиксировано как limited; токены/компоненты — проход 4 |
| Единый клиент | старые fetch-цепочки | browser-core за основу; миграция по порядку settlement→cabinet/wallet→ecosphere→terminal→dashboard/jobs |
| API/capabilities | расхождение реестра и маршрутов | Реестр заведён (`action-registry.json`); автопроверка capabilities↔роуты — проход 2 |
| Очередь signed | legacy production в старых отчётах | В дереве legacy 410/sconfirm-стороны/tick-подпись; прод-очереди проверить помаршрутно |

## Деньги (точно)
- Atomic — строками; BigInt; ввод `parseAtomicStrict` (лишние знаки — отказ, не округление).
- `buildTransferTx` — сумма decimal-строкой через `fromAtomic` (Number*1e9 убран).
- Баланс ноды (float) — только приближение для отображения, не сумма заказа.
- Глубина 6 — текущее правило; обоснование под сеть Agentcoin — отдельный пункт прохода 1 (время блока/реорги/финалка), не закрыт числом.

## Маршруты к приёмке (проход 2)
`/workspace, /ecosphere/, /ecosphere/index.html, /settlement, /robots.txt, /sitemap.xml, /app.webmanifest`:
статус + Content-Type + маркер + версия + реальные API-вызовы. 200 с чужим экраном = дефект.
API-неизвестное → JSON-ошибка с HTTP-статусом, не HTML catch-all. Закрыть: `/api/v1/queue/history /api/v1/memory/state /api/v1/compute/state` (сначала владелец источника, админ-режим ноды не отключать ради чтения).
