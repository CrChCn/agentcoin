# Этап C1.1 — Always-on Orchestrator, hardening

Сервис поверх движка этапа A: очередь, миссия, планировщик по доказанным
расхождениям, память проекта, systemd и публичный read-only статус.
**Публикации в production нет, настоящие агенты по умолчанию выключены.**

C1.1 закрывает восемь дефектов C1: самоповторяющийся planner, слабый lease,
недоказанный STOP, адреса API, публичные поля, hard budget, read-only источник
и установку без dry-run/rollback.

## C2: что добавлено перед установкой

C2 ставит сервис на отдельный ops-host без агентов; для этого закрыты четыре
предустановочных дефекта и добавлена раскладка immutable-code:

| Требование C2 | Реализация | Доказательство |
|---|---|---|
| Symlink-выход из `repositoryRoot` | `service/checks.mjs`: lstat по каждому компоненту, запрет symlink, `realpath` внутри корня, лимит размера, только regular-файлы | тест `registry checks: symlink, traversal, ...`, `c2-acceptance` |
| Повторный дефект после исправления | инциденты `queue/incidents.json`: OPEN → TASK_CREATED → RESOLVED → REOCCURRED, `generation += 1` и новый ключ | тест `incident lifecycle`, `c2-acceptance` |
| Кто снимает STOP | Ed25519: приватный ключ только у root (`/etc/agentcoin/operator.key`), сервис проверяет публичным; `opsd resume` → код 78 | тест `STOP: ... operator signs`, `c1-stop-proof.txt` |
| Код в writable-каталоге | `/opt/agentcoin-orchestrator/current` (root, read-only) + `/var/lib/...` данные + `/var/log/...` журналы; юниты пишут только в данные и журналы | `c2-acceptance.json` (`code-read-only`, `units-readonly-code`) |
| Pinned runtime Codex | `service/tools/codex-pin.mjs` + `service/runtime.mjs`: постоянный путь, SHA256, root-owned, без автообновления; `/tmp` отвергается | тест `pinned runtime`, `c2-acceptance` |

Полный runbook и чек-лист приёмки на хосте — `service/C2.md`.

## Что изменилось в C1.1

| Дефект C1 | Как закрыт в C1.1 | Доказательство |
|---|---|---|
| Planner клонировал `planner.template` бесконечно | задачи только по доказанному расхождению из `queue/registry.json` или backlog владельца; нет evidence → **IDLE** | `planner: empty registry is IDLE`, `proven gap ... deduplication` (tests) |
| Lease = pid + host | lease/lock: `hostId`, `bootId`, `pid`, `processStartTime`, `operationId`, `taskId`; решение по всей комбинации | `lib/procinfo.mjs`, тест `lease: ... survives PID reuse` |
| STOP доказан частично | STOP останавливает planner, lease, implementer, reviewer; переживает перезапуск; resume пишет HMAC-подписанное событие | `evidence/c1-stop-proof.txt` |
| API: только unit-файл | bind строго `127.0.0.1` и `::1`; проверка `ss -ltnp` в доказательстве | `evidence/c1-stop-proof.txt` (LISTEN 127.0.0.1 / [::1] только) |
| Публичный JSON = внутренний объект | `contracts/public-status.schema.json` + allowlist-сборщик `service/publicview.mjs` | тесты схемы и утечек |
| Перерасход 290 851 при лимите 200 000 → ACCEPTED | hard budget (`maxTotalTokens`, `maxTotalRuntimeMinutes`) исключает ACCEPTED, событие `budget.overrun`; soft-порог пишет `budget.soft_exceeded` | тест `budget: hard overrun ... excludes ACCEPTED` |
| Источник репозитория не ограничен | `sourceRequirements` в mission, проверка `source.writable`, `enforceReadOnly` | `service/runner.mjs: sourceAccess` |
| install.sh без отката | `--dry-run`, повторный запуск, `inventory/install-manifest-<ts>.json` с SHA256 и владельцем данных, неизменяемый release, `--rollback` на предыдущий release, `--uninstall`, отказ при чужом владельце (79), доступном STOP (82), расхождении манифеста (83) и изменении `queue.json` | `bash -n`, `--dry-run` в доказательстве |

