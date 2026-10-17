#!/usr/bin/env bash
# ============================================================
# deploy-vps.sh — поднять ноду AGT на внешнем Linux VPS и подключить её
# к ядру AGIP-24 как первый внешний пир (AGIP-27: https-пир через TLS-фаннел).
# Запуск от root (или sudo) на Ubuntu/Debian/Oracle-Ampere:
#   bash deploy-vps.sh [порт=9335]
# Безопасность (аудит-ревью 2026-10-17, AGIP-37.LOCAL):
#   - админ/кошелёк/майнинг-маршруты ноды отвечают НЕ с loopback отказом 403
#     (барьер в самой ноде) → наружу светится только публичный read-only + POST /tx;
#   - правила UFW заносятся ДО enable, SSH-порт определяется из sshd (не 22 «наугад»);
#   - все шаги fail-fast: установка либо прошла с проверкой живости, либо не «ГОТОВО»;
#   - повторный запуск = надёжный апдейт (fetch/reset, systemd restart всегда).
# Скрипт НЕ печатает секретов: токен админа генерируется в data-agtx/admin-token.txt
# (мнемоника кошелька выдаётся на СВОЕЙ ноде после старта — один раз).
# ============================================================
set -euo pipefail

PORT="${1:-9335}"
REPO_URL="https://github.com/CrChCn/agentcoin"
BOOTSTRAP_PEER="${AGT_BOOTSTRAP_PEER:-https://laptop-ih54qpif.tail8c28c2.ts.net}"
INSTALL_DIR="${AGT_INSTALL_DIR:-/opt/agentcoin}"
SVC_USER="${AGT_SVC_USER:-agt}"
UNIT=/etc/systemd/system/agt-node.service
PEERS_FILE="${INSTALL_DIR}/data-vps/peers.json"

die() { echo "✗ ОШИБКА: $*" >&2; exit 1; }

echo "[1/7] Пакеты: curl, git, ca-certificates, jq, ufw"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates jq ufw

echo "[2/7] Node.js ≥ 24 LTS (NodeSource; ветки 18/20 — EOL и не ставим)"
NODE_MAJOR="$(node -e 'console.log(process.version.match(/^v(\d+)/)?.[1]||0)' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -qq nodejs
fi
command -v node >/dev/null || die "Node.js не установился"
echo "  node $(node --version)"

echo "[3/7] Файрвол: SSH не теряем, потом порт ноды, потом enable"
# Ревью п.5: sshd -T может падать (нет sshd_i, права) — fallback 22 должен ВСЁ
# РАВНО выполняться, а не убить скрипт через set -euo pipefail (ssh -T|awk
# с pipefail возвращает ненулевой код при падении sshd).
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')" || true
[ -n "${SSH_PORT:-}" ] || SSH_PORT=22
ufw allow "${SSH_PORT}/tcp" comment 'ssh-admin' >/dev/null
ufw allow "${PORT}/tcp" comment 'agt-node (публичный пир; админ-маршруты закрыты на уровне ноды)' >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/  /'
echo "  ⚠ если это Oracle Cloud — дополнительно открой ${PORT}/tcp в Security List/NSG в консоли OCI"

echo "[4/7] Репозиторий → ${INSTALL_DIR} (повторный запуск = жёсткий апдейт до origin/main)"
if [ -d "${INSTALL_DIR}/.git" ]; then
  # Ревью п.6 (C-2 ревизия): проверять нужно ВСЕ отслеживаемые файлы; прежний
  # pathspec «{...}» — буквальный — ничего не матчил, и грязное дерево проходило.
  # Ошибка git-замера = не верить: стоп, а не обновляться вслепую.
  if ! GIT_DIRTY="$(git -C "${INSTALL_DIR}" status --porcelain --untracked-files=no 2>&1)"; then
    die "git status не удался ($(echo "${GIT_DIRTY}" | head -1)) — обновление прервано без reset"
  fi
  if [ -n "${GIT_DIRTY}" ]; then
    echo "${GIT_DIRTY}" | head -10 >&2
    die "в ${INSTALL_DIR} есть незакоммиченные правки — reset --hard их затрёт. Закоммить/сохранить и повтори"
  fi
  # safe.directory: после chown agt:agt запуск git от root больше не валится
  # с «dubious ownership» (и мы НЕ прячем его ошибку).
  git config --system --add safe.directory "${INSTALL_DIR}"
  git -C "${INSTALL_DIR}" fetch origin --prune
  git -C "${INSTALL_DIR}" reset --hard origin/HEAD
