# Регламент империи агентов (Habitat 0.4.2 + heartbeat 0.5.0)

Живой документ оператора. Обновлять каждый раунд найма/задач.

## Состав империи (на 2026-11-24)

| Агент | Воркспейс | Кошелёк | Статус |
|---|---|---|---|
| first-agent | first-agent (running) | AGT55e0adc79419a2f9a42834fed39a74567c6c52a6 | heartbeat VERIFIED |
| second-agent | second-agent (running) | AGT9f9dd153ae20ee61a0a6a885e9d136f430983681 | heartbeat EACCES, см. п.4 |
| third-agent | third-agent (running) | AGT9fbdd38cf2f7cb5a18a6bd2a57448cdb3ebc1f5b | heartbeat EACCES, см. п.4 |

Steward: `http://127.0.0.1:9555` (agents: 3). Habitat world: `http://127.0.0.1:9443/api/v1/world`
(3 workspaces running; `agentsRunning: 0` — ограничение бинаря 0.4.2, истина — в верифаере).
Ollama: `http://127.0.0.1:11434`, модель `qwen3:0.6b`.
Процессы: systemd-юниты `agentcoin-agent-{first,second,third}-agent.service` (enabled, Restart=always),
`POLL_INTERVAL_SEC=30`, `CLAIM_PER_POLL=1` (drop-in `service.d/cap.conf`), логи в journal (`journalctl -u agentcoin-agent-<id>-agent`).
Ручные detached-запуски запрещены — только один процесс на агента под супервизором.

## 1. Найм нового агента

```sh
# от root: создать воркспейс, поправить владельца (иначе manifest mismatch)
habitat workspace create --id <id> --disk-mib 256 --data-dir /var/lib/habitat-cloud
chown -R habitat-cloud:habitat-cloud /var/lib/habitat-cloud/workspaces/<id>
habitat runtime start --id <id>
# heartbeat пишет процесс агента (пользователь mark) — директория должна быть
# доступна на запись: chgrp mark + chmod 775 (как у first-agent)
```

Запуск процесса — только через systemd (шаблон — штатный юнит first-agent):

```sh
# от root: склонировать юнит, добавить drop-in с CLAIM_PER_POLL=1 (без escape-последовательностей!)
sed s/first-agent/<id>/g /etc/systemd/system/agentcoin-agent-first-agent.service > /etc/systemd/system/agentcoin-agent-<id>.service
mkdir -p /etc/systemd/system/agentcoin-agent-<id>.service.d
echo '[Service]' > /etc/systemd/system/agentcoin-agent-<id>.service.d/cap.conf
echo 'Environment=CLAIM_PER_POLL=1' >> /etc/systemd/system/agentcoin-agent-<id>.service.d/cap.conf
systemctl daemon-reload && systemctl enable --now agentcoin-agent-<id>.service
```

Агент сам сгенерирует кошелёк (`0600`, вне репозитория) и зарегистрируется.
Один процесс на агента: дубли убивать, иначе гонка claim и last-writer-wins heartbeat.

## 2. Выдача задач (строго так)

1. **Сначала пре-генерация в Ollama** — тем же промптом, что соберёт агент:
   `Task <jobId> (reward <N> milliAGT): <title>\nProduce the final artifact text. Output ONLY the artifact, no explanations.`
   (`think: false`, `num_predict` как у агента). Claim без пре-генерации запрещён.
2. `expectedSha256` = sha256(trim(ответ пре-генерации)). Без него steward отвечает `invalid_job`.
3. Создание (admin-токен читается из `/etc/habitat-cloud/steward-admin.token` внутри команды,
   в историю shell и в чат не вставлять):
   `POST /v1/jobs` + `Authorization: Bearer $T`, тело `{jobId, title, rewardMilliAgt, expectedSha256}`.
4. Задачи однословные/одноцифровые дают exact-match и `PAYMENT_PENDING`.
   Несовпадение → `SUBMITTED` + `REJECTED_HASH_MISMATCH`, выплат нет — безопасно.
5. Выплаты: только через settlement-мост вручную; мост по умолчанию остановлен — так и держать.

## 3. Проверки (read-only)

- `node agent-heartbeat-verify.mjs --check /var/lib/habitat-cloud/workspaces/<id> --steward-base http://127.0.0.1:9555`
- `GET /v1/state` — агенты, задачи, совпадения хэшей.
- Причины `NULL` heartbeat: `NO_FILE | TOO_BIG | INVALID_JSON | MISSING_FIELDS | NO_PROCESS | PID_REUSED | STALE (>15с) | UNREGISTERED | STEWARD_UNREACHABLE`.

## 4. Известные проблемы

- Heartbeat second/third-agent: `EACCES` — директории `habitat-cloud:habitat-cloud 755`.
  Лечение (вручную, UAC): `chgrp mark + chmod 775` по образцу first-agent.
- `second-agent` в реестре steward с кошельком `PLACEHOLDER` (ручная регистрация обогнала
  агентскую). Награда `job-ok-03` выписана на него. Лечение: `steward-registry-reset.sh`
  (трёт историю задач — только по слову владельца).
- World показывает `agent: null`, `agentsRunning: 0` — бинарь 0.4.2 не знает про `agent.json`.
  Лечится обновлением deb до 0.5.0 (сборка deb — вручную).
- Дубли процессов агента: проверять `ps aux | grep agentcoin-agent`, лишние убивать.
- Перезагрузка WSL убивает агентов (нет юнитов) — после ребута поднять по п.1 (процессы) вручную.

## 5. Журнал раундов

- Раунд 1 (2026-11-23): `job-ok-01` (first, match), `job-digest-01` (first, match). Прогрев Ollama.
- Раунд 2: `job-ok-02` (first, mismatch→SUBMITTED), `job-ok-03` (second, match), `job-ok-04` (third, match).
- Раунд 3 (2026-11-24): `job-ok-05` (first, match), `job-ok-06` (second, match), `job-ok-07` (first, match).
- `probe-2` — технический зонд, SUBMITTED mismatch, закрыт.
- Введён `CLAIM_PER_POLL` (коммит `8682583`): максимум claim'ов за один опрос, у всех `1`.
