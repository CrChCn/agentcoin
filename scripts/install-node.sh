#!/usr/bin/env bash
# install-node.sh — одна команда, чтобы поднять полную ноду AGT на чистом Ubuntu/Debian VPS
# (хватает 1 vCPU / 1 ГБ RAM). Ставит свои пакеты, свой Node в /opt, юнит systemd,
# сам выставляет AGT_ASSUME_VALID_HEIGHT по высоте публичной ноды (иначе синк с нуля
# падает на легаси-блоке 2: merkle_mismatch), ждёт живость и печатает итог.
#
# Установка (от root, пустая машина) — leaf-пир (наружу ничего не торчит):
#   curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/install-node.sh | sudo bash
#   # или локально: sudo bash scripts/install-node.sh
#
# Полный пир (нода видна сети по своему домену, нужны A-запись и открытые 80,443):
#   curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/install-node.sh | sudo bash -s -- --domain nodeX.example.com
#
# Обновление уже установленной ноды (git-копия в /opt/agentcoin-node/src):
#   sudo bash scripts/install-node.sh --update
#   # полный пир после обновления остаётся полным (self-URL сохраняются из env)
#   # вернуться в leaf (снять self-URL): --update --leaf
#
# Переменные (все необязательные):
#   AGT_REPO=https://github.com/CrChCn/agentcoin.git  AGT_REF=main
#   AGT_PORT=9335              порт на loopback (наружу не открывается)
#   AGT_DOMAIN=nodeX.example.com  полный пир: Caddy 443 → loopback + self-URL ноды
#                              (то же, что флаг --domain; без него — leaf-пир)
#   AGT_NODE_VER=22.23.5       версия рантайма из nodejs.org
#   AGT_SEED_NODES=https://agentcoin.work,https://node2.agentcoin.work,https://node3.agentcoin.work
#                              сиды через запятую (по умолчанию все три публичных входа:
#                              если один хост лёг, нода поднимется с других)
#   AGT_PUBLIC_NODE=https://agentcoin.work  откуда брать высоту для assume-valid
#   AGT_ASSUME_VALID_HEIGHT=<N> сам порог доверия (иначе берётся текущая высота сети)
#   AGT_DRY_RUN=1              показать план, ничего не меняя
#
# Для полного пира нужны открытые 80/443 не только в ufw на машине, но и в файрволе
# хостера (security group / панель VPS) — иначе Caddy не получит сертификат.
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
DOMAIN="${AGT_DOMAIN:-}"
LEAF=0
log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }
usage() { echo "usage: $0 [--update] [--domain <dns-имя> | --leaf]" >&2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --update|-u) MODE=update ;;
    --install) MODE=install ;;
    --domain) DOMAIN="${2:-}"; [ -n "$DOMAIN" ] || { usage; die "--domain ждёт DNS-имя хоста"; }; shift ;;
    --domain=*) DOMAIN="${1#*=}"; [ -n "$DOMAIN" ] || { usage; die "--domain ждёт DNS-имя хоста"; } ;;
    --leaf) LEAF=1; DOMAIN="" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done
if [ "$LEAF" = 1 ] && [ "$MODE" != update ]; then die "--leaf только вместе с --update (снять self-URL у полного пира)"; fi
# домен проверяем до любых изменений системы: иначе битый --domain всплывёт уже после установки
if [ -n "$DOMAIN" ]; then
  DOMAIN="$(printf %s "$DOMAIN" | tr 'A-Z' 'a-z' | sed 's/\.$//')"
  if ! printf %s "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'; then
    die "--domain: нужно DNS-имя хоста (пример node1.example.com), без схемы, порта и пути"
  fi
fi

# --- 1. окружение -------------------------------------------------------------------
if [ "$DRY" != 1 ]; then
  [ "$(uname -s)" = Linux ] || die "скрипт для Linux (Ubuntu/Debian); на Windows/macOS — только локальная разработка"
  [ "$(id -u)" = 0 ] || die "нужен root: запусти через sudo"
  command -v apt-get >/dev/null 2>&1 || die "нужен apt-get (Ubuntu/Debian)"
