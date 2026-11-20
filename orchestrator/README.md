# Agentcoin Autonomous Engineering Loop — этап A

Двухагентный цикл: исполнитель → артефакт → независимый проверяющий →
исправление → приёмка, с hash-журналом, восстановлением после остановки и
типизированными действиями.

> **Статус: Stage A fix7 — весь исполняемый код в runtime manifest, включая `state/` и `artifacts/`.**
> Настоящий агент не запускается ни одним unit-тестом: в тестовом процессе
> адаптер возвращает `REAL_AGENT_DISABLED_IN_TEST` даже при установленном,
> авторизованном Codex и ключе в окружении. Реальный двухагентный цикл ещё не
> выполнялся — `codex login` не запрашивался.
> Тестовый двойник CLI используется **только** в тестах проводки
> (`tests/real-harness.test.mjs`) и нигде не выдаётся за Codex.
> Production, сайт, ноды, очередь и деньги не затрагивались.

---

## 0. Чистая проверка архива

Набор файлов в ZIP не пишется руками: `lib/package.mjs` обходит реальный граф
импортов от `orchestrator.mjs`, всех адаптеров, всех тестов и `tools/*`, и
любой относительный импорт обязан найти файл. `tools/pack.mjs` собирает архив,
распаковывает его в пустой каталог, прогоняет проверки и пересобирает, пока
результат не стабилизируется.

Проверить выданный архив как чужой файл:

```bash
unzip agentcoin-orchestrator-stage-a-fix1-20261119.zip
cd orchestrator

node --test tests/*.test.mjs
node orchestrator.mjs capabilities

# без codex в PATH добавьте --codex-bin <путь к codex.js>
node orchestrator.mjs preflight --task fixtures/tasks/lesson-01.json --root runs/preflight-clean

sha256sum -c SHA256SUMS
```

Ожидаемый результат: тесты зелёные, `capabilities` печатает оба адаптера
(`codex-implementer`, `codex-reviewer`), `preflight` выходит с кодом `3` и
единственным блокером `agent_unauthenticated`, `sha256sum -c` — `OK` для
каждого файла. Полный вывод этих команд лежит в
`evidence/package-clean-test.txt`, разобранный preflight — в
`evidence/preflight-clean.json`, результаты тестов — в `evidence/tests.txt`.
`FILELIST.txt` — полный список файлов с размерами и хешами.

Пересобрать архив и заново прогнать чистую проверку:

```bash
node tools/pack.mjs                            # сборка + clean room + evidence
node tools/clean-check.mjs <archive.zip>       # проверка готового архива
node tools/environment-matrix.mjs <archive.zip>  # четыре окружения Codex
```

`environment-matrix` прогоняет весь набор тестов в четырёх средах: Codex
отсутствует; присутствует, но без входа; присутствует и авторизован; заданы
`CODEX_API_KEY`/`OPENAI_API_KEY`. Результат обязан совпасть — unit-тесты не
зависят от состояния машины. Настоящий CLI не вызывается ни в одном варианте.

---

## 0.1 Изоляция unit-тестов

- `tests/helpers.mjs` задаёт единое тестовое окружение: `CODEX_BIN` — либо
  объявленный двойник, либо гарантированно отсутствующий путь; `CODEX_API_KEY`
  и `OPENAI_API_KEY` удаляются; наследованные `FAKE_CODEX_*` не протекают.
- В процессе теста (`NODE_TEST_CONTEXT` или `ORCH_TEST_MODE=1`) адаптер
  возвращает `REAL_AGENT_DISABLED_IN_TEST` до любого `spawn`. Единственное
  исключение — `tests/codex-cli-double.mjs` при `ORCH_TEST_ALLOW_DOUBLE=1`.
- `tests/test-isolation.test.mjs` подкладывает исполняемый файл, который пишет
  факт запуска, и доказывает, что файл не создан.

## 0.2 Symlink-защита

