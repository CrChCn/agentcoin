# Выкладка рабочих нод A2 (пошагово для оператора, по одному серверу)

## Статус узлов (свежие данные 2026-11-09 ~12:56 UTC, снято публично; прошлое: ~12:14 UTC — 38287/`00e5c9ae…`)

| Узел | Высота/tip | Статус | Роль в выкладке |
|---|---|---|---|
| `agentcoin.work` (upstream) | 38327 / `00e9998e…`, chainValid | Отвечает сам как нода («Эта нода» в `/api/v1/network/nodes`); ростер: нода+node2+node3, все responding/fresh, tipAge ~115с | Проверка оператором (ниже); выкладка после утверждения |
| node1.agentcoin.work | 38327 / тот же tip, age ~134с, chainValid, fresh | **Отвечает, tip совпадает**, но в ростере НЕТ | Кандидат в mesh после проверки ростера |
| node2 (Hetzner fsn1) | 38327 / тот же tip (через ростер upstream) | Подтверждён, reachable, fresh | SEED — первый сервер; **кандидат под пилот** |
| node3 (DO fra1) | 38327 / тот же tip (через ростер upstream) | Подтверждён, reachable, fresh | Второй сервер, пиром к node2 |

Прямые `https://node2.agentcoin.work`, `https://node3.agentcoin.work` отдают
заглушку `reserve node: dark (use https://agentcoin.work)` (проверено: 403) — это не API нод.
Ростер `https://agentcoin.work/api/v1/network/nodes`: «Эта нода» + node2 + node3
(все responding, behindObserved=0). node1 в ростере НЕТ, хотя его `/life`
совпадает по tip — mesh с node1 только после появления в ростере.

### Префлайт пилота AGT-A3-PREFLIGHT (12:56 UTC, только безопасные запросы, без токена)

- `/faucet/pilot/challenge`, `/faucet/pilot/claim` через `https://agentcoin.work`:
  POST (даже с невалидным телом `{}`/`{"address":"AGTX"}` — состояние не меняет)
  → `405` от статики края; GET → `200` HTML-лендинг. Вывод: пилотные маршруты
  к ноде НЕ проброшены — закрытие `/pilot/*` держится по умолчанию, кран снаружи
  недоступен (ожидаемо до запуска). При запуске публиковать ТОЛЬКО
  POST `/faucet/pilot/challenge` + POST `/faucet/pilot/claim`; `/pilot/*` — deny.
- Предложение: пилот — на **node2** (SEED, в ростере responding/fresh). node1 —
  только после появления в ростере и mesh; node3 — резерв.

### Свежий срез 2026-11-09 ~15:43 UTC (AGT-A3-PREFLIGHT, второй проход)

- Upstream `https://agentcoin.work/life` → `blocks 38487`, `tip 00ec1999…`, age 43с, `chainValid true` (цепь идёт: 38327 в 12:56 → 38487 в 15:43, ~63с/блок).
- Ростер (`checkedAt 15:43:31Z`): «Эта нода» + node2 + node3 — все responding/fresh, тот же tip, behindObserved=0.
- node1 direct `/life` → 38487, тот же tip, age 43с, fresh, chainValid — в ростере НЕТ (блокер mesh/pilot для node1 не снят).
- node2 — кандидат подтверждён повторно (в ростере responding/fresh). Но это наблюдение upstream, а не прямое обращение к node2 (прямой URL — заглушка 403).
- Фактический upstream (куда edge направляет API): по конфигурации прокси не установлен — Caddy отвечает за статику (`Server: Caddy` на HTML-fallback), API-JSON идёт без `Server` (сама нода), ростер называет хост «Эта нода». Совпавший tip подтверждает синхронизацию, но НЕ доказывает, какой физический узел обслуживает `agentcoin.work`. Пункт **blocked**: нужны (а) конфиг обратного прокси `agentcoin.work` (Caddyfile/nginx: какой backend у `/api/*` и `/life`), (б) `systemctl cat agt-node` + `AGT_DATA_DIR` с того хоста, (в) заявление оператора, какой физический сервер — upstream.
Upstream: API `agentcoin.work` обслуживает сама нода за этим именем
(доказательство: прямые `/api/v1/life` и `/api/v1/network/nodes` с «Эта нода»);
какой физический сервер — подтверждает оператор (ниже).