else
  git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
  git config --system --add safe.directory "${INSTALL_DIR}"
fi
cd "${INSTALL_DIR}"

echo "[5/7] Пользователь сервиса и права"
id -u "${SVC_USER}" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "${SVC_USER}"
mkdir -p "${INSTALL_DIR}/data-vps"
# токен админа: с ним деструктивные POST требуют x-admin-token ДАЖЕ с loopback
if [ ! -s "${INSTALL_DIR}/data-agtx/admin-token.txt" ]; then
  mkdir -p "${INSTALL_DIR}/data-agtx"
  (umask 077 && head -c 32 /dev/urandom | sha256sum | cut -c1-64 > "${INSTALL_DIR}/data-agtx/admin-token.txt")
fi
chown -R "${SVC_USER}:${SVC_USER}" "${INSTALL_DIR}"
chmod 700 "${INSTALL_DIR}/data-agtx"
chmod 600 "${INSTALL_DIR}/data-agtx/admin-token.txt"

echo "[6/7] systemd unit agt-node.service (порт ${PORT}, data-dir data-vps)"
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
Environment=AGT_ADMIN_MODE=token
ExecStart=/usr/bin/node ${INSTALL_DIR}/node.mjs ${PORT}
Restart=always
RestartSec=15
Nice=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable agt-node.service
# ⚠ enable --now НЕ перезапускает уже работающую службу — restart всегда:
systemctl restart agt-node.service

# bootstrap-пир ядра в peers.json (без чужого рестарта: unit уже перезапущен,
# нода мержит bootstrap.json сама и пересчитывает пиры посменно офлайн-конфига)
install -d -o "${SVC_USER}" -g "${SVC_USER}" "$(dirname "${PEERS_FILE}")"
[ -s "${PEERS_FILE}" ] || (echo '[]' | install -o "${SVC_USER}" -g "${SVC_USER}" /dev/stdin "${PEERS_FILE}")
if ! grep -qF "${BOOTSTRAP_PEER}" "${PEERS_FILE}"; then
  jq --arg p "${BOOTSTRAP_PEER}" '. + [$p]' "${PEERS_FILE}" > "${PEERS_FILE}.tmp"
  install -o "${SVC_USER}" -g "${SVC_USER}" "${PEERS_FILE}.tmp" "${PEERS_FILE}"
  rm -f "${PEERS_FILE}.tmp"
  systemctl restart agt-node.service
fi

echo "[7/7] Проверка живости (ОБЯЗАТЕЛЬНАЯ: без неё скрипт падает, а не рапортует «ГОТОВО»)"
ALIVE=""
for i in $(seq 1 45); do
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/life" 2>/dev/null | jq -e '.chainValid == true' >/dev/null; then
    ALIVE=1; break
  fi
  sleep 2
done
if [ -z "${ALIVE}" ]; then
  journalctl -u agt-node -n 30 --no-pager | tail -n 15 >&2 || true
  die "нода не отвечает 90 секунд — смотри journalctl -u agt-node -f (скрипт НЕ завершён УСПЕХом)"
fi
BLOCKS="$(curl -fsS -m 10 "http://127.0.0.1:${PORT}/life" | jq -r '.blocks')"
echo "  ✓ нода жива, цепь валидна: blocks=${BLOCKS}"
# «чтобы нода не отставала от ядра»: сверяем высоту с bootstrap-пиром
PEER_H="$(curl -fsS -m 12 "${BOOTSTRAP_PEER%/}/life" 2>/dev/null | jq -r '.blocks' || true)"
if [ -n "${PEER_H:-}" ] && [ "${PEER_H}" != "null" ]; then
  DELTA=$(( ${PEER_H} >= ${BLOCKS} ? PEER_H - BLOCKS : BLOCKS - PEER_H ))
  echo "  высота нода/ядро: ${BLOCKS}/${PEER_H} (отставание ${DELTA})"
  if [ "${DELTA}" -gt 25 ]; then
    echo "  ⚠ нода отстаёт от ядра более чем на 25 блоков — догоняет headers-first синком." >&2
    echo "    Дальше: journalctl -u agt-node -f | grep sync; на сервере: curl http://127.0.0.1:${PORT}/sync-now" >&2
  fi
else
  echo "  ⚠ высота ядра недоступна (${BOOTSTRAP_PEER}) — сверку отставания не делал; вызови /life ядра сам"
fi

