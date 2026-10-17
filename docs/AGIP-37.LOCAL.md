# AGIP-37.LOCAL — развязка админ-плоскости и публичного порта ноды

**Статус:** принято (аудит-ревью deploy-vps.sh, 2026-10-17, ветка e6fd5a5 → фикс в этом коммите)
**Связано:** AUDIT-2026-10-15 (ТЗ-1: AGT_ADMIN_TOKEN), AGIP-27 (https-пир), README «VPS для публичной ноды»

## Проблема

Внешняя нода из deploy-гайда слушает `0.0.0.0:9335`, и до этого фикса одно и то же
HTTP-ядро отвечало и сети, и админ-оператору:

1. **`/tx/sign` наружу** — маршрут подписывает транзакции ключами ЛОКАЛЬНОГО
   `wallets.json` без какой-либо авторизации: `AGT_ADMIN_TOKEN` этот маршрут не
   проверял → незащищённый перевод средств чужими ключами с любого IP.
2. **`/wallet/create`, `/mine`, `/security/*`, `/peer/add`, `/jail/*`, gov/dxe/escrow**
   — всё публично: создание адресов с приватными ключами в json, CPU-burn /mine,
   мутации security/карантина.
3. **UFW не спасает**: он фильтрует порты, а не HTTP-маршруты внутри открытого порта ноды.

Прочие находки ревью, которые покрыты тем же коммитом (см. deploy-vps.sh):
SSH-порт разрешается в UFW **до** enable и вычисляется из `sshd -T`; Node 24 LTS
(18/20 EOL); все шаги fail-fast («ГОТОВО» только при живой `/life`); повторный
запуск = надёжный апдейт (`safe.directory`, `reset --hard`, restart всегда); текст
после установки с честными портами; health-check.mjs резолвит `data-vps` и не
вызывает powershell вне Windows.

## Решение — барьер в самой ноде

В `node.mjs` введена разделение плоскостей (PUB_REQUEST_RE):

- **Все запросы НЕ с loopback** проходят только через явный белый список:
  - read-only: `/info`, `/life`, `/headers`, `/blocks`, `/mempool`, `/validate`,
    `/forks`, `/peers/*`, `/ws/status`, `/txproof/*`, `/block/*`, `/blocktemplate`,
    витрины (`/stats*`, `/imperial*`, `/terminal*`, `/chat*`, `/dashboard`, …),
    `/gold` и т.п. view-маршруты;
  - P2P-поверхность: `POST /tx` (приём чужих транзакций — это сеть);
  - тонкие майнеры (PoW на стороне клиента, `miner-client.mjs <внешняя-нода>`):
    `POST /blocktemplate`, `POST /block/submit`.
- **Всё остальное (админ-плоскость)** — только с loopback:
  `/wallet/*`, `/tx/sign`, `/mine`, `/security/*` (POST),
  `/peer/add`, `/sync-now`, `/jail/*` (POST), `/community/send`, `/passport/*`,
  `/gateway/pay`, `/treasury/propose`, `dxe-мутации`, `/escrow/*-мутации` и все
  будущие маршруты по умолчанию приватны (deny-by-default), пока их явно не
  добавят в белый список.
- Ответ нарушителю: `403 admin_loopback_only` + лог `[agip-37] публичный отказ`.
- Выключатель **не предусматривается** (публичная нода = по умолчанию защищена);
  AGT_ADMIN_TOKEN работает дальше как второй слой (теперь деструктивные POST
  требуют и loopback, и токен).

WebSocket `/ws` живёт в `server.on('upgrade')` и барьер HTTP-handler он не
проходит — P2P-госсип пиров не затронут.

## Оператору

- На VPS: `ssh ubuntu@<ip>` → curl `http://127.0.0.1:<PORT>/...` — loopback,
  полный доступ;.remote-скрипты нуги (join-network, watchdog) на ядровой машине
  также loopback-клиенты, поведение не изменилось.
- Тонкий майнер на другой машине: продолжает работать (`/blocktemplate`,
  `/block/submit` публичны). `/mine` — только локально;«майнинг за CPU ноды»
  наружу не продаётся и не светится.

## Приёмка (живой прогон, 2026-10-17)

