#!/usr/bin/env bash
# Установка always-on сервиса Agentcoin Ops на отдельный хост (или отдельный
# пользователь на H1). Скрипт идемпотентен и по умолчанию НЕ запускает сервис.
#
#   ./service/install.sh --dry-run                 # показать план, ничего не менять
#   sudo ./service/install.sh                      # разложить файлы и юниты
#   sudo ./service/install.sh --enable             # плюс enable+start
#   sudo ./service/install.sh --rollback <dir>     # вернуть предыдущую версию кода
#   sudo ./service/install.sh --uninstall          # снять код и юниты, данные оставить
#
# Гарантии:
#   - manifest установленных файлов с SHA256 (inventory/install-manifest-<ts>.json);
#   - предыдущая версия кода сохраняется целиком перед заменой;
#   - очередь, память и workspace никогда не перезаписываются и не удаляются;
#   - отказ, если OPS_ROOT принадлежит неожиданному владельцу;
#   - отказ, если queue/queue.json указывает на другую инсталляцию.
# Не делает: деплой сайта, изменения ноды, Caddy, DATA_DIR, кошельков, сети.

set -euo pipefail

SERVICE_USER="${SERVICE_USER:-agt-orchestrator}"
DEPLOY_USER="${DEPLOY_USER:-agt-deployer}"
OPS_ROOT="${OPS_ROOT:-/srv/agentcoin-ops}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$SRC_DIR/service/systemd"
UNIT_DST="/etc/systemd/system"
ENV_DIR="/etc/agentcoin"
MODE="install"
DRY=0
ENABLE=0
ROLLBACK_DIR=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --enable) ENABLE=1 ;;
    --uninstall) MODE="uninstall" ;;
    --rollback=*) MODE="rollback"; ROLLBACK_DIR="${arg#*=}" ;;
    --rollback) MODE="rollback" ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

if [[ "$MODE" == "rollback" && -z "$ROLLBACK_DIR" ]]; then
  echo "--rollback needs a backup directory: --rollback=/srv/agentcoin-ops/backups/install-<ts>" >&2
  exit 64
fi

say() { printf '%s\n' "$*"; }
run() {
  if [[ "$DRY" -eq 1 ]]; then say "  [dry-run] $*"; else eval "$@"; fi
}

if [[ "$DRY" -ne 1 && "$(id -u)" -ne 0 ]]; then
  echo "install.sh needs root (sudo) except for --dry-run" >&2
  exit 77
fi
if ! command -v node >/dev/null 2>&1 && [[ "$DRY" -ne 1 ]]; then
  echo "node is required in PATH (Node.js 20+)" >&2
  exit 78
fi

say "== mode: $MODE | root: $OPS_ROOT"

# --- проверки владельца и целостности данных -------------------------------
if [[ -d "$OPS_ROOT" ]]; then
  OWNER="$(stat -c '%U' "$OPS_ROOT")"
  if [[ "$OWNER" != "$SERVICE_USER" && "$OWNER" != "root" ]]; then
    echo "refusing: $OPS_ROOT belongs to '$OWNER', expected '$SERVICE_USER' or root" >&2
    exit 79
  fi
  say "  owner of $OPS_ROOT: $OWNER (accepted)"
fi

QUEUE_FILE="$OPS_ROOT/queue/queue.json"
if [[ -f "$QUEUE_FILE" ]]; then
  say "== existing queue preserved ($(stat -c '%s' "$QUEUE_FILE") bytes)"
fi
QUEUE_SUM_BEFORE=""
if [[ -f "$QUEUE_FILE" && "$DRY" -ne 1 ]]; then
  QUEUE_SUM_BEFORE="$(sha256sum "$QUEUE_FILE" | awk '{print $1}')"
fi

