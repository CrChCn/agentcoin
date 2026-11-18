#!/usr/bin/env bash
# diag-readonly.sh — ТОЛЬКО ЧТЕНИЕ, без секретов, без рестартов, без записи.
# Запуск на cx23 оператором:  bash diag-readonly.sh 2>&1 | tee diag-YYYYMMDD-HHMM.log
# Ничего не меняет: только systemctl status/show/is-enabled/cat, ps, ss,
# чтение конфигов и GET-запросы. Файлы .env/токены/ключи НЕ читаются и НЕ печатаются.
set -u
REDACT='s/((TOKEN|SECRET|KEY|PASSWORD|PASSWD|PRIVATE|SEED|MNEMONIC)[A-Za-z0-9_]*=)[^ ]+/\1<redacted>/g; s/(Authorization:[ ]*)[^ ]+/\1<redacted>/g'
redact() { sed -E "$REDACT"; }
say() { echo "### $*"; }

say "UNITS (agentcoin/agt)"
systemctl list-units --all --no-legend 'agentcoin*' 'agt-*' 2>/dev/null || echo "no matching units"
echo
for u in agentcoin-autonomous-job-test-api.service agt-node.service; do
  if systemctl cat "$u" >/dev/null 2>&1; then
    say "UNIT $u"
    systemctl is-enabled "$u" 2>/dev/null | redact
    systemctl is-active "$u" 2>/dev/null | redact
    systemctl show "$u" -p ExecStart,Environment,ActiveEnterTimestamp,MainPID,Restart 2>/dev/null | redact
    pid=$(systemctl show "$u" -p MainPID --value 2>/dev/null)
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      ps -o pid,etime,cmd -p "$pid" 2>/dev/null | redact
    fi
    echo
  fi
done

say "LISTENERS (localhost http)"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | head -30 | redact
echo

say "PROXY ROUTING (caddy, only routing lines)"
if [ -f /etc/caddy/Caddyfile ]; then
  grep -nE "reverse_proxy|file_server|root \*|route |handle|@|\.work|localhost|127\.0\.0\.1|:[0-9]{4,5}" /etc/caddy/Caddyfile | head -60 | redact
else
  echo "no /etc/caddy/Caddyfile"
fi
echo

probe() { # probe <url>
  code=$(curl -s -o /tmp/diag-body.txt -w "%{http_code}" --max-time 8 "$1" 2>/dev/null || echo "curl_fail")
  body=$(head -c 300 /tmp/diag-body.txt 2>/dev/null | tr '\n' ' ' | redact)
  echo "$1 -> HTTP $code :: $body"
}
say "NODE DIRECT (root routes, same host)"
for p in /info /life /capabilities /queue/history /memory/state /compute/state; do
  # порт ноды — из юнита agt-node (Environment PORT) либо 9335/последний известный
  probe "http://127.0.0.1:${AGT_NODE_PORT:-9335}$p"
done
echo
say "ADAPTER /api/v1 (gateway allowlist lives here)"
for p in /info /life /capabilities /queue/history /memory/state /compute/state; do
  probe "http://127.0.0.1:${AGT_API_PORT:-9336}/api/v1$p"
done
echo
say "PUBLIC (as seen by visitors)"
for u in "https://agentcoin.work/" "https://agentcoin.work/api/v1/info" "https://agentcoin.work/api/v1/life"; do
  probe "$u"
done
echo
say "DONE (read-only, no changes made)"