## Планировщик: только доказанное расхождение

`queue/registry.json` — реестр проверок, которые владелец считает значимыми:

```json
{
  "id": "docs-claim-mismatch",
  "priority": 40,
  "type": "registry_gap",
  "check": { "kind": "file_includes", "path": "docs/EXAMPLE.md", "needle": "обязательный текст" },
  "task": { "...": "полный контракт задания (scope, acceptance, лимиты)" }
}
```

Типы проверок: `file_exists`, `file_includes`, `file_excludes`,
`json_field_equals`, `manual`. Все проверки читают только `repositoryRoot`,
абсолютные пути и `..` запрещены.

Порядок работы tick: STOP → breaker → backlog владельца → проверки реестра →
IDLE. Каждая автоматическая задача несёт:

```json
"trigger": {
  "type": "registry_gap",
  "evidence": ["docs/EXAMPLE.md: does not contain \"обязательный текст\""],
  "observedAt": "2026-11-20T17:00:00.000Z",
  "deduplicationKey": "<sha256 от id проверки и её наблюдаемого состояния>"
}
```

Без `evidence` задача не ставится. Повтор с тем же `deduplicationKey` невозможен:
ключ живёт в очереди и памяти, поэтому одна и та же находка не превращается в
бесконечную серию задач с новыми `taskId`.

## Lease и lock: вся комбинация, а не pid

`lib/procinfo.mjs` определяет владельца по `hostId` + `bootId` + `pid` +
`processStartTime`: другой хост, другая загрузка, отсутствующий pid или
несовпавшее время старта означают «владелец мёртв». Где `/proc` нет (Windows),
`bootId`/`processStartTime` остаются `null`, решение помечается `weak` и это
видно в журнале — слабое доказательство не выдаётся за сильное.

## Бюджеты

- `maxTotalTokens` / `maxTotalRuntimeMinutes` — **hard**: превышение пишет
  `budget.overrun` и блокирует задание (`budget_overrun_hard`); ACCEPTED после
  нарушенного hard budget невозможен (три уровня: перед ролью, после роли,
  перед приёмкой).
- `softTotalTokens` / `softRuntimePerAgentMinutes` — **soft**: только событие
  `budget.soft_exceeded`, задание продолжается.
- `mission.budget`: `project: unlimited`, `task: finite`,
  `processIdleTimeoutSec`, `consecutiveFailureBreaker` — после N подряд
  неудачных заданий planner не создаёт новых (`state: breaker`).

## Публичный статус

API отдаёт только `contracts/public-status.schema.json`: `service`,
`generatedAt`, `orchestrator {state, stale, heartbeatAgeSec, continuous}`,
`queue {counts}`, `tasks [{taskId, status, attempts, commit, artifactSha,
triggerType}]`, `mission {title, priorities}`, `deployment: not-enabled`.
Путей, usernames, PID, внутренних адресов, промптов, stderr, credentials,
памяти проекта и имён секретов там нет по построению — объект собирается
allowlist-ом (`service/publicview.mjs`), а не вырезанием полей.

`/ops/memory` отдаёт только счётчики решений и уроков.

## STOP

`opsd stop` создаёт `queue/STOP` и подписывает событие `service.stop_signed`
(HMAC-SHA256 ключом машины `state/machine.key`, 0600). Пока файл есть:

- `plan` не создаёт задач, `tick` не берёт lease, implementer/reviewer не
  запускаются (`logs/`, `workspaces/` остаются пустыми);
- deployer остаётся выключенным (юнит под `ConditionPathExists`, скрипт
  отказывает кодом 3);
- перезапуск процесса ничего не меняет: файл на диске.

`opsd resume` снимает файл и пишет `service.resume_signed`; подпись проверяется,
подделанное событие не проходит.

## Установка и откат

```bash
./service/install.sh --dry-run                  # план, ничего не меняется
sudo ./service/install.sh                       # файлы, юниты, manifest, backup
sudo ./service/install.sh --enable              # + enable/start
sudo ./service/install.sh --rollback            # предыдущий release
sudo ./service/install.sh --uninstall           # код и юниты, данные остаются
```

