#!/usr/bin/env bash
# install-node.sh — одна команда, чтобы поднять полную ноду AGT на чистом Ubuntu/Debian VPS
# (хватает 1 vCPU / 1 ГБ RAM). Ставит свои пакеты, свой Node в /opt, юнит systemd,
# сам выставляет AGT_ASSUME_VALID_HEIGHT по высоте публичной ноды (иначе синк с нуля
# падает на легаси-блоке 2: merkle_mismatch), ждёт живость и печатает итог.
#
# Установка (от root, пустая машина):
#   curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/install-node.sh | sudo bash
#   # или локально: sudo bash scripts/install-node.sh
#
# Обновление уже установленной ноды (git-копия в /opt/agentcoin-node/src):
#   sudo bash scripts/install-node.sh --update
#
# Переменные (все необязательные):
#   AGT_REPO=https://github.com/CrChCn/agentcoin.git  AGT_REF=main
#   AGT_PORT=9335              порт на loopback (наружу не открывается)
#   AGT_NODE_VER=22.23.5       версия рантайма из nodejs.org
#   AGT_SEED_NODES=https://agentcoin.work,https://node2.agentcoin.work,https://node3.agentcoin.work
#                              сиды через запятую (по умолчанию все три публичных входа:
#                              если один хост лёг, нода поднимется с других)
#   AGT_PUBLIC_NODE=https://agentcoin.work  откуда брать высоту для assume-valid
#   AGT_ASSUME_VALID_HEIGHT=<N> сам порог доверия (иначе берётся текущая высота сети)
#   AGT_DRY_RUN=1              показать план, ничего не меняя
#
# Секретов не создаёт: админ-доступ в local-режиме только с loopback, наружу порт не открыт.
set -euo pipefail

REPO="${AGT_REPO:-https://github.com/CrChCn/agentcoin.git}"
REF="${AGT_REF:-main}"
INSTALL_DIR="${AGT_INSTALL_DIR:-/opt/agentcoin-node}"
SRC="$INSTALL_DIR/src"
DATA_DIR="$INSTALL_DIR/data"
ENV_FILE=/etc/agentcoin-node.env
PORT="${AGT_PORT:-9335}"
NODE_VER="${AGT_NODE_VER:-22.23.5}"
SEED="${AGT_SEED_NODES:-https://agentcoin.work,https://node2.agentcoin.work,https://node3.agentcoin.work}"
PUBLIC="${AGT_PUBLIC_NODE:-https://agentcoin.work}"
UNIT=agentcoin-node
DRY="${AGT_DRY_RUN:-0}"
MODE="install"
case "${1:-}" in --update|-u) MODE=update ;; --install|'') ;; *) echo "usage: $0 [--update]" >&2; exit 2 ;; esac

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }

# --- 1. окружение -------------------------------------------------------------------
if [ "$DRY" != 1 ]; then
  [ "$(uname -s)" = Linux ] || die "скрипт для Linux (Ubuntu/Debian); на Windows/macOS — только локальная разработка"
  [ "$(id -u)" = 0 ] || die "нужен root: запусти через sudo"
  command -v apt-get >/dev/null 2>&1 || die "нужен apt-get (Ubuntu/Debian)"
else
  log "dry-run: изменения системы не выполняются"
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=linux-x64 ;;
  aarch64|arm64) ARCH=linux-arm64 ;;
  *) die "неподдерживаемая архитектура: $(uname -m)" ;;
esac

log "[1/8] пакеты: curl, ca-certificates, tar, xz-utils, git"
run apt-get update -qq
run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates tar xz-utils git

# --- 2. рантайм Node в /opt (системный nodejs не нужен) ------------------------------
NODE_BIN="$INSTALL_DIR/runtime/node-v${NODE_VER}-${ARCH}/bin/node"
log "[2/8] node v${NODE_VER} (${ARCH})"
if [ -x "$NODE_BIN" ] && [ "$DRY" != 1 ]; then
  log "    уже установлен: $("$NODE_BIN" --version)"
else
  run mkdir -p "$INSTALL_DIR/runtime"
  if [ "$DRY" = 1 ]; then
    printf '    [dry-run] curl node-v%s-%s.tar.xz + sha256sum -c + tar xJf → %s/runtime\n' "$NODE_VER" "$ARCH" "$INSTALL_DIR"
  else
    TMPX=$(mktemp -d)
    trap 'rm -rf "$TMPX"' EXIT
    curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-${ARCH}.tar.xz" -o "$TMPX/node.tar.xz"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/SHASUMS256.txt" -o "$TMPX/SHASUMS256.txt"
    ( cd "$TMPX" && grep " node-v${NODE_VER}-${ARCH}.tar.xz\$" SHASUMS256.txt | sha256sum -c - ) || die "контрольная сумма Node не совпала"
    tar xJf "$TMPX/node.tar.xz" -C "$INSTALL_DIR/runtime"
  fi
fi

# --- 3. код ноды --------------------------------------------------------------------
log "[3/8] код ноды → $SRC"
if [ "$MODE" = update ]; then
  [ "$DRY" = 1 ] || [ -d "$SRC/.git" ] || die "в $SRC нет git-копии — обновление делай scripts/rollout-node-update.sh"
  run git -C "$SRC" fetch --depth 1 origin "$REF"
  run git -C "$SRC" checkout -q FETCH_HEAD
