#!/usr/bin/env bash
# Установка ноды Agentcoin на отдельный хост.
#
# Раскладка — как у оркестратора: код отделён от данных.
#   /opt/agentcoin-node/releases/<UTC>/node.mjs   root:root 0555, неизменяем
#   /opt/agentcoin-node/current -> releases/<...>  root:root
#   /var/lib/agentcoin-node                        agentcoin-node (AGT_DATA_DIR)
#   /var/log/agentcoin-node                        agentcoin-node
#   /etc/agentcoin/node.env                        root:agentcoin-node 0640
#   /etc/systemd/system/agentcoin-node.service
#
#   ./install.sh --dry-run             # план, ничего не менять
#   ./install.sh                       # код, данные, env, юнит, манифест
#   ./install.sh --enable              # плюс systemctl daemon-reload + enable --now
#   ./install.sh --join                # плюс POST /peer/add и /sync-now по PEER_URL
#   ./install.sh --prefix=/tmp/n1      # репетиция раскладки без root
#   ./install.sh --rollback            # предыдущий release
#   ./install.sh --uninstall           # код и юнит; данные и env остаются
#
# Порт задаётся в юните (ExecStart ... 9335); AGT_BIND и token-режим — в env.
# Публичный бинд без AGT_ADMIN_MODE=token отвергается: открытая админка недопустима.

set -euo pipefail

SERVICE_USER="${SERVICE_USER:-agentcoin-node}"
CODE_BASE="${CODE_ROOT:-/opt/agentcoin-node}"
DATA_BASE="${DATA_ROOT:-/var/lib/agentcoin-node}"
LOG_BASE="${LOG_ROOT:-/var/log/agentcoin-node}"
UNIT_BASE="${UNIT_DST:-/etc/systemd/system}"
ENV_DIR="${ENV_DIR:-/etc/agentcoin}"
PORT="${NODE_PORT:-9335}"
UNIT_NAME="agentcoin-node.service"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${NODE_SRC:-$HERE/src}"
MODE="install"
DRY=0
ENABLE=0
JOIN=0
PREFIX=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --enable) ENABLE=1 ;;
    --join) JOIN=1 ;;
    --uninstall) MODE="uninstall" ;;
    --rollback) MODE="rollback" ;;
    --prefix=*) PREFIX="${arg#*=}" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

if [ -n "$PREFIX" ]; then
  PREFIX="$(mkdir -p "$PREFIX" && cd "$PREFIX" && pwd)"
  CODE_BASE="$PREFIX/opt/agentcoin-node"
  DATA_BASE="$PREFIX/var/lib/agentcoin-node"
  LOG_BASE="$PREFIX/var/log/agentcoin-node"
  UNIT_BASE="$PREFIX/etc/systemd/system"
  ENV_DIR="$PREFIX/etc/agentcoin"
fi

if [ -n "$PREFIX" ] && [ "$ENABLE" -eq 1 ]; then
  echo "--enable runs systemctl on the host; not available with --prefix rehearsal" >&2
  exit 64
fi
if [ "$DRY" -ne 1 ] && [ -z "$PREFIX" ] && [ "$(id -u)" -ne 0 ]; then
  echo "install.sh needs root (or --dry-run/--prefix)" >&2
  exit 77
fi

CURRENT="$CODE_BASE/current"
RELEASES="$CODE_BASE/releases"
ENV_FILE="$ENV_DIR/node.env"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OWNER_OK="$SERVICE_USER"
[ -n "$PREFIX" ] && OWNER_OK="$(id -un)"

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" -eq 1 ]; then say "  [dry-run] $*"; else eval "$@"; fi; }

say "== node package | code: $CODE_BASE | data: $DATA_BASE | port: $PORT${PREFIX:+ | prefix rehearsal}"
[ -f "$SRC/node.mjs" ] || { echo "refusing: $SRC/node.mjs not found (build.sh builds src/ from the import graph)" >&2; exit 66; }
[ -f "$SRC/SHA256SUMS" ] || { echo "refusing: $SRC/SHA256SUMS missing (build.sh writes it)" >&2; exit 66; }

if [ "$MODE" = "uninstall" ]; then
  say "== uninstall: unit and code only, data and env stay"
  run "systemctl disable --now '$UNIT_NAME' >/dev/null 2>&1 || true"
  run "rm -f '$UNIT_BASE/$UNIT_NAME'"
  run "systemctl daemon-reload >/dev/null 2>&1 || true"
  # Код — весь $CODE_BASE (releases, current, vendor); данные и env не трогаем.
  run "chmod -R u+w '$CODE_BASE' 2>/dev/null || true"
  run "rm -rf '$CODE_BASE'"
  say "  kept: $DATA_BASE, $ENV_FILE"
  exit 0
