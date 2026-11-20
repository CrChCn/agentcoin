#!/usr/bin/env bash
# Установка always-on сервиса Agentcoin Ops на отдельный ops-host.
#
# Раскладка C2 — код отделён от данных:
#   /opt/agentcoin-orchestrator/current   root:root, read-only (симлинк на release)
#   /opt/agentcoin-orchestrator/releases  неизменяемые версии кода
#   /var/lib/agentcoin-orchestrator       данные сервиса (agt-orchestrator)
#   /var/log/agentcoin-orchestrator       журналы
#   /var/lib/agentcoin-orchestrator/control  STOP, root:root 0755 (сервис не пишет)
#
#   ./service/install.sh --dry-run                  # план, ничего не менять
#   sudo ./service/install.sh                       # код, данные, юниты, manifest
#   sudo ./service/install.sh --enable              # плюс enable+start
#   sudo ./service/install.sh --rollback            # вернуть предыдущий release
#   sudo ./service/install.sh --uninstall           # снять код и юниты, данные оставить
#   ./service/install.sh --prefix=/tmp/c2 --dry-run # репетиция без root (без systemctl)
#
# Гарантии: manifest SHA256, неизменяемый release, предыдущая версия сохраняется,
# очередь не перезаписывается, отказ при чужом владельце, STOP-каталог не
# доступен сервису на запись. Не делает: деплой сайта, Caddy, сеть, кошельки.

set -euo pipefail

SERVICE_USER="${SERVICE_USER:-agt-orchestrator}"
DEPLOY_USER="${DEPLOY_USER:-agt-deployer}"
CODE_BASE="${CODE_ROOT:-/opt/agentcoin-orchestrator}"
DATA_BASE="${DATA_ROOT:-/var/lib/agentcoin-orchestrator}"
LOG_BASE="${LOG_ROOT:-/var/log/agentcoin-orchestrator}"
UNIT_BASE="${UNIT_DST:-/etc/systemd/system}"
ENV_BASE="${ENV_DIR:-/etc/agentcoin}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$SRC_DIR/service/systemd"
MODE="install"
DRY=0
ENABLE=0
ROLLBACK_DIR=""
PREFIX=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --enable) ENABLE=1 ;;
    --uninstall) MODE="uninstall" ;;
    --rollback=*) MODE="rollback"; ROLLBACK_DIR="${arg#*=}" ;;
    --rollback) MODE="rollback" ;;
    --prefix=*) PREFIX="${arg#*=}" ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

if [[ -n "$PREFIX" ]]; then
  PREFIX="$(mkdir -p "$PREFIX" && cd "$PREFIX" && pwd)"
  CODE_BASE="$PREFIX/opt/agentcoin-orchestrator"
  DATA_BASE="$PREFIX/var/lib/agentcoin-orchestrator"
  LOG_BASE="$PREFIX/var/log/agentcoin-orchestrator"
  UNIT_BASE="$PREFIX/etc/systemd/system"
  ENV_BASE="$PREFIX/etc/agentcoin"
fi

CODE_ROOT="$CODE_BASE"
CURRENT="$CODE_ROOT/current"
RELEASES="$CODE_ROOT/releases"
OPS_ROOT="$DATA_BASE"
UNIT_DST="$UNIT_BASE"
ENV_DIR="$ENV_BASE"
CONTROL_DIR="$DATA_BASE/control"
QUEUE_FILE="$OPS_ROOT/queue/queue.json"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

say() { printf '%s\n' "$*"; }

run() {
  if [[ "$DRY" -eq 1 ]]; then say "  [dry-run] $*"; else eval "$@"; fi
}

if [[ "$DRY" -ne 1 && -z "$PREFIX" && "$(id -u)" -ne 0 ]]; then
  echo "install.sh needs root (sudo) except for --dry-run and --prefix rehearsal" >&2
  exit 77
