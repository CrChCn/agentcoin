# issue-watch — адаптер 5-минутного цикла (AGT-A3-PREFLIGHT, автоматизация)

Минимальный рабочий адаптер: планировщик раз в 5 минут запускает проверку issue #1,
детектит новые `agt-task:`/`agt-review:` по state-файлу, один процесс одновременно (lock).

## Точная команда запуска (Windows, Git Bash)

```bash
export GITHUB_TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
node tools/issue-watch/issue-watch.mjs --repo CrChCn/agentcoin --issue 1 \
  --after <ISO-время-сдачи> --wait-min 5 \
  --state .issue-watch-state.json --lock .issue-watch.lock \
  --out docs/a-topology/issue-watch-log.json
```

## Таймер (Windows Task Scheduler, раз в 5 минут)

```powershell
schtasks /create /tn "AGT-IssueWatch" /tr "node C:\...\agentcoin-fix\tools\issue-watch\issue-watch.mjs --repo CrChCn/agentcoin --issue 1 --after <ISO> --wait-min 0 --state ..." /sc minute /mo 5
```

(`--wait-min 0` в планировщике: сам Task Scheduler и есть таймер; `--wait-min 5`
используется только в разовом демо-тесте «сдача → автозапуск через 5 минут».)

## Что делает / чего не делает

- Делает: ждёт до сдачи+5мин, читает issue #1 по API, пишет журнал
  (deliveryTime / scheduledWake / actualWake / lagSec), дедупликация новых
  задач и ревью по ID, токен только из окружения (в репо секретов нет).
- НЕ делает: не запускает проход агента. Точка входа CLI/API для старта
  прохода Codebuff на этой машине отсутствует (`codebuff: command not found`,
  проверено 2026-11-09) — это точный блокер. Планировщик готовит всё
  (state, лог, список новых задач), но сам проход начинается только сообщением
  в чат («проверь иссию»). Как только появится CLI/API — встраивать вызов
  в одном месте: после записи `newTasks` в журнал.
