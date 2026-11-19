# Truth Gate — этап 3: полное покрытие и контрольный шлюз

Этап 3 превращает реестр и наблюдатель этапа 2 в единый строгий шлюз. Гейт
**ничего не исправляет**: он только читает, проверяет и классифицирует. Рестарты,
деплой, правки конфигов, транзакции и изменения денег/очереди/выплат запрещены и
не выполняются. Mutation-маршруты не вызываются.

Этап 4 (безопасный план исправлений с бэкапом, откатом и проверкой результата)
начинается только после приёмки этого гейта.

## Файлы

| файл | роль |
| --- | --- |
| `config/unified-registry.json` | единственный список компонентов/маршрутов; цели сбора — только отсюда |
| `config/truth-gate-policy.json` | политика: словарь статусов, обязательные проверки, правила блокеров, whitelist env-параметров |
| `tools/gate-collect.mjs` | read-only сбор этапа 3 (изоляция сред, майнинг, Caddy, C07, settlement, capabilities, sdk/cli/mcp/pilot) |
| `tools/net-collect.mjs` | базовый read-only сбор этапа 2 (ноды, маршруты, монитор) |
| `tools/net-diff.mjs` | сравнение ожидаемого с наблюдаемым, `nodeCompare` на одной высоте |
| `tools/truth-gate.mjs` | чистый evaluator + CLI: `truth-gate.json` и `TRUTH-GATE.md` |
| `test/truth-gate.mjs` | 28 сценариев без сети и production |

## Входы и выход

Входы: `unified-registry.json`, `observations.json`, `diff.json`, политика.
Выход — ровно:

```json
{
  "verdict": "PASS|WARN|BLOCKED",
  "blockers": [],
  "warnings": [],
  "unknowns": [],
  "coverage": {},
  "evidence": [],
  "nextActions": []
}
```

В выходе нет времени генерации: повторный запуск на тех же входах даёт побайтово
тот же JSON и тот же Markdown. `coverage` содержит по каждому компоненту статус
(`PASS`, `WARN`, `FAIL`, `BLOCKED`, `OFFLINE_EXPECTED`, `NOT_APPLICABLE`,
`UNKNOWN`), число проверок по статусам, список невыполненных обязательных
проверок и evidence.

## Правила BLOCKED

| код | условие |
| --- | --- |
| `CHAIN_PIN_MISMATCH` | chainId/genesis не совпал с пином реестра |
| `SAME_HEIGHT_FORK` | разные хэши одного блока на одной высоте (не разные высоты) |
| `ROUTE_OWNER_CONFLICT` | один публичный URL имеет двух владельцев/upstream |
| `SHARED_WRITABLE_DATA_DIR` | общий writable DATA_DIR (или cwd) у разных сетей |
| `SECRET_IN_EVIDENCE` | сканер нашёл приватный ключ/токен/присвоенный секрет |
| `DUPLICATE_ROOT_PRODUCT` | два публичных URL отдают побайтово один product (двойник главной) |
| `UNPROVEN_MUTATION_ROUTE` | публичная mutation-route без наблюдаемой защиты |
| `TEST_MUTATION_TO_MAINNET` | тестовый хост проксирует запись в mainnet |
| `TEST_ENV_MAINNET_GENESIS` | testnet/staging с mainnet genesis без `documentedReason` |
| `MONITOR_IMPERSONATION` | монитор выдаёт чужую ноду за локальную |
| `CRITICAL_COMPONENT_UNWATCHED` | у критического компонента ноль успешных наблюдений |
| `SETTLEMENT_CONTRACT_BROKEN` | settlement/платежи не подтверждены (контракт или sha кода) |
| `UNJUSTIFIED_NOT_CHECKED` | `not_checked` без допустимой причины |
| `CATCH_ALL_SHADOWS_MODULE` | более одного catch-all на уровне или catch-all-proxy |
| `MISSING_EVIDENCE` | `ok` без evidence или evidence вне каталога `evidence/` |
| `CORRUPT_INPUT` | входной JSON не читается/неполон |
| `MUTATION_ROUTE_CALLED` | в наблюдениях есть вызов mutation-route |