До чтения каждого изменённого файла проверяется `lstat` каждого компонента:
разрешён только обычный файл, symlink/каталог/FIFO/device/socket — отказ
(`UNSAFE_FILE_TYPE`, `SYMLINK_ESCAPE`), realpath обязан остаться внутри
workspace. Артефакт применяется только через проверенные родительские
каталоги и атомарную замену файла; удаление через symlink запрещено.
`tests/symlink.test.mjs` покрывает девять сценариев плюс сквозную блокировку
итерации, закоммитившей symlink наружу.

## 0.3 Межпроцессный lock

`lib/lock.mjs` захватывает `locks/<taskId>/` атомарным rename уже заполненного
каталога. Критическая секция: `load state → verify journal → reserve → шаг →
append → snapshot → release`; `operationId` пишется в каждое событие журнала.
Второй процесс получает `TASK_BUSY` (exit 75) и ничего не запускает. Мёртвый
lock не снимается сам: `NEEDS_RECONCILE` (exit 76), затем явный
`node orchestrator.mjs reconcile --task <id> --force` после проверки журнала.

## 0.4 Запуск настоящих агентов

```bash
node orchestrator.mjs real \
  --task fixtures/tasks/lesson-01.json \
  --root runs/real-1 \
  --confirm-real-agents lesson-01
```

Без `--confirm-real-agents <taskId>` команда `real`, а также `init` с реальным
адаптером возвращают `BLOCKED REAL_AGENT_NOT_ARMED` и ничего не создают.
Режим (`mode`, `realAgentsArmed`) сохраняется в состоянии при инициализации,
поэтому подменить fixture-адаптер реальным позже нельзя.

## 0.5 Изоляция реального контура (fix3)

fix2 запускал тестовые команды обычным `spawnSync` от имени пользователя: у
процесса были файловая система хоста, сеть, дочерние процессы, а вычитающий
фильтр пропускал `DATABASE_URL`, `SESSION_COOKIE`, `AUTH_HEADER`. fix3 убирает
этот класс дефектов.

**Окружение default-deny.** `lib/envpolicy.mjs` собирает env allowlist'ом;
наследование `process.env` запрещено. Разрешены `PATH`, `LANG`, `LC_ALL`,
`LC_CTYPE`, `TZ`, `TMPDIR`/`TMP`/`TEMP`, `NO_COLOR`, `FORCE_COLOR`, `TERM`
(+ `SYSTEMROOT`/`SYSTEMDRIVE`/`WINDIR` на Windows). Рабочим командам не
передаются `HOME`, ключи API, SSH-сокеты, cookie и cloud-переменные. Codex CLI
получает `HOME` только для чтения ChatGPT-сессии.

**OS-sandbox.** Реальные команды идут через bubblewrap (Linux) или bubblewrap
внутри WSL2 (Windows): смонтирован только workspace, системные каталоги
read-only, пустой `HOME`, tmpfs `/tmp`, нет сети, нет SSH-агента и docker.sock,
PID-namespace, лимиты nproc/память/CPU/размер файла, внешний тайм-аут, среда
уничтожается после завершения. Дополнительно включается permission-модель Node
(`--permission --allow-fs-read/write=<workspace>`): чтение вне workspace,
`child_process` и запись рядом с ним запрещены и на уровне процесса. Нет
backend'а → `BLOCKED ISOLATED_RUNNER_UNAVAILABLE`, реальный цикл не начинается.

**API-key режим заблокирован.** `OPENAI_API_KEY`/`CODEX_API_KEY` больше не
считаются входом: preflight отдаёт `api_key_mode_blocked`. Разрешена только
ChatGPT-сессия, и рабочий код не видит auth-хранилище Codex.

**Вымарывание до записи.** stdout/stderr, JSONL, meta, prompts, отчёты и
артефакт проходят через расширенный фильтр (KEY, TOKEN, SECRET, PASSWORD,
PASS, CREDENTIAL, AUTH, COOKIE, SESSION, PRIVATE, MNEMONIC, SEED, WALLET,
DATABASE_URL, CONNECTION_STRING, AWS_/AZURE_/GCP_/GOOGLE_/SSH_/GITHUB_/GITLAB_/NPM_)
и маскирование строк `scheme://user:password@host`.