Проверка оператором (с любого сервера):
`nslookup node1.agentcoin.work`, `curl -s https://node1.agentcoin.work/life`,
сверить `tipHash` с upstream; `curl -s https://agentcoin.work/api/v1/network/nodes`
— есть ли node1 в списке. До появления в ростере node1 в mesh не включать.

## Правила выкладки (каждый подтверждённый сервер)

Порядок: сохранить конфигурацию → применить изменение → проверить службу,
цепь, соединения и новые блоки → только потом следующий сервер.
Пиринг, запуск крана и реальные выплаты — ОТДЕЛЬНЫЕ этапы: настройка связи
не зависит от бюджета и включается раньше денежных шагов.

Сохранение перед изменением (на сервере):
```bash
sudo tar -czf /root/agt-backup-$(date +%F).tgz -C /opt/agentcoin data-vps/peers.json data-vps/wallets.json data-agtx 2>/dev/null; ls -la /root/agt-backup-*
```
Проверка после изменения (на сервере):
```bash
systemctl is-active agt-node
curl -s http://127.0.0.1:9335/life | jq '{blocks, tipHash, chainValid}'
curl -s http://127.0.0.1:9335/ws/status | jq '{wsPeers}'
```
Откат (на сервере):
```bash
sudo systemctl stop agt-node
sudo tar -xzf /root/agt-backup-<ДАТА>.tgz -C /opt/agentcoin
sudo chown -R agt:agt /opt/agentcoin && sudo systemctl start agt-node
sleep 10; curl -s http://127.0.0.1:9335/life | jq '{blocks, chainValid}'
```

## Порядок серверов

Порядок важен: сначала seed без пиров, затем остальные — пиром к seed.
Стандартный порт `9335`. Все команды — по SSH от root (Ubuntu/Debian).

## Шаг 0. На каждом сервере (перед деплоем)

```bash
ssh root@<server-ip>
```

## Сервер 1 — node2 (Hetzner fsn1): SEED, без стартового пира

```bash
export NODE_PORT=9335
bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) "$NODE_PORT"
# скрипт сам: Node 24, /opt/agentcoin, UFW (SSH + 9335), systemd agt-node, fail-fast /life
systemctl status agt-node --no-pager | head -5
curl -s http://127.0.0.1:9335/life
```

Записать tip: `curl -s http://127.0.0.1:9335/life | jq '{blocks, tipHash, chainValid}'`.

## Сервер 2 — node3 (DO fra1): пиром к node2

```bash
export NODE_PORT=9335
export AGT_BOOTSTRAP_PEER=http://<node2-ip>:9335   # ВНУТРЕННИЙ/публичный IP node2
AGT_BOOTSTRAP_PEER="$AGT_BOOTSTRAP_PEER" bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) "$NODE_PORT"
T=$(sudo cat /opt/agentcoin/data-agtx/admin-token.txt)
curl -s -X POST http://127.0.0.1:9335/sync-now -H "x-admin-token: $T" | head -c 400; echo
curl -s http://127.0.0.1:9335/life | jq '{blocks, tipHash}'
# высоты node2/node3 должны совпасть в течение ~90 с (периодический syncAll)
```

## Сервер 3 — node1: пиром к node2 и node3

```bash
export NODE_PORT=9335
export AGT_BOOTSTRAP_PEER=http://<node2-ip>:9335
AGT_BOOTSTRAP_PEER="$AGT_BOOTSTRAP_PEER" bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) "$NODE_PORT"
T=$(sudo cat /opt/agentcoin/data-agtx/admin-token.txt)
curl -s -X POST http://127.0.0.1:9335/peer/add -H "x-admin-token: $T" \
  -H 'Content-Type: application/json' -d '{"peer":"http://<node3-ip>:9335"}'
curl -s -X POST http://127.0.0.1:9335/sync-now -H "x-admin-token: $T" | head -c 400; echo
```

## Замыкание mesh (на node2 и node3 добавить друг друга + node1)

На каждом из node2/node3 (loopback + свой токен):

