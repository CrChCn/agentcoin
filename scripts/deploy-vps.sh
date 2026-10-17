#!/usr/bin/env bash
# ============================================================
# deploy-vps.sh — поднять ноду AGT на внешнем Linux VPS и подключить её
# к ядру AGIP-24 как первый внешний пир (AGIP-27: https-пир через TLS-фаннел).
# Запуск от root (или sudo) на Ubuntu/Debian/Oracle-Ampere:
#   bash deploy-vps.sh [порт=9335]
# Скрипт НЕ печатает секретов; кошелёк создаётся на СВОЕЙ ноде после старта
# (mnemonic выдаётся один раз) — idempotent: повторный запуск обновляет юнит.
# ============================================================
set -euo pipefail

PORT="${1:-9335}"
REPO_URL="https://github.com/CrChCn/agentcoin"
BOOTSTRAP_PEER="${AGT_BOOTSTRAP_PEER:-https://laptop-ih54qpif.tail8c28c2.ts.net}"
INSTALL_DIR="${AGT_INSTALL_DIR:-/opt/agentcoin}"
SVC_USER="${AGT_SVC_USER:-agt}"

echo "[1/7] Пакеты: curl, git, ca-certificates, jq, ufw"
apt-get update -qq && apt-get install -y -qq curl git ca-certificates jq ufw >/dev/null

echo "[2/7] Node.js ≥ 18 (NodeSource)"
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.version.match(/^v(\d+)/)?.[1]||0)')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

echo "[3/7] Файрвол: ${PORT}/tcp наружу разрешаем (нода — публичный пир)"
ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
echo "  ⚠ если это Oracle Cloud — дополнительно открой ${PORT}/tcp в Security List/NSG в консоли OCI"

echo "[4/7] Репозиторий → ${INSTALL_DIR}"
if [ -d "${INSTALL_DIR}/.git" ]; then
  git -C "${INSTALL_DIR}" pull --ff-only >/dev/null 2>&1 || git -C "${INSTALL_DIR}" pull >/dev/null 2>&1 || true
else
  git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}" >/dev/null
fi
cd "${INSTALL_DIR}"

echo "[5/7] Пользователь сервиса и права"
id -u "${SVC_USER}" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "${SVC_USER}"
mkdir -p "${INSTALL_DIR}/data-vps"
chown -R "${SVC_USER}:${SVC_USER}" "${INSTALL_DIR}"

echo "[6/7] systemd unit agt-node.service (порт ${PORT}, data-dir data-vps)"
UNIT=/etc/systemd/system/agt-node.service
cat > "${UNIT}" <<EOF
[Unit]
Description=AGENTCOIN (AGT) full node — внешняя нода империи
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SVC_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=AGT_DATA_DIR=${INSTALL_DIR}/data-vps
Environment=AGT_BIND=0.0.0.0
ExecStart=/usr/bin/node ${INSTALL_DIR}/node.mjs ${PORT}
Restart=always
RestartSec=15
Nice=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now agt-node.service

sleep 8
echo "[7/7] Проверка живости и соседство с ядром (bootstrap-мердж AGIP-23)"
if curl -fsS -m 15 "http://127.0.0.1:${PORT}/life" | jq -e '.chainValid == true' >/dev/null; then
  echo "  ✓ нода жива, цепь валидна: $(curl -fsS -m 10 http://127.0.0.1:${PORT}/life | jq -r '.blocks')"
else
  echo "  ⚠ нода ещё синхронизируется — смотри: journalctl -u agt-node -f"
fi
# Добавляем https-пир ядра в peers.json ноды (AGIP-27: https-госсип поддержан)
PEERS="${INSTALL_DIR}/data-vps/peers.json"
[ -f "${PEERS}" ] || echo "[]" > "${PEERS}"
if ! grep -q "${BOOTSTRAP_PEER}" "${PEERS}"; then
  jq --arg p "${BOOTSTRAP_PEER}" '. + [$p]' "${PEERS}" > "${PEERS}.tmp" && mv "${PEERS}.tmp" "${PEERS}"
  chown "${SVC_USER}:${SVC_USER}" "${PEERS}"
  systemctl restart agt-node.service
fi

cat <<'NEXT'

=== ГОТОВО ===
  - нода:      systemctl status agt-node
  - логи:      journalctl -u agt-node -f
  - кошелёк:   curl -X POST http://127.0.0.1:PORT2/wallet/create -H 'Content-Type: application/json' -d '{"label":"vps-agent","recover":true}'
               → mnemonic ОДИН раз; ключи остаются в data-vps/wallets.json
  - в сеть:    curl -X POST http://127.0.0.1:9335/community/send -H 'Content-Type: application/json' \
                 -d '{"text":"Внешняя нода поднята 🏰"}'   (адрес подставит нода — AGIP-21)
  - хелсчек:   node health-check.mjs  (проверка балансов из цепи)

NEXT