fi

if [ "$MODE" = "rollback" ]; then
  TARGET="$(ls -1d "$RELEASES"/*/ 2>/dev/null | sed 's#/$##' | sort | head -1)"
  CUR="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  for dir in $(ls -1d "$RELEASES"/*/ 2>/dev/null | sed 's#/$##' | sort); do
    if [ "$dir" != "$CUR" ]; then TARGET="$dir"; fi
  done
  [ -n "$TARGET" ] && [ -f "$TARGET/node.mjs" ] || { echo "refusing: no previous release under $RELEASES" >&2; exit 80; }
  say "== rollback to $TARGET"
  run "ln -sfn '$TARGET' '$CURRENT.new' && mv -Tf '$CURRENT.new' '$CURRENT'"
  run "systemctl restart '$UNIT_NAME' >/dev/null 2>&1 || true"
  exit 0
fi

# --- пользователь и раскладка ---------------------------------------------
if [ -z "$PREFIX" ]; then
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    run "useradd --system --home-dir '$DATA_BASE' --shell /usr/sbin/nologin '$SERVICE_USER'"
    say "  user $SERVICE_USER created (no shell, no sudo)"
  else
    say "  user $SERVICE_USER exists"
  fi
fi
run "install -d -m 0755 '$CODE_BASE' '$RELEASES' '$CODE_BASE/vendor'"
say "  vendor: $CODE_BASE/vendor (опционально snarkjs для PoUW ZK; без него 503 zk_unavailable)"
run "install -d -m 0750 '$DATA_BASE' '$LOG_BASE'"
if [ -n "$PREFIX" ]; then
  say "  [rehearsal] ownership stays with $(id -un)"
else
  run "chown -R '$SERVICE_USER:$SERVICE_USER' '$DATA_BASE' '$LOG_BASE'"
fi

# --- код: неизменяемый release --------------------------------------------
RELEASE="$RELEASES/$TS"
if [ "$DRY" -eq 1 ]; then
  say "  [dry-run] install $(( $(grep -c . "$SRC/SHA256SUMS") + 1 )) files -> $RELEASE; chown root:root; chmod a-w"
  say "  [dry-run] current -> $RELEASE"