Гарантии install.sh: manifest `inventory/install-manifest-<ts>.json` с SHA256
каждого файла; предыдущий `orchestrator/` копируется в `backups/install-<ts>`;
`queue/`, `project-memory/`, `workspaces/`, `runs/`, `artifacts/`, `logs/` не
перезаписываются; отказ, если `OPS_ROOT` принадлежит неожиданному владельцу;
отказ, если `queue/queue.json` изменился во время установки.

## Команды

```bash
node service/opsd.mjs status                 # внутренний статус (для владельца)
node service/opsd.mjs plan                   # один проход планировщика
node service/opsd.mjs tick                   # один цикл
node service/opsd.mjs loop                   # постоянный цикл
node service/opsd.mjs api --port 8799        # публичный allowlist API (loopback)
node service/opsd.mjs watchdog               # проверка зависания (код 2)
node service/opsd.mjs queue --add task.json  # задание владельца
node service/opsd.mjs memory --lesson "…"    # заметка в память проекта
node service/opsd.mjs stop|resume           # отказ 78: STOP и resume ставит только service/operator.mjs
```

## Доказательства

| Файл | Что показывает |
|---|---|
| `evidence/c1-service-tests.txt` | 11 тестов: очередь, lease/PID reuse, planner IDLE/dedup, цикл до ACCEPTED, restart, STOP, budget overrun, публичная схема, API, watchdog/breaker |
| `evidence/c1-restart-proof.txt` | SIGKILL на середине задания → lease и lock мёртвого владельца → продолжение до ACCEPTED → второе задание из backlog |
| `evidence/c1-stop-proof.txt` | STOP до и после перезапуска, отсутствие side effects, подписанные stop/resume, `ss -ltnp` только loopback, отказ deployer |
| `evidence/c1-real-crash-recovery.txt` | **BLOCKED**: настоящий Codex на этой машине недоступен (`agent_unavailable`, `adapterEndToEnd=false`); скрипт отказывается подменять доказательство дублёром |
| `evidence/c1-install-dryrun.txt` | dry-run install/rollback/uninstall, повторный запуск, отказ при чужом владельце (79) и без root (77) |
| `evidence/c2-acceptance.txt` / `.json` | 28 проверок C2 (включая манифест против владельца данных и границу репетиции): read-only код, IDLE, одна задача, symlink, инцидент, STOP/ключ, loopback API, deployer, rollback/uninstall, pinned runtime; 2 пункта `PENDING` (systemd/reboot на хосте) |
| `evidence/c2-host-acceptance.txt` / `.json` | приёмка на реальном ops-host (`service/tools/c2-host-acceptance.sh`): юниты, loopback API, IDLE, одна задача по registry evidence, STOP/queue/checkpoint после reboot, rollback/uninstall; PASS только за выполненную проверку, остальное SKIP/PENDING |
| `evidence/c2-install-rehearsal.txt` | новая раскладка: dry-run, идемпотентность, prefix-установка, отказ rollback без release (80), group-writable STOP (82), без root (77), границы репетиции |
| `evidence/c1-systemd-verify.txt` | `systemd-analyze verify` для 7 юнитов |

`evidence/c1-real-crash-recovery.txt` — единственный незакрытый пункт C1.1:
реальный crash-recovery требует машины с установленным и авторизованным Codex
(`codex login`) и `adapterEndToEnd=true` после
`node tools/agent-hostile-check.mjs --real`. Скрипт
`service/tools/c1-real-crash-recovery.sh` для этого готов: он проверяет
preflight, убивает процесс в середине implementer-шага, проверяет отсутствие
осиротевших codex/bwrap, broker-сокетов и временных `CODEX_HOME`, и требует
ровно один коммит и тот же артефакт у ревьюера.

## Границы этапа

Не включено: staging, атомарный release, backup/health-check/rollback
публикации, доступ агентов к `/agent-room`, приём задач извне. Deployer —
выключенный юнит, который всегда отказывает. Production не затрагивается.
