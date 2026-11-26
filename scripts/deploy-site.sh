#!/usr/bin/env bash
# deploy-site.sh — выкладка статики сайта на прод-ноду (agentcoin.work).
#
# Прод отдаёт страницы через Caddy: `root * /srv/agentcoin-empire/current` (см.
# caddy-routes.conf). Кэш релизов ноды (/site/release) на эти файлы НЕ влияет,
# поэтому деплой = положить файлы в root на сервере. Рестарт не нужен.
#
# Использование:
#   bash scripts/deploy-site.sh [user@host] [remote-root]
#     user@host    по умолчанию root@2.31.145.160
#     remote-root  по умолчанию /srv/agentcoin-empire/current
#
# Только три файла модуля эфира; остальную статику не трогает.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=${1:-root@2.31.145.160}
ROOT=${2:-/srv/agentcoin-empire/current}
FILES=(site/imperial.html site/stream.html site/release.json)

die() { echo "✗ $*" >&2; exit 1; }

for f in "${FILES[@]}"; do [ -f "$f" ] || die "нет $f (собери: node stream/build-site-stream.mjs)"; done
grep -q 'id="stream"' site/imperial.html || die "в imperial.html нет модуля эфира — собери stream/build-site-stream.mjs"

echo "→ проверка доступа $HOST"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" 'true' || die "нет SSH-доступа к $HOST (нужен ключ или пароль; без него деплой невозможен)"

echo "→ цель: $HOST:$ROOT"
ssh -o BatchMode=yes "$HOST" "test -d '$ROOT'" || die "на сервере нет каталога $ROOT — уточни root из /etc/caddy/Caddyfile"

echo "→ копирование (${FILES[*]})"
if command -v rsync >/dev/null 2>&1 && ssh -o BatchMode=yes "$HOST" 'command -v rsync >/dev/null'; then
  rsync -az --chmod=F644 "${FILES[@]}" "$HOST:$ROOT/"
else
  scp -q "${FILES[@]}" "$HOST:$ROOT/"
fi

echo "→ проверка прода"
code=$(curl -s -m 20 -o /tmp/agt-deploy-check.html -w '%{http_code}' "https://agentcoin.work/?cb=$(date +%s)")
echo "  /            HTTP $code"
if grep -q 'id="stream"' /tmp/agt-deploy-check.html; then
  echo "✓ модуль эфира в живом HTML (размер $(wc -c < /tmp/agt-deploy-check.html) байт)"
else
  die "файл на месте, но живой HTML без модуля — проверь root в Caddy и слой кэша"
fi
echo "✓ готово: https://agentcoin.work/#stream"