Тайм-аут сам по себе — `WARN`/`UNKNOWN`, не доказательство падения. `LAGGING` и
`STALE` — предупреждения, не форк. Отсутствие проверки никогда не выдаётся за
исправность: `not_checked` допустим только с причиной из
`notCheckedAllowedReasons` (`param_required`, `offline_expected`,
`not_applicable`, `public_only_ssh_skipped`, `bare_path_needs_parameter`,
`mutation_not_called`).

## Что именно проверяется

1. **Покрытие.** Для каждого из 20 компонентов задан список обязательных
   проверок. Компонент без успешного наблюдения — `UNKNOWN`, критический —
   блокер.
2. **Изоляция сред.** Для mainnet/testnet/job-test/staging: unit, пользователь,
   PID, `ExecStart`, порт, cwd, DATA_DIR, chainId, genesis, путь кода, sha файлов,
   время запуска, зависимости, публичный маршрут. Жёсткие блокеры — общий
   writable DATA_DIR, mainnet genesis у теста без причины, тестовая запись в
   mainnet. Значения env не читаются: только имена параметров и значения из
   whitelist (`DATA_DIR`, `AGT_DATA_DIR`, `AGT_BIND`, `AGT_PUBLIC_URL`, `PORT`,
   `CHAIN_ID`, `NETWORK`, `NETWORK_ID`, `NODE_ENV`).
3. **Майнинг.** Активные units/timers/cron, процесс-кандидат, источник coinbase,
   производители последних 20 блоков, дубли майнеров, соответствие расписанию
   реестра, объект наблюдения watchdog. Совпадение адресов не объявляется
   независимостью операторов — это `UNKNOWN`.
4. **Caddy.** Редактированная карта host → matcher → handler → upstream → owner;
   порядок static/Next/proxy, `/`, `/imperial`, `/agent-room`, `/settlement`,
   `/mainnet/*`, `/api/v1/*`, `/ecosphere/*`, reserve-маршруты, `/ws/*`. Один
   публичный URL — один владелец. Caddy сортирует `handle` по специфичности
   path-матчера, поэтому «catch-all ниже модуля» само по себе не перекрытие;
   блокер — конкурирующие catch-all одного уровня и catch-all-proxy.
5. **C07 — единый сайт.** Для страниц: HTTP status, final URL, Content-Type,
   SHA тела, title/H1, nav/release-маркер, источник маршрута, владелец. Два URL с
   одинаковым телом и одним title/H1 — `DUPLICATE_ROOT_PRODUCT`.
6. **Settlement.** Голый `/mainnet/settlements` — не контракт (`PARAM_REQUIRED`);
   реальный контракт — `/mainnet/settlements/:orderId/status`. Без реального
   orderId маршрут не называется mismatch; проверяется корректный отказ
   `settlement_not_found`, а совпадение задеплоенных sha с репозиторием
   фиксирует контракт кода.
7. **Capabilities против маршрутов.** Каждый рекламируемый read-route
   проверяется GET; параметризованные — `PARAM_REQUIRED`; 404 рекламируемого —
   `CAPABILITY_GHOST`; существующий, но не рекламированный машинный маршрут —
   `UNDOCUMENTED_ROUTE`. Mutation-route не вызываются.
8. **Секреты и дисциплина.** Evidence сканируется на приватные ключи, Bearer и
   присвоенные секреты (значения не сохраняются, только sha совпадения); сбор
   проверяет, что mutation-маршруты не вызывались.

## Результат среза 2026-11-19

Полный read-only срез: 190 наблюдений (`ok=182`, `mismatch=6`, `not_checked=2`),
20 компонентов: `PASS=16`, `FAIL=3`, `WARN=1`. Вердикт — **BLOCKED**, 3 блокера,
15 предупреждений, 0 unknowns. Все детали и evidence — в
`reports/stage3-2026-11-19/{truth-gate.json,TRUTH-GATE.md,DIFF.md,observations.json,evidence/}`.

Блокеры среза:

- `DUPLICATE_ROOT_PRODUCT`: `https://agentcoin.work/` и `/imperial` отдают одно и
  то же тело (131290 байт, sha256 `0582e147…0852f`, один title/H1); в Caddy оба
  URL переписываются на `imperial.html`, `/index` → 308 `/`.
- `ROUTE_OWNER_CONFLICT`: на `api-staging.agentcoin.work` путь `/txproof/*`
  обслуживают два handler'а — `@owner_session_read` → `127.0.0.1:9335`
  (mainnet-нода) и `@public_reads` → `127.0.0.1:29335` (staging).
