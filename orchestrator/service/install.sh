#!/usr/bin/env bash
# Установка always-on сервиса Agentcoin Ops на отдельный хост (или отдельный
# пользователь на H1). Скрипт идемпотентен и по умолчанию НЕ запускает сервис:
# он раскладывает файлы, пользователей, каталоги и юниты, а включение остаётся
# за владельцем.
#
#   sudo OPS_ROOT=/srv/agentcoin-ops ./service/install.sh
#   sudo ... ./service/install.sh --enable     # сразу enable+start
#
# Что скрипт НЕ делает: не деплоит сайт, не трогает ноду, Caddy, DATA_DIR,
# кошельки и очередь задач сети.

set -euo pipefail

SERVICE_USER="${SERVICE_USER:-agt-orchestrator}"
DEPLOY_USER="${DEPLOY_USER:-agt-deployer}"
OPS_ROOT="${OPS_ROOT:-/srv/agentcoin-ops}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # .../orchestrator
UNIT_SRC="$SRC_DIR/service/systemd"
UNIT_DST="/etc/systemd/system"
ENV_DIR="/etc/agentcoin"
ENABLE=0

for arg in "$@"; do
  case "$arg" in
    --enable) ENABLE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "install.sh must run as root (sudo)" >&2
  exit 77
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required in PATH (Node.js 20+)" >&2
  exit 78
fi

echo "== users"
for user in "$SERVICE_USER" "$DEPLOY_USER"; do
  if id -u "$user" >/dev/null 2>&1; then
    echo "  $user exists"
  else
    useradd --system --home-dir "$OPS_ROOT" --shell /usr/sbin/nologin "$user"
    echo "  $user created (no shell, no sudo)"
  fi
done

echo "== layout $OPS_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 \
  "$OPS_ROOT" \
  "$OPS_ROOT/repository" \
  "$OPS_ROOT/workspaces" \
  "$OPS_ROOT/runs" \
  "$OPS_ROOT/artifacts" \
  "$OPS_ROOT/project-memory" \
  "$OPS_ROOT/queue" \
  "$OPS_ROOT/queue/tasks" \
  "$OPS_ROOT/queue/backlog" \
  "$OPS_ROOT/logs" \
  "$OPS_ROOT/state"

echo "== code"
# Код сервиса копируется без локальных прогонов: они принадлежат машине
# разработки, а не серверу.
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

echo "== mission"
if [[ ! -f "$OPS_ROOT/queue/mission.json" ]]; then
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0640 \
    "$SRC_DIR/service/mission.json" "$OPS_ROOT/queue/mission.json"
  echo "  mission.json installed (adapters.mode=fixture)"
else
  echo "  mission.json kept as-is"
fi

echo "== environment"
install -d -m 0755 "$ENV_DIR"
if [[ ! -f "$ENV_DIR/ops.env" ]]; then
  install -o root -g "$SERVICE_USER" -m 0640 "$SRC_DIR/service/ops-env.example" "$ENV_DIR/ops.env"
  echo "  $ENV_DIR/ops.env created from example"
else
  echo "  $ENV_DIR/ops.env kept as-is"
fi

echo "== systemd units"
for unit in agt-orchestrator.service agt-orchestrator-api.service \
            agt-orchestrator-scheduler.service agt-orchestrator-scheduler.timer \
            agt-orchestrator-watchdog.service agt-orchestrator-watchdog.timer \
            agt-deployer.service; do
  install -o root -g root -m 0644 "$UNIT_SRC/$unit" "$UNIT_DST/$unit"
  echo "  installed $unit"
done
systemctl daemon-reload

if command -v systemd-analyze >/dev/null 2>&1; then
  echo "== verify"
  systemd-analyze verify \
    "$UNIT_DST/agt-orchestrator.service" \
    "$UNIT_DST/agt-orchestrator-api.service" \
    "$UNIT_DST/agt-orchestrator-scheduler.service" \
    "$UNIT_DST/agt-orchestrator-watchdog.service" \
    "$UNIT_DST/agt-deployer.service" || echo "  verify reported problems (см. вывод выше)"
fi

if [[ "$ENABLE" -eq 1 ]]; then
  echo "== enable + start"
  systemctl enable --now agt-orchestrator.service agt-orchestrator-api.service
  systemctl enable --now agt-orchestrator-scheduler.timer agt-orchestrator-watchdog.timer
else
  cat <<EOF

Готово. Сервисы НЕ запущены. Включение — отдельным решением владельца:

  systemctl enable --now agt-orchestrator.service
  systemctl enable --now agt-orchestrator-api.service
  systemctl enable --now agt-orchestrator-scheduler.timer
  systemctl enable --now agt-orchestrator-watchdog.timer

Проверка без запуска:
  sudo -u $SERVICE_USER OPS_ROOT=$OPS_ROOT node $OPS_ROOT/orchestrator/service/opsd.mjs status

Deployer остаётся выключенным: /etc/agentcoin/deploy-enabled не создаётся,
публикация появится только на этапе staging + атомарного release.
EOF
fi