fi
if [[ -z "${SERVICE_USER//[[:space:]]/}" ]]; then
  echo "SERVICE_USER is empty: refusing to install without a service account" >&2
  exit 64
fi
if ! command -v node >/dev/null 2>&1 && [[ "$DRY" -ne 1 ]]; then
  echo "node is required in PATH (Node.js 20+)" >&2
  exit 78
fi

# В репетиции владелец — текущий пользователь; на ops-host данные принадлежат
# сервисному пользователю, а код — root.
if [[ -n "$PREFIX" ]]; then
  OWNER_OK="$(id -un)"
else
  OWNER_OK="$SERVICE_USER"
fi

own_data() { if [[ -n "$PREFIX" ]]; then :; else eval "chown -R '$SERVICE_USER:$SERVICE_USER' '$1'"; fi; }
own_code() { if [[ -n "$PREFIX" ]]; then :; else eval "chown -R root:root '$1'"; fi; }

say "== mode: $MODE | code: $CODE_ROOT | data: $OPS_ROOT | logs: $LOG_BASE${PREFIX:+ | prefix rehearsal}"

# --- проверки владельца данных и управляющего каталога ---------------------
if [[ -d "$OPS_ROOT" ]]; then
  OWNER="$(stat -c '%U' "$OPS_ROOT")"
  if [[ "$OWNER" != "$OWNER_OK" && "$OWNER" != "root" ]]; then
    echo "refusing: $OPS_ROOT belongs to '$OWNER', expected '$OWNER_OK' or root" >&2
    exit 79
  fi
  say "  owner of $OPS_ROOT: $OWNER (accepted)"
fi
if [[ -d "$CONTROL_DIR" ]]; then
  CMODE="$(stat -c '%a' "$CONTROL_DIR")"
  if [[ "$CMODE" =~ [2367]$ ]]; then
    echo "refusing: $CONTROL_DIR is writable by group/others ($CMODE); STOP must not be service-writable" >&2
    exit 82
  fi
  say "  control dir $CONTROL_DIR mode $CMODE (service cannot write STOP)"
fi

QUEUE_SUM_BEFORE=""
if [[ -f "$QUEUE_FILE" && "$DRY" -ne 1 ]]; then
  QUEUE_SUM_BEFORE="$(sha256sum "$QUEUE_FILE" | awk '{print $1}')"
  say "== existing queue preserved ($(stat -c '%s' "$QUEUE_FILE") bytes)"
fi

# --- uninstall -------------------------------------------------------------
if [[ "$MODE" == "uninstall" ]]; then
  say "== uninstall: units and code only, data stays"
  for unit in agt-orchestrator.service agt-orchestrator-api.service \
              agt-orchestrator-scheduler.service agt-orchestrator-scheduler.timer \
              agt-orchestrator-watchdog.service agt-orchestrator-watchdog.timer \
              agt-deployer.service; do
    if [[ -z "$PREFIX" ]]; then
      run "systemctl disable --now '$unit' >/dev/null 2>&1 || true"
    fi
    run "rm -f '$UNIT_DST/$unit'"
  done
  if [[ -z "$PREFIX" ]]; then run "systemctl daemon-reload || true"; fi
  run "rm -f '$CURRENT'"
  # Release неизменяем (a-w): снимаем биты записи, иначе unlink запрещён.
  run "chmod -R u+w '$RELEASES' 2>/dev/null || true"
  run "rm -rf '$RELEASES'"
  say "  data kept: $OPS_ROOT/{queue,project-memory,workspaces,runs,artifacts,state,control}"
  say "  to remove everything, delete $OPS_ROOT manually after inspection"
  exit 0
fi

