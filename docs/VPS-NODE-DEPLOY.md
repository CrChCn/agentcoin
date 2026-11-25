# 🌍 Внешняя нода AGT на VPS (AGIP-27) — первый пир вне этой машины

Цель: нода в собственной среде владельца, со своими адресами и явно выбранными пирами. Кластер автора и его tailnet не являются обязательной инфраструктурой. `127.0.0.1` в командах означает VPS, на котором вы выполняете их по SSH.

## Быстрый деплой (Ubuntu/Debian VPS, от root)

```bash
export LOCAL_NODE_URL="http://127.0.0.1:9335"  # порт ноды фиксирован; наружу открывается только 443 через Caddy
# SEEDS — ваши выбранные доступные соседи (обычно https://node1.agentcoin.work и рядом); без них нода стартует без пиров.
bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) nodeX.agentcoin.work ./dist/node/agentcoin-node-0.1.1.tar.gz "$SEED1" "$SEED2"
```
или из клона: `git clone https://github.com/CrChCn/agentcoin && cd agentcoin && bash scripts/deploy-vps.sh <site-hostname> <release-tgz> [seed-url...]`  
(релизный тарболл собирается штатно: `VERSION=x.y.z bash packaging/node/build.sh`)

Скрипт: бандл Node **24 LTS** в `/opt/agentcoin-node/runtime` (системный nodejs не ставится; ветки 18/20 — EOL) → код из релизного тарболла в `/opt/agentcoin-node/src` →
systemd-юнит `agentcoin-node.service` (restart всегда, данные `/opt/agentcoin-node/data`, `BIND 127.0.0.1`, `ADMIN local`) → пример Caddy-dark для 443 (печатается, вставляется руками + дописать IP пиров; `/ws` — локально, `/health`+`/life` пирам — локально через `@peerHealth` (иначе мониторинг видит зеркало node1), остальное пирам — прокси на node1, всем прочим 403) → cron ежедневных бэкапов данных (03:20, keep 14 дней) → live-проверка `/life` обязательна (fail-fast — без живой ноды install провален).

## Обновления (git на хостах НЕТ — только файловой раскаткой)

1. Локально подготовить новый `node.mjs` (контекст сверен с живой копией хоста, `node --check` чист) и узнать md5 текущей копии на хосте.
2. `scp new-node.mjs root@<host>:/root/node.mjs.new` и `scp scripts/rollout-node-update.sh root@<host>:/root/`.
3. На хосте: `bash /root/rollout-node-update.sh /root/node.mjs.new <md5-текущего>` — скрипт сверит базу, сделает бэкап кода и данных, поставит файл, прогонит `node --check` бандл-рантаймом, рестартанёт юнит, дождётся живости и проверит журнал.
4. Tip сверить с H1 (`https://agentcoin.work/life`): лаг в 1–2 блока — норма gossip-синхронизации, смотреть прямые loopback-чтения, а не только `/network/nodes`.
Откат: `ROLLBACK=1 bash /root/rollout-node-update.sh` (возвращает свежий `.bak-*`, рестарт, проверка).

**Админ-плоскость закрыта от интернета**: нода слушает только loopback (`AGT_ADMIN_MODE=local`), наружу — только Caddy-dark (`POST /tx/sign`, `/wallet/create` и прочие непубличные пути с интернета → 403 `reserve node: dark`). Кошельковые операции — только по SSH на loopback, без токенов:
- `curl -s "$LOCAL_NODE_URL/life"` → `blocks`, `chainValid`;
- `curl -X POST "$LOCAL_NODE_URL/wallet/create" -d '{"label":"vps-agent","recover":true}'` → mnemonic ОДИН раз;
- `curl -X POST "$LOCAL_NODE_URL/community/send" -d '{"text":"Внешняя нода поднята 🏰"}'`;
- `node health-check.mjs` из клона репозитория — аудит балансов из цепи.

Сайт и политика обновлений принадлежат владельцу развёртывания. Адрес для посетителей публикуется как собственный `NODE_URL`; состояние сравнивают с выбранными пирами, если они настроены.

## Куда смотреть в панели провайдера

| что | где |
|---|---|
| живость | `journalctl -u agentcoin-node -f` (рестарт всегда через 15с) |
| цепь | `curl -s "$LOCAL_NODE_URL/life"` → `blocks`, `chainValid` |
| порт | наружу только `443/tcp` (Caddy); порт ноды `9335` — только loopback, в фаерволе не открывается |

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
1. Пробуем **Oracle A1** (регион home, форма создания VM, Ubuntu 22.04 ARM) → `bash deploy-vps.sh <site-hostname> <release-tgz> [seed-url...]`;
2. Если `out of host capacity` — повторять в другой день или همین **OVH VPS-1** ($4.54).

Подключение к существующей сети требует доступных выбранных соседей: передайте их URL при деплое (параметры seed-url → `AGT_SEED_NODES`). Сам факт установки VPS не делает его известным всем остальным участникам. Соседи настраивают ваши URL у себя независимо.

## Безопасность

- admin-эндпоинты ноды (`/wallet/create`, `/security/*` и деструктивные POST) доступны только с loopback самой машины; наружу скрипт ничего не открывает: Caddy отдаёт 403 dark всему, кроме `/ws` и явно перечисленных пиров.
- ключи кошелька — в `/opt/agentcoin-node/data/wallets.json` на VPS (никогда не публикуются и не уезжают в чат);
  mnemonic — одна выдача, потом хранится только у оператора.
- подключение к другому владельцу не передаёт ему административные права; свои `/peer/add`, подпись и кошельковые операции выполняйте с авторизацией только на своей ноде.
- TS bind на Windows — собственный `AGT_TS_BIND` или ignored `data-agtx/ts-bind.txt`; публичный пример не содержит адреса VPN другого владельца.