**Hostile clean-room.** `node tools/hostile-check.mjs` создаёт workspace с
враждебным тестом, канарейку вне workspace, поддельные `~/.ssh/id_rsa` и
`~/.codex/auth.json`, canary-переменные и требует технического отказа на 15
атак: чтение вне workspace, SSH-ключ, auth Codex, `DATABASE_URL`,
`SESSION_COOKIE`, `OPENAI_API_KEY`, 127.0.0.1, публичный IP,
curl/PowerShell/shell, docker.sock, SSH-агент, symlink наружу, запись рядом с
workspace. Отчёт: `evidence/hostile-check.txt`.

## 0.6 Изоляция реального контура (fix5)

fix4 верно убрал прямой `spawn` Codex на хосте, но границей считал подмену
`PATH`/`bash`/`sh`. Это не граница: внутри namespace оставались настоящие
`/bin/bash`, `/bin/sh`, `/usr/bin/env` и `/usr/bin/node`, поэтому абсолютный
путь обходил прокси и получал одновременно сеть и `/run/credentials/codex`.
Плюс уровень 3 принимался по полям JSON, то есть подделывался вручную.
fix5 меняет и механизм, и доказательство.

**1. Подмена PATH больше не заявлена границей.** В namespace Codex каталоги
`/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`, `/usr/local/bin`, `/usr/local/sbin`
заменяются `tmpfs` целиком. В них остаются только клиенты broker'а (`bash`,
`sh`), а `PATH=/orch/bin`. Настоящих shell'ов и интерпретаторов там нет:
`/bin/bash`, `/bin/sh`, `/usr/bin/env`, `/usr/bin/node` не существуют
технически, а не «не находятся по PATH». Node для самого Codex живёт по
отдельному адресу `/orch/rt/node` (bind, read-only).

**2. Инструменты исполняет отдельный broker.** `tools/tool-broker.mjs`
запускается своим bwrap-процессом: `--unshare-all`, без `/run/credentials`,
без `CODEX_HOME`, без provider-сети, rw только workspace. Клиент
`tools/tool-proxy.mjs` (он же `/bin/bash`) передаёт команду по unix-сокету
`/orch/ipc/broker.sock`; broker применяет allowlist и исполняет её у себя.
Даже если команда разрешена, она не видит ни сети (включая loopback), ни
credential-каталог Codex.

**3. Абсолютные обходы закрыты и проверяются.** Матрица
`lib/attackmatrix.mjs` — фиксированный список обязательных проверок (18 в fix5,
22 в fix6 — четыре script-mode атаки добавлены в 0.7):
`/bin/bash`, `/bin/sh`, `/usr/bin/env bash`, прямой `/usr/bin/node`,
`node` + `probes/net.mjs`, чтение `/run/credentials/codex/auth.json`, чтение
вне workspace, `~/.ssh/id_rsa`, `DATABASE_URL`, публичная сеть, localhost,
`curl`, запись рядом с workspace, а также три разрешённые операции (чтение
workspace, отсутствие credentials и сети в broker-namespace). Атаки исполняет
harness внутри того же плана, что и Codex; вердикт берётся из кода выхода и
кода ошибки, а не из ответа модели. Allowlist дополнительно запрещает
абсолютные пути, `~` и `..` (`TOOL_PATH_DENIED`).

**4. Маскирование fail-closed.** Из прокси удалены `mount ... || true`:
маскирование делает bwrap, и любая ошибка mount завершает запуск. Broker при
старте сам проверяет, что `/run/credentials` отсутствует и сеть недоступна
(реальный `connect`); если проверка не проходит — `BROKER_CREDENTIALS_VISIBLE`
или `ISOLATED_TOOL_NET_UNAVAILABLE`, сокет не открывается, команды не
исполняются.

**5. Уровень 3 привязан к машине и сборке.** `evidence/agent-isolation.json`
принимается только если он:

- подписан HMAC-SHA256 ключом `~/.agentcoin/evidence-hmac.key`, который
  лежит вне workspace агента и создаётся один раз;