```bash
T=$(sudo cat /opt/agentcoin/data-agtx/admin-token.txt)
for P in http://<node1-ip>:9335 http://<node2-ip>:9335 http://<node3-ip>:9335; do
  curl -s -X POST http://127.0.0.1:9335/peer/add -H "x-admin-token: $T" \
    -H 'Content-Type: application/json' -d "{\"peer\":\"$P\"}"; echo
done
curl -s -X POST http://127.0.0.1:9335/sync-now -H "x-admin-token: $T" | head -c 300; echo
```

Проверка mesh (с любого сервера): все три `/life` — один `tipHash`,
`/ws/status` — `wsPeers > 0`, `/peers/meta` — accepted растёт без strikes.

## Кран A3 (после mesh, на ОДНОЙ ноде — node2)

Фонд крана читается из env при старте, поэтому:

```bash
T=$(sudo cat /opt/agentcoin/data-agtx/admin-token.txt)
# 1) кошелёк фонда:
curl -s -X POST http://127.0.0.1:9335/wallet/create -H "x-admin-token: $T" \
  -H 'Content-Type: application/json' -d '{"label":"faucet-fund","recover":true}'
#    → записать address; mnemonic — один раз оператору
# 2) профинансировать майнингом (3 блока × 50 = 150 AGT):
FUND=<address>; for i in 1 2 3; do
  curl -s -X POST http://127.0.0.1:9335/mine -H "x-admin-token: $T" \
    -H 'Content-Type: application/json' -d "{\"miner\":\"$FUND\"}"; echo; done
# 3) прописать фонд в unit и перезапустить:
sudo sed -i "s|^ExecStart=|Environment=AGT_FAUCET_FUND=$FUND\nExecStart=|" /etc/systemd/system/agt-node.service
sudo systemctl daemon-reload && sudo systemctl restart agt-node
sleep 8; curl -s http://127.0.0.1:9335/life | jq '{blocks, chainValid}'
# 4) проверка выдачи:
curl -s -X POST http://127.0.0.1:9335/faucet/drip -H 'Content-Type: application/json' -d '{"address":"<AGT-адрес>"}'
#    → {"dripped":0.5,...}; повтор → 429 already_dripped_24h
```

Пилотный бюджет крана (решение владельца): 0.5 / 5 / 20 AGT — на стенде
проверены как суммы выплат; дневной лимит крана — 0.5/адрес, 10 адресов/IP.

## Выплаты A4 (на node2, после крана)

Фонд тот же (`$FUND`). Выплаты — подписанные tx с memo `payout:<кому>:<сумма>`.
Повтор того же txid отклоняется (`already_in_chain`) — проверено на стенде.
Шаблон (нужен `core.mjs` из репо + ключ фонда из `data-vps/wallets.json`):

```bash
node commission-payout.mjs http://127.0.0.1:9335   # существующий скрипт, 10 AGT/член
```

Для произвольных сумм — `treasury-payout.mjs` как образец (build/sign/submit +
ончейн-верификация по txid). Реестр получателей и сумм утверждает владелец.

## Пилот A3/A4: включение на одной ноде

Контуры включаются по отдельности env. Выбери одну ноду (рекомендую node2) **после**
проверки A2; перед включением сверь tip (`/life` → `tipHash`) с остальными узлами.
На остальных нодах пилотные переменные оставить пустыми. Требуется Node.js 24
(node:sqlite) и постоянный локальный `AGT_DATA_DIR`.

Env выбранной ноды (`/etc/agentcoin/pilot.env`, права 600, подключить в unit):
```bash
AGT_PILOT_FAUCET_FUND=AGT…        # адрес выделенного фонда крана (ключ в wallets.json ЭТОЙ ноды;
                                   # адрес ОТЛИЧЕН от фонда старого крана и фонда выплат)
AGT_PILOT_REVOKED_FILE=/opt/agentcoin/data-vps/pilot-revoked.json   # JSON-массив, напр. [] (обновлять атомарно)
AGT_PILOT_PAYOUT_FUND=AGT…        # адрес отдельного фонда выплат (ключ в закрытом контуре ЭТОЙ ноды)
AGT_PILOT_PAYOUT_REGISTRY=/opt/agentcoin/data-vps/pilot-registry.json # абсолютный путь, JSON-массив
# AGT_ADMIN_TOKEN уже обязателен (выплаты и восстановление — только по нему)
```
Запись реестра (`period` — дата понедельника UTC; суммы целые, 1 AGT = 1e9):
`{"operatorId":"node2-operator","period":"2026-11-09","address":"AGT…","amountMinor":1000000000}`

