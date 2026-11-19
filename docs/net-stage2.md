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
- fix4: глобального `ps -eo pid,user,args` нет; `ss -ltnp` нет. Только
  `systemctl show <unit> --property=ActiveState,MainPID,User,ExecStart,ExecMainStartTimestamp`,
  `systemctl is-active`, точечный `ps -p <PID> -o pid=,user=,lstart=` по
  числовому MainPID из show, `ss -ltn` с сохранением только строк ожидаемых
  портов. Перед сохранением evidence значения с токенами/паролями/ключами
  маскируются (`[REDACTED]`); 64-hex хэши не трогаем.
- Никакой веб-панели и постоянно работающего сервиса.
- Тайм-ауты конечны (HTTP 8 с, SSH 15 с), параллелизм строго ≤ 4,
  повторов нет. Частичный сбой не уничтожает остальные наблюдения.
- Тело HTTP читается потоком с лимитом 64 КиБ: при превышении чтение
  прекращается, фиксируется `truncated:true`.

## Одна команда — тесты без production

Из каталога `agentcoin`:

```
node test/registry-check.mjs   # 33/33 (25 этапа 1 сохранены + observe-кейсы)
node test/net-collect.mjs      # 25/25, изолированно (fetch/ssh — моки)
```

Обязательные сценарии покрыты: исправный ответ; тайм-аут; 403/404/500;
HTML вместо JSON; структуры `/info` (`{}`/`null`/`[]`/text/plain — mismatch);
отсутствующий пин — mismatch; тёмный 403 с маркером ok vs 404 без маркера;
неверный chainId/genesis; capabilities реального формата `get` с полным
охватом (без среза 12: `/queue/history`, `/gateway/list` проверяются);
параметризованные пути — явный пропуск без bare-запроса; редирект 308 —
mismatch для реестровых маршрутов, ok-redirect для caps-проб `/index → /`;
прокси node1 в ответе резерва; отсутствие SSH; частичный сбой;
параллелизм строго 4; лимит тела потоком; план только из реестра;
строгая allowlist read-only команд (без `;`, `||`, `|`, переводов строк;
fix4: `ps -eo`, `ss -ltnp` отклоняются);
разбор unit/pid-check/sha/ss с exitCode + scrub секретов; общий блок только по валидному хэшу
(без хэша — unknown, без вывода о совпадении; совпадение истории не
доказывает отсутствие расхождения выше); монитор nodeCompare с
INSUFFICIENT; цепочка raw→collect→diff.

Вердикты компонентов: `match` — только когда все наблюдения `ok`.
Любые `not_checked`/`unavailable`/`unknown` исключают полный `match`
(`partial` с явным `coverage: public=X/Y local=A/B skipped=C`).
Доступность публичных маршрутов и исправность ноды — разные выводы.

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
публичный `/network/nodes` через `nodeCompare` — при недостатке данных
INSUFFICIENT; совпадение вершин само по себе проксирование не доказывает —
учитываются время, общий блок и подтверждённый маршрут источника; высоты —
с допуском времени опроса, спор решает общий блок `common-block-<H>`
только по валидным хэшам).

Статусы: `ok` | `mismatch` | `unavailable` | `unknown` | `not_checked`.
Тайм-аут = `unavailable`, не «остановка». HTTP 200 с не-JSON = `mismatch`.
Ответ через прокси ≠ состояние локальной ноды резерва.
Тёмный резерв: только 403 с маркером `reserve node: dark` — ok;
404 без маркера — mismatch (неизвестный 404 ≠ ожидаемый запрет).