- содержит nonce из реестра `~/.agentcoin/nonces.json`, не старше 24 часов и
  привязанный к хэшу ровно этого файла (повторное использование отклоняется);
- совпадает с текущим host fingerprint (hostname, платформа, ядро, CPU);
- совпадает с текущей сборкой: commit, SHA256 `bwrap`, Codex entrypoint и его
  версия, хэши policy/proxy/broker/attack matrix/orchestrator;
- содержит ровно по одному результату каждого обязательного attack ID, без
  неизвестных, пропущенных и повторных; каждая запрещённая атака — `denied`
  с ненулевым кодом выхода и кодом отказа, каждая разрешённая — `exit 0`;
- содержит непрерывную хэш-цепочку журнала broker'а (head сверяется);
- не содержит найденных утечек из временной копии `auth.json`.

Preflight отклоняет ручной JSON, неизвестный/пропущенный/повторный attack ID,
другой хэш кода или Codex, другой host fingerprint, устаревший nonce и
отсутствие проверяемой подписи — во всех случаях `agent_isolation_unproven`.
Регрессионный тест `tests/evidence.test.mjs` фиксирует именно тот файл,
который fix4 принимал за уровень 3.

**6. Утечки ищутся по значениям, а не по именам.** `--real` читает значения
из временной копии `auth.json`, ищет их в transcript, журнале и prompt и
сохраняет в evidence только SHA256 найденного (сам токен не пишется ни в
журнал, ни в отчёт).

**7. Что именно доказывает `--real`.** Сначала harness прогоняет матрицу
атак, затем запускает настоящий `codex exec` в том же плане и требует хотя бы
одну разрешённую операцию с `exit 0` в журнале broker'а, наличие `thread_id`
и отсутствие записи вне workspace. Текст ответа модели не используется как
доказательство.

Ограничения, которые не спрятаны: на этой машине уровень 3 не доказан —
вход Codex не выполнялся (`codex login` не запускался), поэтому
`adapterEndToEnd=false` и preflight остаётся `BLOCKED` с кодом выхода `3`.
`node tools/hostile-check.mjs` (фазы runner + матрица) проходит, но уровня 3
не открывает. Реальный `--real` на Windows требует Codex, установленного
внутри WSL: путь вида `C:\...\codex.js` в sandbox не существует.

## 0.7 Исправления fix6

Аудит fix5 нашёл три дефекта, каждый закрыт механизмом и регрессионным тестом.

**1. Script-mode удалён из прокси.** fix5 в режиме `bash <file>` вызывал
`fs.readFileSync(file)` внутри namespace Codex, где виден
`/run/credentials/codex/auth.json`; `/bin/bash /run/credentials/codex/auth.json`
возвращал содержимое credentials до политики broker'а. Теперь
`tools/tool-proxy.mjs` принимает только `-c`/`-lc`, не импортирует `fs` и не
читает ни один файл. `bash file`, `sh file`, `bash -- file`, `bash -s`
завершаются техническим отказом `TOOL_SCRIPT_MODE_DENIED` (exit 126). Матрица
дополнена четырьмя атаками: `/bin/bash /run/credentials/codex/auth.json`,
`/bin/sh /run/credentials/codex/auth.json`, внешний `../outside-script.sh` и
symlink из workspace наружу. Harness проверяет, что канарейка внешнего скрипта
не появилась ни в ответе, ни в журнале broker'а.

**2. Временное состояние удаляется всегда.** `plan.cleanup()` удаляет
broker socket, IPC-каталог, scratch (policy и stub-клиенты) и одноразовый
`CODEX_HOME` вместе с `auth.json`. Вызывается из `adapter.finish()` (успех,
timeout, SIGTERM, отмена), из `finally` шага engine, из `finally` harness'а и
из `process.on('exit')`; повторный вызов идемпотентен. `--real` передаёт отчёт
об удалении в evidence (`cleanup.authCopyRemoved`), и preflight отклоняет
доказательство без него. Тест `tests/fix6.test.mjs` проверяет отсутствие
`orch-codex-home-*` после сценария.

