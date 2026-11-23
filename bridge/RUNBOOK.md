# Мост AGT↔wAGT — стенд v1. Runbook (стенд, независимая воспроизводимость)

Статус: ядро + политика расхождения + локальный e2e собраны изолированно.
Контракты + тесты EVM (8/8: кросс-шлюз replay и ротация подписаны), proto-каноника,
сверка, vault 2-of-3 (6/6), расхождение политик, двусторонний e2e — зелены.
НЕ собрано — наблюдатели/аттестор/ретранслятор как сервисы, API `/bridge/*`.
Развёртывание — есть (`bridge/scripts/deploy-bridge.mjs`), на локальной сети прогон зелёный;
Sepolia ждёт ключа деплоера с газом и отчёта независимого проверяющего (гейт 0).
Основная сеть и реальные средства — НЕ подключать.

## Воспроизводимость стенда (независимый проверяющий, одна документация)
Из корня репо `agentcoin/` (все команды — отсюда, если не сказано иное):
1. `node --check queue.mjs && node --check queue-auth.mjs && node --check queue-guards.mjs && node --check bridge/services.mjs && node --check bridge/api.mjs` (очередь и прод не трогаются).
2. Всё не-EVM одной командой: `node test/repro-stand.mjs` (ALL GREEN). Внутри по порядку:
   очередь v2 (`queue-v2-isolated`, `queue-v2-clarify`: grace-слот, привязка попытки,
   nonce-идемпотентность, resend того же txid, границы/skew/часы, миграция/откат);
   атомарность/авторизация (`queue-atomic-auth`: WAL pending, падение/конкуренция/рестарт,
   guard всех маршрутов, байты повтора, реорг после settled);
   межпроцессный WAL (`queue-wal-multiproc`: два отдельных процесса, падения до/после
   эффекта, operationId, три исхода resolvePending) + восстановление lock
   (`queue-lock-recover`: протухший/свежий lock, реальный kill -9 держателя, журнал цел)
   + область nonce (`queue-nonce-scope`: адрес|nonce, без межпользовательского DoS);
   HTTP-авторизация (`queue-http-auth`: изолированный сервер, матрица подписей/подмен/
   просрочек/повторов/конкуренции, readyEnforced=false, обход через старый done, оператор);
   ядро моста (`bridge/test-proto.mjs`, `bridge/test-reconcile.mjs`);
   vault/политика (`test/bridge-vault-2of3.mjs`, `test/bridge-policy-divergence.mjs`);
   e2e-модель (`test/bridge-local-e2e.mjs`: lock→mint→burn→release, AlreadyExecuted,
   рестарт, реорг-стоп, стоп при расхождении, мусорный memo без выпуска);
   действительная остановка (`test/bridge-halt-stop.mjs`: дефицит после mint, стоп
   аттестаций/отправок, API STOP ≠ остановка контракта, окно риска, запрет авторезюма)
   + стоп обоих направлений (`test/bridge-halt-both.mjs`: любой красный флаг —
   mint=STOP и release=STOP одновременно; дефицит burn-стороны после реорга EVM;
   canRelease; сведение обоих дефицитов в `bridgeState`).
3. EVM + живые контракты: `cd bridge && node node_modules/hardhat/internal/cli/cli.js test`
   (9 passing: 8 gateway/wAGT + full-local на реальных контрактах: lock→mint→burn→release,
   рестарт релеера, сверка, реорг ПОСЛЕ mint = дефицит + стоп, не автокансел).
   ВАЖНО: запускать именно из `bridge/` (путь `node_modules/...` относительный).
   Сервисы: `bridge/services.mjs` (observe/health/deficit/halt: canAttest/canRelay,
   recordHaltObservation, clearHalt только вручную), состояние `bridge/api.mjs`.
   (solc 0.8.24, evmVersion cancun, OZ v5).
Секреты не нужны: все ключи генерируются внутри тестов (tmp), продовых нет.
Шаблон отчёта проверяющего: `docs/INDEPENDENT-REPRO-TEMPLATE.md`.
Пакет для проверяющего целиком: `node tools/gate0-package.mjs` → `dist/gate0-<ts>.tar.gz`
(37 файлов, SHA256SUMS, README-GATE0, импорты замыкаются автоматически, секреты сканируются).
Проверено распаковкой с нуля: `sha256sum -c` 37/37 OK, `node test/repro-stand.mjs` — ALL GREEN.
EVM-часть требует `npm install` в `bridge/` (на Windows это десятки минут, в лимит командного окна не влезает).