if [[ "$MODE" == "uninstall" ]]; then
  say "== uninstall: units and code only, data stays"
  for unit in agt-orchestrator.service agt-orchestrator-api.service \
              agt-orchestrator-scheduler.service agt-orchestrator-scheduler.timer \
              agt-orchestrator-watchdog.service agt-orchestrator-watchdog.timer \
              agt-deployer.service; do
    run "systemctl disable --now '$unit' >/dev/null 2>&1 || true"
    run "rm -f '$UNIT_DST/$unit'"
  done
  run "systemctl daemon-reload || true"
  run "rm -rf '$OPS_ROOT/orchestrator'"
  say "  data kept: queue/, project-memory/, workspaces/, runs/, artifacts/, logs/, state/"
  say "  to remove everything, delete $OPS_ROOT manually after inspection"
  exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
  if [[ ! -d "$ROLLBACK_DIR/orchestrator" ]]; then
    echo "refusing: $ROLLBACK_DIR/orchestrator not found" >&2
    exit 80
  fi
  say "== rollback code from $ROLLBACK_DIR/orchestrator"
  run "rm -rf '$OPS_ROOT/orchestrator.current'"
  run "mv '$OPS_ROOT/orchestrator' '$OPS_ROOT/orchestrator.current'"
  run "cp -a '$ROLLBACK_DIR/orchestrator' '$OPS_ROOT/orchestrator'"
  run "chown -R '$SERVICE_USER:$SERVICE_USER' '$OPS_ROOT/orchestrator'"
  run "systemctl restart agt-orchestrator.service agt-orchestrator-api.service || true"
  if [[ "$DRY" -eq 1 ]]; then say "  [dry-run] rollback planned; nothing changed";
  else say "  rollback done; previous tree kept at $OPS_ROOT/orchestrator.current"; fi
  exit 0
fi

# --- layout ----------------------------------------------------------------
say "== users"
for user in "$SERVICE_USER" "$DEPLOY_USER"; do
  if id -u "$user" >/dev/null 2>&1; then
    say "  $user exists"
  else
    run "useradd --system --home-dir '$OPS_ROOT' --shell /usr/sbin/nologin '$user'"
    say "  $user will be created (no shell, no sudo)"
  fi
done

say "== layout"
for dir in repository workspaces runs artifacts project-memory queue queue/tasks queue/backlog logs state; do
  run "install -d -o '$SERVICE_USER' -g '$SERVICE_USER' -m 0750 '$OPS_ROOT/$dir'"
done

# --- backup предыдущей версии кода ---------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$OPS_ROOT/backups/install-$TS"
if [[ -d "$OPS_ROOT/orchestrator" ]]; then
  say "== backup previous code -> $BACKUP"
  run "install -d -o root -g root -m 0750 '$BACKUP'"
  run "cp -a '$OPS_ROOT/orchestrator' '$BACKUP/orchestrator'"
fi

# --- copy code -------------------------------------------------------------
say "== code"
if [[ "$DRY" -eq 1 ]]; then
  say "  [dry-run] rsync -a --delete (excluding runs/workspaces/logs/locks) $SRC_DIR/ -> $OPS_ROOT/orchestrator/"
else
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'node_modules' --exclude 'runs/' --exclude 'workspaces/' \
      --exclude 'logs/' --exclude 'locks/' --exclude 'state/*/' \
      "$SRC_DIR/" "$OPS_ROOT/orchestrator/"
  else
    mkdir -p "$OPS_ROOT/orchestrator"
    tar -C "$SRC_DIR" --exclude='node_modules' --exclude='runs' --exclude='workspaces' \
        --exclude='logs' --exclude='locks' -cf - . | tar -C "$OPS_ROOT/orchestrator" -xf -
  fi
  chown -R "$SERVICE_USER:$SERVICE_USER" "$OPS_ROOT/orchestrator"
fi

# --- mission / registry / env --------------------------------------------
say "== mission and registry (existing files are never overwritten)"
if [[ ! -f "$OPS_ROOT/queue/mission.json" ]]; then
  run "install -o '$SERVICE_USER' -g '$SERVICE_USER' -m 0640 '$SRC_DIR/service/mission.json' '$OPS_ROOT/queue/mission.json'"
else
  say "  mission.json kept"
fi
if [[ ! -f "$OPS_ROOT/queue/registry.json" ]]; then
  run "install -o '$SERVICE_USER' -g '$SERVICE_USER' -m 0640 '$SRC_DIR/service/registry.json' '$OPS_ROOT/queue/registry.json'"
  say "  registry.json installed empty: planner stays IDLE until the owner registers a proven gap"
else
  say "  registry.json kept"
fi

run "install -d -m 0755 '$ENV_DIR'"
if [[ ! -f "$ENV_DIR/ops.env" ]]; then
  run "install -o root -g '$SERVICE_USER' -m 0640 '$SRC_DIR/service/ops-env.example' '$ENV_DIR/ops.env'"
else
  say "  $ENV_DIR/ops.env kept"
fi