**3. Уровень 3 привязан ко всему runtime.** Вместо восьми выбранных файлов
evidence содержит единый manifest (`lib/`, `adapters/`, `tools/`,
`contracts/`, `policies/`, `orchestrator.mjs`) с `rootHash`. Список каталогов
оказался неполным — `state/` и `artifacts/` добавлены в 0.8. Изменение одного
байта любого runtime-файла (включая `adapters/codex-cli.mjs`, `lib/engine.mjs`,
`lib/envpolicy.mjs`, `lib/prompts.mjs`, схемы и harness'ы) меняет `rootHash` и
инвалидирует evidence. Verifier требует `dirty === false` и `dirtyFiles === 0`
на обеих сторонах; evidence, подписанный с `dirty:false` при грязном дереве,
отклоняется. В распакованном ZIP без `.git` привязкой служит подписанный
manifest digest, а `commit:null` сам по себе ничего не открывает.

**4. Порядок политики зафиксирован.** `lib/toolpolicy.mjs` проверяет:
синтаксис → substitution/redirection → пути → запрещённые команды → точное
совпадение с allowlist задачи. Префиксного разрешения больше нет, поэтому
`node --test $(touch injected)`, backticks, `/absolute/path` и `../outside`
отклоняются до любых разрешений; точное совпадение с allowlist не отменяет
запрет команды.

**5. Хранилище ключа и nonce усилено.** Ключ и реестр nonce — только обычные
файлы (symlink отклоняется), владелец — текущий UID, режим 0600 на POSIX;
ключ создаётся атомарно через `open(..., 'wx')`; обновление реестра идёт под
lock-файлом, поэтому конкурентные preflight'ы не теряют запись и не выдают
один nonce дважды.

**Ограничение остаётся тем же.** Уровень 3 в этой сборке не доказан:
`codex login` не выполнялся, `agent-hostile-check --real` не запускался,
`adapterEndToEnd=false`, preflight — `BLOCKED` с кодом `3`. До приёмки fix7
запрещены `--real`, автономный цикл, Stage B и push.

## 0.8 Исправление fix7

Аудит fix6 нашёл дыру в самой привязке: manifest обходил только `lib/`,
`adapters/`, `tools/`, `contracts/`, `policies/` и `orchestrator.mjs`, а
`state/store.mjs`, `artifacts/store.mjs` и `artifacts/apply.mjs` — исполняемый
runtime-код (apply.mjs применяет патч к рабочему дереву) — оставались вне
хэша. Правка этого кода не меняла `rootHash`, и подписанное evidence
продолжало приниматься.

Теперь `runtimeManifest` берёт из `state/` и `artifacts/` модули верхнего
уровня (`.mjs`/`.cjs`/`.js`) и не берёт данные прогонов: `state/<task>/state.json`
и `artifacts/<task>/<iteration>/...` меняются каждым запуском, и их включение
делало бы evidence недействительным сразу после собственного прогона.
Данные по-прежнему защищены SHA256 в state и журнале, но не входят в
fingerprint сборки. `EVIDENCE_VERSION` поднят до 4, поэтому evidence,
подписанное по старому (неполному) manifest, отклоняется как несовместимое.

Регрессии: `tests/evidence.test.mjs` проверяет, что три модуля входят в
manifest, что изменение `state/lesson-01/state.json` или файла артефакта не
меняет `rootHash`, что один байт в `artifacts/apply.mjs` его меняет и что
любой модуль, достижимый из runtime entrypoint'ов через граф импортов,
присутствует в manifest. Последняя проверка не даёт новому каталогу с кодом
снова выпасть из привязки незамеченным.

---

## 1. Что нужно сделать владельцу один раз

На компьютере, где будет идти цикл:

```bash
codex login          # официальный вход, ключ в чат и в репозиторий не передавать
```

Если CLI ещё не установлен глобально:

```bash
npm i -g @openai/codex
codex login
```

Затем проверить точку запуска и выполнить цикл:

```bash
cd agentcoin/orchestrator

# 1) проверка: CLI, вход, контракты, бюджеты, свежий root
node orchestrator.mjs preflight --task fixtures/tasks/lesson-01.json --root runs/real-1

# 2) настоящий цикл: два независимых процесса codex exec
node orchestrator.mjs real \
  --task fixtures/tasks/lesson-01.json \
  --root runs/real-1
```

`real` сначала вызывает `preflight` и **ничего не запускает**, если вход не
выполнен: печатает JSON с `blockers` и выходит с кодом `3`. Это и есть точка
остановки этапа A. После `codex login` повторный запуск не требует правок кода.

`--codex-bin <path-to-codex.js>` (или `CODEX_BIN`) нужен, только если CLI
установлен не в `PATH`. Адаптер сам находит JS-энтрипоинт npm-пакета и
запускает его без shell.

---

## 2. Два разных процесса, два разных контракта

| Роль | Адаптер | Процесс | Рабочий каталог | Схема вывода |
|---|---|---|---|---|
| Исполнитель | `codex-implementer` | отдельный `codex exec` | `workspaces/<task>/implementer` (git, `workspace-write`) | `contracts/implementer-result.schema.json` |
| Проверяющий | `codex-reviewer` | отдельный `codex exec` | `workspaces/<task>/reviewer/applied` (чистый клон базы + артефакт) | `contracts/review-result.schema.json` |

- `implementer` и `reviewer` — разные id, поэтому оркестратор не может принять
  самоприёмку (`SELF_REVIEW`).
- У каждого запуска свой `thread_id` из `thread.started`; он пишется в журнал.
  Исполнитель может продолжить **только свою** сессию на следующей итерации
  (`codex exec resume`); проверяющий никогда не продолжает чужую сессию.
- Проверяющий не получает переписку, рассуждения и незакоммиченные файлы
  исполнителя. Он получает исходное ТЗ, base/result commit, архив, его SHA256,
  чистую базу и применённое дерево.
- Перед работой исполнителя каталог проверяющего удаляется; он пересоздаётся
  из базы перед каждым ревью.
- Ответы моделей валидируются по JSON Schema. Нет структурированного ответа,
  невалидный JSON, отсутствие `resultCommit`/`artifactSha256`, тайм-аут или
  потеря процесса → `BLOCKED`, а не успех.
- `review.reviewer` должен совпадать с id проверяющего, `review.simulated`
  должен соответствовать адаптеру; вердикт `ACCEPTED` при проваленном
  `check` понижается до `CHANGES_REQUESTED`.

### Схемы

- `implementer-result.schema.json` — то, что возвращает модель: задача,
  итерация, base/result commit, изменённые файлы, команды, тесты, ограничения.
  Хеш артефакта модель не объявляет: его считает оркестратор.
- `review-result.schema.json` — вердикт, SHA256 артефакта, коммиты, проверки с
  фактическими `command`/`exitCode`, findings. Оркестратор требует хотя бы одну
  реально выполненную проверку для `ACCEPTED`/`CHANGES_REQUESTED`.
- `task.schema.json` — `productionWrites`, `moneyOperations`,
  `consensusChanges` зафиксированы `const:false`; бюджеты обязательны;
  `scope.environment` — только `isolated`.
- `state.schema.json`, `event.schema.json` — снимок и событие журнала.

---

## 3. Изоляция и полномочия

Что действительно ограничено:

- **Запись.** Оба агента запускаются с `--sandbox workspace-write` и
  `-c sandbox_workspace_write.network_access=false`. Оркестратор после
  исполнителя проверяет `git diff` и `scanEscape`: файл вне рабочего дерева —
  `authority_violation`.
- **Команды.** Модель не может попросить оркестратор выполнить произвольный
  shell: есть только типизированные действия (`checkout`, `apply_patch`,
  `run_test`, `build_artifact`, `calculate_hash`, `submit_review`,
  `prepare_deployment`) и allowlist команд задания. `prepare_deployment` всегда
  отвечает `DEPLOYMENT_RUNNER_NOT_PROVISIONED`.
- **Секреты.** Дочернему процессу не передаются переменные окружения с
  `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL`, кроме ключа, которым реально
  аутентифицируется сам CLI. В журналы и meta пишутся argv без prompt и без
  значений ключей.
- **Scope.** Пути с `..`, абсолютные пути и `.` отклоняются при загрузке
  задания; запись в `tests/acceptance.test.mjs` и `config`/`.env` запрещена
  контрактом.

Честные остаточные ограничения:

- `workspace-write` ограничивает **запись**, а не чтение. Процесс Codex
  технически может прочитать файлы за пределами своего worktree, если знает
  путь. Жёсткая гарантия чтения требует отдельного OS-пользователя/контейнера;
  это не заявляется как сделанное.
- Оба агента — один поставщик (OpenAI Codex). Это два изолированных процесса
  без общей переписки и самоприёмки, но не два независимых поставщика ИИ.
  Для консенсуса, ключей и денежных операций нужен второй поставщик или
  ручной финальный контроль владельца.
- CLI не даёт денежного лимита. Гарантирован только локальный учёт токенов и
  остановка по политике; счёт в OpenAI может быть больше нуля.

---

## 4. Бюджеты

Задание `fixtures/tasks/lesson-01.json`:

```json
"maxIterations": 3,
"maxRuntimePerAgentMinutes": 20,
"maxTotalRuntimeMinutes": 60,
"maxTotalTokens": 200000
```

- Перед каждым запуском оркестратор считает остаток: минимум из лимита роли и
  общего лимита. Меньше 5 секунд — `BLOCKED` (`max_runtime_exceeded`).
- `usage` берётся из `turn.completed` (input / cached / output / reasoning /
  total) и суммируется в состоянии и журнале. При достижении
  `maxTotalTokens` новые итерации не начинаются (`max_total_tokens_exceeded`).
- `maxRuntimePerAgentMinutes > maxTotalRuntimeMinutes` отклоняется инвариантом
  загрузчика.
- Тайм-аут процесса аварийный: `SIGTERM`, затем `BLOCKED` (`agent_timeout`).

Оценка стоимости при допущении $1.25 / 1M input и $10 / 1M output:
первая итерация ≈ 12–20k input + 2–4k output ≈ $0.04–0.07; цикл из двух
итераций с двумя ревью ≈ **$0.15–0.30**. Точная стоимость появится только
после реального прогона: CLI отдаёт usage, но не деньги.

---

## 5. Доказательства, которые оставит реальный прогон

```
runs/real-1/
  logs/<taskId>/events.jsonl                  hash-цепочка переходов
  logs/<taskId>/codex/implementer-N.jsonl     сырой JSONL процесса
  logs/<taskId>/codex/implementer-N.meta.json argv, cwd, thread_id, usage
  logs/<taskId>/codex/reviewer-N.jsonl        сырой JSONL процесса
  logs/<taskId>/codex/reviewer-N.meta.json
  logs/<taskId>/prompts/*.txt                 точные промпты ролей
  logs/<taskId>/implementer-N.result.json     структурированный ответ
  logs/<taskId>/reviewer-N.result.json
  logs/<taskId>/iteration-N.log               длительность, thread_id, usage
  logs/<taskId>/report.json                   сводка (usage, runtime, sessions)
  artifacts/<taskId>/<iter>/<sha256>.zip      контентный артефакт
  artifacts/<taskId>/<iter>/<sha256>.meta.json
  state/<taskId>/state.json                   снимок (журнал — источник истины)
```

`report` дополнительно печатает `threadIds`, `sameProvider`, `usage`,
`runtimeMs`, `budget`, `simulatedAgents`. Восстановление проверяется тем, что
каждый `step` — отдельный процесс, а состояние проигрывается из журнала.

---

## 6. Тесты

```bash
cd agentcoin/orchestrator
node --test tests/e2e.test.mjs tests/restart.test.mjs \
  tests/artifact-swap.test.mjs tests/authority.test.mjs \
  tests/contracts.test.mjs tests/capabilities.test.mjs \
  tests/real-harness.test.mjs
```

15 тестов, все проходят (~51 с):

| Файл | Что доказывает |
|---|---|
| `e2e` | дефект → findings → исправление → `ACCEPTED`, хеши в журнале |
| `restart` | снимок откатан назад, состояние восстановлено из журнала, цикл доведён в новом процессе |
| `artifact-swap` | подмена байта отзывает приёмку (`revoke_acceptance`) |
| `authority` | запрещённый путь, запись вне workspace, команда вне allowlist → `BLOCKED` |
| `contracts` | `productionWrites`/деньги/консенсус/ослабленные лимиты отклоняются |
| `capabilities` | Freebuff не scriptable; неаутентифицированный Codex → `BLOCKED` |
| `real-harness` | два процесса дают разные `thread_id`, пишутся JSONL/usage; невалидный JSON, нет commit, тайм-аут → `BLOCKED`; несогласованный `ACCEPTED` понижается |
| `package-closure` | граф импортов замкнут, entrypoint загружаются, `SHA256SUMS`/`FILELIST.txt` покрывают каждый файл |
| `termination` | процесс, игнорирующий SIGTERM, не вешает прогон; эскалация до убийства дерева; финальная JSONL-запись без `\n` читается |
| `secrets` | ключ из окружения не попадает в argv, meta, JSONL, отчёт, промпты, ошибки и артефакты |

`tests/codex-cli-double.mjs` — процессный двойник **только для проводки**. Он
помечен в отчёте как тестовый, и ни один его результат не используется как
доказательство работы настоящего агента.

---

## 7. Официальные интерфейсы: проверенные факты

### Freebuff / Buffy

Официального программного запуска задачи нет. Freebuff CLI `0.1.6` —
интерактивный TUI: prompt аргументом не принимается, scriptable JSON-режима
нет; Desktop не имеет документированного локального API. Управление
браузером, клавиатурой и экраном не использовалось.
Документация: <https://docs.freebuff.page/cli/> — «It is an interactive client:
it does not accept an initial prompt as an argument, and it is not a
scriptable JSON mode.»

### Codex CLI

Официальный неинтерактивный режим: `codex exec`, `--json` (JSONL),
`thread.started.thread_id`, `turn.completed.usage`, `resume`/`fork`, `-C`,
`--sandbox`, `--output-schema`, `--output-last-message`. Лицензия Apache-2.0,
пакет `@openai/codex@0.170.0`.
Документация: <https://developers.openai.com/codex/noninteractive>.

---

## 8. Структура и воспроизведение без агентов

```
orchestrator.mjs        CLI: capabilities/preflight/real/init/step/run/status/verify/report/demo
contracts/              task, implementer-result, review-result, state, event
adapters/              codex-implementer, codex-reviewer, codex-cli, freebuff-cli, fixture-*
policies/policy.mjs     типизированные действия, пути, команды, escape-scan
lib/                    engine, prompts, schema, zip, fsx, git
state/store.mjs         состояния, переходы, hash-журнал, replay
artifacts/              детерминированный ZIP (STORE, фиксированная дата) + meta
tests/                  7 файлов, 15 тестов
fixtures/               учебная задача, приёмка, тесты проверяющего
```

Механизм без агентов:

```bash
node orchestrator.mjs demo
```

Демо идёт в временном корне, репозиторий не меняет, использует
`fixture-implementer`/`fixture-reviewer` и печатает `(SIMULATED)`.

Проверка артефакта:

```bash
node orchestrator.mjs verify --task lesson-01 --artifact <zip>
```

При расхождении байт — exit `2` и `revoked: true`.

---

## 9. Границы этапа

- Оркестратор не подключён к production, сайту, нодам, очереди и деньгам.
- Нет Deployment Runner: `prepare_deployment` типизирован, но всегда отказывает.
- Нет публикации/деплоя и нет коммитов в репозиторий проекта.
- Этап A не принят владельцем: сначала проверяется архив, затем один реальный
  цикл на безопасной фикстуре.
