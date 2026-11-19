# Stage 4 — оставшиеся WARN/UNKNOWN (кандидат)

Гейт кандидата (`gate/verdict.json`, политика `stage4-candidate`):
вердикт **WARN**, блокеров **0**, warnings **1**, unknowns **2**.

## Warnings (1)

- `MODULE_NOT_PUBLISHED` [site-static] — `/ecosphere` документированно не
  опубликован (404). Решение по ТЗ: до признания модуля утверждённым держать
  404 и `implemented=false`, убрать из навигации/tree/sitemap. Закрытие —
  отдельным решением владельца, не этим этапом.

Исчезнувшие относительно среза fix1 (16 → 1): 3 `LAGGING` (кандидат-стенд без
монитора-петли; прод-лаг проверяется отдельным наблюдением), 3
`CAPABILITY_GHOST` (реклама удалена), 8 `UNDOCUMENTED_ROUTE` (7 маршрутов
внесены в кандидат-реестр/capabilities; теневой txproof-дубль убран),
`ROUTE_PATTERN_OVERLAP` (второй декларации больше нет),
`SITE_RELEASE_MARKER_ABSENT` (маркер единый на всех трёх страницах).

## Unknowns (2, оба честные и видимые)

- `MINER_OPERATOR_INDEPENDENCE_UNKNOWN` [miner-stack] — независимость
  операторов майнинга чтением не доказуема; один наблюдаемый miner service
  с N адресами ротации считается одним оператором. Остаётся UNKNOWN
  по требованию ТЗ, не подделывается.
- `COVERAGE_UNKNOWN` [miner-stack] — обязательная проверка `operators`
  выполнена со статусом `unknown` (независимость не доказана), поэтому
  компонент не может быть PASS (минимум WARN). Это следствие предыдущего
  пункта, а не новая проблема.

## Отсутствуют (обязательный результат ТЗ)

- `DUPLICATE_ROOT_PRODUCT` — отсутствует (стенд: `/imperial*` → 308 `/`).
- `SITE_SHELL_INCONSISTENT` — отсутствует (единые shell.css/shell.js/app.js).
- `TEST_MUTATION_TO_MAINNET` — отсутствует (mutation закрыты 404).
- `CORRUPT_OUTPUT` — отсутствует (все блокеры имели бы evidence; блокеров нет).
- `SECRET_IN_EVIDENCE` — отсутствует (скан стенда: 0 находок).
