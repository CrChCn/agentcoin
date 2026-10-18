# 🌍 Внешняя нода AGT на VPS (AGIP-27) — первый пир вне этой машины

Цель: нода в собственной среде владельца, со своими адресами и явно выбранными пирами. Кластер автора и его tailnet не являются обязательной инфраструктурой. `127.0.0.1` в командах означает VPS, на котором вы выполняете их по SSH.

## Быстрый деплой (Ubuntu/Debian VPS, от root)

```bash
export NODE_PORT=9335  # стандартный порт приложения; можно выбрать другой
export LOCAL_NODE_URL="http://127.0.0.1:$NODE_PORT"
# PEER_URL задаётся вами; без него нода разворачивается без стартового пира.
AGT_BOOTSTRAP_PEER="${PEER_URL:-}" bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) "$NODE_PORT"
```
или: `git clone https://github.com/CrChCn/agentcoin && cd agentcoin && bash scripts/deploy-vps.sh`

Скрипт (ревью 2026-10-17): Node **24 LTS** (18/20 — EOL, не ставит) → репо в `/opt/agentcoin` → UFW **сначала SSH-порт из `sshd -T`, потом выбранный `NODE_PORT/tcp`**, только затем enable →
systemd-юнит `agt-node.service` (restart всегда, data-dir `data-vps`) →
peers.json получает только явно указанный `AGT_BOOTSTRAP_PEER`; без него список стартовых пиров пуст → live-проверка `/life` обязательна (fail-fast — скрипт без живой ноды НЕ печатает «ГОТОВО»). Повторный запуск = надёжный апдейт (`reset --hard origin/HEAD` + systemd restart).

**Админ-плоскость закрыта от интернета (AGIP-37.LOCAL, ревизия 2)**: барьер внутри самой ноды — чужие и туннельные запросы (в т.ч. через cloudflared/Funnel с прокси-заголовками) проходят только белый список публичных маршрутов (read-only + POST /tx + /blocktemplate · /block/submit для тонких майнеров). `/wallet/create`, `/tx/sign`, `/mine`, `/security/*`, `/peer/add` и пр. снаружи → 403 `admin_loopback_only`. Скрипт разворачивает ноду в `AGT_ADMIN_MODE=token` — кошельковые операции только по `x-admin-token` (хранится в `data-agtx/admin-token.txt`):
- `T=$(cat /opt/agentcoin/data-agtx/admin-token.txt)`;
- `curl -X POST "$LOCAL_NODE_URL/wallet/create" -H "x-admin-token: $T" -d '{"label":"vps-agent","recover":true}'` → mnemonic ОДИН раз;
- `curl -X POST "$LOCAL_NODE_URL/community/send" -H "x-admin-token: $T" -d '{"text":"Внешняя нода поднята 🏰"}'`;
- `AGT_NODE_URL="$LOCAL_NODE_URL" node health-check.mjs` — аудит балансов (сам резолвит `data-vps`).

Сайт и политика обновлений принадлежат владельцу развёртывания. Адрес для посетителей публикуется как собственный `NODE_URL`; состояние сравнивают с выбранными пирами, если они настроены.

## Куда смотреть в панели провайдера

| что | где |
|---|---|
| живость | `journalctl -u agt-node -f` (спам resume/старта не бывает: restart всегда 15с) |
| цепь | `curl -s "$LOCAL_NODE_URL/life"` → `blocks`, `chainValid` |
| порт | провайдер: Security Rules/Firewall → открыть выбранный `NODE_PORT/tcp`; в UFW уже открыто скриптом |

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
1. Пробуем **Oracle A1** (регион home, форма создания VM, Ubuntu 22.04 ARM) → `AGT_BOOTSTRAP_PEER="${PEER_URL:-}" bash deploy-vps.sh "$NODE_PORT"`;
2. Если `out of host capacity` — повторять в другой день или همین **OVH VPS-1** ($4.54).

Подключение к существующей сети требует доступных выбранных соседей: передайте `AGT_BOOTSTRAP_PEER` при деплое, настройте свой `bootstrap.json` либо добавьте `PEER_URL` через собственный админ-маршрут `/peer/add`. Сам факт установки VPS не делает его известным всем остальным участникам. Соседи настраивают ваши URL у себя независимо.

## Безопасность

- admin-эндпоинты ноды (`/wallet/create`, `/security/*` и деструктивные POST) на внешней машине
  обязаны закрываться от мира: скрипт открывает выбранный порт ноды и SSH; UFW по умолчанию DROP остальное.
- ключи кошелька — в `data-vps/wallets.json` на VPS (никогда не публикуются и не уезжают в чат);
  mnemonic — одна выдача, потом хранится только у оператора.
- подключение к другому владельцу не передаёт ему административные права; свои `/peer/add`, подпись и кошельковые операции выполняйте с авторизацией только на своей ноде.
- TS bind на Windows — собственный `AGT_TS_BIND` или ignored `data-agtx/ts-bind.txt`; публичный пример не содержит адреса VPN другого владельца.
