# Нативные расчёты AGT: модуль через API живой ноды (2026-11-18)

`core.mjs` не менялся (мораторий соблюдён). Локальный файл цепи (`data/chain.json`,
41996 блоков — отсталый снимок) источником НЕ является: все балансы, высота,
вершина и подтверждения читаются из ответов живой серверной ноды через её
предназначенный публичный API. TEST-книга стенда (`/settlements/*`) публичным
платёжным путём не является (стенд-only).

## Карта публичных маршрутов (сверена живым опросом + браузером, 2026-11-18)
- Голые пути → нода (JSON): `GET /info /life /balances /blocks /headers`,
  `POST /balance`, `POST /tx/preflight`, `POST /tx` (существующий приёмник).
- `/api/v1/txproof/:txid`, `/api/v1/mempool?full=1` → нода (голые `/txproof`,
  `/mempool` отдаёт Next-оболочка сайта 200-HTML — их не используем).
- `POST /api/v1/tx` → `404 route_not_allowlisted` (шлюз-адаптер блокирует приём
  tx — зафиксировано и в браузере). Приём подписанных tx идёт голым `POST /tx`.
- Цепь живая: высота 48560→48566 за окно опроса, вершина свежая (11–55 с),
  `chainValid:true`, `fresh:true`.

## Что сделано (коммит ниже)
- `sdk/js/mainnet-node-api.mjs` — клиент живой ноды: `netEvidence()` сверяет
  chainId + genesis + высоту info/life + хеш вершины life/блок + свежесть/валидность
  (одного genesis недостаточно); `submitSignedTx()` проверяет подпись и
  соответствие заказу (отправитель/получатель/сумма) ДО отправки и шлёт в
  существующий `POST /tx`; `checkConfirmation()` — пруф → тело блока →
  связность заголовков → глубина 6; потеря ответа → `pending` + сверка, не
  повтор вслепую; `duplicate_tx` → уже принято, второй платёж не создан.
  Не-JSON от upstream — fail-closed ошибка, не «данные».
- `sdk/js/mainnet-server.mjs` — шлюз на том же API (файла цепи нет):
  `GET /mainnet/info|/balances|/policy`, `POST /mainnet/preview|/obligations|/submit`,
  `GET /mainnet/settlements/:id|…/status`. Ключи не принимает (`private_key_rejected`).
- `site/ecosphere/mainnet.html` — страница v0.2: сверка сети → баланс → превью →
  вставка подписанной tx со сверкой условий → статус по пруфу. Ключ в браузер
  не вводится.
- `test/mainnet-node-api.mjs` — 9/9 (stub fetch): гейты сети, реорг, pending/sent/
  confirmed, recipient/amount-mismatch, отказ без сетевого вызова.
- `test/mainnet-settlement.mjs` — 7/7 (журнал, политика, локальная подпись).

## Живые доказательства (публичный HTTPS, без mainnet-транзакций)
- `netEvidence`: `AGENTCOIN / 00026d18… / 48564=48564 / tip agree / age 54s / synced:true`.
- Реальный баланс `AGT11a…439a` → `920839817600000` atomic (помечен approximate:
  округление float ноды; точная сумма — только в подписанной tx).
- Реальный tx `5dc2326f…` (высота 48557) → `confirmed`, 7 подтверждений.
- Неизвестный txid → `pending` (путь восстановления после потери ответа работает).
- Браузер (fetch из контекста страницы agentcoin.work): `/info` 200,
  `POST /balance` 200, `/api/v1/txproof` 200 (height 48557),
  `/txproof` 200-HTML (поэтому не используем), `POST /tx/preflight` 200,
  `POST /api/v1/tx` 404 `route_not_allowlisted` (поэтому приём — голый `/tx`).

## Локальный стенд (только проверка, не публикация)
- `http://127.0.0.1:18744` (новый код, шлюз на живом API: отдаёт 48566 против
  41996 локального файла — файл больше не источник). Стенд 18743 не тронут.

## Публикация (2026-11-18, окно владельца по SSH)
- Модуль: `https://agentcoin.work/settlement` (страница, 200-HTML модуля)
  + `https://agentcoin.work/mainnet/*` (шлюз `agt-settlement.service`, порт 18745).
- Опубликованный коммит: `509968d` (файлы сверены: `node --check` на сервере
  тем же рантаймом v24.22.2; VERSION на сервере = хеш коммита).
- Серверный узел истины: `127.0.0.1:9335` (mainnet, цепь живая, 48579→48581 за окно).
- Нода/консенсус не тронуты: рестарта `agentcoin-node.service` не было,
  `core.mjs` не менялся. Бэкап Caddy: `/root/Caddyfile.bak-20261118-settlement`.
- Живые доказательства через публичный HTTPS: `netEvidence synced:true`
  (48564=48564, tip 11–55 с, `chainValid:true`); баланс `AGT11a… →
  920839817600000` atomic; tx `5dc2326f…` (высота 48557) → `confirmed`, 7
  подтверждений; неизвестный txid → `pending`.
- Сквозной прогон публичным маршрутом (эфемерные ключи, средств ноль):
  `probe-no-funds-1 → obl-0e9025538ff4`, без manualApprove → 409
  `no_policy_manual_approve_required`; с manualApprove → подпись и условия
  сошлись, нода честно отказала `insufficient_funds` (релей до приёмника
  работает); статус `sent/pending/paid:false`. Журнал после пробы вычищен.
- Браузер (fetch из контекста страницы): `/mainnet/info` 200 synced,
  `/mainnet/balances` 200, секрет → 400, `/mainnet/policy` → `configured:false`.
- Первый перевод: не выполнен — ждёт политику владельца, разрешённый кошелёк,
  утверждённую сумму и подпись владельца (см. DEPLOY-документ).
Первый перевод — только после: политики владельца, разрешённого кошелька,
утверждённой суммы и подписи владельца.
