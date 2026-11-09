# Контракт операции кошелька: дайджест, привязка, идемпотентность, сеть

Релизная приёмка `/wallet` (ветка `feat/wallet-release-accept`). Что подписывается,
как сервер связывает подпись с заявкой и где границы защиты.

## 1. Что входит в подписываемый дайджест

Перевод готовится сервером (`POST /cabinet/op-request`, kind `send`), подписывается
только локально (`agt-skill/sign-op.mjs`), исполняется сервером (`POST /cabinet/op-submit`).

- Тело операции: `tx = { from, fromPub, to, amount, nonce, ts, memo }`.
  `amount` — Number, выведенный детерминированно из канонических минор
  (`amountMinor`, целые mGNT строкой): `Number(minorToAgt(minorU))`.
- `txid = txDigest(tx) = sha256d(JSON({ from, to, amount, nonce, ts, memo }))`
  (`core.mjs`, v1-дайджест: исторические txid/меркл/подписи заморожены).
- Подпись: `ed25519(sign, bytes(txidHex))` ключом паспорта (`crypto.sign(null, …)`).
  Проверка (`verifyTransaction`): `addressFromPub(fromPub) === from` строго ДО
  `crypto.verify`, затем подпись над `txid` — чужой ключ расход с чужого адреса
  невозможен (аудит AUDIT-20261018-01, P0-1).
- Пакет (`payload` op-request) дополнительно несёт `amountMinor`, `feeMinor`,
  `network` — они НЕ входят в v1-txid, их связь с tx проверяется отдельно (п. 3).

## 2. Привязка подписи к неизменяемой заявке и срок

- `cabinet.stashOp`: заявка живёт только в RAM, TTL 5 мин (`OP_TTL_MS`), не более
  20 заявок на адрес, не более 1000 на ноду.
- `cabinet.takeOp`: атомарное гашение (delete-on-read). Повторный submit того же
  `opId` — `400 op_not_found`, кроме исполненных (п. 4).
- `nonce` уникален на заявку (`Date.now()`); мемпул и цепь отвергают повторы
  `(from|nonce)` (`duplicate_tx`, `already_in_chain`, `chainNonceKeysOf`).
- Просроченная заявка (`expiresAt`) стирается `_pruneOps` — submit после TTL
  невозможен, нужна новая заявка.

## 3. Суммы: миноры как каноника

- `POST /cabinet/wallet/estimate` и `op-request` принимают `amountMinor`
  (целые mGNT строкой); legacy `amount` (число/decimal-строка) — совместимость.
  Значения с точностью хуже 9 знаков — честный `400 inexact_amount`, а не тихая
  порча (`amountMinorOf`, `core.mjs`).
- Пакет обязан: `payload.amountMinor === tx`-миноры (иначе CLI —
  `op_amount_package_mismatch`, submit — `400 op_amount_package_mismatch`).
- `agt-skill/sign-op.mjs` сверяет сумму ИЗ `tx.amount` (поле, покрытое txid) с
  ожиданием `--amount-minor`/`--amount` и с `payload.amountMinor`; до подписи
  печатает сводку (сеть/отправитель/получатель/миноры+AGT/комиссия/TTL).
- Контракт нулевой комиссии: `SEND_BASE_FEE_MINOR = '0'` (`wallet-api.mjs`);
  direct-смета содержит ровно одну network-запись `amount: 0`; баланс получателя
  меняется ровно на сумму (проверено стендом, Z4).

## 4. Повтор после потери ответа

Исполненный `opId` помнится 10 мин (`sealedOps`, `SEAL_TTL_MS`): повторный submit
той же подписи возвращает `200 { ok, duplicate: true, txidFull }` — ТОТ ЖЕ txid,
второй перевод не создаётся. Клиент (`site/wallet.html`) при потере ответа сам
повторяет submit, затем сверяется чтением (мемпул/цепь). В цепи появляется РОВНО
одна операция с этим txid (проверено стендом, Z4).

## 5. Сеть: граница v1 и план совместимости v2

- v1-txid НЕ содержит `chainId`/`fromPub`. Проверка `addTransaction`/`verifyTxAny`
  для v1-пути сеть не сверяет: подпись, верная в одной сети, верифицируется и в
  другой при тех же ключах. Барьеры сегодня: изоляция пиров/генезиса на p2p-уровне
  и привязка пакета к сети на стороне ПОДПИСАНТА (`payload.network` vs `--network`
  в sign-op — чужой network отклоняется до подписи).
- Полное закрытие требует смены формата подписи — отдельным решением:
  1. `op-request` отдаёт `digestVersion: 2` + v2-payload
     (`canonicalAuthPayload` v2: `domain, digv, chainId, from, fromPub, to,
     amountUnits, nonce, ts, memo, escProof, sig2Pub, sig2Present`).
  2. `sign-op` подписывает v2-payload (`signTransactionV2`), submit проверяет
     `verifyTransactionV2` (там уже есть network-pin: чужой `chainId` — отказ).
  3. Переходный период: submit принимает оба формата (по `tx.digestVersion`),
     старые клиенты работают через v1; после порога adoption v1-submit
     объявляется deprecated.
  4. База — `docs/CORE-P0-DIGEST-PLAN.md` (там же зафиксирована заморозка v1
     исторических дайджестов).
- До миграции: кросс-сетевой повтор v1-tx возможен на транспортном уровне —
  задокументированное ограничение, не скрытый дефект.

## 6. Проверено стендом

`tools/stand/verify-wallet-release.mjs` (штатная сборка v4 + HTTPS-прокси):
подмены to/amount/memo/network/txid отклонены CLI; просрочка и повтор —
сервером; сумма/комиссия/сеть пакета сверены; мемпул→блок по тому же txid;
повтор submit — duplicate с тем же txidFull; цепь содержит одну операцию.
