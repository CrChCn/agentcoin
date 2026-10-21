# EMPIRE-PILOT-01 — Safe PR #1: закрытие пяти замечаний review (CLOUD-API-02)

Стек строится от принятого API-GATEWAY-01 (`b16c3ff349b7c8e1aa3ffcaa8d87aa66074b2e07`).
Всё офлайн, off-chain, без billable-вызовов, без трогания mainnet-консенсуса;
затронуты только `api-gateway.mjs`, `test/api-gateway.mjs` и этот документ.

## Что закрыто (соответствие замечаниям review из issue #1)

1. **Конкурентный execute** — новый тест `parallel execute of the same order runs provider
   exactly once, loser rejects`: два параллельных `execute()` одного оплаченного заказа —
   ровно один вызов provider'а, второй отклоняется `execution_race`; повторная оплата не
   происходит. В коде ничего не менялось — гонка решалась синхронными вставками между
   `await`; теперь она зафиксирована тестом.
2. **Экономические пределы units** — `MAX_PRICE_UNITS = 21e6 AGT × 1e9 units/AGT = 21e16`
   minor: цена котировки выше планового эмиссионного потолка отклоняется
   `price_units_beyond_supply` на конструкторе. Негативный тест + пограничный
   in-cap кейс.
3. **Bounded journal** — опция `quoteLimit` (по умолчанию 200, диапазон 10–10000):
   самые старые котировки вытесняются при вставке новых. Заказы содержат собственную
   копию котировки, а карта `payments` **никогда не прореживается** (уникальность
   payment-binding сохраняется). Тест подтверждает: счётчик котировок = лимит,
   устаревшая котировка не может создать новый заказ, заказ и `payments` выживают.
4. **Долговечность на поддерживаемых ОС** — после `rename` journal и result-файла —
   best-effort `fsync` родительской директории (на Windows fsync директории невозможен
   технически — операция обёрнута и деградирует молча, на POSIX закрывает разрыв
   метаданных rename).
5. **Получение результата после settled** — отдельный side-file `<journal>.results.json`
   (0600, tmp+fsync+rename, вне публичной цепи): `execute(settled)` и новый метод
   `retrieveResult(orderId)` возвращают сохранённый текст через проверку хеша
   (`result_integrity_mismatch` при подделке) и TTL (`resultTtlMs` опционально;
   `result_expired` по таймауту) — **без новой покупки и без повторного вызова provider'а**.
   Back-compat: журналы до result-store возвращают только квитанцию; опции
   `quoteLimit`/`resultTtlMs` не входят в `configHash` — существующие v1-журналы
   принимаются без миграции.

## Приёмка

- `node --check api-gateway.mjs`, `node --check test/api-gateway.mjs` — ok.
- `node --test test/api-gateway.mjs` — **12/12 PASS** (7 исходных + 5 новых).
- `git diff --check` — ok.
- Ручной негативный прогон TTL-кейса (`now` = storedAt+100000) — `result_expired`, повторное
  исполнение не вызывалось.

## Границы (остаются открытыми, как и в ТЗ)

- Provider/verifier — контролируемые fixture'ы; реальный bounded provider adapter и
  независимый payment verifier на тестовой сети — следующий этап CLOUD-API-02 (нужен выбор
  ОДНОЙ услуги/провайдера, инвентаризация CPU/GPU, лицензий и fiat-cap оператором).
- Refund engine, ACL-политика результата при multi-tenant доступе, экспорт accounting —
  отдельные задачи (TASKS-GRANTS-01 / ACCOUNTING-01).
- Billable calls не включены; mainnet-консенсус не изменён.
