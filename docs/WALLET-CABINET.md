# WALLET-CABINET — кабинет пользователя + кошелёк AGENTCOIN

Статус: IMPLEMENTED (тестовая среда verified; живой rollout — отдельный явный шаг).
Дата: 2026-10-20 · Требование ТЗ: единый кабинет + кошелёк, не уступающий хорошим Bitcoin-кошелькам по UX.
Главный принцип совместимости: **сеть не тронута**; всё новое — надстройка над существующими потоками `/cabinet/*`.

## Что сделано

| Слой | Файл | Назначение |
|---|---|---|
| Backend read-only API | [wallet-api.mjs](../wallet-api.mjs) | история tx пользователя (по сессии), смета комиссий, height-gated классификация treasury |
| Маршруты ноды | [node.mjs](../node.mjs) | `POST /cabinet/wallet/history`, `POST /cabinet/wallet/estimate` (в PUB_TX_ROUTES), страницы `/wallet`, `/wallet-format.js` |
| Клиентский формат | [site/wallet-format.js](../site/wallet-format.js) | контракт `agentcoin.wallet.intent.v1/signed.v1` (идентичен кабинетскому) + единицы AGT/mAGT/mGNT + **самодостаточный QR-энкодер** (byte mode, ECC L, v1–10, BCH(15,5) + RS, без внешних зависимостей) |
| Страница кабинета | [site/wallet.html](../site/wallet.html) | Обзор (баланс в 3 единицах, переключатель), Отправить (маршрут + смета + op-request→op-submit), Получить (QR + счёт JSON для «Алисы»), История (пагинация, категории, treasury-note), Контакты (localStorage, шаблоны Алиса/Боб), Комиссии и казна |
| Тесты | [test/wallet-page.mjs](../test/wallet-page.mjs) | 7/7 pass: height-gating классификатора, QR-алгебра (BCH/RS), страница публична, без пароль-полей, login по паспорту, смета честная (network fee = 0), полный send-флоу через op-request/op-submit, приватность истории (401 чужим) |

## Height-gating treasury (главное исправление из ТЗ)

Классификация tx казны учитывает `policy.effectiveFrom` (= closesAt + 1, установлен
в [treasury.mjs](../treasury.mjs) в рамках strict-ревалидации):

- tx казны ДО `effectiveFrom` → `sig.required = 1`, note «политика ещё не активна» — **ретроактивного 2-sig нет**;
- tx казны ПОСЛЕ → `sig.required = 2`, `sig2Present`;
- политика без `effectiveFrom` (legacy-инъекции тестов) → как раньше (всегда 2 sig).

Страница кошелька показывает это явно на вкладке «Комиссии и казна» и в строках истории.

## API (новые маршруты)

- `POST /cabinet/wallet/history` `{address, token, limit≤500, beforeHeight?}` →
  `{rows[], mempoolRows[], nextBeforeHeight, treasury:{ref,treasury,requires,effectiveFrom}}`
  (строго по живой сессии; чужой токен → 401).
- `POST /cabinet/wallet/estimate` `{address, token, to, route:'direct'|'gateway', amount}` →
  `{fees[], arrival, units:{AGT,mAGT,mGNT}, sufficient, unavailable?}`.
  Честность: **базовая комиссия сети = 0** (fee-none, как Nano); шлюз показывает свой feeBps
  (математика идентична `core.executeMultiHop`); налог по паспорту печатается как
  «НЕ удерживается при P2P» (AGIP-10 не переопределяем).
- Страницы: `GET /wallet` (→ wallet.html), `GET /wallet-format.js`.

Подписание и отправка денег идут через СУЩЕСТВУЮЩИЙ AGIP-46 поток: `/cabinet/op-request` →
локальная подпись txid → `/cabinet/op-submit`. Новых денег/подписей нода не берёт; страницы
не запрашивают seed/privkey/пароль.

## Миграции

**Нет** (сознательно): wallet-api — надстройка, хранилищ не добавляет. Контакты —
localStorage браузера (schema `agentcoin.wallet.contacts.v1`, экспорт/импорт JSON).

## Совместимость

- Все существующие маршруты/схемы tx/treasury не изменены; `wallet-api.mjs` only reads.
- `classifyTx`/`walletHistory`/`walletEstimate` — чистые функции, тестируются отдельно.
- localStorage-изоляция: сессия в sessionStorage (как весь кабинет).

## Инструкции запуска (тестовая среда)

```bash
# тест-нода на копии данных (или любой локальный data-dir):
node --test test/wallet-page.mjs                 # полный E2E: 7/7
node tools/check-html-scripts.mjs                # inline-скрипты всех страниц
# ручной просмотр: AGT_DATA_DIR=<copy> AGT_PEER_DISCOVERY=0 node node.mjs 9399 → http://127.0.0.1:9399/wallet
```

## Риски и ограничения

1. **UI-порядок загрузки**: wallet-format.js подключён без defer — inline-скрипт тела
   вызывает единицы/QR при входе; если кто-то вернёт defer, вход снова сломается
   (обнаружено и покрыто финальной гарантией классов в `enter()` + check-html-scripts).
2. QR-энкодер самописный: алгебра верифицирована (BCH remainder=0 для всех масок,
   RS syndromes=0, placement self-consistent), но он ECC L без версии >10 → payload ≤271
   байт; для这人-длинных реквизитов нужен v11+ (не требовалось).
3. История — с глубиной ноды (пагинация по beforeHeight); полная выписка с genesis —
   всё ещё локальный Skill-задача.
4. Демо-«Алиса/Боб» — шаблоны с пустыми адресами (проверка регексом при использовании);
   это UX-подсказки, не криптография.
5. Ретроактивная strict-ревалидация fix-а (treasury.mjs/core.mjs height-gating) включена
   в цепочку, но **живая нода 9335 не реконфигурирована** — rollout отдельным явным шагом.
6. Сценарий «через шлюз» в UI в отправке сознательно заблокирован подсказкой
   (нужна операторная подпись leg2) — honest-gating, не скрытая кнопка.
