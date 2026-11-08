# ТЗ: автодеплой сайта из Git (pull-механизм)

## 1. Цель
Обновление `/site` на Leader-ноде — коммитом в `main`, без ручного `scp` и без SSH.
Коммит → сайт обновился (SLA 5 минут). Нода (`node.mjs`/`core.mjs`) pull-механизмом
НЕ обновляется — только статика сайта (рестарт не требуется: `serveSitePage` читает с диска).

## 2. Что есть сейчас (исходная точка)
- Сайт отдаёт нода: `serveSitePage` читает `src/site/<page>` с диска (+ `src/site/skill/*`).
- Релизный контроль уже существует: `site/release.json` (manifest `{файл: sha256}`)
  + `SiteReleaseManager` (`site-release.mjs`) с апрувом релизов и `resolvePage()`.
  Сейчас источник апрува — `raw.githubusercontent.com` (см. `invalid_release_source`):
  его и заменяем на Git.
- Файлы `site/mine.html`, `site/agent.html` в git, деплой — `scp` + (без рестарта).

## 3. Проектное решение: git-pull + hash-gate
На Leader-ноде — bare-mirror репозитория `/opt/agentcoin-site.git` + рабочая копия
`/opt/agentcoin-site`, systemd-таймер `site-pull.service` каждые 60 с:
1. `git fetch origin main` → `git rev-parse origin/main` (новой ревизии нет — выход).
2. `git checkout -f origin/main -- site/` в stage-каталог.
3. Проверка: `node --check` неприменим к html — вместо него hash-gate:
   сверить sha256 каждого файла с `site/release.json` из ТОГО ЖЕ коммита;
   несовпадение/отсутствие manifest — отказ (fail-closed, старая версия продолжает отдаваться).
4. Атомарная замена: `rsync` в `src/site/` + `src/site/skill/` (исключая `release.json`
   ноды? нет — manifest кладётся вместе со статикой, он и есть эталон).
5. Пост-проверка: `curl http://127.0.0.1:9335/life` + `curl` главной; неуспех — откат
   (`rsync` из backup-снапшота, храним 3 последних).
6. Метрики/логи: `/var/log/site-pull.log`, счетчик в `/life` (`siteRev`, `siteUpdatedAt`).

## 4. Безопасность (fail-closed)
- Pull ТОЛЬКО `site/`-поддерево (allowlist расширений: `.html .js .mjs .css .png .wasm .webmanifest .md .zip`); всё остальное из коммита игнорируется — исполнение кода через сайт невозможно.
- GPG-подпись коммитов владельца (опция 2 этапа: `git verify-commit` по ключу из `/etc/agentcoin-owner.gpg`).
- Секреты/кошельки в pull не участвуют (другой DATA_DIR, вне репозитория).
- Резервные ноды сайт НЕ тянут (проксируют Leader через Caddy) — pull только на Leader.

## 5. Не scope
- Деплой `node.mjs`/`core.mjs`/Caddy/env — только вручную: требует `node --check`,
  симуляции (как CORE-P0 120/120) и согласованного рестарта 3 нод.
- Управление Caddy (`/skill/*`, `/jobs/zkclaim/*`, `/escrow/*` handles) — вручную + `caddy validate`.

## 6. Приёмка
- Коммит в `site/` → ≤5 мин страница новая (`curl` diff), старая ревизия в backup.
- Битый manifest → деплоя нет, сайт старый, ошибка в логе.
- `git log --oneline -1` рабочей копии == ревизия в `/site/release` endpoint.

## 7. Оценка
~0.5 дня: таймер + скрипт pull-gate (~80 строк sh) + `siteRev` в `/life` + доку.
