#!/usr/bin/env bash
# Валидация <site-hostname> для deploy-vps.sh.
# Этот аргумент попадает в AGT_PUBLIC_URL и в блок Caddyfile, поэтому принимаем
# только чистое DNS-имя: без схемы, пути, порта, креденшелов и пробелов.
# Использование: bash scripts/validate-site-host.sh node4.agentcoin.work
set -euo pipefail
host="${1:-}"
[ -n "$host" ] || { echo "site-hostname required" >&2; exit 1; }
[ "${#host}" -le 253 ] || { echo "site-hostname too long" >&2; exit 1; }
# Отсекаем всё, чего в DNS-имени быть не может (в т.ч. перевод строки: bash-регекс
# с `$` пропускает хвостовой \n).
if [[ "$host" == *[!A-Za-z0-9.-]* ]]; then echo "некорректный site-hostname: $host" >&2; exit 1; fi
[[ "$host" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || {
  echo "некорректный site-hostname: $host" >&2
  exit 1
}
printf '%s' "${host,,}"
