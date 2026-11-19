# Truth Gate — этап 3

**Вердикт: WARN**

- policy: stage4-candidate
- компонентов: 6, наблюдений: 26
- blockers: 0, warnings: 1, unknowns: 2

Гейт ничего не исправляет: только чтение и классификация. Mutation-маршруты не вызывались.

## Blockers
нет

## Warnings
- **MODULE_NOT_PUBLISHED** [site-static / site-static:page-ecosphere] — модуль /ecosphere документированно не опубликован (404), backing не выдаётся за работающий

## Unknowns
- **COVERAGE_UNKNOWN** [miner-stack] — покрытие: нет обязательных проверок: operators
- **MINER_OPERATOR_INDEPENDENCE_UNKNOWN** [miner-stack / miner-stack:operators] — UNKNOWN: one observed miner service with N rotation addresses counts as one operator; independence unproven

## Покрытие компонентов

| component | status | checks | ok | mismatch | unavailable | unknown | not_checked | missing required |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| caddy-h1 | PASS | 4 | 4 | 0 | 0 | 0 | 0 | — |
| env-mainnet | PASS | 3 | 3 | 0 | 0 | 0 | 0 | — |
| env-staging | PASS | 3 | 3 | 0 | 0 | 0 | 0 | — |
| mainnet-node-1 | PASS | 3 | 3 | 0 | 0 | 0 | 0 | — |
| miner-stack | UNKNOWN | 6 | 5 | 0 | 0 | 1 | 0 | operators |
| site-static | PASS | 5 | 5 | 0 | 0 | 0 | 0 | — |

## Следующие действия
- Опубликовать модуль или убрать его из ожиданий единого сайта.

Этап 4 (план исправлений с бэкапом и откатом) начинается только после приёмки этого гейта.
