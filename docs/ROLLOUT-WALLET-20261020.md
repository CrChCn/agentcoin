# Production Rollout — кабинет + кошелёк на живую ноду 9335

Дата: 2026-10-20 · Бранч: `codebuff/guest-acceptance-20261020` · Коммиты: `e9f25bf` (+ wallet) → `597b3d5` (+ release manifest).

## Фактическое состояние до deploy

| Факт | Значение |
|---|---|
| Процесс живой ноды | PID 22132 (node.exe, листенер 127.0.0.1:9335) |
| Data-dir | `agentcoin/data` (используется только процессом 9335 — `run-node.cmd` строка 18) |
| Запуск | `run-node.cmd` (лог `log-node.txt`) |
| Живой сайт | старый код: `GET /wallet → 404`, `/cabinet → 200`, `POST /cabinet/wallet/history → 400 bad_address` (старый 404/400 ответ) |

## Файлы релиза (коммит e9f25bf + 597b3d5)

| Файл | Тип | Роль |
|---|---|---|
| `wallet-api.mjs` | new | read-only API истории/сметы, height-gated classifyTx |
| `node.mjs` | mod | 3 маршрута (`/wallet`, `/wallet-format.js`, 2 × `POST /cabinet/wallet/*`), whitelist-записи |
| `core.mjs` | mod | height-gating 2-sig (без ретроактивности) |
| `treasury.mjs` | mod | policy + `effectiveFrom: closesAt + 1` |
| `site/user-wallet-page.html` | new | страница кабинета (URL /wallet) |
| `site/user-wallet-format-lib.js` | new | контракт + units + QR (URL /wallet-format.js) |
| `test/wallet-page.mjs` | new | 7/7 acceptance (изолированная нода) |
| `docs/WALLET-CABINET.md` | new | документация |
| `site/release.json` | mod | манифет site-v2-c09272b900fef211 (12 файлов, hashes) |
| `tools/build-site-release.mjs` | mod | pages += 2 wallet-файла |
| `site/panel.js` | regen | пересобрана от committed bytes |

Несвязные файлы НЕ в коммите: `.github/workflows/ci.yml` (в рабочем дереве, commit отложен — workflow-scope), `treasury-payout.mjs`, `comm-wallets.json`, прочие untracked leftovers.

## Rollout-план (canary 9335 — единственный живой процесс ноды с этим портом)

1. **Бэкап**: руб-copy `data → data-backup-<ts>` (текущий ізвестен консистентный state — процесс остановим корректно).
2. **Остановить указанный PID** 22132 (только его: `taskkill /PID 22132`) — не массовый kill node.exe.
3. **Дождаться освобождения порта 9335** (netstat, до 30 с).
4. **Запустить ноду штатным способом**: `run-node.cmd` (тот же data-dir, тот же бинд, тот же лог).
5. **Проверить готовность**: `/life → 200` (максимум 60 с), `/info.blocks` ~12100+.
6. **Live-приёмка** (после готовности, отдельной секцией ниже).
7. **Наблюдение 10–15 мин**: tip растёт, WS-пиры подключаются; при расхождении с сетью — rollback.

## Live-приёмка (пункт 5 ТЗ)

| Проверка | Ожидание |
|---|---|
| `GET /wallet` | 200, содержит `Кошелёк AGENTCOIN` |
| `GET /wallet-format.js` | 200 с AgentcoinWalletFormat |
| `GET /cabinet` | 200 (регресс: старый кабинет жив) |
| `GET /life` | 200 fresh=true |
| `POST /cabinet/wallet/estimate` (валидная сессия) | 200 + `fees[0].amount === 0` |
| `POST /cabinet/wallet/history` (валидная сессия) | 200 + rows с собственного адреса |
| login → state | 200 по паспорту, баланс >0, wallet.baoMGNT согласован |
| send/receive E2E | op-request → подпись → op-submit → mine → history confirmed |
| treasury panel | `/treasury/state` → policy с `effectiveFrom` |

## Rollback-план

Если приёмка упала или нода нездорова после рестарта:

1. Остановить PID нового процесса 9335 (taskkill /PID <new>).
2. `git revert 597b3d5 e9f25bf` — откат до pre-wallet (state до e9f25bf: `4e31f9c`).
3. Восстановление данных: если data-dir повреждён — `data-backup-<ts> → data` (работали только через остановленный процесс).
4. Запуск `run-node.cmd`, live-чек `/life`, `/cabinet → 200`, `/validate?strict=1` (должен вернуть прежний `false at 4092` — возврат к известному состоянию).
5. Сверить tip с network bootstrap перед включением внешних пиров.

**Мониторинг после deploy**: `log-node.txt` — errors за 5 мин; `/info.blocks` растёт; форк-детектор (`/forks`) пуст.
