# Stage 4 — результаты тестов

## Изолированный стенд (без production)

`node candidate-stage4/stand/accept.mjs` → **30/30 PASS** (`accept-out.json`).

- Блок 2 (DUPLICATE_ROOT_PRODUCT): `/` → 200; `/imperial`, `/imperial.html` →
  308 `/`; `/imperial?x=1` → `/?x=1`; loop исключён; canonical на месте;
  ссылок `href="/imperial"` нет.
- Блок 3 (shell): общий CSS/shell.js/app.js на всех трёх; release-маркер
  непустой и одинаковый; nav одинаковый; ровно один h1; без ссылок на
  двойники; noscript с названием и навигацией; viewport; CSP без
  `'unsafe-inline'`; модули различны.
- Блок 4 (staging mutation + негативы): POST закрыт 404
  `staging_mutation_unavailable`; mainnet-mock не hit (0 обращений);
  поддельный admin-заголовок не меняет результат; fallback отсутствует;
  редирект на mainnet запрещён; `strip_prefix` владельца не меняет;
  `GET /working/txproof/*` — только staging; в staging-блоке нет
  `127.0.0.1:9335`/`node1.agentcoin.work`.
- Блок 5: ghost-маршруты — 404; `/ecosphere` — 404, не рекламируется.

## Truth Gate кандидата

Политика `stage4-candidate` → **WARN, блокеров 0, warnings 1, unknowns 2**
(`gate/verdict.json`, `gate/TRUTH-GATE.md`).
Обязательный результат ТЗ: `DUPLICATE_ROOT_PRODUCT`, `SITE_SHELL_INCONSISTENT`,
`TEST_MUTATION_TO_MAINNET`, `CORRUPT_OUTPUT`, `SECRET_IN_EVIDENCE` —
отсутствуют; `MINER_OPERATOR_INDEPENDENCE_UNKNOWN` — остаётся UNKNOWN.

## Регрессия (репо, без сети)

- `node test/registry-check.mjs` → `SELFTEST OK 33/33`, exit 0.
- `node test/net-collect.mjs` → `NET SELFTEST OK 43/43`, exit 0.
- `node test/truth-gate.mjs` → `TRUTH GATE SELFTEST OK 42/42`, exit 0.

Инструменты гейта/сбора не менялись.