VPS-симуляция: `AGT_BIND=0.0.0.0 node node.mjs 9398` на Windows-хосте, «внешний»
клиент = подключения к LAN-IP (192.168.1.136), «оператор» = 127.0.0.1:

| проверка | результат |
|---|---|
| EXT GET `/life` `/info` `/headers?limit=1` `/blocks?n=1` `/validate` `/stats-data` | 200 |
| EXT POST `/tx` (invalid sig) | 400 `bad_signature` (маршрут жив, не барьерится) |
| EXT POST `/blocktemplate` | 200 (тонкий майнер ок) |
| EXT POST `/tx/sign` → | 403 `admin_loopback_only` |
| EXT POST `/wallet/create` → | 403 `admin_loopback_only` |
| EXT POST `/mine`, `/community/send` → | 403 `admin_loopback_only` |
| LO `/wallet/create` | 201 (адрес+ключи выдаются только locally) |
| LO `/tx/sign` | 404 `wallet_not_found` (доходит до кошельковой логики) |
| LO `/life` | 200 `chainValid=true` |

Плюс: `node --check` по всем tracked .mjs — OK (CI-эквивалент), core-smoke 4/4.

## Ревизия 2 — независимое ревью 95d3801 (2026-10-17, вечер)

1. **Блокер чистой установки: spore.mjs не в репо** — статический import ронял node на
   чистом клоне (файл исторически не закоммичен). Спора — опциональная канареечная
   фича → ленивый dynamic import: модуля нет → `spore=null`, нода живёт как раньше.
2. **Туннель-обход барьера** — прокси (cloudflared/Funnel/nginx) доставляет чужой
   запрос на 127.0.0.1, и локальный-админ   считался админом по IP. Теперь админ =
   `x-admin-token` ИЛИ (mode=local ∧ прямая петля ∧ БЕЗ форвардирующих заголовков
   x-forwarded-for/x-real-ip/cf-connecting-ip/forwarded/x-via). Для публичного
   байнда deploy-vps.sh ставит `AGT_ADMIN_MODE=token`: туннель НИКОГДА не админ,
   кошельковые операции — только по токену.
3. **Ложный успех самопроверки** — `curl -f` трактовал 404/отказ сети как «барьер
   активен». Замер теперь ДОСЛОВЕН: PASS = HTTP 403 + тело admin_loopback_only;
   сетевая ошибка = «НЕ ПРОВЕРЕНО» (без GOТОВО-успеха); 404/2xx → hard fail.
4. **HTTPS WS-пиры на порту 80** — `Number(u.port) || 80` в ws.mjs connectClient:
   URL нормализует стандартные порты в пустой u.port → для wss депался 80. Теперь
   стандартный порт = 443 для https (80 для http).
5. **sshd -T и set -euo pipefail** — fallback 22 теперь доезжает (`|| true`).
6. **reset --hard и «модифицированные файлы»** — обновлятор деплоя проверяет
   `git status --porcelain` и останавливается с явным советом, вместо затирания.

## AGIP-38: SITE-SYNC — один сайт на всех нодах

Сайт лечится из repo-чекаута ноды; устаревший чекаут = старый сайт. Теперь каждая
нода раз в 10 мин сверяет 9 страниц (index/imperial/terminal/dashboard/chat/jail/
mbc20/cabinet/jobs) с каноном `raw.githubusercontent.com/.../main/site` и кладёт
свежак в `DATA_DIR/site-live/` (не трогает tracked-файлы). Отдача: свежий кэш < 24 ч,
иначе локальный файл. Offline → локальный чекаут. Плюс «ноды не отстают»:
высота сверяется с ядром на деплое, WS/syncAll механизм AGIP-7/23
активен как был.

## Что НЕ сделано (осознанно)

- `/balance` POST, `/community/send` и прочие POST-роуты в белом списке
  расширять не стали — удалить spam-поверхность можно отдельно (после
  обсуждения: базовые токен-модели они под потребностью тонких майнеров).
- Полноценный TLS на самом HTTP-ядре остаётся делом TLS-фаннелов (AGIP-27).
- Забор токена печатает файлом, не stdout — оператор сам `sudo cat` если нужно
  (деплой не печатает секреты).
