# Этап C1 — Always-on Orchestrator

Постоянный сервис поверх движка этапа A. Задача этапа: оркестратор перестаёт
зависеть от ноутбука — очередь, миссия, планировщик, память проекта, systemd и
read-only статус для сайта. **Публикации в production на этом этапе нет.**

```
agentcoin.work/ops                  ← публичный статус (только чтение)
        │  Caddy → 127.0.0.1:8799
Agentcoin Ops API                   ← service/api.mjs
        │
Оркестратор 24/7                    ← service/opsd.mjs loop
        │
   planner (timer) → queue → engine step → reviewer → ACCEPTED
        │
   project-memory + artifacts + commits (без push и без деплоя)
```

## Что сервис умеет и чего не умеет

| Разрешено | Запрещено |
|---|---|
| читать source-репозиторий и создавать рабочие копии | push в любой remote |
| писать код в изолированном workspace | deployment, staging, production |
| запускать разрешённые контрактом тесты | SSH к нодам, Caddy, DATA_DIR цепи |
| создавать commits и артефакты | кошельки, казна, транзакции, мост |
| вести очередь, память, журнал решений | принимать задачи от посетителей сайта |

Реальные агенты (`codex-implementer` / `codex-reviewer`) включаются только
двумя условиями сразу: `allowRealAgents: true` в mission **и** доказанная
изоляция (`adapterEndToEnd=true`, см. `orchestrator.mjs preflight`). Пока этого
нет, сервис работает детерминированными дублёрами — они честно помечены
`simulated=true` в состоянии задания, и это видно в API.

## Раскладка на ops-хосте

```
/srv/agentcoin-ops/
├── orchestrator/      код (этот каталог после install.sh)
├── repository/        source-репозиторий, только чтение для сервиса
├── workspaces/        изолированные копии на задание
├── runs/              отчёты прогонов движка
├── artifacts/         ZIP-артефакты accepted-заданий
├── project-memory/    memory.json + lessons.jsonl
├── queue/             queue.json, tasks/, backlog/, mission.json, journal.jsonl, STOP
├── logs/              журнал заданий движка
└── state/             heartbeat.json, checkpoint.json, watchdog.json
```

Каталоги создаёт `service/install.sh`; владелец — системный пользователь
`agt-orchestrator` без shell и без sudo. `agt-deployer` существует отдельно и
не имеет доступа к `OPS_ROOT` на запись.

## Очередь и миссия

`queue/mission.json` — стратегическая цель, приоритеты и границы прав.
Общего конца у mission нет; каждая задача конечна и имеет доказательство
(коммит + артефакт + отчёт).

Очередь (`queue/queue.json`) хранит по заданию: `taskId`, `status`
(`pending|leased|done|failed|blocked`), `attempts`, lease с pid и хостом,
результат (`state`, `commit`, `artifactSha`). Все изменения дублируются в
`queue/journal.jsonl` событиями `queue.enqueued`, `queue.claimed`,
`lease.expired`, `lock.reconciled`, `queue.done`, …

Планировщик (`service/planner.mjs`):
1. если в очереди есть незавершённое задание — новых не создаёт;
2. иначе забирает контракт владельца из `queue/backlog/*.json`;
3. иначе клонирует `planner.template` с новым `taskId`. Содержание контракта
   (scope, acceptance, лимиты) не меняется: планировщик не редактирует
   требования.

`queue/STOP` останавливает и планирование, и исполнение: цикл доигрывает
текущий переход движка и встаёт. Снимается `opsd.mjs resume`.

## Восстановление после перезапуска

Шаги задания живут в hash-журнале движка (`logs/<taskId>/events.jsonl`), а не в
очереди. Поэтому:

- SIGTERM — процесс доигрывает шаг, пишет checkpoint и выходит с кодом 0;
- SIGKILL / выключение машины — lease остаётся с мёртвым pid, а lock задания —
  с мёртвым владельцем;
- следующий процесс: `releaseExpiredLeases` возвращает задание в `pending`
  (событие `lease.expired`), `reconcileDeadLocks` снимает lock **только** если
  pid мёртв и журнал задания цел (событие `lock.reconciled`), затем задание
  продолжается с последнего подтверждённого состояния;
- повторная постановка того же `taskId` невозможна (`QUEUE_DUPLICATE`), поэтому
  перезапуск не создаёт дубль задания.

Доказательство: `service/tools/c1-restart-proof.sh` и его вывод в
`evidence/c1-restart-proof.txt` (SIGKILL на середине задания, затем ACCEPTED,
затем следующее задание из planner, штатная остановка SIGTERM).

