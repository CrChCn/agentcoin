# Stage 4 — план production-развёртывания (НЕ ВЫПОЛНЯЛСЯ)

Production не изменялся. Ниже — точный план отдельного окна (этап 5).

## 0. Окно и условие входа

Отдельное окно по слову владельца. Входное условие: кандидат принят
независимой проверкой ZIP (этап 4), бэкап из п.2 готов и проверен.

## 1. Изменяемые файлы (кандидат → серверный путь)

| кандидат | серверный путь | действие |
| --- | --- | --- |
| `site/index.html` | `/srv/agentcoin-empire/current/index.html` | создать/заменить |
| `site/agent-room.html` | `/srv/agentcoin-empire/current/agent-room.html` | заменить |
| `site/settlement.html` | `/srv/agentcoin-empire/current/settlement.html` | создать/заменить |
| `site/_shell/shell.css` | `/srv/agentcoin-empire/current/_shell/shell.css` | создать |
| `site/_shell/shell.js` | `/srv/agentcoin-empire/current/_shell/shell.js` | создать |
| `site/app.js` | `/srv/agentcoin-empire/current/app.js` | создать |
| `site-patches/buffy-ops.html` | `/srv/agentcoin-empire/current/buffy-ops.html` | заменить (1 ссылка) |
| `site-patches/buffy.html` | `/srv/agentcoin-empire/current/buffy.html` | заменить (1 ссылка) |
| `site-patches/cabinet.html` | `/srv/agentcoin-empire/current/cabinet.html` | заменить (1 ссылка) |
| `site-patches/compute.html` | `/srv/agentcoin-empire/current/compute.html` | заменить (1 ссылка) |
| `site-patches/memory.html` | `/srv/agentcoin-empire/current/memory.html` | заменить (1 ссылка) |
| `site-patches/tree.json` | `/srv/agentcoin-empire/current/tree.json` | заменить |
| `Caddyfile.candidate` (два site-блока) | `/etc/caddy/Caddyfile` | применить блоки |
| `site/release.json` | — | НЕ копировать: перегенерировать на сервере штатным `site-release.mjs` |

SHA256 каждого файла — в `SHA256SUMS` пакета. `imperial.html` на диске НЕ
трогаем (backing-файл, больше не обслуживается).

## 2. Бэкап (до любых изменений)

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
B=/root/stage4-backup-$TS
mkdir -p $B
cp -a /etc/caddy/Caddyfile $B/Caddyfile
cp -a /srv/agentcoin-empire/current $B/site-current
sha256sum $B/Caddyfile > $B/SHA256SUMS
(cd /srv/agentcoin-empire/current && sha256sum index.html agent-room.html settlement.html buffy-ops.html buffy.html cabinet.html compute.html memory.html tree.json 2>/dev/null) > $B/site-SHA256SUMS
echo $B  # этот путь — единственный источник отката
```

## 3. Проверка конфигурации

```bash
caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --pretty > /tmp/adapted.json
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Оба должны завершиться успешно. При ошибке — стоп, откат не нужен (ничего не
тронуто, т.к. reload ещё не выполнялся).

## 4. Атомарная публикация

1. Положить файлы сайта и `_shell/`/`app.js` рядом, права как у соседних файлов.
2. Заменить два site-блока Caddyfile.
3. `caddy validate` → `systemctl reload caddy` (без restart сервисов и нод).
4. Перегенерировать `site/release.json` штатным средством.

Рестарт нод, systemd-юнитов и любые транзакции запрещены.

## 5. Проверки после публикации

- `GET /` → 200, canonical `https://agentcoin.work/`, release-маркер единый.
- `GET /imperial`, `/imperial.html` → 308 `/`; `/imperial?x=1` → `/?x=1`.
- `GET /agent-room`, `/settlement` → 200, тот же shell/release, свои модули.
- `POST api-staging…/working/cabinet/login` → 404 `staging_mutation_unavailable`;
  mainnet-лог без новых записей за окно.
- `GET api-staging…/working/txproof/x` → ответ staging (29335), не mainnet.
- Повторный read-only gated-срез: три исходных блокера отсутствуют.

## 6. Откат

Только из фактического серверного бэкапа п.2 (не из этого ZIP):

```bash
cp -a $B/Caddyfile /etc/caddy/Caddyfile
rm -rf /srv/agentcoin-empire/current && cp -a $B/site-current /srv/agentcoin-empire/current
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
```

## 7. Явная строка

Production не изменялся: на этапе 4 не выполнена ни одна команда против
production, Caddy, systemd и запущенных процессов.
