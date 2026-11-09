# wAGT: подтверждения, остановки, роли, сверка (мост AGT ↔ wAGT)

Только тестовые средства. Реализация ворот — `scripts/cycle.mjs`
(`relayMint`, `relayReleaseGate`, `routeHalt`); контракт — `contracts/WAGT.sol`.

## 1. Когда депозит доступен для mint / burn разрешает release

Пороги — env, стенд по умолчанию: `WAGT_MIN_AGT_CONF=2`, `WAGT_MIN_EVM_CONF=2`.

- Mint: lock-tx обязан быть в запечатанном блоке AGT (`/txproof` 200 с высотой)
  И `tip - proofHeight >= WAGT_MIN_AGT_CONF`. До порога — отказ `lock_immature`
  (не очередь, не mint): реорг ещё может унести событие. Неизвестный lock —
  `lock_event_missing`.
- Release: burn обязан быть в канонической цепи EVM (receipt status 1)
  И `evmTip - burnBlock >= WAGT_MIN_EVM_CONF`. До порога — `burn_immature`.
- Проверено на стенде (`npm run cycle`): R0 (missing), R1 (immature→mature
  после добора блоков), главная ветка (burn зрел → release), отчёт
  `cycle-report.json` (поля `minAgtConf/minEvmConf`, все R-флаги true).

## 2. Откат до и после порога (стенд R2)

- Откат ДО порога: событие незрелое — mint/release и так заблокированы
  воротами; последствий нет.
- Откат ПОСЛЕ порога (стенд: `evm_snapshot` → burn → добор → `evm_revert`):
  receipt исчезает → ворота возвращают `burn_event_vanished` и ставят
  `haltRoute(evm2agt)`. Пока halt стоит, НОВЫЕ операции направления
  отклоняются (проверено: повторный release блокирован). Halt затрагивает
  только своё направление (mint-направление остаётся открытым).
- Halt снимается ТОЛЬКО вручную (`operatorResetHalt` с причиной разбора),
  событие пересоздаётся заново (повторный burn), ворота снова требуют порог,
  затем release. Проверено: после сброса release 1 AGT прошёл, инвариант цел.

## 3. Роли и ключи

| Роль | Тест (стенд/Sepolia) | Подписывает | Смена ключа / восстановление | Прод (решение владельца) |
|---|---|---|---|---|
| Bridge/minter wAGT | EOA релейера (`bridge`, hardhat signer0 / Sepolia-ключ) | `mint` (onlyBridge) | В контракте НЕТ смены: `bridge` immutable → ротация = редеплой + миграция | Мультисиг; в mainnet-контракт добавить смену bridge + паузу (сейчас нет) |
| Хранитель резерва AGT (vault) | EOA, ключ в кошельках ноды | `release` (перевод AGT) | Ключ в `wallets.json` пилотной ноды; бэкап с остановкой службы | Мульсиг/кастоди; процедура ротации — TBD |
| Поставщик ликвидности | EOA (`lp`), внёс 40 wAGT + 400 tAGT | addLiquidity/remove | Свои ключи | Стартовый объём и владелец пула — TBD (лист решений) |
| Оператор релейера | Процесс `cycle`/релейер | Ничего (ворота, halt) | Перезапуск + ресинк (п.4) | Дежурство, алерты на halt — TBD |
| Пауза моста | ОТСУТСТВУЕТ в WAGT.sol (нет ownable/pausable) | — | — | Обязательное требование к mainnet-контракту + аудит |

## 4. Перезапуск и сверка (ресинк)

Реестр релейера сейчас в памяти (`ledger`), второй рубеж — on-chain
`mintedDeposit[depositId]` (повтор отклоняется контрактом `deposit_replayed`).
После перезапуска:

1. Прочитать `BridgeMint`/`BridgeBurn` события и `mintedDeposit` по известным depositId.
2. Незамороженные lock (txproof зрел, mint-события нет) — обработать воротами заново.
3. Отчёт сверки: `reserve (vault баланс AGT) == wAGT totalSupply`; список
   незавершённых (lock без mint, burn без release) с txid обеих цепей.
4. НЕОБЪЯСНЁННОЕ РАСХОЖДЕНИЕ ОСТАНАВЛИВАЕТ НОВЫЕ ВЫДАЧИ: поставить halt
   вручную на оба направления до разбора (аналог `haltRoute`).

Шаблон отчёта: `cycle-report.json` (`contracts`, `agt.lockTx*/releaseTx`,
`evmTx.*`, `amounts`, `checks`) + живой `LIVE-EVIDENCE-sepolia.md`
(для Sepolia: хеши, ссылки на explorer, газ).

## 5. Правила остановки (итог)

- Ворота: незрелое/пропавшее событие → отказ, mint/release нет.
- Откат после порога → halt направления с причиной; новые операции стоят.
- Расхождение резерв/выпуск без объяснения → halt обоих направлений вручную.
- Halt снимается только вручную после разбора; mainnet — только мультисигом.
