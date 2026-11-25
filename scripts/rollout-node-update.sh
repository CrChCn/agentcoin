#!/usr/bin/env bash
# rollout-node-update.sh — штатная раскатка обновления ноды (H1, node2, node3).
# Реальная раскладка (проверено руками 2026-11-25): git на хостах НЕТ, код —
# файловая копия /opt/agentcoin-node/src, юнит agentcoin-node.service, данные
# /opt/agentcoin-node/data, BIND 127.0.0.1, ADMIN local, снаружи Caddy-dark.
#
# Использование (выполнять НА хосте):
#   1. локально: подготовить новый node.mjs (контекст сверен, node --check чист)
#   2. scp new-node.mjs root@<host>:/root/node.mjs.new
#      scp scripts/rollout-node-update.sh root@<host>:/root/
#   3. на хосте:  bash /root/rollout-node-update.sh /root/node.mjs.new <md5-текущего-node.mjs>
# Откат: ROLLBACK=1 bash /root/rollout-node-update.sh
#
# Скрипт ничего не скачивает и не меняет кроме node.mjs. Секретов не печатает.
set -euo pipefail

SRC=/opt/agentcoin-node/src
INSTALL_DIR=/opt/agentcoin-node
UNIT=agentcoin-node
PORT=9335

die() { echo "✗ ОШИБКА: $*" >&2; exit 1; }

pick_node() {
  for c in "${INSTALL_DIR}"/runtime/*/bin/node /opt/agentcoin-staging/runtime/*/bin/node /usr/bin/node /usr/local/bin/node; do
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
  report_life || die "нода не отвечает на /life после отката"
  echo "ОТКАТ ГОТОВ"
  exit 0
fi

NEW_FILE="${1:-}"; BASE_MD5="${2:-}"
[ -n "$NEW_FILE" ] && [ -f "$NEW_FILE" ] || die "usage: bash $0 /root/node.mjs.new <md5-текущего-node.mjs>  (или ROLLBACK=1 $0)"
[ -n "$BASE_MD5" ] || die "нужен md5 текущего node.mjs — защита от наката не на ту базу"
grep -q "escrow/payout" "$NEW_FILE" || die "файл не похож на node.mjs (нет escrow/payout) — не тот файл подсунут"

echo "[1/5] база"
report_life || die "нода не отвечает на /life — катить на мёртвую ноду запрещено, сначала разберись"
CUR_MD5="$(md5sum "${SRC}/node.mjs" | cut -d' ' -f1)"
echo "  текущий md5: ${CUR_MD5}"
if [ "$CUR_MD5" = "$(md5sum "$NEW_FILE" | cut -d' ' -f1)" ]; then
  echo "  файл уже стоит — делать нечего, выхожу без рестарта"
  exit 0
fi
[ "$CUR_MD5" = "$BASE_MD5" ] || die "база на хосте (${CUR_MD5}) != ожидаемой (${BASE_MD5}) — хост менялся, разбирайся руками"

echo "[2/5] бэкап (код + данные; tar rc=1 допустим — цепь живая, файлы меняются)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cp "${SRC}/node.mjs" "${SRC}/node.mjs.bak-${STAMP}"
tar czf "/root/agentcoin-update-data-${STAMP}.tgz" -C "$INSTALL_DIR" data || [ $? -eq 1 ]
chmod 600 "/root/agentcoin-update-data-${STAMP}.tgz"

echo "[3/5] установка + node --check (гейт)"
cp "$NEW_FILE" "${SRC}/node.mjs"
NODE_BIN="$(pick_node)" || die "node runtime не найден"
"$NODE_BIN" --check "${SRC}/node.mjs" && echo "  JS_OK"

echo "[4/5] рестарт + ожидание живости (до 90с)"
systemctl restart "$UNIT"
wait_alive || die "нода не отвечает 90с — откат: ROLLBACK=1 bash $0; логи: journalctl -u ${UNIT} -f"

echo "[5/5] сверки"
report_life || die "нода не отвечает на /life после рестарта"
ERRS="$(journalctl -u "$UNIT" --since '10 min ago' --no-pager -p err 2>/dev/null | grep -v -- '-- No entries --' | tail -5 || true)"
if [ -z "$ERRS" ]; then echo "  журнал: ошибок нет"; else echo "$ERRS"; die "есть ошибки в журнале — разбирай"; fi
echo "=== ГОТОВО. Tip сверь с H1 (https://agentcoin.work/life): лаг в 1-2 блока — норма gossip-синхронизации ==="