else
  log "dry-run: изменения системы не выполняются"
fi

case "$PORT" in
  ''|*[!0-9]*) die "AGT_PORT должен быть числом: $PORT" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=linux-x64 ;;
  aarch64|arm64) ARCH=linux-arm64 ;;
  *) die "неподдерживаемая архитектура: $(uname -m)" ;;
esac

log "[1/9] пакеты: curl, ca-certificates, tar, xz-utils, git"
run apt-get update -qq
run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates tar xz-utils git

# --- 2. рантайм Node в /opt (системный nodejs не нужен) ------------------------------
NODE_BIN="$INSTALL_DIR/runtime/node-v${NODE_VER}-${ARCH}/bin/node"
log "[2/9] node v${NODE_VER} (${ARCH})"
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
log "[3/9] код ноды → $SRC"
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
log "[4/9] высота сети для AGT_ASSUME_VALID_HEIGHT"
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
log "[5/9] пользователь agentcoin и каталог данных"
if [ "$DRY" != 1 ] && ! id -u agentcoin >/dev/null 2>&1; then
  run useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin agentcoin
fi
run mkdir -p "$DATA_DIR" "$INSTALL_DIR/backups"
run chown -R agentcoin:agentcoin "$INSTALL_DIR" 2>/dev/null || true

# --- 6. env + systemd ---------------------------------------------------------------
log "[6/9] $ENV_FILE и юнит $UNIT"
# --update без --domain не должен разжаловать полный пир в leaf: несём self-URL из env
if [ -z "$DOMAIN" ] && [ "$LEAF" != 1 ] && [ -f "$ENV_FILE" ]; then
  KEEP_SELF="$(sed -n 's/^AGT_SELF_URL=//p' "$ENV_FILE" | head -n1)"
  KEEP_PUB="$(sed -n 's/^AGT_PUBLIC_URL=//p' "$ENV_FILE" | head -n1)"
else
  KEEP_SELF=""; KEEP_PUB=""
fi
KEEP_EXTRA=""
if [ "$DRY" != 1 ] && [ -f "$ENV_FILE" ]; then
  KEEP_EXTRA="$(grep -Ev '^(AGT_DATA_DIR|AGT_BIND|AGT_PEER_DISCOVERY|AGT_SEED_NODES|AGT_ASSUME_VALID_HEIGHT|AGT_SELF_URL|AGT_PUBLIC_URL)=' "$ENV_FILE" || true)"
fi
if [ "$DRY" = 1 ]; then
  printf '    [dry-run] AGT_DATA_DIR=%s AGT_BIND=127.0.0.1 AGT_PEER_DISCOVERY=1 AGT_SEED_NODES=%s%s%s\n' \
    "$DATA_DIR" "$SEED" "${ASSUME:+ AGT_ASSUME_VALID_HEIGHT=$ASSUME}" "${DOMAIN:+ AGT_SELF_URL=https://$DOMAIN AGT_PUBLIC_URL=https://$DOMAIN}"
  printf '    [dry-run] systemd unit %s (ExecStart=%s %s/node.mjs %s)\n' "$UNIT" "$NODE_BIN" "$SRC" "$PORT"