else
  install -d -m 0755 "$RELEASE"
  # Нода — не один файл: ставится весь граф (node.mjs + core/ws/sync/bip39-lite/...).
  cp -a "$SRC/." "$RELEASE/"
  chmod -R a-w "$RELEASE"
  chmod 0555 "$RELEASE"/*.mjs 2>/dev/null || true
  if [ -z "$PREFIX" ]; then chown -R root:root "$RELEASE"; fi
  ( cd "$RELEASE" && sha256sum -c --quiet SHA256SUMS ) || { echo "FATAL: SHA256SUMS mismatch in $RELEASE" >&2; exit 83; }
  PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  ln -sfn "$RELEASE" "$CURRENT.new" && mv -Tf "$CURRENT.new" "$CURRENT"
  say "  release: $RELEASE"
  [ -n "$PREVIOUS" ] && say "  previous: $PREVIOUS (kept for --rollback)"
fi

# --- env-конфиг ------------------------------------------------------------
install -d -m 0755 "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  run "install -m 0640 '$HERE/node-env.example' '$ENV_FILE'"
  if [ "$DRY" -ne 1 ] && [ -z "$PREFIX" ]; then
    chown "root:$SERVICE_USER" "$ENV_FILE"
    TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
    sed -i "s#^AGT_ADMIN_TOKEN=.*#AGT_ADMIN_TOKEN=$TOKEN#" "$ENV_FILE"
    say "  env created with generated AGT_ADMIN_TOKEN (0640 root:$SERVICE_USER)"
  else
    say "  env template would be created"
  fi
else
  say "  env kept: $ENV_FILE"
fi

env_value() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }
BIND="$(env_value AGT_BIND)"
ADMIN_MODE="$(env_value AGT_ADMIN_MODE)"
if [ -n "$BIND" ] && [ "$BIND" != "127.0.0.1" ] && [ "$BIND" != "localhost" ] && [ "$ADMIN_MODE" != "token" ]; then
  echo "refusing: AGT_BIND=$BIND with AGT_ADMIN_MODE='$ADMIN_MODE' — public bind needs token mode (open admin is not allowed)" >&2
  exit 84
fi
[ -n "$BIND" ] && say "  bind: $BIND (admin-mode: ${ADMIN_MODE:-local})"

# --- юнит ------------------------------------------------------------------
if [ "$DRY" -eq 1 ]; then
  say "  [dry-run] render $UNIT_NAME -> $UNIT_BASE/$UNIT_NAME"
else
  install -d -m 0755 "$UNIT_BASE"
  sed -e "s#^User=.*#User=${SERVICE_USER}#" \
      -e "s#^Group=.*#Group=${SERVICE_USER}#" \
      -e "s#/opt/agentcoin-node#${CODE_BASE}#g" \
      -e "s#/var/lib/agentcoin-node#${DATA_BASE}#g" \
      -e "s#/var/log/agentcoin-node#${LOG_BASE}#g" \
      -e "s#/etc/agentcoin/node.env#${ENV_FILE}#g" \
      -e "s#current/node.mjs 9335#current/node.mjs ${PORT}#" \
      "$HERE/systemd/$UNIT_NAME" > "$UNIT_BASE/$UNIT_NAME"
  chmod 0644 "$UNIT_BASE/$UNIT_NAME"
  say "  unit: $UNIT_BASE/$UNIT_NAME"
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
  fi
fi

# --- манифест --------------------------------------------------------------
if [ "$DRY" -ne 1 ]; then
  install -d -m 0750 "$DATA_BASE/inventory"
  MANIFEST="$DATA_BASE/inventory/install-manifest-$TS.json"
  if [ -n "$PREFIX" ]; then INSTALL_KIND="rehearsal"; else INSTALL_KIND="host"; fi
  cat > "$MANIFEST" <<JSON
{
  "installedAt": "$TS",
  "mode": "$INSTALL_KIND",
  "release": "$RELEASE",
  "dataRoot": "$DATA_BASE",
  "logRoot": "$LOG_BASE",
  "serviceUser": "$SERVICE_USER",
  "port": $PORT,
  "bind": "$BIND",
  "adminMode": "$ADMIN_MODE",
  "nodeSha256": "$(sha256sum "$SRC/node.mjs" | awk '{print $1}')",
  "nodeBytes": $(stat -c '%s' "$SRC/node.mjs"),
  "codeFiles": $(grep -c . "$SRC/SHA256SUMS"),
  "unit": "$UNIT_BASE/$UNIT_NAME"
}
JSON
  say "  manifest: $MANIFEST"
fi

# --- enable ----------------------------------------------------------------
if [ "$ENABLE" -eq 1 ] && [ "$DRY" -ne 1 ]; then
  systemctl enable --now "$UNIT_NAME"
  say "  systemctl: $(systemctl is-active "$UNIT_NAME")"
else
  say "  services NOT started. Run: systemctl enable --now $UNIT_NAME"
fi

# --- join ------------------------------------------------------------------
if [ "$JOIN" -eq 1 ] && [ "$DRY" -ne 1 ]; then
  PEER="$(env_value PEER_URL)"
  if [ -z "$PEER" ]; then
    say "  --join skipped: PEER_URL is empty in $ENV_FILE"
  else
    say "== join peer $PEER"
    node - "$PEER" "$(env_value AGT_ADMIN_TOKEN)" "$PORT" <<'NODE'
const [peer, token, port] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const headers = { 'content-type': 'application/json', 'x-admin-token': token || '' };
(async () => {
  const add = await fetch(`${base}/peer/add`, { method: 'POST', headers, body: JSON.stringify({ peer }) });
  console.log(`  peer/add  -> ${add.status} ${(await add.text()).slice(0, 200)}`);
  const sync = await fetch(`${base}/sync-now`, { method: 'POST', headers });
  console.log(`  sync-now  -> ${sync.status} ${(await sync.text()).slice(0, 200)}`);
})().catch((err) => { console.error(`  join failed: ${err.message}`); process.exitCode = 1; });
NODE
  fi
fi

say ""
say "Проверка:  curl -fsS http://127.0.0.1:$PORT/health && curl -fsS http://127.0.0.1:$PORT/life"
say "Откат:     $HERE/install.sh --rollback"
say "Снятие:    $HERE/install.sh --uninstall   (данные и env остаются)"
