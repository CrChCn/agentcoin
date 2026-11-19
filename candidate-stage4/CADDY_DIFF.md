# Stage 4 — Caddy diff (поведенческий; production не изменялся)

Серверный файл: `/etc/caddy/Caddyfile`. Ниже — что меняется в двух site-блоках.
Полный текст кандидата: `Caddyfile.candidate`. Проектный Caddyfile в репозитории
отсутствует (конфиг живёт на сервере), поэтому diff дан относительно поведения,
зафиксированного read-only срезом stage3-fix1 (evidence `caddy-h1:map`,
`caddy-h1:guard-scan`, `caddy-h1:adapted`).

## Блок agentcoin.work / www.agentcoin.work

ДО (срез 2026-11-19):
- `/` и `/imperial` переписываются на `imperial.html` и отдают одно и то же тело
  (131290 байт, sha256 `0582e1477e09…`) → `DUPLICATE_ROOT_PRODUCT`.
- `/index` → 308 `/` (уже корректно, не трогаем).

ПОСЛЕ (кандидат):
```
@imperial path /imperial /imperial.html /imperial/
redir @imperial / 308
handle /        { rewrite * /index.html; file_server }
handle /agent-room { rewrite * /agent-room.html; file_server }
handle /settlement { rewrite * /settlement.html; file_server }
```
- `/` → 200 `index.html` (канон, canonical `https://agentcoin.work/`).
- `/imperial`, `/imperial.html` → 308 `/`, query string сохраняется
  (`/imperial?x=1` → `/?x=1`), redirect loop исключён (цель — `/`, не `/imperial`).
- backing-файл `imperial.html` остаётся на диске, ни один маршрут его не отдаёт.
- Mainnet API/proxy-маршруты (`/tx`, `/balance`, `/info`, settlement) — без изменений.

## Блок api-staging.agentcoin.work

ДО (срез 2026-11-19):
- `POST /working/cabinet/{challenge,login,state,logout,wallet/*,op-request,op-submit}`
  (после `strip_prefix /working` → `/cabinet/*`) → `127.0.0.1:9335`
  → `TEST_MUTATION_TO_MAINNET` (BLOCKED). Защита в конфиге не наблюдается,
  `applicationAuth=UNKNOWN`.
- `GET /working/txproof/*` — две декларации: `mainnet-node-1@L35` (effective,
  `127.0.0.1:9335`) + тень `env-staging@L44` (`127.0.0.1:29335`)
  → `ROUTE_PATTERN_OVERLAP` (WARN).

ПОСЛЕ (кандидат):
```
@staging_mutation { path /working/cabinet/* /cabinet/*; method POST PUT PATCH DELETE }
handle @staging_mutation { respond `{"ok":false,"error":"staging_mutation_unavailable"}` 404 }
handle /working/txproof/* { uri strip_prefix /working; reverse_proxy 127.0.0.1:29335 }
handle /working/node-info /working/identity/meta /working/balance {
  uri strip_prefix /working; reverse_proxy 127.0.0.1:29335 }
```
- Ни одна mutation не проксируется; fallback на mainnet отсутствует; редирект на
  mainnet запрещён (любой неизвестный staging-путь — 404 тем же кодом).
- Один владелец `GET /working/txproof/*` — `env-staging` (`127.0.0.1:29335`).
- В staging-блоке нет `127.0.0.1:9335` и `node1.agentcoin.work` (проверено стендом).
- Вопрос «существует ли настоящий staging-обработчик mutation» из ТЗ: на срезе
  staging-обработчика не обнаружено (все mutation вели в mainnet), поэтому по
  пункту 3 ТЗ маршруты закрыты явным 404 `staging_mutation_unavailable`,
  а не направлены на staging-mock. Когда настоящий staging-обработчик появится,
  его подключают отдельным изменением с доказательством отдельных
  chainId/genesis/DATA_DIR.

## Проверка в deploy-окно (на сервере, после бэкапа)
- `caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --pretty`
- `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