# --- rollback --------------------------------------------------------------
if [[ "$MODE" == "rollback" ]]; then
  if [[ -z "$ROLLBACK_DIR" ]]; then
    mapfile -t CANDIDATES < <(ls -1d "$RELEASES"/*/ 2>/dev/null | sed 's#/$##' | sort)
    CURRENT_TARGET="$(readlink -f "$CURRENT" 2>/dev/null || true)"
    for dir in "${CANDIDATES[@]}"; do
      if [[ "$dir" != "$CURRENT_TARGET" ]]; then ROLLBACK_DIR="$dir"; fi
    done
    if [[ -z "$ROLLBACK_DIR" ]]; then
      echo "refusing: no previous release under $RELEASES" >&2
      exit 80
    fi
  fi
  if [[ ! -d "$ROLLBACK_DIR/orchestrator" ]]; then
    echo "refusing: $ROLLBACK_DIR/orchestrator not found" >&2
    exit 80
  fi
  say "== rollback to $ROLLBACK_DIR"
  run "ln -sfn '$ROLLBACK_DIR' '$CURRENT.new'"
  run "mv -Tf '$CURRENT.new' '$CURRENT'"
  if [[ -z "$PREFIX" ]]; then
    run "systemctl restart agt-orchestrator.service agt-orchestrator-api.service || true"
    say "  previous tree kept at $CURRENT.previous"
  else
    say "  [rehearsal] symlink points at the previous release; systemctl not called"
  fi
  run "ln -sfn '$ROLLBACK_DIR' '$CURRENT.previous'" || true
  exit 0
fi

# --- пользователи ----------------------------------------------------------
say "== users"
for user in "$SERVICE_USER" "$DEPLOY_USER"; do
  if [[ -n "$PREFIX" ]]; then
    say "  [rehearsal] $user is not created"
  elif id -u "$user" >/dev/null 2>&1; then
    say "  $user exists"
  else
    run "useradd --system --home-dir '$OPS_ROOT' --shell /usr/sbin/nologin '$user'"
    say "  $user will be created (no shell, no sudo)"
  fi
done

# --- раскладка -------------------------------------------------------------
say "== layout (data and logs are writable, code is not)"
for dir in repository workspaces runs artifacts project-memory queue queue/tasks queue/backlog state; do
  run "install -d -m 0750 '$OPS_ROOT/$dir'"
  if [[ "$DRY" -ne 1 ]]; then own_data "$OPS_ROOT/$dir"; fi
done
run "install -d -m 0750 '$LOG_BASE'"
if [[ "$DRY" -ne 1 ]]; then own_data "$LOG_BASE"; fi
run "install -d -m 0755 '$CONTROL_DIR'"
if [[ -z "$PREFIX" && "$DRY" -ne 1 ]]; then run "chown root:root '$CONTROL_DIR'"; fi

# --- код: неизменяемый release + current -----------------------------------
say "== code release (root-owned, read-only, previous release kept)"
run "install -d -m 0755 '$RELEASES'"
RELEASE="$RELEASES/$TS"
if [[ "$DRY" -eq 1 ]]; then
  say "  [dry-run] rsync -a (excluding runs/workspaces/logs/locks/codex-home) $SRC_DIR/ -> $RELEASE/orchestrator/"
  say "  [dry-run] chown -R root:root '$RELEASE'; chmod -R a-w '$RELEASE'"
  say "  [dry-run] ln -sfn '$RELEASE' '$CURRENT.new' && mv -Tf '$CURRENT.new' '$CURRENT'"
else
  install -d -m 0755 "$RELEASE/orchestrator"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'node_modules' --exclude 'runs/' --exclude 'workspaces/' \
      --exclude 'logs/' --exclude 'locks/' --exclude 'codex-home/' --exclude 'state/*/' \
      "$SRC_DIR/" "$RELEASE/orchestrator/"
  else
    tar -C "$SRC_DIR" --exclude='node_modules' --exclude='runs' --exclude='workspaces' \
        --exclude='logs' --exclude='locks' --exclude='codex-home' -cf - . | tar -C "$RELEASE/orchestrator" -xf -
  fi
  own_code "$RELEASE"
  chmod -R a-w "$RELEASE"
  PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  ln -sfn "$RELEASE" "$CURRENT.new"
  mv -Tf "$CURRENT.new" "$CURRENT"
  say "  release: $RELEASE"
  [[ -n "$PREVIOUS" ]] && say "  previous: $PREVIOUS (kept for --rollback)"
fi

# --- mission / registry / env ---------------------------------------------
say "== mission and registry (existing files are never overwritten)"
if [[ ! -f "$OPS_ROOT/queue/mission.json" ]]; then
  run "install -m 0640 '$SRC_DIR/service/mission.json' '$OPS_ROOT/queue/mission.json'"
  [[ "$DRY" -ne 1 ]] && own_data "$OPS_ROOT/queue/mission.json"
else
  say "  mission.json kept"
fi
if [[ ! -f "$OPS_ROOT/queue/registry.json" ]]; then
  run "install -m 0640 '$SRC_DIR/service/registry.json' '$OPS_ROOT/queue/registry.json'"
  [[ "$DRY" -ne 1 ]] && own_data "$OPS_ROOT/queue/registry.json"
  say "  registry.json installed empty: planner stays IDLE until the owner registers a proven gap"
else
  say "  registry.json kept"
fi

run "install -d -m 0755 '$ENV_DIR'"
if [[ ! -f "$ENV_DIR/ops.env" ]]; then
  run "install -m 0640 '$SRC_DIR/service/ops-env.example' '$ENV_DIR/ops.env'"
else
  say "  $ENV_DIR/ops.env kept"
fi

# --- units (пути подставляются под фактическую раскладку) -----------------
say "== systemd units"
run "install -d -m 0755 '$UNIT_DST'"
for unit in agt-orchestrator.service agt-orchestrator-api.service \
            agt-orchestrator-scheduler.service agt-orchestrator-scheduler.timer \
            agt-orchestrator-watchdog.service agt-orchestrator-watchdog.timer \
            agt-deployer.service; do
  if [[ "$DRY" -eq 1 ]]; then
    say "  [dry-run] render $unit -> $UNIT_DST/$unit"
  else
    sed -e "s#/opt/agentcoin-orchestrator#${CODE_BASE}#g" \
        -e "s#/var/lib/agentcoin-orchestrator#${DATA_BASE}#g" \
        -e "s#/var/log/agentcoin-orchestrator#${LOG_BASE}#g" \
        -e "s#/etc/agentcoin#${ENV_BASE}#g" \
        "$UNIT_SRC/$unit" > "$UNIT_DST/$unit"
    chmod 0644 "$UNIT_DST/$unit"
    say "  $unit"
  fi
done
if [[ -z "$PREFIX" && "$DRY" -ne 1 ]] && command -v systemctl >/dev/null 2>&1; then
  run "systemctl daemon-reload || true"
  say "== verify units"
  systemd-analyze verify "$UNIT_DST/agt-orchestrator.service" "$UNIT_DST/agt-orchestrator-api.service" \
    "$UNIT_DST/agt-orchestrator-scheduler.service" "$UNIT_DST/agt-orchestrator-watchdog.service" \
    "$UNIT_DST/agt-deployer.service" || say "  verify reported problems (см. вывод выше)"
fi

# --- manifest --------------------------------------------------------------
if [[ "$DRY" -ne 1 ]]; then
  say "== manifest"
  install -d -m 0750 "$OPS_ROOT/inventory"
  MANIFEST="$OPS_ROOT/inventory/install-manifest-$TS.json"
  node - "$RELEASE" "$UNIT_DST" "$MANIFEST" "$TS" "$CURRENT" "$OPS_ROOT" "$LOG_BASE" "$SERVICE_USER" "$DEPLOY_USER" <<'NODE'
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
/* Пользователи передаются аргументами. Переменные install.sh не экспортированы,
   поэтому чтение process.env.SERVICE_USER молча подставляло 'agt-orchestrator'
   и записывало в манифест владельца, которого в системе может не быть. */
const [release, unitDir, out, ts, current, dataRoot, logRoot, serviceUser, deployUser] = process.argv.slice(2);
if (!serviceUser || !deployUser) {
  console.error('refusing to write a manifest without serviceUser/deployUser');
  process.exit(1);
}
const units = ['agt-orchestrator.service', 'agt-orchestrator-api.service', 'agt-orchestrator-scheduler.service',
  'agt-orchestrator-scheduler.timer', 'agt-orchestrator-watchdog.service', 'agt-orchestrator-watchdog.timer',
  'agt-deployer.service'];
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    const stat = fs.statSync(full);
    files.push({ path: path.relative(release, full), sha256: execSync(`sha256sum "${full}"`).toString().split(' ')[0], bytes: stat.size, mode: (stat.mode & 0o777).toString(8) });
  }
};
walk(release);
const unitFiles = units.filter((unit) => fs.existsSync(path.join(unitDir, unit))).map((unit) => ({
  path: path.join(unitDir, unit),
  sha256: execSync(`sha256sum "${path.join(unitDir, unit)}"`).toString().split(' ')[0],
}));
fs.writeFileSync(out, JSON.stringify({
  installedAt: ts, release, current: fs.readlinkSync(current), dataRoot, logRoot, serviceUser, deployUser,
  codeFiles: files.length, units: unitFiles, files,
}, null, 2) + '\n');
console.log(`  ${files.length} code files + ${unitFiles.length} units recorded in ${out}`);
NODE
fi