# публичный барьер — самопроверка с фактического публичного адреса.
# Ревью п.3: «curl -f» успешно скрывает 404/таймаут и «барьер активен» печатался
# даже при полном отказе сети. Проверяем ДОСЛОВНО: HTTP 403 и тело admin_loopback_only.
# Сетевая ошибка (000/refused/timeout) = НЕ ПРОВЕРЕНО — так и печатаем, успеха не заявляем.
PUB_IP="$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || true)"
BARRIER_VERIFIED=0
if [ -n "${PUB_IP}" ]; then
  BODY_FILE=$(mktemp)
  # при refused/timeout curl сам пишет 000 в -w и выходит с ошибкой — перезатираем
  # ОДНИМ 000 (без доклейки: двойной «000000» ломал ветку «не проверено»)
  HTTP_CODE=$(curl -sS -m 10 -o "${BODY_FILE}" -w '%{http_code}' -X POST "http://${PUB_IP}:${PORT}/tx/sign" -H 'Content-Type: application/json' -d '{}') || HTTP_CODE=000
  BODY_GOT=$(head -c 200 "${BODY_FILE}"; rm -f "${BODY_FILE}")
  # C-3: гонки веток честные: PASS = 403+тело; НЕ ПРОВЕРЕНО = только «сеть не
  # дала ответ» (000); ВСЁ ОСТАЛЬНОЕ (2xx/3xx/любой другой 4xx/5xx/странный
  # 403 без нашего тела) — защита сломана → hard fail.
  if [ "${HTTP_CODE}" = "403" ] && grep -q 'admin_loopback_only' <<<"${BODY_GOT}"; then
    BARRIER_VERIFIED=1
    echo "  ✓ публичный барьер подтверждён: POST /tx/sign с ${PUB_IP} → 403 admin_loopback_only"
  elif [ "${HTTP_CODE}" = "000" ]; then
    echo "  ⚠ барьер НЕ ПРОВЕРЕН: публичный ${PUB_IP}:${PORT} не отвечает изнутри (NAT/провайдер firewall?) — проверь снаружи сам:  curl -i http://${PUB_IP}:${PORT}/tx/sign -X POST -d '{}'" >&2
  else
    echo "  ✗ админ-маршрут ответил извне: HTTP ${HTTP_CODE} ($(echo "${BODY_GOT}" | head -1)) — старая версия кода? git -C ${INSTALL_DIR} pull && systemctl restart agt-node" >&2
    exit 1
  fi
fi

# C-1 (Codex): делимитер в КАВЫЧКАХ — текст ниже — чистые инструкции для ЧЕЛОВЕКА:
# $T и $(sudo ...) исполняются только в его SSH-сессии, а никогда — в деплое
# (раскрытие здесь печатало бы админ-токен в stdout и падало с unbound T).
# Плейсхолдеры __PORT__/__CONF__ подставляет sed (PORT/INSTALL_DIR — механически).
cat <<'NEXT' | sed "s|__PORT__|${PORT}|g; s|__CONF__|${INSTALL_DIR}|g"

=== ГОТОВО ===
  - нода:      systemctl status agt-node
  - логи:      journalctl -u agt-node -f
  - админ-токен (для деструктивных POST и кошельковых операций):
               sudo cat __CONF__/data-agtx/admin-token.txt

КОШЕЛЁК И АДМИН — ТОЛЬКО ЧЕРЕЗ SSH (AGIP-37.LOCAL, режим admin_mode=token):
  с твоей машины:
    ssh ubuntu@<vps-ip>
  на сервере (loopback + админ-токен — нода развернута в token-режиме: туннель
  никогда не считается админом, авторизация — единственный путь):
    T=$(sudo cat __CONF__/data-agtx/admin-token.txt)
    curl -X POST http://127.0.0.1:__PORT__/wallet/create \\
      -H 'Content-Type: application/json' -H "x-admin-token: $T" \\
      -d '{"label":"vps-agent","recover":true}'
      → mnemonic ОДИН раз; ключи остаются в data-vps/wallets.json
  АНОНС В ЧАТ (на сервере, порт подставлен честно):
    curl -X POST http://127.0.0.1:__PORT__/community/send -H 'Content-Type: application/json' \\
      -H "x-admin-token: $T" -d '{"text":"Внешняя нода поднята 🏰"}'
    (адрес подставит нода — AGIP-21)

ПРОВЕРКА БАЛАНСОВ ИЗ ЦЕПИ (на сервере; health-check сам подхватит токен из
__CONF__/data-agtx/admin-token.txt или из env AGT_ADMIN_TOKEN):
    node health-check.mjs __PORT__

NEXT
