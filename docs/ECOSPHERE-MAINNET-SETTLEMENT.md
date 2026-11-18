# Нативные расчёты AGT (проход, 2026-11-18): чтение mainnet + прямой перевод

`core.mjs` не менялся (мораторий соблюдён). TEST-книга стенда (`/settlements/*`)
убрана из публичного платёжного пути: в UI помечена как стенд-only, публичные
выплаты идут только через `/mainnet/*` (нативный AGT).

## Что сделано
- `sdk/js/mainnet-settlement.mjs` — адаптер поверх консенсуса: проверка
  `chainId=AGENTCOIN` + пин генезиса `00026d18…188e4e`, балансы точным per-tx
  replay в целых атомарных единицах (магнеты), превью до подписи, политика
  расходов владельца, журнал `orderId → obligationId → signed tx → txid`,
  идемпотентный повтор теми же байтами, подтверждение по глубине 6 с
  детектом реорга, разделение приёмки/оплаты, `kind: direct-transfer`
  (слово «эскроу» не используется), приватный ключ сервером/сайтом не принимается.
- `sdk/js/mainnet-server.mjs` — шлюз: `GET /mainnet/info|/balances|/policy`,
  `POST /mainnet/preview|/obligations|/submit`, `GET /mainnet/settlements/:id|…/status`.
  Отправка — только уже подписанной tx; релей в ноду mainnet (`POST /tx`)
  теми же байтами; без ноды байты хранятся для ручной отправки владельцем.
- `scripts/ecosphere-staging-serve.mjs` — смонтирован `/mainnet/*` (цепь читается
  из `agentcoin/data`, ключей в процессе нет).
- `site/ecosphere/mainnet.html` — страница: баланс → превью → политика → статус;
  подпись — только локально у владельца (`signTransfer`), ключ в браузер не вводится.
- `site/ecosphere/index.html` — ссылка на нативные расчёты; баннер честно
  отделяет TEST-книгу от mainnet.
- `test/mainnet-settlement.mjs` — 7/7: chainId/genesis-gate, атомарные суммы,
  превью, политика, обязательство после приёмки, локальная подпись + запрет
  второго платежа, подтверждения/реорг, честные отказы.

## Проверка на живом стенде 18744 (новый код; 18743 не тронут)
- `GET /mainnet/info` → `AGENTCOIN / 00026d18… / blocks 41996 / tip 00c95a…` (`test:false`).
- `GET /mainnet/balances?address=AGT11a…439a` → `946839786000000` atomic
  (точный replay; float-хвост `...7860000001` устранён).
- `POST /mainnet/preview` с `privKey` → `400 private_key_rejected`.
- Без `acceptedProof.state=accepted` → `409 no_obligation` (приёмка ≠ оплата).
- Сквозной демо-прогон эфемерными ключами (средства mainnet не тронуты):
  `orderId=ord-demo-ephem-2 → obligationId=obl-bd3374fc889c → txid=72f6930c…ba396b5`,
  повтор submit — тот же txid (`replay:true`), статус `sent/pending/paid:false`
  (нода 9333 не поднята — релей отложен, байты сохранены; фиктивного успеха нет).
  Демо-записи из журнала удалены.

## Что ждёт владельца (без его слова не делаем)
1. Задать `settlement-policy.json` (пример — `sdk/js/settlement-policy.example.json`):
   лимиты на платёж/день, allowlist, порог ручного подтверждения.
2. Подписать первый реальный перевод локально (`signTransfer` своим ключом) и
   прислать `signedTx` в `POST /mainnet/submit` — это и будет доказательство
   первого разрешённого расчёта: orderId, txid, сумма, получатель, 6 подтверждений.
3. Поднять mainnet-ноду (9333) для релея — либо отправлять подписанные байты вручную.
4. Рестарт 18743 / внешняя публикация — отдельным решением (см. ECOSPHERE-STAGING-EXTERNAL.md).

## Рабочий URL
- Стенд с нативным шлюзом: `http://127.0.0.1:18744` (процесс на этой машине).
- Нативные расчёты: `http://127.0.0.1:18744/ecosphere/mainnet.html`.
- Витрина стенда: `http://127.0.0.1:18744/ecosphere/index.html`.
