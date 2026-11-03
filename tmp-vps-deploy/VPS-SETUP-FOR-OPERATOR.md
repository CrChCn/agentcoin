# VPS-нода AGENTCOIN с публичным DNS и HTTPS — инструкция оператора (2026-10-21)

Собрано Buffy: провайдер **Hetzner CX22** (~€4/мес), домен **DuckDNS-субдомен**, доступ — SSH-ключ агента.

## Что уже готово (у агента)

- **SSH-ключ**: приватный лежит у агента на этой машине (`~/.ssh/agentcoin-vps/ed25519`).
  Публичный ключ — вставить в панель Hetzner:

  ```
  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII7YiZSjFWuANJFd0eErA1vsBLMum4wdPNR9DH9A6ZUt codebuff-agent-vps-20261021
  ```

- **Скрипт деплоя**: [tmp-vps-deploy/vps-https-setup.sh](vps-https-setup.sh) — обёртка над
  `scripts/deploy-vps.sh`: ставит ноду, поднимает Caddy + Let's Encrypt, закрывает 9335 наружу,
  оставляет 22/80/443, и падает, если `/life` не отвечает строго по **HTTPS** (fail-fast на каждом шаге).

## Что сделать тебе (10–15 минут)

1. **Регистрация Hetzner Cloud** — https://console.hetzner.cloud/register
   (карта/PayPal → New project в Cloud Console).
2. **Сервер**:
   - Location: любой близкий (Falkenstein / Nuremberg / Helsinki);
   - Image: **Ubuntu 24.04** (22.04 тоже ок);
   - Type: **CX22** (2 vCPU / 4 GB RAM);
   - SSH Key → «Add new key» → вставь публичный ключ агента выше;
   - Create & Buy.
3. **DuckDNS** (бесплатный публичный домен) — https://www.duckdns.org
   - Войди (GitHub/Google), создай субдомен, например `agentcointest` → будет `agentcointest.duckdns.org`;
   - IP-адрес укажи IPv4 сервера (его видно в панели Hetzner) → «update».
4. **Передай мне**: IPv4 сервера + выбранное имя `*.duckdns.org`.
   Пароли/токены сервисов мне не нужны — доступ только по SSH-ключу под `root`.

## Что я сделаю по SSH после твоего возврата

1. Залью `vps-https-setup.sh` на сервер (или использую локальную копию repo).
2. `DOMAIN=<имя>.duckdns.org bash vps-https-setup.sh` — полный деплой:
   Node 24 → репо → UFW → systemd → peer → barrier → Caddy → LE-сертификат → HTTPS-проверка.
3. **Проверка снаружи (не с сервера)**: `curl -s https://<имя>.duckdns.org/info`,
   `/life` (chainValid=true, блоки растут), `POST /tx/sign` снаружи → ожидаем 403 `admin_loopback_only`.
4. Подключение к сети: на локальной ноде — `POST /peer/add {url:"https://<имя>.duckdns.org"}`,
   сверка высот, наблюдение 10–15 минут синхронизации. Пир не получает никаких прав:
   админ-плоскость VPS-ноды остаётся закрытой снаружи (AGIP-37.LOCAL), доступ только по SSH.
5. После приёмки обновлю [docs/FRIEND-AGENT-TZ.md](../docs/FRIEND-AGENT-TZ.md): добавлю публичный
   `https://<имя>.duckdns.org` как вторую точку входа (genesis/issuer пины те же), чтобы
   агент друга подключался без Tailscale.

## Ограничения (честно)

- **Hetzner блокирует SMTP** — ноде не мешает (исходящей почты нет).
- Let's Encrypt требует **открытых 80/tcp и 443/tcp снаружи**: если создашь детальный
  Hetzner Firewall, добавь правила для 22/80/443; без панели-файрвола Hetzner порты не режет.
- DuckDNS при статическом IPv4 не требует скрипта обновления.
- bump цен: Hetzner CX22 сейчас ~€3.79/мес net price (проверь при заказе).

— Codebuff (Buffy)
