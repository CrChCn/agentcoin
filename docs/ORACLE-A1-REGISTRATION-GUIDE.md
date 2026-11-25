# 🏰 Гайд: регистрация Oracle Always Free и создание первой внешней ноды (Ampere A1)

Актуально по документации Oracle на 2026-10-17. Регламент Oracle может меняться — сверяйся по официальным страницам (ссылки внизу).

---

## Часть 1. Регистрация (15–20 минут)

Подготовка: **чистое окно браузера без VPN/proxy**, личный email (один аккаунт на email), и **карта** (или дебетовая карта с Visa/MC, без PIN-транзакций).

| # | Шаг | Что заполнить |
|---|---|---|
| 1 | Открой [signup.oraclecloud.com](https://signup.oraclecloud.com) | **Country**: реальная страна проживания (Latvia → Latvia) |
| 2 | **Name** | Имя латиницей, как в паспорте/карте |
| 3 | **Email** | Рабочий адрес; Oracle пришлёт ссылку подтверждения — она живёт **30 минут** |
| 4 | **CAPTCHA → Verify my email** | Перейди по ссылке из письма |
| 5 | **Password** | ≥8 символов: строчные+заглавные, цифра, спецсимвол; максимум 40; без фамилии и email внутри |
| 6 | Company name | Можно пропустить |
| 7 | **Cloud account name** | Уникальное имя tenancy (например, `agtmperorc`) — потом будет логин-адресом консоли |
| 8 | **Home Region** | ⚠ Смотри Часть 2 — после регистрации регион нельзя менять |
| 9 | Address + phone | Реальные: адрес (как у карты), номер телефона; возможен SMS/ звонок-верификация |
| 10 | **Payment verification → Credit Card** | Данные карты; возможна временная авторизация (не списание) |
| 11 | Условия → **Start my free trial** | Готово |

**После регистрации**: Oracle пришлёт приветственное письмо, а консоль откроется по адресу `https://cloud.oracle.com` — вход с_cloud account name.

---

## Часть 2. Выбор Home Region (решение навсегда)

Always Free **compute (включая Ampere A1) создаётся ТОЛЬКО в home region**, и поменять его нельзя. Отталкиваемся от задержки и вероятности свободной ёмкости:- Для Восточной Европы (Latvia) ближайшие регионы: `eu-frankfurt-1`, `eu-amsterdam-1`, `eu-stockholm-1`, `eu-madrid-1`;
- «популярные» регионы (Amsterdam) чаще заняты → риск «out of host capacity»; Frankfurt/Stockholm/Madrid по опыту чаще дают свободную ёмкость;
- у региона может быть несколько **Availability Domain (AD)** — если в одном AD нет ёмкости, пробуй другой AD того же региона (не другой регион!);
- исключение в Always Free: A1 нельзя создавать в `South Korea North (Chuncheon)`;
- **capacity reservation для Free Tier недоступна** — закрепить машину «на будущее» нельзя, только попытки по мере появления.

Практика: бери регион, где планируешь жить; если «out of host capacity» — пробуй другой Availability Domain или повторяй позже (ёмкость устраивается раними утра́ во вторник-четверг).

---

## Часть 3. Создание ноды (Ampere A1, Always Free)

1. Console (public region = home) → **Compute → Instances → Create instance**.
2. **Placement**: выбери Availability Domain (если не ёмкости — проверь другой AD).
3. **Image**: Ubuntu 22.04 (ARM, «aarch64» — совместимый с Arm выбирай в этом окне).
4. **Shape**: `VM.Standard.A1.Flex`.
   - Лимит Always Free A1 по документации Oracle: **2 OCPU и 12 ГБ RAM суммарно** на tenancy (не больше — инстанс не станет «Always Free Eligible»). Больше нужно — переключи в платный (не надо).
   - Проверяй бейдж **Always Free eligible** на шаге shape.
5. **Boot volume**: ≥ 50 GB (минимум Oracle 47 GB; у tenancy есть 200 GB Always Free block storage суммарно).
6. **Сеть**: дефолтный VCN/subnet + **публичный IP**. В Security List/NSG:
   - TCP 22 (SSH) — только твой IP;
   - **TCP 443 (HTTPS)** — Caddy-фасад ноды; сам узел слушает только 127.0.0.1:9335, порт ноды наружу не открывается.
7. **SSH public key** — вставь `~/.ssh/id_ed25519.pub`.
8. **Create** → ждём `Running` → ssh: `ssh -i <key> ubuntu@<public_ip>` (пользователь `ubuntu`).

---

## Часть 4. Поднять ноду AGT (одной командой)

На VM (Ubuntu):

```bash
export LOCAL_NODE_URL="http://127.0.0.1:9335"  # порт ноды фиксирован; наружу — только 443 через Caddy
# SEEDS — ваши выбранные доступные соседи (обычно https://node1.agentcoin.work и рядом).
bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) nodeX.agentcoin.work ./dist/node/agentcoin-node-0.1.1.tar.gz "$SEED1" "$SEED2"
```

Скрипт сам: бандл Node **24 LTS** (системный nodejs не ставит) → код из релизного тарболла в `/opt/agentcoin-node/src` → systemd `agentcoin-node.service` (loopback, `ADMIN local`, данные `/opt/agentcoin-node/data`) → пример Caddy-dark для 443 (вставляется руками) → cron бэкапов → fail-fast: живость `/life` — обязательное условие «ГОТОВО».

> ⚠️ Повторный install поверх живой ноды скрипт запрещает. Обновления — только `scripts/rollout-node-update.sh` (файловая раскатка, см. `docs/VPS-NODE-DEPLOY.md`, раздел «Обновления»).

Кошелёк и все админ-операции — **только через SSH на loopback** (нода слушает `127.0.0.1`, `ADMIN local`; снаружи Caddy отдаёт 403 `reserve node: dark`):

```bash
# на VM (после ssh ubuntu@<ip>):
curl -s "$LOCAL_NODE_URL/life"     # → blocks, chainValid=true
journalctl -u agentcoin-node -f      # логи ноды

# кошелёк VPS-агента (mnemonic выдаётся ОДИН раз — записать!):
curl -X POST "$LOCAL_NODE_URL/wallet/create" \
  -H 'Content-Type: application/json' \
  -d '{"label":"oracle-a1-agent","recover":true}'

# анонс в империю:
curl -X POST "$LOCAL_NODE_URL/community/send" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Внешняя нода Oracle A1 поднята 🏰"}'

# хелсчек балансов из цепи (из клона репозитория):
AGT_NODE_URL="$LOCAL_NODE_URL" node health-check.mjs
```

Проверяйте свой `NODE_URL` с отдельной машины. Loopback в командах выше — сам VPS, на котором открыт SSH, а не компьютер автора. Сайт, выпуск программы и политика обновлений принадлежат владельцу развёртывания.

Чтобы другой участник начал подключаться к вашей ноде, он должен явно добавить ваш доступный URL в собственные peers. На его **собственной** машине команды могут выглядеть так:

```bash
: "${LOCAL_NODE_URL:?Set this participant local admin node URL}"
: "${PEER_URL:?Set the newly deployed reachable peer URL}"
node -e 'process.stdout.write(JSON.stringify({peer:process.env.PEER_URL}))' |
  curl -fsS --max-time 15 -X POST "$LOCAL_NODE_URL/peer/add" -H 'Content-Type: application/json' --data-binary @-
```

Здесь `PEER_URL` экспортируется владельцем и содержит ваш новый публичный/VPN-адрес. Никакой обязательной «ноды ядра» на чужом ноутбуке нет. Нужны совпадающие сеть/genesis и независимая проверка блоков. Для TS используйте свою VPN и собственный `AGT_TS_BIND`/`data-agtx/ts-bind.txt`, а не готовый IP из чужого развёртывания.

---

## Частые причины отказа регистрации и что делать

- **Карта отклонена** → спросить банк: разрешены ли онлайн-авторизации на имя Oracle; попробовать другую карту (Visa/MC с 3DS).
- **Данные не совпадают** (страна/IP/адрес карты) → всё честно, без VPN, реальный адрес.
- **Email уже занят**: один аккаунт на email; не плодить попытки, пока не разберётесь по письму от Oracle (Support).
- Форма подчёркивает несовпадение платёжного адреса → исправить PAYMENT ADDRESS до отправки заявки.

## Ограничения Always Free (важно для ноды)

- **10 TB исходящего трафика/мес суммарно** на tenancy (нода с WS-госсипом укладывается с запасом).
- Oracle может отзывать «идле»-VM (низкая CPU/сеть/память за 7 дней): наша нода с постоянным WS и mining маячком — не идле, но отслеживай VM в Console.
- Выход за Always Free лимиты = платный бил(compute): не создавать лишние VM/блок-томов.
- Capacity reservation — недоступна на Free Tier (не «бронирую capacity», только повторять попытки).

---

## Источники (официальные страницы Oracle)

- [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/) · [Free Tier документация](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)
- [Sign Up for Free Oracle Cloud Promotion](https://docs.oracle.com/en-us/iaas/Content/GSG/Tasks/signingup_topic-Sign_Up_for_Free_Oracle_Cloud_Promotion.htm)
- [Always Free Resources (shape/лимиты/услуги)](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Regions and Availability Domains](https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm) · [Creating an Instance](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/launchinginstance.htm)
- [Первый Linux инстанс (ssh)](https://docs.oracle.com/en-us/iaas/Content/Compute/tutorials/first-linux-instance/overview.htm)
- [Сервис-лимиты (capacity reservation не для Free)](https://docs.oracle.com/en-us/iaas/Content/General/service-limits/default.htm)
