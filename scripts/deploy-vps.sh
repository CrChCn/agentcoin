#!/usr/bin/env bash
# deploy-vps.sh — первичная установка внешней ноды AGT (класс node2/node3)
# в РЕАЛЬНОЙ раскладке сети: /opt/agentcoin-node, юнит agentcoin-node.service,
# код /opt/agentcoin-node/src, данные /opt/agentcoin-node/data, BIND 127.0.0.1,
# ADMIN local, снаружи — Caddy-dark. Прямой порт наружу НЕ открывается.
# Проверено руками 2026-11-25.
#
# Использование (только от root, только на пустой машине):
#   bash deploy-vps.sh <site-hostname> <release-tgz> [seed-url...]
#     site-hostname: напр. node4.agentcoin.work
#     release-tgz:   dist/node/agentcoin-node-*.tar.gz (содержит agentcoin-node/src/)
#     seed-url:      пиры для AGT_SEED_NODES (обычно https://node1… и соседи)
#
# Обновления уже установленной ноды — НЕ этим скриптом (git на хосте нет):
#   scripts/rollout-node-update.sh (scp на хост + запуск там).
# Секретов скрипт не создаёт и не печатает: в local-режиме админ — только loopback.
set -euo pipefail

INSTALL_DIR=/opt/agentcoin-node
SRC=${INSTALL_DIR}/src
DATA_DIR=${INSTALL_DIR}/data
UNIT=agentcoin-node
PORT=9335

die() { echo "✗ ОШИБКА: $*" >&2; exit 1; }

SITE="${1:-}"; TGZ="${2:-}"; shift 2 || true
SEEDS="$*"
[ -n "$SITE" ] || die "usage: bash $0 <site-hostname> <release-tgz> [seed-url...]"
[ -f "$TGZ" ] || die "релизный тарболл ${TGZ} не найден"
[ "$(id -u)" = "0" ] || die "install — только от root"
[ -e "$SRC" ] && die "${SRC} уже существует — это не install; обновления: scripts/rollout-node-update.sh"

echo "[1/7] пакеты: curl, ca-certificates, jq"
apt-get update -qq
apt-get install -y -qq curl ca-certificates jq

echo "[2/7] рантайм node (бандл; системный nodejs не ставим — юнит берёт свой)"
NODE_VER="${AGT_NODE_VER:-24.22.2}"
mkdir -p "${INSTALL_DIR}/runtime"
if [ ! -x "${INSTALL_DIR}/runtime/node-v${NODE_VER}-linux-x64/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz" \
    -o /tmp/node-runtime.tar.xz
  tar xJf /tmp/node-runtime.tar.xz -C "${INSTALL_DIR}/runtime"
  rm -f /tmp/node-runtime.tar.xz
fi
"${INSTALL_DIR}"/runtime/*/bin/node --version

echo "[3/7] код из релизного тарболла → ${SRC}"
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
tar xzf "$TGZ" -C "$TMPD"
[ -f "$TMPD/agentcoin-node/src/node.mjs" ] || die "в тарболле нет agentcoin-node/src/node.mjs — не тот архив"
mkdir -p "$SRC" "$DATA_DIR" "${INSTALL_DIR}/backups"
cp -r "$TMPD"/agentcoin-node/src/. "$SRC/"
echo '[]' > "${INSTALL_DIR}/monitor-targets.json"
chmod 700 "${INSTALL_DIR}/backups"

echo "[4/7] env + systemd юнит ${UNIT} (loopback; наружу — только Caddy)"
{
  echo "AGT_DATA_DIR=${DATA_DIR}"
  echo "AGT_BIND=127.0.0.1"
  echo "AGT_ADMIN_MODE=local"
  echo "AGT_PEER_DISCOVERY=1"
  echo "AGT_PUBLIC_URL=https://${SITE}"
  echo "AGT_MONITOR_TARGETS_FILE=${INSTALL_DIR}/monitor-targets.json"
  [ -n "$SEEDS" ] && echo "AGT_SEED_NODES=${SEEDS// /,}"
} > /etc/agentcoin-node.env
chmod 600 /etc/agentcoin-node.env
cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=AGENTCOIN validating pull node
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
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

echo "[5/7] Caddy-dark (вручную: блок ниже в /etc/caddy/Caddyfile, затем systemctl reload caddy)"
cat <<EOF
${SITE} {
	@ws { path /ws /ws/* }
	handle @ws { reverse_proxy 127.0.0.1:${PORT} }
	@peer { remote_ip 127.0.0.1 ::1 100.64.0.0/10 }
	handle @peer { reverse_proxy https://agentcoin.work }
	handle { respond "reserve node: dark (use https://agentcoin.work)" 403 }
}
EOF

echo "[6/7] cron ежедневных бэкапов данных (03:20, keep 14 дней)"
(crontab -l 2>/dev/null | grep -v 'agentcoin-data-' || true; echo "20 3 * * * tar czf ${INSTALL_DIR}/backups/agentcoin-data-\$(date -u +\%Y\%m\%dT\%H\%M\%SZ).tar.gz -C ${DATA_DIR} . && chmod 600 ${INSTALL_DIR}/backups/agentcoin-data-*.tar.gz && find ${INSTALL_DIR}/backups -name 'agentcoin-data-*.tar.gz' -mtime +14 -delete") | crontab -

echo "[7/7] живость (обязательно: без неё install провален)"
for _ in $(seq 1 45); do
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/life" 2>/dev/null | grep -q '"chainValid": *true'; then
    ALIVE=1; break
  fi
  sleep 2
done
[ "${ALIVE:-}" = "1" ] || die "нода не отвечает 90с — journalctl -u ${UNIT} -f"
curl -fsS -m 10 "http://127.0.0.1:${PORT}/life" 2>/dev/null | python3 -c \
  "import json,sys; d=json.load(sys.stdin); print('blocks:',d['blocks'],'| tip:',str(d['tipHash'])[:16],'| fresh:',d['fresh'],'| valid:',d['chainValid'])"
echo "=== УСТАНОВЛЕНО. Проверка снаружи: POST https://${SITE}/tx/sign → 403 dark; дальше — только rollout-node-update.sh ==="