# --- очередь не изменилась -------------------------------------------------
if [[ -n "$QUEUE_SUM_BEFORE" ]]; then
  QUEUE_SUM_AFTER="$(sha256sum "$QUEUE_FILE" | awk '{print $1}')"
  if [[ "$QUEUE_SUM_BEFORE" != "$QUEUE_SUM_AFTER" ]]; then
    echo "FATAL: queue.json changed during install" >&2
    exit 81
  fi
  say "== queue.json unchanged ($QUEUE_SUM_AFTER)"
fi

# --- STOP не должен быть доступен сервису ---------------------------------
if [[ "$DRY" -ne 1 ]]; then
  CSTAT="$(stat -c '%U:%G %a' "$CONTROL_DIR")"
  say "== STOP control dir: $CSTAT"
  CMODE="$(stat -c '%a' "$CONTROL_DIR")"
  if [[ "$CMODE" =~ [2367]$ ]]; then
    echo "FATAL: $CONTROL_DIR became writable by group/others" >&2
    exit 82
  fi
fi

if [[ "$ENABLE" -eq 1 && "$DRY" -ne 1 && -z "$PREFIX" ]]; then
  say "== enable + start"
  systemctl enable --now agt-orchestrator.service agt-orchestrator-api.service
  systemctl enable --now agt-orchestrator-scheduler.timer agt-orchestrator-watchdog.timer
else
  cat <<EOF

Готово ($MODE$( [[ "$DRY" -eq 1 ]] && echo ", dry-run: ничего не изменено" )). Сервисы НЕ запущены.

  systemctl enable --now agt-orchestrator.service agt-orchestrator-api.service
  systemctl enable --now agt-orchestrator-scheduler.timer agt-orchestrator-watchdog.timer

Проверка:
  sudo -u $SERVICE_USER OPS_ROOT=$OPS_ROOT OPS_LOG_DIR=$LOG_BASE \\
    node $CURRENT/orchestrator/service/opsd.mjs status

Операторский ключ (один раз, от root):
  sudo node $CURRENT/orchestrator/service/operator.mjs init-key --root $OPS_ROOT
  STOP ставит только оператор: sudo node $CURRENT/orchestrator/service/operator.mjs stop --root $OPS_ROOT

Откат:  sudo $SRC_DIR/service/install.sh --rollback
Снятие: sudo $SRC_DIR/service/install.sh --uninstall

Deployer остаётся выключенным: $ENV_DIR/deploy-enabled не создаётся.
EOF
fi
