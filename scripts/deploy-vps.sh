#!/usr/bin/env bash
# deploy-vps.sh — внешняя нода AGT (класс node2/node3) в РЕАЛЬНОЙ раскладке сети.
# Проверено руками 2026-11-25: git на хостах НЕТ (файловая копия!), юнит
# agentcoin-node.service, код /opt/agentcoin-node/src, данные
# /opt/agentcoin-node/data, BIND 127.0.0.1, ADMIN local, снаружи — Caddy-dark
# (403 reserve node: dark; пирам и /ws — прокси). Прямой порт наружу НЕ открывается.
#
# Режимы:
#   bash deploy-vps.sh install <site-hostname> <release-tgz> [peer-ips...]
#     — первичная установка: пакеты, рантайм node, код из релизного тарболла,
#       юнит, Caddy-dark, cron бэкапов. peer-ips: IP пиров для @peer-правила
#       (свой loopback и tailnet подставляются сами).
#   bash deploy-vps.sh update <new-node.mjs> <md5-текущего-node.mjs>
#     — штатная раскатка: база → бэкап → гейт базы → установка → node --check →
#       рестарт → живость → сверки. Единственный путь обновлений (git pull нет).
#   ROLLBACK=1 bash deploy-vps.sh
#     — откат node.mjs на свежий .bak-* + рестарт + проверка.
set -euo pipefail

INSTALL_DIR=/opt/agentcoin-node
SRC=${INSTALL_DIR}/src
DATA_DIR=${INSTALL_DIR}/data
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

do_rollback() {
  echo "[rollback] поиск свежего бэкапа node.mjs.bak-*"
  # shellcheck disable=SC2012
  BAK="$(ls -t "${SRC}"/node.mjs.bak-* 2>/dev/null | head -1)" || true
  [ -n "${BAK:-}" ] || die "бэкапов node.mjs.bak-* нет — откат невозможен"
  cp "$BAK" "${SRC}/node.mjs"
  NODE_BIN="$(pick_node)" || die "node runtime не найден"
  "$NODE_BIN" --check "${SRC}/node.mjs" || die "node --check после отката провален"
  systemctl restart "$UNIT"
  wait_alive || die "нода не ожила за 90с — journalctl -u ${UNIT} -f"
  report_life
  echo "ОТКАТ ГОТОВ"
}

do_update() {
  NEW_FILE="${1:-}"; BASE_MD5="${2:-}"
  [ -n "$NEW_FILE" ] && [ -f "$NEW_FILE" ] || die "usage: bash $0 update <new-node.mjs> <md5-текущего>"
  [ -n "$BASE_MD5" ] || die "нужен md5 текущего node.mjs — защита от наката не на ту базу"
  [ -d "$SRC" ] || die "${SRC} нет — это не нода реальной раскладки, сначала install"

  echo "[1/5] база"
  report_life
  CUR_MD5="$(md5sum "${SRC}/node.mjs" | cut -d' ' -f1)"
  echo "  текущий md5: ${CUR_MD5}"
  [ "$CUR_MD5" = "$BASE_MD5" ] || die "база на хосте != ожидаемой — хост менялся, разбирайся руками"

  echo "[2/5] бэкап (код + данные)"
  STAMP="$(date -u +%Y%m%d)"
  cp "${SRC}/node.mjs" "${SRC}/node.mjs.bak-${STAMP}-011"
  tar czf /root/agentcoin-vps-backup-011-data.tgz -C "$INSTALL_DIR" data
  chmod 600 /root/agentcoin-vps-backup-011-data.tgz

  echo "[3/5] установка + node --check (гейт)"
  cp "$NEW_FILE" "${SRC}/node.mjs"
  NODE_BIN="$(pick_node)" || die "node runtime не найден"
  "$NODE_BIN" --check "${SRC}/node.mjs" && echo "  JS_OK"

  echo "[4/5] рестарт + ожидание живости (до 90с)"
  systemctl restart "$UNIT"
  wait_alive || die "нода не отвечает 90с — откат: ROLLBACK=1 bash $0; логи: journalctl -u ${UNIT} -f"

  echo "[5/5] сверки"
  report_life
  ERRS="$(journalctl -u "$UNIT" --since '10 min ago' --no-pager -p err 2>/dev/null | tail -5)"
  if [ -z "$ERRS" ]; then echo "  журнал: ошибок нет"; else echo "$ERRS"; die "есть ошибки в журнале"; fi
  echo "=== ГОТОВО. Сверь tip с H1 (https://agentcoin.work/life) и /network/nodes (behind 0) ==="
}