# --- units -----------------------------------------------------------------
say "== systemd units"
for unit in agt-orchestrator.service agt-orchestrator-api.service \
            agt-orchestrator-scheduler.service agt-orchestrator-scheduler.timer \
            agt-orchestrator-watchdog.service agt-orchestrator-watchdog.timer \
            agt-deployer.service; do
  run "install -o root -g root -m 0644 '$UNIT_SRC/$unit' '$UNIT_DST/$unit'"
  say "  $unit"
done
run "systemctl daemon-reload || true"

if command -v systemd-analyze >/dev/null 2>&1 && [[ "$DRY" -ne 1 ]]; then
  say "== verify units"
  systemd-analyze verify \
    "$UNIT_DST/agt-orchestrator.service" \
    "$UNIT_DST/agt-orchestrator-api.service" \
    "$UNIT_DST/agt-orchestrator-scheduler.service" \
    "$UNIT_DST/agt-orchestrator-watchdog.service" \
    "$UNIT_DST/agt-deployer.service" || say "  verify reported problems (см. вывод выше)"
fi

# --- manifest --------------------------------------------------------------
if [[ "$DRY" -ne 1 ]]; then
  say "== manifest"
  MANIFEST="$OPS_ROOT/inventory/install-manifest-$TS.json"
  install -d -o root -g root -m 0750 "$OPS_ROOT/inventory"
  node -e '
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const [root, units, out, ts] = process.argv.slice(1);
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = dir + "/" + entry.name;
    if (entry.isDirectory()) { if (entry.name !== "runs" && entry.name !== "workspaces") walk(full); continue; }
    const sha = execSync(`sha256sum "${full}"`).toString().split(" ")[0];
    files.push({ path: full.replace(root, "$OPS_ROOT"), sha256: sha, bytes: fs.statSync(full).size });
  }
};
walk(root + "/orchestrator");
for (const unit of units.split(",")) files.push({ path: unit, sha256: execSync(`sha256sum "${unit}"`).toString().split(" ")[0], bytes: fs.statSync(unit).size });
fs.writeFileSync(out, JSON.stringify({ installedAt: ts, opsRoot: root, serviceUser: process.env.SERVICE_USER || "agt-orchestrator", files }, null, 2) + "\n");
console.log(`  ${files.length} files recorded in ${out}`);
' "$OPS_ROOT" "$UNIT_DST/agt-orchestrator.service,$UNIT_DST/agt-orchestrator-api.service,$UNIT_DST/agt-orchestrator-scheduler.service,$UNIT_DST/agt-orchestrator-scheduler.timer,$UNIT_DST/agt-orchestrator-watchdog.service,$UNIT_DST/agt-orchestrator-watchdog.timer,$UNIT_DST/agt-deployer.service" "$MANIFEST" "$TS"
fi

# --- queue untouched -------------------------------------------------------
if [[ -n "$QUEUE_SUM_BEFORE" ]]; then
  QUEUE_SUM_AFTER="$(sha256sum "$QUEUE_FILE" | awk '{print $1}')"
  if [[ "$QUEUE_SUM_BEFORE" != "$QUEUE_SUM_AFTER" ]]; then
    echo "FATAL: queue.json changed during install" >&2
    exit 81
  fi
  say "== queue.json unchanged ($QUEUE_SUM_AFTER)"
fi

if [[ "$ENABLE" -eq 1 && "$DRY" -ne 1 ]]; then
  say "== enable + start"
  systemctl enable --now agt-orchestrator.service agt-orchestrator-api.service
  systemctl enable --now agt-orchestrator-scheduler.timer agt-orchestrator-watchdog.timer
else
  cat <<EOF

Готово ($MODE$( [[ "$DRY" -eq 1 ]] && echo ", dry-run: ничего не изменено" )). Сервисы НЕ запущены. Включение — отдельным решением владельца:

  systemctl enable --now agt-orchestrator.service agt-orchestrator-api.service
  systemctl enable --now agt-orchestrator-scheduler.timer agt-orchestrator-watchdog.timer

Проверка без запуска:
  sudo -u $SERVICE_USER OPS_ROOT=$OPS_ROOT node $OPS_ROOT/orchestrator/service/opsd.mjs status

Откат кода:  sudo $SRC_DIR/service/install.sh --rollback=$BACKUP
Снятие:      sudo $SRC_DIR/service/install.sh --uninstall

Deployer остаётся выключенным: /etc/agentcoin/deploy-enabled не создаётся.
EOF
fi
