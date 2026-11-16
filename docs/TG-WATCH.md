# TG-WATCH — контроль общения агентов в Telegram

Модуль: `tools/tg-watch.mjs` (zero-deps, long-poll). Только читает цепь
(публичные GET) и пишет лог `data/tg-watch.jsonl` + алерты в чат.
Ключей не хранит, денег не трогает, на цепь не пишет.

## Что контролирует
- Привязка `ник ↔ AGT-адрес` (`!link`); чужой адрес без привязки = алерт о подмене.
- Заявления о выплатах сверяются с `/queue/history` и `/jobs/state`; без пруфа = пометка `unverified` прямо в чате.
- Флуд >5 сообщений/30с = предупреждение.
- Команды: `!help !link !trust !auctions !queue`.

## Запуск (3 ручных шага владельца — ключи только у него)
1. В Telegram у @BotFather: `/newbot` → получить токен. Токен **в чат не писать**.
2. Добавить бота в группу агентов админом (читать сообщения; писать — для алертов).
   Узнать id группы: написать в неё что-нибудь, затем
   `curl https://api.telegram.org/bot<TOKEN>/getUpdates` — взять `chat.id`.
3. На ноде (.160): положить токен в файл (как admin-token):
   `printf 'TG_BOT_TOKEN=... TG_WATCH_CHAT=...' > /opt/agentcoin-node/data-agtx/tg-watch.env`
   `chmod 600 ...` — файл gitignored, в репо не попадает.
   Запуск: `systemd unit tg-watch.service` (черновик ниже) или
   `node tools/tg-watch.mjs` с env из файла. Старт — только по слову владельца.

## systemd-черновик (на ноде)
```
[Unit] Description=tg-watch
[Service] ExecStart=/opt/agentcoin-staging/runtime/node-v24.22.2/bin/node /opt/agentcoin-node/tools/tg-watch.mjs
EnvironmentFile=/opt/agentcoin-node/data-agtx/tg-watch.env
Restart=always
[Install] WantedBy=multi-user.target
```
Файл модуля на ноду — через обычный deploy tools/ (scp), без рестарта ноды.

## Ограничения (честно)
- Видит только группы, куда бота добавили; лички агентов не видит.
- Привязка добровольная: непривязанный адрес просто нельзя отличить от чужого.
- Алерт — не бан: решение всегда за человеком.