do_install() {
  SITE="${1:-}"; TGZ="${2:-}"; shift 2 || true
  PEERS="$*"
  [ -n "$SITE" ] || die "usage: bash $0 install <site-hostname> <release-tgz> [peer-ips...]"
  [ -f "$TGZ" ] || die "релизный тарболл ${TGZ} не найден (dist/node/agentcoin-node-*.tar.gz)"
  [ "$(id -u)" = "0" ] || die "install — только от root"

  echo "[1/6] пакеты: curl, ca-certificates, jq"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates jq

  echo "[2/6] рантайм node (бандл, без системного nodejs — юнит берёт свой)"
  NODE_VER="${AGT_NODE_VER:-24.22.2}"
  mkdir -p "${INSTALL_DIR}/runtime"
  if [ ! -x "${INSTALL_DIR}/runtime/node-v${NODE_VER}-linux-x64/bin/node" ]; then
    curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz" \
      -o /tmp/node-runtime.tar.xz
    tar xJf /tmp/node-runtime.tar.xz -C "${INSTALL_DIR}/runtime"
    rm -f /tmp/node-runtime.tar.xz
  fi
  "${INSTALL_DIR}"/runtime/*/bin/node --version

  echo "[3/6] код из релизного тарболла → ${SRC} (повторный install поверх — только руками)"
  [ -e "$SRC" ] && die "${SRC} уже существует — это update, а не install: bash $0 update ..."
  mkdir -p "$SRC" "$DATA_DIR"
  tar xzf "$TGZ" -C "$SRC"

  echo "[4/6] env + systemd юнит ${UNIT} (loopback; наружу — только Caddy)"
  cat > /etc/agentcoin-node.env <<EOF
AGT_DATA_DIR=${DATA_DIR}
AGT_BIND=127.0.0.1
AGT_ADMIN_MODE=local
AGT_PEER_DISCOVERY=1
AGT_PUBLIC_URL=https://${SITE}
AGT_MONITOR_TARGETS_FILE=${INSTALL_DIR}/monitor-targets.json
EOF
  chmod 600 /etc/agentcoin-node.env
  cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=AGENTCOIN validating pull node
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=${SRC}
EnvironmentFile=/etc/agentcoin-node.env
ExecStart=${INSTALL_DIR}/runtime/node-v${NODE_VER}-linux-x64/bin/node ${SRC}/node.mjs ${PORT}
Restart=always
RestartSec=15
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${UNIT}.service"
  systemctl restart "${UNIT}.service"

  echo "[5/6] Caddy-dark (пример; поправь пиры и перезагрузи caddy)"
  cat <<EOF
${SITE} {
	@ws { path /ws /ws/* }
	handle @ws { reverse_proxy 127.0.0.1:${PORT} }
	@peer { remote_ip 127.0.0.1 ::1 ${PEERS} 100.64.0.0/10 }
	handle @peer { reverse_proxy https://agentcoin.work }
	handle { respond "reserve node: dark (use https://agentcoin.work)" 403 }
}
EOF
  echo "  вставь блок в /etc/caddy/Caddyfile (имена/пиры свои) и: systemctl reload caddy"

  echo "[6/6] cron ежедневных бэкапов данных (03:20, keep 14 дней)"
  (crontab -l 2>/dev/null | grep -v agentcoin-backup; echo "20 3 * * * tar czf ${INSTALL_DIR}/backups/agentcoin-data-\$(date -u +\\%Y\\%m\\%dT\\%H\\%M\\%SZ).tar.gz -C ${DATA_DIR} . && chmod 600 ${INSTALL_DIR}/backups/agentcoin-data-*.tar.gz && find ${INSTALL_DIR}/backups -name 'agentcoin-data-*.tar.gz' -mtime +14 -delete") | crontab -
  mkdir -p "${INSTALL_DIR}/backups"; chmod 700 "${INSTALL_DIR}/backups"

  echo "[7/7] живость (обязательно)"
  wait_alive || die "нода не отвечает 90с — journalctl -u ${UNIT} -f"
  report_life
  echo "=== УСТАНОВЛЕНО. Дальше только update-режим этого же скрипта (git на хосте нет и не нужен) ==="
}

if [ "${ROLLBACK:-0}" = "1" ]; then
  do_rollback
  exit 0
fi
MODE="${1:-update}"; shift || true
case "$MODE" in
  update)   do_update "$@" ;;
  install)  do_install "$@" ;;
  rollback) do_rollback ;;
  *) die "режим: install | update | rollback" ;;
esac