else
  [ "$DRY" = 1 ] || [ ! -e "$SRC" ] || die "$SRC уже существует: для обновления запусти $0 --update"
  run mkdir -p "$INSTALL_DIR"
  if [ "$DRY" = 1 ]; then
    printf '    [dry-run] git clone --depth 1 --branch %s %s %s\n' "$REF" "$REPO" "$SRC"
  else
    git clone --depth 1 --branch "$REF" "$REPO" "$SRC"
  fi
fi
[ "$DRY" = 1 ] || [ -f "$SRC/node.mjs" ] || die "в $SRC нет node.mjs — не тот репозиторий/ветка"

# --- 4. порог assume-valid: высота публичной ноды ------------------------------------
log "[4/8] высота сети для AGT_ASSUME_VALID_HEIGHT"
PUB_HEIGHT="$(curl -fsS -m 15 "$PUBLIC/info" 2>/dev/null | tr -d '\n' | sed -n 's/.*"blocks":[[:space:]]*\([0-9][0-9]*\).*/\1/p' || true)"
if [ -n "${AGT_ASSUME_VALID_HEIGHT:-}" ]; then
  ASSUME="$AGT_ASSUME_VALID_HEIGHT"
  log "    задан вручную: $ASSUME"
elif [ -n "$PUB_HEIGHT" ]; then
  ASSUME="$PUB_HEIGHT"
  log "    публичная нода сообщила $PUB_HEIGHT блоков → порог $ASSUME"
else
  warn "не удалось узнать высоту $PUBLIC — задай AGT_ASSUME_VALID_HEIGHT явно (иначе синк упадёт на merkle_mismatch)"
  ASSUME=""
fi

# --- 5. пользователь, каталоги ------------------------------------------------------
log "[5/8] пользователь agentcoin и каталог данных"
if [ "$DRY" != 1 ] && ! id -u agentcoin >/dev/null 2>&1; then
  run useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin agentcoin
fi
run mkdir -p "$DATA_DIR" "$INSTALL_DIR/backups"
run chown -R agentcoin:agentcoin "$INSTALL_DIR" 2>/dev/null || true

# --- 6. env + systemd ---------------------------------------------------------------
log "[6/8] $ENV_FILE и юнит $UNIT"
if [ "$DRY" = 1 ]; then
  printf '    [dry-run] AGT_DATA_DIR=%s AGT_BIND=127.0.0.1 AGT_PEER_DISCOVERY=1 AGT_SEED_NODES=%s%s\n' \
    "$DATA_DIR" "$SEED" "${ASSUME:+ AGT_ASSUME_VALID_HEIGHT=$ASSUME}"
  printf '    [dry-run] systemd unit %s (ExecStart=%s %s/node.mjs %s)\n' "$UNIT" "$NODE_BIN" "$SRC" "$PORT"
else
  {
    echo "AGT_DATA_DIR=$DATA_DIR"
    echo "AGT_BIND=127.0.0.1"
    echo "AGT_PEER_DISCOVERY=1"
    echo "AGT_SEED_NODES=$SEED"
    [ -n "$ASSUME" ] && echo "AGT_ASSUME_VALID_HEIGHT=$ASSUME"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=AGENTCOIN full node (loopback, pull-sync)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agentcoin
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $SRC/node.mjs $PORT
Restart=always
RestartSec=15
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
fi

# --- 7. запуск ----------------------------------------------------------------------
log "[7/8] systemd: enable + restart"
run systemctl daemon-reload
if [ "$MODE" = update ]; then run systemctl restart "$UNIT"; else run systemctl enable --now "$UNIT"; fi
if [ "$DRY" = 1 ]; then log "dry-run завершён — реальных изменений не было"; exit 0; fi

# --- 8. проверка живости и догона ---------------------------------------------------
log "[8/8] проверка: /life, высота, догон сети (до 150 с)"
ALIVE=0
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/life" 2>/dev/null | grep -q '"chainValid": *true'; then ALIVE=1; break; fi
  sleep 2
done
[ "$ALIVE" = 1 ] || die "нода не ответила за 120 с: journalctl -u $UNIT -n 60 --no-pager"

BLOCKS="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/info" | tr -d '\n' | sed -n 's/.*"blocks":[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
for _ in $(seq 1 30); do
  PUB_HEIGHT="$(curl -fsS -m 10 "$PUBLIC/info" 2>/dev/null | tr -d '\n' | sed -n 's/.*"blocks":[[:space:]]*\([0-9][0-9]*\).*/\1/p' || true)"
  [ -n "$PUB_HEIGHT" ] && [ "$BLOCKS" -ge "$PUB_HEIGHT" ] && break
  sleep 5
  BLOCKS="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/info" | tr -d '\n' | sed -n 's/.*"blocks":[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
done

echo
log "ГОТОВО: нода работает как systemd-сервис ${UNIT}"
printf '    blocks: %s' "$BLOCKS"
[ -n "${PUB_HEIGHT:-}" ] && printf ' (публичная нода: %s)' "$PUB_HEIGHT"
printf '\n    порог доверия: %s\n' "${ASSUME:-не задан}"
echo
cat <<EOF
    Статус:      systemctl status ${UNIT} --no-pager
    Логи:        journalctl -u ${UNIT} -f
    Вручную:     curl -s http://127.0.0.1:${PORT}/info
    Пиры:        curl -s http://127.0.0.1:${PORT}/peers/meta
    Обновление:  sudo bash ${SRC}/scripts/install-node.sh --update
    Данные:      ${DATA_DIR} (бэкап: tar czf ~/agt-backup.tar.gz -C ${DATA_DIR} .)
EOF
