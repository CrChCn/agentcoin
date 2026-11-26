# Agentcoin net-monitor

Опрос сети каждые 3 минуты (systemd-таймер), алерты в Telegram.

## Что проверяет

- доступность каждой ноды (`/life`): DOWN — крит;
- свежесть tip (`fresh`, `tipAgeSec > 300`): STALE — крит;
- `chainValid=false` / `chainIssue`: CHAIN INVALID — крит;
- расхождение высот (> 6 блоков от лидера): LAG — варн;
- пиров < 2: LONELY; все пиры в одной подсети: ECLIPSE-RISK;
  пиры без реального IP: IP-BLIND — варны;
- рост счётчика `security.attacks`: разовое info;
- свой диск `/` (> 85%): DISK — варн;
- сроки TLS-сертификатов всех входов (< 21 дня): CERT — варн;
- суточный дайджест в 09:00 UTC: высоты, tip, пиры, диск, серты.

## Анти-флэппинг

Состояние — `/var/lib/agentcoin-net-monitor/state.json`: алерт уходит один
раз, recovery — при исчезновении проблемы, напоминание — раз в 6 часов.

## Кто рассылает (без координации)

Рассыльщик — первая живая нода по порядку `NODES` (по умолчанию node1).
Остальные молчат, пока все старшие мертвы, — в текст подставляется своё имя.
Дайджест шлёт только рассыльщик. Тройной спам исключён по построению.

## Установка на ноду

```sh
mkdir -p /opt/agentcoin-node/ops/net-monitor /var/lib/agentcoin-net-monitor
cp net-monitor.mjs /opt/agentcoin-node/ops/net-monitor/
cp agentcoin-net-monitor.service agentcoin-net-monitor.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now agentcoin-net-monitor.timer
node /opt/agentcoin-node/ops/net-monitor/net-monitor.mjs --once   # проверка
```

Без Telegram-токена работает в log-only режиме (exit 0, пишет в журнал).

## Telegram

Отдельный токен не нужен: монитор читает те же файлы, что и TG-бот
оператора (`/root/.watchdog.env`, `/root/.bot.env` — `TG_TOKEN`, `ADMIN_CHATS`),
плюс свой `/etc/agentcoin/notify.env` (приоритет выше). Проверка доставки:

```sh
node /opt/agentcoin-node/ops/net-monitor/net-monitor.mjs --self-test
```

Токен в репозиторий не попадает, в логи не печатается (видно только имя файла).

## Пороги (env, необязательно)

`STALE_SEC=300 LAG_BLOCKS=6 MIN_PEERS=2 DISK_PCT=85 CERT_DAYS=21
FETCH_TIMEOUT_MS=15000 REMIND_HOURS=6 DIGEST_HOUR_UTC=9`

## Ограничения (честно)

- Диски node2/node3 из опросов не видны — каждая нода следит только за своим.
- Падение самого монитора/таймера никто не сторожит — видно по отсутствию
  дайджеста и по тишине журнала (`journalctl -u agentcoin-net-monitor`).
