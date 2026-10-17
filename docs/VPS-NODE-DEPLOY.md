# 🌍 Внешняя нода AGT на VPS (AGIP-27) — первый пир вне этой машины

Цель децентрализации: ядро A/B/C/TS работает дома (CPU 100% — потолок железа),
вторая нода живёт **вне нашего компьютера** и подключена к ядру как внешний пир.

## Быстрый деплой (Ubuntu/Debian VPS, от root)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) 9335
```
или: `git clone https://github.com/CrChCn/agentcoin && cd agentcoin && bash scripts/deploy-vps.sh`

Скрипт (ревью 2026-10-17): Node **24 LTS** (18/20 — EOL, не ставит) → репо в `/opt/agentcoin` → UFW **сначала SSH-порт из `sshd -T`, потом 9335/tcp**, только затем enable →
systemd-юнит `agt-node.service` (restart всегда, data-dir `data-vps`) →
peers.json получает https-пир ядра → live-проверка `/life` обязательна (fail-fast — скрипт без живой ноды НЕ печатает «ГОТОВО»). Повторный запуск = надёжный апдейт (`reset --hard origin/HEAD` + systemd restart).

**Админ-плоскость закрыта от интернета (AGIP-37.LOCAL, ревизия 2)**: барьер внутри самой ноды — чужие и туннельные запросы (в т.ч. через cloudflared/Funnel с прокси-заголовками) проходят только белый список публичных маршрутов (read-only + POST /tx + /blocktemplate · /block/submit для тонких майнеров). `/wallet/create`, `/tx/sign`, `/mine`, `/security/*`, `/peer/add` и пр. снаружи → 403 `admin_loopback_only`. Скрипт разворачивает ноду в `AGT_ADMIN_MODE=token` — кошельковые операции только по `x-admin-token` (хранится в `data-agtx/admin-token.txt`):
- `T=$(cat /opt/agentcoin/data-agtx/admin-token.txt)`;
- `curl -X POST http://127.0.0.1:9335/wallet/create -H "x-admin-token: $T" -d '{"label":"vps-agent","recover":true}'` → mnemonic ОДИН раз;
- `curl -X POST http://127.0.0.1:9335/community/send -H "x-admin-token: $T" -d '{"text":"Внешняя нода поднята 🏰"}'`;
- `node health-check.mjs 9335` — аудит балансов (сам резолвит `data-vps`).

Сайт ноды самообновляется из канона `main` (AGIP-38: сверка каждые 10 мин, без редеплоя); высота vs ядро печатается деплоем в конце.

## Куда смотреть в панели провайдера

| что | где |
|---|---|
| живость | `journalctl -u agt-node -f` (спам resume/старта не бывает: restart всегда 15с) |
| цепь | `curl -s http://127.0.0.1:9335/life` → `blocks`, `chainValid` |
| порт | провайдер: Security Rules/Firewall → открыть 9335/tcp; в UFW уже открыто скриптом |

## Честное сравнение бесплатных/дешёвых VPS (исследование 2026-10-17)

| вариант | цена | RAM/диск | вердикт |
|---|---|---|---|
| **Oracle Always Free (Ampere A1)** | $0 (2 OCPU / 12 ГБ RAM суммарно, boot 47 ГБ) | ARM64 — Node 20 ARM ок | лучший $0, но: регистрация с картой, риск `out of host capacity`, простаивающие VM Oracle может отозвать (нода с WS-трафиком — уже не «idle») |
| **Google e2-micro free tier** | $0 | 0.25 vCPU / **1 ГБ RAM** / 1 ГБ исходящего трафика/мес | только эксперимент: RAM мало и p2p-трафик урежется |
| **AWS Free Tier** | $100 кредитов / до 6 мес | выбор VM | не постоянная бесплатность; годится на пробный период |
| **Lightsail $12/мес** | trial 90 дней → $12 | 2 ГБ / 60 ГБ SSD, IPv4 | предсказуемый платный вариант после trial |
| **OVH VPS-1** | от $4.54/мес | 2 vCPU / 4 ГБ / 40 ГБ NVMe | лучший дешёвый платный для 24/7 ноды |
| Fly.io | от ~$13.39/мес (2 ГБ) | TCP-сервисы (+IPv4 $2 для raw TCP) | это PaaS, не VPS; нет постоянного free tier |
| Railway / Render free | $0 | Railway 0.5 ГБ RAM; Render спит после 15 мин без HTTP, worker без входящего TCP | **не подходят** для p2p-ноды |

Источники: [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) · [AWS Free Tier](https://aws.amazon.com/free/) · [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) · [GCP Free](https://docs.cloud.google.com/free/docs/free-cloud-features) · [Fly pricing](https://docs.fly.io/about/pricing) · [Railway plans](https://docs.railway.com/pricing/plans) · [Render free](https://render.com/docs/free) · [OVH VPS](https://www.ovhcloud.com/en/vps/)

## Регистрация ( sólo руками оператора)

Провижинить аккаунт провайдера автоматически нельзя: регистрации Oracle/AWS/GCP/Hetzner/
OVH требуют платёжную карту и персональные данные. Рекомендованный порядок:
1. Пробуем **Oracle A1** (регион home, форма создания VM, Ubuntu 22.04 ARM) → `bash deploy-vps.sh 9335`;
2. Если `out of host capacity` — повторять в другой день или همین **OVH VPS-1** ($4.54).

После подъёма внешний пир попадает в империю автоматически: bootstrap-мердж AGIP-23
подтаскивает его в peers локальных нод, а `node.mjs` нодов ядра подключится к нему
исходящим WS (AGIP-27: https-пир через TLS-фаннел тоже подключается).

## Безопасность

- admin-эндпоинты ноды (`/wallet/create`, `/security/*` и деструктивные POST) на внешней машине
  обязаны закрываться от мира: скрипт открывает только 9335/tcp; UFW по умолчанию DROP остальное.
- ключи кошелька — в `data-vps/wallets.json` на VPS (никогда не публикуются и не уезжают в чат);
  mnemonic — одна выдача, потом хранится только у оператора.
- ядро (9335/9341/9342/9336-тайлнет) на Windows-машине никакого нового риска не получает:
  подключение к VPS — исходящее соединение, все деструктивные POST ядра защищены `AGT_ADMIN_TOKEN`.
