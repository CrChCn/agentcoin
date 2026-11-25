#!/usr/bin/env bash
# rollout-h1 — раскатка обновления ноды на H1 (node1, 2.31.145.160).
# Реальная раскладка (2026-11-25, проверено руками): git на хосте НЕТ,
# код — файловая копия /opt/agentcoin-node/src, юнит agentcoin-node.service,
# данные /opt/agentcoin-node/data, BIND 127.0.0.1, ADMIN local, Caddy-dark снаружи.
#
# Использование (обновление):
#   1. локально: подготовить новый node.mjs (контекст сверен, node --check чист)
#   2. scp new-node.mjs root@2.31.145.160:/root/node.mjs.new
#   3. на H1:  bash deploy-h1-pull-restart.sh /root/node.mjs.new <md5-текущего-node.mjs>
# Откат: ROLLBACK=1 bash deploy-h1-pull-restart.sh
set -euo pipefail

SRC=/opt/agentcoin-node/src
DATA_DIR=/opt/agentcoin-node/data
UNIT=agentcoin-node
PORT=9335

die() { echo "✗ ОШИБКА: $*" >&2; exit 1; }

pick_node() {
  for c in /opt/agentcoin-node/runtime/*/bin/node /opt/agentcoin-staging/runtime/*/bin/node /usr/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

wait_alive() {
  for _ in $(seq 1 45); do
    if curl -fsS -m 5 "http://127.0.0.1:${PORT}/life" 2>/dev/null | grep -q '"chainValid": *true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

report_life() {
  curl -fsS -m 10 "http://127.0.0.1:${PORT}/life" 2>/dev/null | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print('blocks:',d['blocks'],'| tip:',str(d['tipHash'])[:16],'| age:',d['tipAgeSec'],'| fresh:',d['fresh'],'| valid:',d['chainValid'])"
}

if [ "${ROLLBACK:-0}" = "1" ]; then
  echo "[rollback] поиск свежего бэкапа node.mjs.bak-*"
  # shellcheck disable=SC2012
  BAK="$(ls -t "${SRC}"/node.mjs.bak-* 2>/dev/null | head -1)" || true
  [ -n "${BAK:-}" ] || die "бэкапов node.mjs.bak-* нет — откат невозможен"
  echo "[rollback] возвращаю ${BAK}"
  cp "$BAK" "${SRC}/node.mjs"
  NODE_BIN="$(pick_node)" || die "node runtime не найден"
  "$NODE_BIN" --check "${SRC}/node.mjs" || die "node --check после отката провален"
  systemctl restart "$UNIT"
  wait_alive || die "нода не ожила за 90с после отката — journalctl -u ${UNIT} -f"
  report_life
  echo "ОТКАТ ГОТОВ"
  exit 0
fi

NEW_FILE="${1:-}"; BASE_MD5="${2:-}"
[ -n "$NEW_FILE" ] && [ -f "$NEW_FILE" ] || die "usage: bash $0 /root/node.mjs.new <md5-текущего-node.mjs>  (или ROLLBACK=1 $0)"
[ -n "$BASE_MD5" ] || die "нужен md5 текущего node.mjs — защита от наката не на ту базу"

echo "[1/5] база"
report_life
CUR_MD5="$(md5sum "${SRC}/node.mjs" | cut -d' ' -f1)"
echo "  текущий md5: ${CUR_MD5}"
[ "$CUR_MD5" = "$BASE_MD5" ] || die "база на хосте (${CUR_MD5}) != ожидаемой (${BASE_MD5}) — хост менялся, разбирайся руками"

echo "[2/5] бэкап (код + данные)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cp "${SRC}/node.mjs" "${SRC}/node.mjs.bak-${STAMP:0:8}-011"
tar czf "/root/agentcoin-h1-backup-011-data.tgz" -C /opt/agentcoin-node data
chmod 600 /root/agentcoin-h1-backup-011-data.tgz
ls -la "${SRC}/node.mjs.bak-"* /root/agentcoin-h1-backup-011-data.tgz | tail -2

echo "[3/5] установка + node --check (гейт)"
cp "$NEW_FILE" "${SRC}/node.mjs"
NODE_BIN="$(pick_node)" || die "node runtime не найден"
"$NODE_BIN" --check "${SRC}/node.mjs" && echo "  JS_OK"
grep -c treasury_employer_exempt "${SRC}/node.mjs" | sed 's/^/  exempt-маркер: /'

echo "[4/5] рестарт + ожидание живости (до 90с)"
systemctl restart "$UNIT"
wait_alive || die "нода не отвечает 90 секунд — откат: ROLLBACK=1 bash $0; логи: journalctl -u ${UNIT} -f"
systemctl show "$UNIT" -p ExecMainStartTimestamp --value | sed 's/^/  старт: /'

echo "[5/5] сверки"
report_life
echo -n "  PIN-роут loopback /cabinet/pin/status → "
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${PORT}/cabinet/pin/status"
ERRS="$(journalctl -u "$UNIT" --since '10 min ago' --no-pager -p err 2>/dev/null | tail -5)"
if [ -z "$ERRS" ]; then echo "  журнал: ошибок нет"; else echo "$ERRS"; die "есть ошибки в журнале — разбирай"; fi
echo "=== ГОТОВО. Наружная сверка: curl -sk https://agentcoin.work/life и /network/nodes (все behind 0) ==="
