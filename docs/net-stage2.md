# Этап 2 — сбор фактического состояния и отчёт расхождений (только чтение)

Механизм принят вместе с реестром этапа 1 (`config/unified-registry.json`).
Никакого второго списка серверов, компонентов и маршрутов: сборщик читает
цели только из реестра — поля `routes` (публичные owner-маршруты) и
`observe` (SSH-цели, локальные эндпоинты, юниты, файлы, порты, publicBase).

Ожидаемое состояние не перезаписывается наблюдаемым. Старые evidence
(E01–E25) за новый опрос не выдаются: доказательства — только `evidence/`
текущего сбора.

## Границы (жёстко)

- Только GET и read-only команды. POST `/tx` `/mine` `/mainnet/*`
  не опрашиваются; журнал платежей, цепи, очереди, Caddy, права, деплой,
  рестарты — вне этапа.
- SSH — только к хостам из `observe.ssh` через существующую авторизацию
  (`~/.ssh/agentcoin-deploy`, `BatchMode=yes`). Секреты и полные переменные
  окружения не читаются: `observe.files` с секретами/политикой/журналом
  отклоняется валидатором.
- Никакой веб-панели и постоянно работающего сервиса.
- Тайм-ауты конечны (HTTP 8 с, SSH 15 с), параллелизм ≤ 4 (по умолчанию),
  повторов нет. Частичный сбой не уничтожает остальные наблюдения.

## Одна команда — тесты без production

Из каталога `agentcoin`:

```
node test/registry-check.mjs   # 33/33 (25 этапа 1 сохранены + observe-кейсы)
node test/net-collect.mjs      # 13/13, изолированно (fetch/ssh — моки)
```

Обязательные сценарии покрыты: исправный ответ; тайм-аут; 403/404/500;
HTML вместо JSON; неверный chainId/genesis; capabilities с недоступным
маршрутом; прокси node1 в ответе резерва; отсутствие SSH; частичный сбой;
ограничение параллелизма; план только из реестра; allowlist read-only команд;
вердикт общего блока (match vs fork-signal).

## Отдельная команда — разрешённый сбор (чтение)

Полный сбор (нужен SSH-доступ с ключом, иначе SSH-наблюдения станут
`unavailable`, остальные сохранятся):

```
node tools/net-collect.mjs --registry config/unified-registry.json --out reports/stage2-<YYYY-MM-DD>
node tools/net-diff.mjs reports/stage2-<YYYY-MM-DD>/observations.json reports/stage2-<YYYY-MM-DD>/DIFF.md --registry config/unified-registry.json
```

Публичная часть без SSH (с этого хоста без ключа):

```
node tools/net-collect.mjs --registry config/unified-registry.json --out reports/stage2-<YYYY-MM-DD> --public-only
```

Выход: `observations.json` (каждое наблюдение: componentId, checkId,
sourceHost, sourceEndpoint/команда, startedAt/completedAt, status,
observedValue, evidenceFile, error), `evidence/*` сырые тела,
`COLLECT.md` сводка, `diff.json` + `DIFF.md` (компонент → ожидалось →
наблюдалось → доказательство → вывод; отдельно недоступные и неизвестные;
раздел «Монитор» сравнивает node1-local / node2-local / node3-local /
публичный `/network/nodes` и явно сообщает, если публичный монитор показывает
node1 вместо резервов; высоты — с допуском времени опроса, спор решает
общий блок `common-block-<H>`).

Статусы: `ok` | `mismatch` | `unavailable` | `unknown` | `not_checked`.
Тайм-аут = `unavailable`, не «остановка». HTTP 200 с не-JSON = `mismatch`.
Ответ через прокси ≠ состояние локальной ноды резерва.