else
  {
    echo "AGT_DATA_DIR=$DATA_DIR"
    echo "AGT_BIND=127.0.0.1"
    echo "AGT_PEER_DISCOVERY=1"
    echo "AGT_SEED_NODES=$SEED"
    if [ -n "$ASSUME" ]; then echo "AGT_ASSUME_VALID_HEIGHT=$ASSUME"; fi
    if [ -n "$DOMAIN" ]; then
      echo "AGT_SELF_URL=https://$DOMAIN"
      echo "AGT_PUBLIC_URL=https://$DOMAIN"
    else
      if [ -n "${KEEP_SELF:-}" ]; then echo "AGT_SELF_URL=$KEEP_SELF"; fi
      if [ -n "${KEEP_PUB:-}" ]; then echo "AGT_PUBLIC_URL=$KEEP_PUB"; fi
    fi
    # чужие ключи (AGT_MAX_INBOUND и т.п.), выставленные руками, при обновлении не теряем
    if [ -n "${KEEP_EXTRA:-}" ]; then printf '%s\n' "$KEEP_EXTRA"; fi
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
log "[7/9] systemd: enable + restart"
run systemctl daemon-reload
if [ "$MODE" = update ]; then run systemctl restart "$UNIT"; else run systemctl enable --now "$UNIT"; fi

# --- 8. проверка живости и догона ---------------------------------------------------
log "[8/9] проверка: /life, высота, догон сети (до 150 с)"
if [ "$DRY" = 1 ]; then
  printf '    [dry-run] curl http://127.0.0.1:%s/life → chainValid, сверка высоты с %s\n' "$PORT" "$PUBLIC"
else
ALIVE=0
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "http://127.0.0.1:${PORT}/life" 2>/dev/null | grep -q '"chainValid": *true'; then ALIVE=1; break; fi
  sleep 2
done
[ "$ALIVE" = 1 ] || die "нода не ответила за 120 с: journalctl -u $UNIT -n 60 --no-pager"

BLOCKS="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/info" 2>/dev/null | tr -d '\n' | sed -n 's/.*"blocks":[[:space:]]*\([0-9][0-9]*\).*/\1/p' || true)"
for _ in $(seq 1 30); do
  PUB_HEIGHT="$(curl -fsS -m 10 "$PUBLIC/info" 2>/dev/null | tr -d '\n' | sed -n 's/.*"blocks":[[:space:]]*\([0-9][0-9]*\).*/\1/p' || true)"
  if [ -n "$BLOCKS" ] && [ -n "$PUB_HEIGHT" ] && [ "$BLOCKS" -ge "$PUB_HEIGHT" ]; then break; fi
  sleep 5
  BLOCKS="$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/info" 2>/dev/null | tr -d '\n' | sed -n 's/.*"blocks":[[:space:]]*\([0-9][0-9]*\).*/\1/p' || true)"
done
fi

# --- 9. полный пир (опционально): Caddy 443 → loopback, один хоп --------------------
EFF_DOMAIN=""
if [ -n "$DOMAIN" ]; then
  EFF_DOMAIN="$DOMAIN"
elif [ -n "${KEEP_SELF:-}" ]; then
  # self-URL бывает списком и бывает http://ip:port — берём только https-хост без порта
  EFF_DOMAIN="$(printf %s "$KEEP_SELF" | tr ',' '\n' | sed -n 's#^https://\([^/:]*\)/*$#\1#p' | head -n1)"
fi
if [ -z "${EFF_DOMAIN:-}" ]; then
  if [ "$LEAF" = 1 ]; then
    log "[9/9] self-URL снят (--leaf): нода — leaf-пир; Caddy больше не проксирует её (блок в Caddyfile можно удалить руками)"
  else
    log "[9/9] полный пир пропущен (нет --domain: нода — leaf-пир, наружу ничего не торчит)"
  fi
