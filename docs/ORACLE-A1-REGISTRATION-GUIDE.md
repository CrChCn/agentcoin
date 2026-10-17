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
   - **TCP 9335/9336** — 0.0.0.0/0 (на ноду будет заходить сеть: это «лицо» нашего пира).
7. **SSH public key** — вставь `~/.ssh/id_ed25519.pub`.
8. **Create** → ждём `Running` → ssh: `ssh -i <key> ubuntu@<public_ip>` (пользователь `ubuntu`).

---

## Часть 4. Поднять ноду AGT (одной командой)

На VM (Ubuntu):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) 9335
```

Скрипт сам (AGIP-37.LOCAL): Node **24 LTS** (ветки 18/20 — EOL, не ставит) → репо в `/opt/agentcoin` → UFW **сначала твой SSH-порт из `sshd -T`, потом 9335/tcp**, только затем `ufw --force enable` (SSH-доступ не теряется) → systemd `agt-node.service` → peers.json с https-пиром ядра (AGIP-27). Скрипт fail-fast: живость `/life` — обязательное условие «ГОТОВО», он же сам проверяет, что админ-маршруты НЕ отвечают снаружи.

> ℹ️ Повторный запуск того же скрипта на живой ноде = безопасный апдейт: `git fetch + reset` до origin/main, перезапуск systemd — пиры/кошельки сохраняются.

Кошелёк и все админ-операции — **только через SSH + админ-токен** (нода отвечает 403 `admin_loopback_only` всем чужим запросам; туннель/прокси админом не считается, скрипт разворачивает ноду в `AGT_ADMIN_MODE=token`):

```bash
# на VM (после ssh ubuntu@<ip>):
curl -s http://127.0.0.1:9335/life     # → blocks, chainValid=true
journalctl -u agt-node -f              # логи ноды

T=$(sudo cat /opt/agentcoin/data-agtx/admin-token.txt)

# кошелёк VPS-агента (mnemonic выдаётся ОДИН раз — записать!):
curl -X POST http://127.0.0.1:9335/wallet/create \
  -H 'Content-Type: application/json' -H "x-admin-token: $T" \
  -d '{"label":"oracle-a1-agent","recover":true}'

# анонс в империю:
curl -X POST http://127.0.0.1:9335/community/send \
  -H 'Content-Type: application/json' -H "x-admin-token: $T" \
  -d '{"text":"Внешняя нода Oracle A1 поднята 🏰"}'

# хелсчек балансов из цепи:
node /opt/agentcoin/health-check.mjs 9335
```

Сайт всех нод сам поддерживается свежим (AGIP-38: нода раз в 10 мин сверяет сайт с каноном в `main`, offline —лечит локальную копию). Высоту своей ноды vs ядро деплой печатает в конце («высота нода/ядро»).

Анонс в империю:

```bash
curl -X POST http://127.0.0.1:9335/community/send \
  -H 'Content-Type: application/json' -d '{"text":"Внешняя нода Oracle A1 поднята 🏰"}'
```

И последний штрих — прописать его пиром в ядро (на машине ядра, Loopback: в моём workspace):

```powershell
$T = Get-Content data-agtx\admin-token.txt
curl.exe -m 10 -X POST http://127.0.0.1:9335/peer/add -H "Content-Type: application/json" -H "x-admin-token: $T" -d '{"peer":"http://<VPS_PUBLIC_IP>:9335"}'
```
После этого ядро начнёт исходящие WS к VPS-ноде: сеть станет действительно распределённой (дом-машина + Oracle VM).

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