## Команды

```bash
node service/opsd.mjs status                 # состояние, очередь, checkpoint, память
node service/opsd.mjs plan                   # один проход планировщика (таймер)
node service/opsd.mjs tick                   # один цикл: восстановление → план → шаги
node service/opsd.mjs loop                   # постоянный цикл
node service/opsd.mjs api --port 8799        # read-only API
node service/opsd.mjs watchdog               # проверка зависания (код 2 = внимание)
node service/opsd.mjs queue --add task.json  # поставить задание владельцем
node service/opsd.mjs stop|resume            # STOP-файл
```

## Read-only Ops API

Слушает только loopback (`127.0.0.1:8799`, юнит запрещает прочие адреса).
Только `GET`/`HEAD`: `POST`/`PUT`/`DELETE` получают `405`. Все ответы
`cache-control: no-store`.

| Маршрут | Содержимое |
|---|---|
| `/ops/status` | состояние оркестратора, heartbeat, checkpoint, счётчики очереди, память |
| `/ops/queue` | задания: статус, попытки, коммит, sha256 артефакта |
| `/ops/memory` | факты, решения и последние уроки |
| `/ops/releases` | `deployment: not-enabled` до появления deployer |
| `/ops/health` | свежесть heartbeat (для мониторинга) |

Публикация на сайт — отдельным решением владельца, конфигурация Caddy:

```caddy
handle /ops {
    reverse_proxy 127.0.0.1:8799
}
```

Страница `service/public/ops.html` берёт те же данные и не содержит ни одной
операции записи: кнопки STOP, разрешения deployment и rollback на ней нет по
замыслу — это действия владельца на сервере.

## systemd

| Юнит | Роль |
|---|---|
| `agt-orchestrator.service` | постоянный цикл (`opsd loop`), `Restart=always`, `TimeoutStopSec=180` |
| `agt-orchestrator-scheduler.timer` (+ `.service`) | каждые 5 минут один проход планировщика |
| `agt-orchestrator-api.service` | read-only API на loopback |
| `agt-orchestrator-watchdog.timer` (+ `.service`) | каждые 2 минуты проверка зависания |
| `agt-deployer.service` | выключен; `ConditionPathExists=/etc/agentcoin/deploy-enabled`, в C1 всегда отказ |

Общие ограничения юнитов: `NoNewPrivileges`, `ProtectSystem=strict`,
`ProtectHome`, `PrivateTmp`, пустой `CapabilityBoundingSet`,
`ReadWritePaths=/srv/agentcoin-ops` (у API — `ReadOnlyPaths`), `UMask=0077`,
`RestrictAddressFamilies`, `SystemCallFilter=@system-service`.
`MemoryDenyWriteExecute` намеренно не включён: Node нуждается в JIT.
Проверено `systemd-analyze verify` — 7 файлов без замечаний.

Watchdog ничего не убивает и не перезапускает: он пишет вердикт в
`state/watchdog.json` и выходит с кодом 2. Зависание — событие для владельца,
а не повод для автомата.

## Установка

```bash
# на ops-хосте, от root
sudo OPS_ROOT=/srv/agentcoin-ops ./service/install.sh          # разложить, не запускать
sudo systemctl enable --now agt-orchestrator.service agt-orchestrator-api.service
sudo systemctl enable --now agt-orchestrator-scheduler.timer agt-orchestrator-watchdog.timer
sudo -u agt-orchestrator OPS_ROOT=/srv/agentcoin-ops \
  node /srv/agentcoin-ops/orchestrator/service/opsd.mjs status
```

Если отдельного сервера нет, тот же скрипт ставится на H1: отдельный
пользователь, отдельный каталог, отдельный юнит, без доступа к `DATA_DIR`
цепи, без кошельков и без root-shell.

## Проверка

```bash
node --test service/tests/service.test.mjs   # 7 тестов: очередь, lease, planner, цикл, restart, API, watchdog
bash service/tools/c1-restart-proof.sh       # доказательство перезапуска (Linux/WSL)
systemd-analyze verify service/systemd/*.service service/systemd/*.timer
```

## Границы этапа

Не реализовано и не включено намеренно: staging-сборка, атомарный release,
backup, health-check, rollback, автоматическая публикация, доступ агентов к
`/agent-room`, приём задач извне. Это следующие этапы; C1 заканчивается там,
где заканчивается безопасная автономия — писать код, коммитить и готовить
артефакты без права публиковать.