### Деплой стенда в EVM-сеть
```bash
cd bridge
# локальная hardhat-сеть: ничего не стоит, 5 проверок состояния
node node_modules/hardhat/internal/cli/cli.js run scripts/deploy-bridge.mjs
# Sepolia — только с явным подтверждением и ключом в env:
#   CONFIRM_DEPLOY=sepolia SEPOLIA_RPC_URL=... SEPOLIA_DEPLOYER_KEY=0x... npm run deploy:sepolia
```
Скрипт деплоит wAGT → gateway, выдаёт шлюзу `GATEWAY_ROLE`, перечитывает состояние
(`gateway.wag()`, роль, `dstChainId`, `agentcoinChainId`, порог) и пишет
`bridge/deployments/<network>.json` — без ключей, только адреса и параметры.
Без `CONFIRM_DEPLOY=<сеть>` на внешней сети скрипт отказывается работать до отправки транзакций.

### Приёмочный пилот: выпуск → сжигание → учёт → сверка
```bash
cd bridge
# локально: стенд развернётся сам, если в файле деплоя нет кода (эфемерная сеть)
node node_modules/hardhat/internal/cli/cli.js run scripts/pilot-bridge.mjs
# на уже развёрнутом стенде (в т.ч. localhost / Sepolia):
#   node node_modules/hardhat/internal/cli/cli.js run --network localhost scripts/pilot-bridge.mjs
#   CONFIRM_PILOT=sepolia BRIDGE_SIGNER_KEYS=0x...,0x...,0x... npm run pilot:sepolia
```
20 проверок в 6 шагах: состояние стенда → `mintAttested` настоящими подписями федерации → отказы
(`ThresholdNotMet`, `OverPerOpLimit`, повтор `AlreadyExecuted` — через `eth_call`, без трат газа) →
`burnWithRecipient` → `observeBurn` (+ отказ постороннему) → `computeReserves` по дельтам прогона.
Пишет `evidence/bridge-pilot-<network>-<ts>.json` с хешами и результатом; exit 2 — пилот не пройден.
На локальной сети — 20/20, в том числе два прогона подряд на одном стенде (сверка по дельтам,
а не по абсолюту — стенд мог быть использован раньше). Нативная нога в отчёте помечена как модельная:
живой цепи Agentcoin в этом прогоне нет, проверяется EVM-сторона и её инварианты.

## Ключи стенда (тестовые, НЕ продовые)
- Подписанты федерации 3-of-5: тестовые ключи hardhat-сети; продовые генерируются
  отдельно, в репозиторий/логи/API не попадают.
- ECDSA (EVM-аттестации) и ed25519 (Agentcoin co-sign) — разные ключи у каждого
  подписанта; ключ оператора vault — офлайн, сервисы его не видят.
- Газ EVM-операций стенда — отдельный тестовый ключ с минимальным балансом.

## Остановка и восстановление (политика)
- `setMintPaused(true)` (роль PAUSER) — мгновенно, останавливает только выпуск wAGT.
  Уже выпущенные wAGT не замораживаются; начатые `executable` — дозавершить или вернуть.
- Пауза НЕ меняет получателей и НЕ конфискрует (проверено тестами: пауз-функций
  смены получателя нет).
- Ротация подписантов/порога — только `proposeSigners` + `applySigners` после 2 суток.
- Релизы Agentcoin останавливаются операторной политикой + статусом `/bridge/health`
  (после сборки сервисов); сожжённые во время стопа wAGT учитываются и обслуживаются
  после снятия стопа, не конфискуются.
- Расхождение политик федерации — стоп новых выпусков/релизов до сверки политик
  (см. §14 отчёта; тест расхождения — обязательный пункт health-чека).

## Что дальше (следующие шаги стенда)
1. Наблюдатели обеих сетей + аттестор как сервисы (проверка K подтверждений,
   каноничности, уникальности подписантов, журнал без секретов).
2. Ретранслятор (идемпотентный по eventId) + API `/bridge/*` + страница сверки.
3. Затем Sepolia; тесты §10 ТЗ (реорг до/после, рестарты, смена подписантов, лимиты).