- `TEST_MUTATION_TO_MAINNET`: тот же тестовый хост проксирует `POST
  /cabinet/{challenge,login,state,logout,wallet/*,op-request,op-submit}` в
  `127.0.0.1:9335`, то есть запись в mainnet с тестового домена; кроме снятия
  `X-Admin-Token` защита в конфиге не наблюдается.

Предупреждения: 3 `CAPABILITY_GHOST` (`/peers/bootstrap`,
`/ops/watchdog/state`, `/gateway/list` рекламируются, но отдают 404), 3
`LAGGING` (транзиентное отставание вершин, не расхождение), 1
`MODULE_NOT_PUBLISHED` (`/ecosphere` — документированный 404), 8
`UNDOCUMENTED_ROUTE` (машинные GET-маршруты, которых нет ни в реестре, ни в
capabilities).

Изоляция сред подтверждена чтением: mainnet `AGENTCOIN` / genesis `00026d18…`
(DATA_DIR `/opt/agentcoin-node/data`, root:root 700), testnet `AGT_TESTNET` /
`00022668…`, job-test `AGENTCOIN_JOB_TEST` / `0001bb89…`, staging-API
`AGT_TESTNET` / `00022668…`. Разные chainId/genesis, отдельные каталоги и
пользователи (`agt-staging`, `agt-job-test`); общего writable DATA_DIR с
mainnet нет.

Майнинг: `agentcoin-miner.service` (auto-miner 60с, 7 адресов ротации),
cron `*/10 mine-cron.sh`, `agentcoin-watchdog.service`
(`/opt/agentcoin-sups/watchdog-svc.mjs`), heartbeat-таймер. Последние 20 блоков
произведены 7 адресами — это ротация, а не доказательство независимости
операторов.

## Воспроизведение

```bash
# 1) read-only сбор (SSH-ключ ~/.ssh/agentcoin-deploy; без него SSH-проверки станут unavailable)
node tools/gate-collect.mjs --registry config/unified-registry.json \
  --policy config/truth-gate-policy.json \
  --out reports/stage3-<date> --concurrency 1

# 2) сравнение и отчёт по компонентам
node tools/net-diff.mjs reports/stage3-<date>/observations.json \
  reports/stage3-<date>/DIFF.md --registry config/unified-registry.json

# 3) гейт
node tools/truth-gate.mjs --registry config/unified-registry.json \
  --observations reports/stage3-<date>/observations.json \
  --diff reports/stage3-<date>/diff.json \
  --policy config/truth-gate-policy.json \
  --out reports/stage3-<date>/truth-gate.json --md reports/stage3-<date>/TRUTH-GATE.md
```

Параллелизм сбора — не больше 4; в этом срезе использован `--concurrency 1`,
потому что при одновременных запросах к одному и тому же URL наблюдались
ложные тайм-ауты. Тайм-аут остаётся `WARN`, а не доказательством падения.

## Тесты

```bash
node test/registry-check.mjs   # 33/33 — схема/валидатор реестра
node test/net-collect.mjs      # 43/43 — этап 2 + fix6, изолированно (моки)
node test/truth-gate.mjs       # 28/28 — гейт, изолированно (фикстуры)
```

Сценарии гейта покрывают: здоровую систему, одинаковую историю трёх нод,
транзиентный лаг, форк на одной высоте, несовпадение chainId/genesis, общий
DATA_DIR, конфликт владельцев, двойную главную, capability ghost, mutation-route
без защиты, offline expected, необоснованный `not_checked`, тайм-аут (не форк),
отсутствующий evidence, повреждённый вход, `PARAM_REQUIRED`, catch-all,
запись теста в mainnet, секрет в evidence, детерминизм, подмену монитора,
критический компонент без наблюдения, сломанный settlement, вызов
mutation-route, `NOT_APPLICABLE`, одинаковую высоту/хэш, лаг при разных
вершинах и видимость `UNKNOWN`.

## Границы

Гейт не чинит найденное: три блокера требуют решения владельца (убрать двойник
главной или развести модули, свести `/txproof/*` к одному владельцу, убрать
запись с тестового хоста в mainnet). До этого этап 4 не начинается.