else
  log "[9/9] полный пир: Caddy для $EFF_DOMAIN → 127.0.0.1:$PORT"
  EFF_DOMAIN="$(printf %s "$EFF_DOMAIN" | tr 'A-Z' 'a-z' | sed 's/\.$//')"
  # требуем FQDN: IP и одиночное имя не годятся — Caddy не выпустит на них сертификат
  printf %s "$EFF_DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$' \
    || die "--domain: нужно DNS-имя хоста (пример node1.example.com), без схемы, порта и пути"
  MYIP="$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || curl -fsS -m 10 https://ifconfig.me 2>/dev/null || true)"
  DIP="$({ getent ahostsv4 "$EFF_DOMAIN" 2>/dev/null || getent hosts "$EFF_DOMAIN" 2>/dev/null; } | awk 'NR==1{print $1}' || true)"
  if [ -z "${DIP:-}" ]; then
    warn "домен $EFF_DOMAIN пока не резолвится — проверь A-запись у регистратора, иначе Caddy не выпустит сертификат"
  elif [ -n "$MYIP" ] && [ "$DIP" != "$MYIP" ]; then
    warn "домен резолвится в $DIP, а внешний IP этой машины $MYIP — A-запись, похоже, не туда"
  fi
  if ! command -v caddy >/dev/null 2>&1; then
    log "    ставлю Caddy из официального репозитория"
    if ! command -v gpg >/dev/null 2>&1; then run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gnupg; fi
    if [ "$DRY" = 1 ]; then
      printf '    [dry-run] gpg.key → keyrings + sources.list.d/caddy-stable.list + apt-get install caddy\n'
    else
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /etc/apt/keyrings/caddy-stable-archive-keyring.gpg \
        || die "не скачался gpg.key Caddy"
      chmod go+r /etc/apt/keyrings/caddy-stable-archive-keyring.gpg
      echo "deb [signed-by=/etc/apt/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
    fi
    run apt-get update -qq
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
  fi
  CF=/etc/caddy/Caddyfile
  ESC_DOMAIN="$(printf %s "$EFF_DOMAIN" | sed 's/\./\\./g')"
  if [ -f "$CF" ] && grep -Eq "(^|[[:space:]])${ESC_DOMAIN}([[:space:]]|\{|$)" "$CF"; then
    log "    блок $EFF_DOMAIN уже есть в Caddyfile — не трогаю"
  else
    BK="$CF.bak-agt-$(date +%Y%m%d-%H%M%S)"
    BLOCK="$(printf '\n# agentcoin-node: полный пир, один хоп (вторую Caddy не ставить — будут дубли заголовков)\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$EFF_DOMAIN" "$PORT")"
    if [ "$DRY" = 1 ]; then
      printf '    [dry-run] backup %s → %s + append блок:%s\n' "$CF" "$BK" "$BLOCK"
    else
      # без "admin off": он выключает admin API, через который работает systemctl reload caddy
      [ -f "$CF" ] || printf '# Caddyfile (создан agentcoin install-node.sh)\n' > "$CF"
      cp -a "$CF" "$BK"
      printf '%s' "$BLOCK" >> "$CF"
      caddy validate --config "$CF" --adapter caddyfile \
        || { cp -a "$BK" "$CF"; systemctl reload caddy 2>/dev/null || true; die "Caddyfile не валиден — откатил к $BK"; }
    fi
  fi
  run systemctl enable --now caddy
  # reload идёт через admin API (127.0.0.1:2019); чужой Caddyfile с "admin off" его ломает → restart
  if [ "$DRY" = 1 ]; then
    printf '    [dry-run] systemctl reload caddy (fallback: restart)\n'
  else
    systemctl reload caddy 2>/dev/null || run systemctl restart caddy
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    run ufw allow 80,443/tcp
  else
    log "    ufw не активен — пропускаю (если есть внешний файрвол, открой 80,443)"
  fi
  run systemctl restart "$UNIT"
  log "    жду публичный https://$EFF_DOMAIN/life (сертификат может выпускаться 1–2 мин)"
  OK=0
  for _ in $(seq 1 36); do
    if [ "$DRY" = 1 ]; then printf '    [dry-run] curl https://%s/life → chainValid\n' "$EFF_DOMAIN"; OK=1; break; fi
    if curl -fsS -m 10 "https://$EFF_DOMAIN/life" 2>/dev/null | grep -q '"chainValid": *true'; then OK=1; break; fi
    sleep 5
  done
  [ "$OK" = 1 ] || die "публичный вход не отвечает: проверь DNS/файрвол (80,443) и journalctl -u caddy"
  log "    полный пир жив: https://$EFF_DOMAIN/life"
fi
if [ "$DRY" = 1 ]; then log "dry-run завершён — реальных изменений не было"; exit 0; fi

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
if [ -n "${EFF_DOMAIN:-}" ]; then
cat <<EOF
    Публично:    https://${EFF_DOMAIN}/life (цепь), https://${EFF_DOMAIN}/ws/status (пиры)
EOF
fi
