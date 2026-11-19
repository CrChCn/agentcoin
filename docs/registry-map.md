# Карта реестра Agentcoin (Этап 1, без изменений production)

## Где хранится техническое описание
- Канон: `config/unified-registry.json` (v1, 20 компонентов). Источники переиспользуются, а не копируются:
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
  - `/cabinet`, `/create-wallet`, `/settlement`, `/`, `/operator-cabinet`, `/passport-cabinet` → `site-static` (owner:true).

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