Прокси: наружу публиковать ТОЛЬКО `/faucet/pilot/challenge` и `/faucet/pilot/claim`;
`/pilot/*` — только 127.0.0.1 (пример nginx: `location /pilot/ { deny all; }` +
отдельный `listen 127.0.0.1` для операторских вызовов).

Команды оператора (с сервера выбранной ноды; `request.json` — утверждённая запись):
```bash
jq '. + {execute:false}' request.json | curl --fail-with-body -sS -H "x-admin-token: $AGT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @- "$AGT_PILOT_LOCAL_URL/pilot/payout"
# после eligible — тот же запрос с execute:true (повтор вернёт тот же txid)
curl -sS -H "x-admin-token: $AGT_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @- "$AGT_PILOT_LOCAL_URL/pilot/reconcile" <<< '{}'   # после рестарта/сбоя
curl -sS -H "x-admin-token: $AGT_ADMIN_TOKEN" "$AGT_PILOT_LOCAL_URL/pilot/status"  # контуры, счётчики
```
Точный путь журнала: `AGT_DATA_DIR` службы (`Environment=AGT_DATA_DIR=/opt/agentcoin/data-vps` в unit из `scripts/deploy-vps.sh`) + `pilot-payments.sqlite` (открывается `withDb` на операцию и закрывается — висячих блокировок нет). Итого: `/opt/agentcoin/data-vps/pilot-payments.sqlite` (НЕ `data-agtx/` — там только `admin-token.txt`). Фактический dataDir подтвердить выводом `systemctl cat agt-node` на выбранной ноде до работ (пока — по скрипту деплоя, сверено с кодом).
Резервная копия (на выбранной ноде, пилотный журнал ведёт и подписывает ТОЛЬКО она).
Сценарий 1 — первый запуск (базы ещё нет): служба создаёт `pilot-payments.sqlite` при первом вызове контура (`CREATE TABLE IF NOT EXISTS` в `withDb`); проверять: файл появился, `GET /pilot/status` (loopback) → 200 со счётчиками. Отдельный бэкап пустого журнала не нужен.
Сценарий 2 — база есть (порядок строгий, архив проверить ДО перезапуска):
```bash
sudo systemctl stop agt-node
sudo tar -czf /root/agt-pilot-$(date +%F).tgz -C /opt/agentcoin data-vps/wallets.json data-vps/pilot-revoked.json data-vps/pilot-registry.json data-vps/pilot-payments.sqlite
sudo tar -tzf /root/agt-pilot-$(date +%F).tgz   # архив содержит все 4 файла — только потом дальше
sudo systemctl start agt-node
sleep 8; curl -s http://127.0.0.1:9335/life | jq '{blocks, chainValid}'
```
Целостность копии (на выгруженном файле, службой не держится): открыть через `node:sqlite` и выполнить `PRAGMA integrity_check` → `ok`. Процедура проверена локально реальным кодом `pilot.mjs`: `node tools/stand/verify-pilot-backup.mjs` → 13/13 (создание базы первым запуском, claim→pending, копия→integrity ok→tar→снос→восстановление→тот же challenge и reconcile→pending с тем же txid).
Проверка маршрутов через фактический прокси (снаружи — только безопасные запросы, без токена, состояние не меняют).
Факт 2026-11-09 ~15:42–15:43 UTC по `https://agentcoin.work`:
- `GET /pilot/status` → `200`, `Content-Type: text/html; charset=utf-8`, `Server: Caddy`, тело — HTML-лендинг. Это попадание в fallback сайта, НЕ ответ ноды: явного отказа прокси нет, маршрут к ноде не проброшен.
- `POST /faucet/pilot/challenge` с `{}` и с `{"address":"AGTX"}` → `405`, пустое тело (статика края). `POST /faucet/pilot/claim`, `POST /pilot/payout`, `POST /pilot/reconcile` с `{}` → `405`. POST-405 не проверяет защиту GET — см. GET выше.
- Проверка с админ-токеном — ТОЛЬКО loopback на самой ноде (пример ниже); по публичному URL токен не передавать и не проверять.
Текущее состояние: пилотные маршруты к ноде НЕ проброшены — `/pilot/*` закрыт по умолчанию, кран снаружи недоступен (ожидаемо до запуска).
Ожидаемое после настройки (край публикует ТОЛЬКО два POST, остальное deny):
| Запрос (снаружи, без токена) | Ожидаемо | Почему |
|---|---|---|
| `POST /faucet/pilot/challenge` `{}` | `400 bad_params` | контур включён, валидация тела до создания — записи нет |
| `POST /faucet/pilot/challenge` `{"address":"AGTX"}` | `400 bad_address` | формат до паспорта/лимитов, записи нет |
| `POST /faucet/pilot/claim` `{}` / мусор | `400 bad_params` | строгий формат id/подписи |
| `POST /faucet/pilot/claim` чужая/неверная подпись | `403 bad_signature` (тело `{"error":"bad_signature"}`) | challenge НЕ гасится |
| контур выключен (нет `AGT_PILOT_FAUCET_FUND`) | `503 pilot_faucet_disabled` / `503 pilot_payout_disabled` | до любых проверок тела |
| `GET /pilot/status`, `POST /pilot/payout`, `POST /pilot/reconcile` | отказ края (4xx) — НЕ JSON ноды | `/pilot/*` наружу не публиковать |
Команды (снаружи — без токена; с токеном — только loopback выбранной ноды):
```bash
curl -sS -D- -o /dev/null https://<pilot-host>/pilot/status            # снаружи: ждём НЕ-JSON (HTML fallback или отказ края), фиксируем Content-Type
curl -sS -X POST https://<pilot-host>/faucet/pilot/challenge -H 'Content-Type: application/json' -d '{}'   # снаружи: 400 bad_params, без токена
curl -sS -H "x-admin-token: $AGT_ADMIN_TOKEN" http://127.0.0.1:9335/pilot/status   # ТОЛЬКО loopback: 200, контуры и счётчики
```
`/pilot/*` наружу не публиковать (deny на прокси; операторские вызовы — только loopback).
Восстановление/перенос и откат (строгий порядок): 1) закрыть публичные маршруты крана на прокси (deny); 2) остановить службу; 3) восстановить файлы из архива (проверить `tar -tzf` и `integrity_check`); 4) убрать пилотные env для отключения (рестарт); 5) журнал (`pilot-payments.sqlite`), реестр и txid сохранить — сверка по ним продолжается вручную (`recorded` с причиной = платёж зарезервирован исходной подписью). При переносе остановить старый экземпляр ДО запуска нового.
`recorded` с причиной = платёж зарезервирован исходной подписью, требует разбора/сверки.
Остановка пилота и откат конфигурации: убрать пилотные env + рестарт; журнал
(`pilot-payments.sqlite`), реестр и txid сохранить — сверка по ним продолжается вручную.
Рабочая приёмка (после утверждения сервера, фондов и реестра владельцем): совпадение цепи
с соседней нодой; публичный запрос крана + отказ без токена (команды выше); одна
согласованная выдача крана и одна выплата оператору после dry-run; зафиксировать полные
txid, высоты блоков и изменения балансов.
Стенд API: `node tools/stand/stand-a5.mjs` (43/43: кран, привязка challenge к сети/аудитории,
лимиты, пустой фонд → `fund_insufficient` без записи (t1.2), отказ после подписи →
`recorded`+txid+причина (t5.11c–e), различие точного дубля txid и конфликта по nonce
(t5.11b), потеря mempool (t2.6/t5.6c), откат блока к снимку chain.json с восстановлением
тех же txid (t5.10), выплаты, V1 до порога и v2-подпись за порогом `AGT_TX_DIGEST_V2_HEIGHT`,
рестарт, fail-closed). Откат через снимок — имитация потери блока на стенде.
Формат challenge — JSON-массив `['agentcoin:faucet:v1', chainId, audience, …]`; формат tx пилот
следует порогу v2 сети (до порога v1, после — v2 с chainId).

## Что остаётся за владельцем (заблокировано без него)

- Upstream `agentcoin.work`: к какому физическому узлу вести, кто оператор.
- Подтверждение node1 (DNS/роль) — в roster его нет.
- Бюджет пилота крана и реестр выплат A4.
