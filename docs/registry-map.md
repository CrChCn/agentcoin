# Карта реестра Agentcoin (Этап 1, без изменений production)

## Где хранится техническое описание
- Канон: `config/unified-registry.json` (v2, 20 компонентов). Контракт: `config/registry.schema.json` — единственный источник ограничений; `tools/registry-check.mjs` обязан читать схему и применять её (required/типы/паттерны). Расхождение запрещено. Источники переиспользуются, а не копируются:
  - `config/system-registry.json` — исходные 11 технических компонентов (источник полей purpose/files/routes/process);
  - `config/action-registry.json` — 11 действий (привязка через `actionIds` в компонентах: settle.*/room.*/route.*);
  - `site/tree.json` — каноническое дерево навигации (привязка через `navIds`: href разделов; `/index→308 /`, `/wallet→308 /cabinet`);
  - `docs/audit-network/` — доказательства E01–E25 + CSV-карты (привязка через `verification.evidence` + `proofSource`);
  - `agentcoin-infrastructure-audit-20261119/` — снапшоты/diffs/config-redacted/validation-matrix (только `proofSource`, чтобы evidence-код проверки оставался коротким и воспроизводимым без секретов).
- Второго равноправного реестра нет: все новые поля (`expected/observed/verification`) живут только в unified-registry; остальные файлы — источники, на которые ссылаются `sources/proofSource/evidence`.

## Как связано дерево навигации
- `navIds` компонента = href из `site/tree.json`. Правило: файл-бэкенд (`site/*.html`) не равен владельцу публичного пути.
  - `/` → `site-static` (owner:true, imperial.html канон); `/index` — deprecated 308 (не владелец).
  - `/agent-room`, `/agent-room.json` → `agent-room` (owner:true); `site-static` — backing (owner:false).
  - `/workspace` → `web-next` (owner:true, оболочка E19); `site-static` — backing (owner:false).
  - `/mempool`, `/mine`, `/gov`, `/jobs` → `web-next` (owner:true, оболочки); файлы `site/*.html` — backing (owner:false), порядок static-vs-catch-all честно помечен неизвестным.
  - `/cabinet`, `/create-wallet`, `/`, `/operator-cabinet`, `/passport-cabinet` → `site-static` (owner:true); `/settlement` — живой маршрут static v0.3 (E19, `routes` owner:true), но отсутствует в `site/tree.json`, поэтому в `navIds` честно не заявляется (навигационный пробел, см. unknowns). `settlement-gateway.navIds=[]` по той же причине.

## Как связаны действия
- `actionIds` компонента = `actionId` из `config/action-registry.json`. Мутации только подписанные; чтение — без мутаций:
  - `settlement-gateway` + `site-static(/settlement)` ↔ `settle.net-boot/prov/preview/submit-signed/confirm-check`;
  - `agent-room` ↔ `room.net-check/my-state/claim/order-create/transfer` (claim/order — существующие очередь/рынок, второй очереди нет);
  - `caddy-h1` ↔ `route.verify-public` (релиз-чек: статус+CT+маркер+версия).
- Действия не дублируются в реестре: реестр хранит только привязку `actionIds`, полное описание — в action-registry.

## Разделение ожидаемого и наблюдаемого
- `expected` — роль/расписание/пин по коду и документации; `observed` — živые срезы (E04 09:23Z, E20–E25 09:33Z) или `null/false` с пометкой; `verification{status,evidence,unknowns,checkedAt}` — статус достоверности.
- `null` — только честное «неизвестно», с обязательным пунктом в `unknowns` и запретом `confirmed` (ловит `tools/registry-check.mjs`).
- Путь/SHA файла на диске ≠ версия загруженного процесса: `observed.loadedReleaseId=null` + unknowns (F-пункт реестра).

## Строгий контракт (фикс приёмки + добор 2026-11-19)
- Схема применяется: валидатор читает `config/registry.schema.json`; `version` integer, `updatedAt`/`checkedAt` ISO8601 `YYYY-MM-DDTHH:MM[:SS]Z` с календарной проверкой (2026-02-30 отклоняется, `Date.parse` нормализации недостаточно), `componentId` `^[a-z0-9][a-z0-9-]{1,63}$`, `kind` enum, `expectedVersion`/`observedVersion` string|null, `verification.status` enum.
- Роль — явным полем `kind` (`blockchain-node|miner|proxy|static-site|app|gateway|queue|monitor|env|sdk|cli|mcp|pilot`). Пин цепи требует `kind=blockchain-node`, префикс ID игнорируется: переименование ноды не отключает `chain.chainId+genesis`. Неизвестный `kind` — ошибка схемы.
- Пины цепи — только структурированные `chain.chainId` (`^[A-Z][A-Z0-9_]*$`) + `chain.genesis` (полные 64 hex). Поле `network` — только отображение (короткий пин), в сравнении не участвует. Компоненты mainnet-скоупа с пином обязаны совпадать с корнем; неизвестный пин — отдельная ошибка, не совпадение. Шлюзы между сетями описывают стороны через `bridges[]`.
- Владельцы маршрутов — в пределах одного окружения: ключ `envScope|METHOD host path`, где `envScope=mainnet` для всех `mainnet*`, остальные — по токену env; `route.env` при наличии переопределяет. Разные изолированные окружения не конфликтуют; два владельца одного публичного prod-маршрута отклоняются.
- Существование ссылок: `actionIds` сверяются с `config/action-registry.json`; `navIds` — с href из `site/tree.json`; bare `E##/F##/C##/V##` — с `EVIDENCE-INDEX.csv`/`FACTS.csv`/`CONTRADICTIONS.md`/`VERIFICATION-PLAN.md`; пути — с наличием файлов в пакете. Префикса недостаточно. Отсутствующий/нечитаемый индекс при используемых ссылках — ошибка (`nav-tree unavailable`, `action-registry unavailable`, `index ... unavailable`), а не молчаливый пропуск. `external:...` — явно внешнее, недоступное для воспроизведения, в `confirmed` только с verifiable-доказательством не засчитывается.
- Bare `E##` требует backing-файла `docs/audit-network/evidence/E##-*`: строка в `EVIDENCE-INDEX.csv` без файла — ошибка `evidence file for E## missing` (индекс отдельно, файл отдельно, `SHA256SUMS` эту проверку не заменяет).
- node-monitor: `partial` (не `confirmed`). E04 подтверждает только ответ API; корректность рендера и публикация C07 — отдельные unknowns. Файл `test/node-monitor.mjs` приложен как артефакт.
- miner-stack: активность юнитов (`agentcoin-miner.service active`, E20) отделена от доказанной добычи; параметры активации отделены от depth6/fee0 и PoW-наблюдения shareDiff12/difficulty9.

## Этап 2: машинные цели сбора (только чтение, без второго реестра)
- `observe` (опционально, задано у 3 нод + `node-monitor.publicBase`): `ssh{host,user,port}`, `localBase` (только loopback `http://127.0.0.1:PORT` — удалённые базы запрещены), `localEndpoints[]`, `units[]`, `files[]` (абсолютные пути; секреты/политика/журнал/ключи — ошибка), `listenPorts[]`, `publicBase`. Сборщик (`tools/net-collect.mjs`, `tools/net-diff.mjs`, тесты `test/net-collect.mjs`, доки `docs/net-stage2.md`) читает цели только отсюда; `routes owner:true` + `note` дают ожидания (тёмный 403 резервов, голый 404 без `:txid`, staging-скоуп). Конфиги и монитор не меняются.
