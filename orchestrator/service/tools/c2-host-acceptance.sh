#!/usr/bin/env bash
# Приёмка C2 на реальном ops-host. Запускать от root из дерева исходников:
#
#   sudo ./service/tools/c2-host-acceptance.sh                    # безопасные проверки
#   sudo ./service/tools/c2-host-acceptance.sh --with-queue-test  # + мутирующая проверка очереди
#   sudo ./service/tools/c2-host-acceptance.sh --stop-and-reboot  # подписанный STOP + маркер
#   sudo reboot
#   sudo ./service/tools/c2-host-acceptance.sh --after-reboot     # STOP/очередь/checkpoint после reboot
#   sudo ./service/tools/c2-host-acceptance.sh --with-teardown    # rollback + uninstall (в конце)
#
# Результат: evidence/c2-host-acceptance.txt и .json. PASS ставится только за
# фактически выполненную проверку; пункты, которым нужен второй хост,
# перезагрузка или разрушительный шаг, помечаются PENDING/SKIP, а не PASS.
#
# Права: скрипт требует root, потому что читает владельцев, control/STOP и
# операторский ключ. Он ничего не запускает как агент, не касается сети, Caddy,
# кошельков и production: только локальный сервис Agentcoin Ops.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH="$(cd "$HERE/../.." && pwd)"

CODE_ROOT="${CODE_ROOT:-/opt/agentcoin-orchestrator}"
DATA_ROOT="${OPS_ROOT:-/var/lib/agentcoin-orchestrator}"
LOG_ROOT="${OPS_LOG_DIR:-/var/log/agentcoin-orchestrator}"
ENV_DIR="${ENV_DIR:-/etc/agentcoin}"
API_PORT="${OPS_API_PORT:-8799}"
OUT=""
PHASE="pre"
WITH_QUEUE=0
WITH_TEARDOWN=0
KEEP_STOPPED=0
SERVICE_USER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root=*) DATA_ROOT="${1#*=}" ;;
    --code=*) CODE_ROOT="${1#*=}" ;;
    --logs=*) LOG_ROOT="${1#*=}" ;;
    --port=*) API_PORT="${1#*=}" ;;
    --out=*) OUT="${1#*=}" ;;
    --service-user=*) SERVICE_USER="${1#*=}" ;;
    --with-queue-test) WITH_QUEUE=1 ;;
    --with-teardown) WITH_TEARDOWN=1 ;;
    --stop-and-reboot) PHASE="stop" ;;
    --after-reboot) PHASE="post" ;;
    --keep-stopped) KEEP_STOPPED=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "c2-host-acceptance.sh must run as root (ownership, control/STOP and the operator key are root-only)" >&2
  exit 77
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node is required in PATH (Node.js 20+)" >&2
  exit 78
fi

CODE="$CODE_ROOT/current"
OPSD="$CODE/orchestrator/service/opsd.mjs"
OPERATOR="$CODE/orchestrator/service/operator.mjs"
DEPLOYER="$CODE/orchestrator/service/deployer.mjs"
CONTROL="$DATA_ROOT/control"
QUEUE="$DATA_ROOT/queue/queue.json"
REGISTRY="$DATA_ROOT/queue/registry.json"
INCIDENTS="$DATA_ROOT/queue/incidents.json"
CHECKPOINT="$DATA_ROOT/state/checkpoint.json"

for dir in "$CODE" "$DATA_ROOT"; do
  if [[ ! -d "$dir" ]]; then
    echo "not installed or wrong --root/--code: $dir is missing" >&2
    exit 66
  fi
done

REAL_CODE="$(readlink -f "$CODE")"
OUT="${OUT:-$ORCH/evidence/c2-host-acceptance.txt}"
JSON_OUT="${OUT%.txt}.json"
REBOOT_STATE="${OUT%.txt}.reboot-state.json"
mkdir -p "$(dirname "$OUT")" || { echo "cannot write evidence next to $OUT" >&2; exit 73; }

RESULTS="$(mktemp)"
TMPD=""
cleanup() {
  rm -f "$RESULTS" "${BODY:-}" 2>/dev/null || true
  [[ -n "$TMPD" ]] && rm -rf "$TMPD"
}
trap cleanup EXIT

UNITS=(agt-orchestrator.service agt-orchestrator-api.service agt-orchestrator-scheduler.timer agt-orchestrator-watchdog.timer)

say() { printf '%s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

record() {
  local id="$1" status="$2" detail
  shift 2
  detail="${*//$'\t'/ }"
  detail="${detail//$'\n'/ }"
  printf '%s\t%s\t%s\n' "$id" "$status" "$detail" >>"$RESULTS"
  printf '  %-7s %-32s %s\n' "$status" "$id" "$detail"
}

json_get() { # file dotted.path
  "$NODE" -e 'const fs=require("node:fs");const [f,p]=process.argv.slice(1);let v=JSON.parse(fs.readFileSync(f,"utf8"));for(const k of String(p||"").split(".").filter(Boolean))v=v==null?undefined:v[k];process.stdout.write(v==null?"":String(v));' "$1" "$2" 2>/dev/null
}

queue_total() { # file; свежая установка может не иметь queue.json — это 0 заданий
  "$NODE" -e 'const fs=require("node:fs");const f=process.argv[1];if(!fs.existsSync(f)){process.stdout.write("0");process.exit(0)}const q=JSON.parse(fs.readFileSync(f,"utf8"));process.stdout.write(String((q.items||[]).length));' "$1" 2>/dev/null
}

sha_of() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
queue_sha() { if [[ -f "$1" ]]; then sha_of "$1"; else echo absent; fi; }

as_service() {
  if [[ "$SERVICE_USER" == "$(id -un)" ]]; then
    env OPS_ROOT="$DATA_ROOT" OPS_LOG_DIR="$LOG_ROOT" \
      OPS_CONTROL_DIR="$CONTROL" OPS_OPERATOR_PUB="$DATA_ROOT/state/operator.pub" "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- env OPS_ROOT="$DATA_ROOT" OPS_LOG_DIR="$LOG_ROOT" \
      OPS_CONTROL_DIR="$CONTROL" OPS_OPERATOR_PUB="$DATA_ROOT/state/operator.pub" "$@"
  else
    sudo -n -u "$SERVICE_USER" env OPS_ROOT="$DATA_ROOT" OPS_LOG_DIR="$LOG_ROOT" \
      OPS_CONTROL_DIR="$CONTROL" OPS_OPERATOR_PUB="$DATA_ROOT/state/operator.pub" "$@"
  fi
}

as_service_plan() { # target file for the plan JSON; stderr -> <file>.err
  as_service "$NODE" "$OPSD" plan --root "$DATA_ROOT" >"$1" 2>"$1.err"
}

# Пустой action означает, что plan не выполнился (например, runuser не нашёл
# сервисного пользователя). Detail показывает причину, а не прячет её.
plan_action() { # json file
  local action
  action="$(json_get "$1" action)"
  if [[ -z "$action" && -f "$1.err" ]]; then
    action="plan failed: $(head -n1 "$1.err" | cut -c1-120)"
  fi
  printf '%s' "$action"
}

# --- кто сервисный пользователь: юнит и манифест должны совпадать ------------
MANIFEST="$(ls -1t "$DATA_ROOT"/inventory/install-manifest-*.json 2>/dev/null | head -n1 || true)"
MANIFEST_USER=""
MANIFEST_DEPLOY_USER=""
MANIFEST_DATA_OWNER=""
MANIFEST_MODE=""
if [[ -n "$MANIFEST" ]]; then
  MANIFEST_USER="$(json_get "$MANIFEST" serviceUser)"
  MANIFEST_DEPLOY_USER="$(json_get "$MANIFEST" deployUser)"
  MANIFEST_DATA_OWNER="$(json_get "$MANIFEST" dataOwner)"
  MANIFEST_MODE="$(json_get "$MANIFEST" mode)"
fi
UNIT_USER="$(systemctl show -p User --value agt-orchestrator.service 2>/dev/null | tr -d '[:space:]')"
if [[ -z "$SERVICE_USER" ]]; then
  SERVICE_USER="${UNIT_USER:-${MANIFEST_USER:-agt-orchestrator}}"
fi

checks_core() {
  section "1. systemd units"
  local states="" all_active=1 unit state
  for unit in "${UNITS[@]}"; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    states+="${unit}=${state:-unknown} "
    [[ "$state" == "active" ]] || all_active=0
  done
  if [[ "$all_active" -eq 1 ]]; then
    record units-active PASS "$states"
  else
    record units-active FAIL "$states"
  fi

  local enabled="" all_enabled=1
  for unit in "${UNITS[@]}"; do
    state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    enabled+="${unit}=${state:-unknown} "
    [[ "$state" == "enabled" ]] || all_enabled=0
  done
  if [[ "$all_enabled" -eq 1 ]]; then
    record units-enabled PASS "$enabled"
  else
    record units-enabled FAIL "$enabled"
  fi

  section "2. service account recorded by install.sh"
  local data_owner_now
  data_owner_now="$(stat -c '%U' "$DATA_ROOT" 2>/dev/null || echo '?')"
  if [[ -n "$MANIFEST_USER" && "$MANIFEST_MODE" == "host" && "$MANIFEST_USER" == "$SERVICE_USER" \
        && "$MANIFEST_DATA_OWNER" == "$data_owner_now" && "$SERVICE_USER" == "$data_owner_now" ]]; then
    record manifest-service-user PASS "manifest=$(basename "${MANIFEST:-none}") serviceUser=$MANIFEST_USER dataOwner=$MANIFEST_DATA_OWNER matches disk ($data_owner_now)"
  else
    record manifest-service-user FAIL "manifest serviceUser='${MANIFEST_USER:-missing}' dataOwner='${MANIFEST_DATA_OWNER:-missing}' mode='${MANIFEST_MODE:-missing}'; disk owner=$data_owner_now, resolved=$SERVICE_USER"
  fi
  if [[ -n "$MANIFEST_DEPLOY_USER" && "$MANIFEST_DEPLOY_USER" != "root" ]]; then
    record manifest-deploy-user PASS "deployUser=$MANIFEST_DEPLOY_USER"
  else
    record manifest-deploy-user FAIL "deployUser='${MANIFEST_DEPLOY_USER:-missing}'"
  fi
  if [[ -n "$UNIT_USER" && "$UNIT_USER" == "$SERVICE_USER" && "$UNIT_USER" != "root" ]]; then
    record unit-runs-as-service-user PASS "User=$UNIT_USER"
  else
    record unit-runs-as-service-user FAIL "Systemd User='${UNIT_USER:-missing}' resolved=$SERVICE_USER"
  fi

  section "3. data, logs and control/STOP ownership"
  local downer dmode
  downer="$(stat -c '%U' "$DATA_ROOT" 2>/dev/null || echo '?')"
  dmode="$(stat -c '%a' "$DATA_ROOT" 2>/dev/null || echo '?')"
  if [[ "$downer" == "$SERVICE_USER" && "$dmode" == "750" ]]; then
    record data-owner PASS "$DATA_ROOT $downer:$dmode"
  else
    record data-owner FAIL "$DATA_ROOT $downer:$dmode (expected $SERVICE_USER:750)"
  fi
  local cstat cowner cmode
  cstat="$(stat -c '%U:%G %a' "$CONTROL" 2>/dev/null || echo '?')"
  cowner="$(stat -c '%U:%G' "$CONTROL" 2>/dev/null || echo '?')"
  cmode="$(stat -c '%a' "$CONTROL" 2>/dev/null || echo '?')"
  if [[ "$cowner" == "root:root" && "$cmode" == "755" ]]; then
    record control-dir-root-owned PASS "$cstat"
  else
    record control-dir-root-owned FAIL "$cstat (expected root:root 755)"
  fi
  if as_service test -w "$CONTROL"; then
    record stop-not-service-writable FAIL "$SERVICE_USER can write $CONTROL"
  else
    record stop-not-service-writable PASS "$SERVICE_USER cannot write $CONTROL"
  fi

  section "4. code is immutable and separate from data"
  local writable
  writable="$(find "$CODE/" -type f -perm -u+w 2>/dev/null | head -n 5 | tr '\n' ' ')"
  if [[ -z "${writable// /}" ]]; then
    record code-read-only PASS "no writable file under $CODE"
  else
    record code-read-only FAIL "writable files: $writable"
  fi
  if [[ "$REAL_CODE" == "$CODE_ROOT/releases/"* && "$REAL_CODE" != "$DATA_ROOT"* ]]; then
    record code-outside-data PASS "current -> $REAL_CODE"
  else
    record code-outside-data FAIL "current -> $REAL_CODE"
  fi
  local release_owner
  release_owner="$(stat -c '%U:%G' "$REAL_CODE" 2>/dev/null || echo '?')"
  if [[ "$release_owner" == "root:root" ]]; then
    record release-root-owned PASS "$release_owner $REAL_CODE"
  else
    record release-root-owned FAIL "$release_owner (expected root:root)"
  fi

  section "5. Ops API is loopback-only"
  local listeners=""
  if command -v ss >/dev/null 2>&1; then
    listeners="$(ss -ltnH "sport = :$API_PORT" 2>/dev/null | awk 'NF{print $4}')"
    if [[ -z "$listeners" ]]; then
      listeners="$(ss -ltn 2>/dev/null | awk -v p=":$API_PORT" '$4 ~ p {print $4}')"
    fi
    local addrs=() loopback=1 addr
    while read -r addr; do
      [[ -z "$addr" ]] && continue
      addrs+=("$addr")
      [[ "$addr" == "127.0.0.1:$API_PORT" || "$addr" == "[::1]:$API_PORT" ]] || loopback=0
    done <<<"$listeners"
    if [[ "${#addrs[@]}" -gt 0 && "$loopback" -eq 1 ]]; then
      record api-loopback-listeners PASS "listeners=${addrs[*]}"
    else
      record api-loopback-listeners FAIL "listeners=${addrs[*]:-none} (expected only 127.0.0.1/$API_PORT and [::1]/$API_PORT)"
    fi
  else
    record api-loopback-listeners PENDING "ss is not available; inspect listeners manually"
  fi

  if ! command -v curl >/dev/null 2>&1; then
    record api-local-get PENDING "curl is not available"
    record api-external-refused PENDING "curl is not available"
  else
    BODY="$(mktemp)"
    local http_code
    http_code="$(curl -sS --max-time 5 -o "$BODY" -w '%{http_code}' "http://127.0.0.1:$API_PORT/ops/status" 2>/dev/null || echo 000)"
    if [[ "$http_code" == "200" ]]; then
      record api-local-get PASS "GET http://127.0.0.1:$API_PORT/ops/status -> 200"
    else
      record api-local-get FAIL "GET /ops/status -> $http_code"
    fi
    if [[ "$http_code" == "200" ]]; then
      if "$NODE" -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$BODY" >/dev/null 2>&1; then
        record api-public-parse PASS "response body is JSON"
      else
        record api-public-parse FAIL "response body is not JSON"
      fi
      local leaks
      leaks="$(grep -Eo '/(var|opt|home|etc|srv)/|"pid"[[:space:]]*:|"username"[[:space:]]*:|Authorization' "$BODY" 2>/dev/null | sort -u | tr '\n' ' ')"
      if [[ -z "${leaks// /}" ]]; then
        record api-public-fields PASS "no paths, pids, usernames or auth headers"
      else
        record api-public-fields FAIL "leaked fields: $leaks"
      fi
      local post_code
      post_code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$API_PORT/ops/status" 2>/dev/null || echo 000)"
      if [[ "$post_code" == "405" ]]; then
        record api-post-rejected PASS "POST -> 405"
      else
        record api-post-rejected FAIL "POST -> $post_code (expected 405)"
      fi
    else
      record api-public-parse SKIP "no successful response to inspect"
      record api-public-fields SKIP "no successful response to inspect"
      record api-post-rejected SKIP "no successful response to inspect"
    fi

    local ext_ip=""
    if command -v ip >/dev/null 2>&1; then
      ext_ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)"
    fi
    if [[ -z "$ext_ip" ]]; then
      record api-external-refused PENDING "no global IPv4 on this host; verify from another machine"
    elif curl -sS --max-time 3 -o /dev/null "http://$ext_ip:$API_PORT/ops/status" 2>/dev/null; then
      record api-external-refused FAIL "reachable via $ext_ip:$API_PORT"
    else
      record api-external-refused PASS "connection to $ext_ip:$API_PORT refused or timed out"
    fi
  fi

  section "6. only the operator can stop or resume"
  local out code
  out="$(as_service "$NODE" "$OPSD" resume --root "$DATA_ROOT" 2>&1)"; code=$?
  if [[ "$code" -eq 78 && "$out" == *RESUME_REQUIRES_OPERATOR* ]]; then
    record service-cannot-resume PASS "opsd resume exit=$code"
  else
    record service-cannot-resume FAIL "opsd resume exit=$code: $(printf '%s' "$out" | head -n1)"
  fi
  out="$(as_service "$NODE" "$OPSD" stop --reason acceptance 2>&1)"; code=$?
  if [[ "$code" -eq 78 && "$out" == *STOP_REQUIRES_OPERATOR* ]]; then
    record service-cannot-stop PASS "opsd stop is gone: refusal exit=$code, no STOP written"
  else
    record service-cannot-stop FAIL "opsd stop exit=$code: $(printf '%s' "$out" | head -n1)"
  fi

  local verify_tmp signed all_valid
  verify_tmp="$(mktemp)"
  "$NODE" "$OPERATOR" verify --root "$DATA_ROOT" >"$verify_tmp" 2>/dev/null
  code=$?
  signed="$(json_get "$verify_tmp" signed)"
  all_valid="$(json_get "$verify_tmp" allValid)"
  if [[ "${signed:-0}" == "0" ]]; then
    record operator-ledger PENDING "no signed stop/resume events yet"
  elif [[ "$all_valid" == "true" && "$code" -eq 0 ]]; then
    record operator-ledger PASS "$signed signed events, signatures valid"
  else
    record operator-ledger FAIL "$signed events, allValid=${all_valid:-unknown}, exit=$code"
  fi
  rm -f "$verify_tmp"

  section "7. deployer disabled, runtime not required for C2"
  out="$(as_service "$NODE" "$DEPLOYER" 2>&1)"; code=$?
  if [[ "$code" -eq 3 && "$out" == *DEPLOYMENT_NOT_ENABLED* && ! -f "$ENV_DIR/deploy-enabled" ]]; then
    record deployer-disabled PASS "deployer exit=$code, $ENV_DIR/deploy-enabled absent"
  else
    record deployer-disabled FAIL "deployer exit=$code, deploy-enabled=$([[ -f "$ENV_DIR/deploy-enabled" ]] && echo present || echo absent)"
  fi

  local status_tmp allow
  status_tmp="$(mktemp)"
  as_service "$NODE" "$OPSD" status --root "$DATA_ROOT" >"$status_tmp" 2>/dev/null
  allow="$(json_get "$status_tmp" mission.allowRealAgents)"
  if [[ "$allow" == "false" ]]; then
    record allow-real-agents-false PASS "mission.allowRealAgents=false"
  else
    record allow-real-agents-false FAIL "mission.allowRealAgents=${allow:-missing} (C2 must stay false)"
  fi
  rm -f "$status_tmp"

  out="$("$NODE" "$OPSD" runtime --root "$DATA_ROOT" 2>&1)"; code=$?
  if [[ "$code" -eq 0 ]]; then
    record runtime-pinned PASS "pinned runtime verified"
  else
    record runtime-pinned PENDING "C3 gate: pinned runtime not configured or not verified (exit=$code)"
  fi
}

checks_pre_service() {
  section "8. planner stays IDLE with no evidence"
  TMPD="$(mktemp -d)"
  as_service_plan "$TMPD/plan-idle.json"
  local action total
  action="$(plan_action "$TMPD/plan-idle.json")"
  total="$(queue_total "$QUEUE")"
  if [[ "$action" == "idle" && "${total:-0}" == "0" ]]; then
    record planner-idle PASS "plan action=idle, queue.total=0"
  elif [[ "$action" == "stopped" ]]; then
    record planner-idle FAIL "plan action=stopped: a STOP is present before the acceptance run"
  else
    record planner-idle FAIL "plan action=${action:-none}, queue.total=${total:-?} (expected idle on an empty registry)"
  fi
}

queue_test() {
  section "9. one task per proven registry gap (mutating, restored)"
  local tmp reg_mode queue_mode total_before entry_id plan1 plan2 total_after matching task_id
  tmp="$TMPD/queue-test"
  mkdir -p "$tmp"
  reg_mode="$(stat -c '%a' "$REGISTRY" 2>/dev/null || echo 640)"
  queue_mode="$(stat -c '%a' "$QUEUE" 2>/dev/null || echo 640)"
  cp -a "$REGISTRY" "$tmp/registry.bak"
  total_before="$(queue_total "$QUEUE")"
  entry_id="host-acceptance-$(date -u +%Y%m%dT%H%M%S)"

  "$NODE" - "$REGISTRY" "$tmp/registry.new" "$CODE/orchestrator/fixtures/tasks/lesson-01.json" "$entry_id" <<'NODE'
const fs = require('node:fs');
const [regFile, outFile, templateFile, id] = process.argv.slice(2);
const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
const template = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
delete template.taskId;
reg.entries = [...(reg.entries || []), {
  id, priority: 5, type: 'registry_gap',
  check: { kind: 'file_exists', path: `acceptance-gap-${id}.txt` },
  task: template,
}];
fs.writeFileSync(outFile, `${JSON.stringify(reg, null, 2)}\n`);
NODE
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m "$reg_mode" "$tmp/registry.new" "$REGISTRY"

  as_service_plan "$tmp/plan1.json"
  as_service_plan "$tmp/plan2.json"
  total_after="$(queue_total "$QUEUE")"
  task_id="$(json_get "$tmp/plan1.json" taskId)"
  matching="$("$NODE" -e 'const fs=require("node:fs");const [f,id]=process.argv.slice(1);const q=JSON.parse(fs.readFileSync(f,"utf8"));process.stdout.write(String((q.items||[]).filter((i)=>i.trigger&&i.trigger.registryId===id).length));' "$QUEUE" "$entry_id" 2>/dev/null)"

  if [[ "$(plan_action "$tmp/plan1.json")" == "enqueued" && "$matching" == "1" && "${total_after:-0}" -eq "$(( ${total_before:-0} + 1 ))" ]]; then
    record queue-single-creation PASS "first plan enqueued $task_id; one queue item for $entry_id; total $total_before -> $total_after"
  else
    record queue-single-creation FAIL "first=$(plan_action "$tmp/plan1.json") second=$(plan_action "$tmp/plan2.json") matching=$matching total=$total_before->$total_after"
  fi
  local second_action
  second_action="$(plan_action "$tmp/plan2.json")"
  if [[ "$second_action" != "enqueued" ]]; then
    record queue-no-duplicate PASS "second plan action=$second_action"
  else
    record queue-no-duplicate FAIL "second plan enqueued another task"
  fi

  # Уборка: удаляем только созданное этой проверкой и возвращаем registry.
  "$NODE" - "$QUEUE" "$entry_id" <<'NODE'
const fs = require('node:fs');
const [file, id] = process.argv.slice(2);
const queue = JSON.parse(fs.readFileSync(file, 'utf8'));
queue.items = (queue.items || []).filter((item) => !(item.trigger && item.trigger.registryId === id));
const tmp = `${file}.acceptance.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(queue, null, 2)}\n`);
fs.renameSync(tmp, file);
NODE
  chown "$SERVICE_USER:$SERVICE_USER" "$QUEUE" 2>/dev/null || true
  chmod "$queue_mode" "$QUEUE" 2>/dev/null || true
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m "$reg_mode" "$tmp/registry.bak" "$REGISTRY"
  [[ -n "$task_id" ]] && rm -f "$DATA_ROOT/queue/tasks/$task_id.json"
  "$NODE" - "$INCIDENTS" "$entry_id" <<'NODE'
const fs = require('node:fs');
const [file, id] = process.argv.slice(2);
if (!fs.existsSync(file)) process.exit(0);
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.items = (state.items || []).filter((item) => item.id !== id);
const tmp = `${file}.acceptance.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, items: state.items }, null, 2)}\n`);
fs.renameSync(tmp, file);
NODE
  if [[ -f "$INCIDENTS" ]]; then
    chown "$SERVICE_USER:$SERVICE_USER" "$INCIDENTS" 2>/dev/null || true
    chmod 640 "$INCIDENTS" 2>/dev/null || true
  fi

  local total_cleaned reg_sha_backup reg_sha_now
  total_cleaned="$(queue_total "$QUEUE")"
  reg_sha_backup="$(sha_of "$tmp/registry.bak")"
  reg_sha_now="$(sha_of "$REGISTRY")"
  if [[ "${total_cleaned:-0}" -eq "${total_before:-0}" && "$reg_sha_backup" == "$reg_sha_now" ]]; then
    record queue-test-cleanup PASS "queue back to $total_before items; registry restored ($reg_sha_now)"
  else
    record queue-test-cleanup FAIL "queue $total_before -> $total_cleaned; registry sha ${reg_sha_backup:0:12} -> ${reg_sha_now:0:12}"
  fi
}

stop_and_reboot() {
  section "10. signed STOP + reboot marker"
  local out code
  out="$("$NODE" "$OPERATOR" stop --root "$DATA_ROOT" --reason "c2 host acceptance: reboot test" 2>&1)"; code=$?
  if [[ "$code" -ne 0 || ! -f "$CONTROL/STOP" ]]; then
    record operator-stop FAIL "exit=$code: $(printf '%s' "$out" | head -n1)"
    record reboot-marker FAIL "not ready for reboot: the signed STOP failed, fix operator stop first"
    return
  fi
  record operator-stop PASS "signed STOP written: $(printf '%s' "$out" | tr -d '\n' | cut -c1-120)"

  as_service_plan "$TMPD/plan-stopped.json"
  if [[ "$(plan_action "$TMPD/plan-stopped.json")" == "stopped" ]]; then
    record stop-blocks-planner PASS "plan action=stopped"
  else
    record stop-blocks-planner FAIL "plan action=$(plan_action "$TMPD/plan-stopped.json")"
  fi

  "$NODE" - "$REBOOT_STATE" "$QUEUE" "$CHECKPOINT" "$CONTROL/STOP" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [outFile, queueFile, checkpointFile, stopFile] = process.argv.slice(2);
/* Свежая установка может не иметь queue.json: это «ноль заданий», а не ошибка. */
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent');
const queue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : { items: [] };
fs.writeFileSync(outFile, `${JSON.stringify({
  at: new Date().toISOString(),
  queueSha256: sha(queueFile),
  queueItems: (queue.items || []).length,
  checkpoint: fs.existsSync(checkpointFile) ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) : null,
  stopPresent: fs.existsSync(stopFile),
  stopContent: fs.existsSync(stopFile) ? fs.readFileSync(stopFile, 'utf8').trim() : null,
}, null, 2)}\n`);
NODE
  if [[ -f "$REBOOT_STATE" ]]; then
    record reboot-marker PASS "state saved to $REBOOT_STATE; run: sudo reboot, then --after-reboot"
    say ""
    say "  STOP записан. Перезагрузите хост и повторите скрипт с --after-reboot."
  else
    record reboot-marker FAIL "cannot write $REBOOT_STATE: fix the error above before rebooting"
  fi
}

after_reboot() {
  section "10. STOP, queue and checkpoint survived the reboot"
  if [[ ! -f "$REBOOT_STATE" ]]; then
    record reboot-marker FAIL "missing $REBOOT_STATE (run --stop-and-reboot before rebooting)"
    return
  fi
  local expected_queue expected_items expected_cp stop_ok checkpoint_now stop_present
  expected_queue="$(json_get "$REBOOT_STATE" queueSha256)"
  expected_items="$(json_get "$REBOOT_STATE" queueItems)"
  stop_present="$(json_get "$REBOOT_STATE" stopPresent)"
  checkpoint_now="$("$NODE" -e 'const fs=require("node:fs");const f=process.argv[1];process.stdout.write(fs.existsSync(f)?JSON.stringify(JSON.parse(fs.readFileSync(f,"utf8"))):"null");' "$CHECKPOINT" 2>/dev/null)"
  expected_cp="$("$NODE" -e 'const fs=require("node:fs");const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(s.checkpoint ?? null));' "$REBOOT_STATE" 2>/dev/null)"

  if [[ "$(queue_sha "$QUEUE")" == "$expected_queue" && "$(queue_total "$QUEUE")" == "$expected_items" ]]; then
    record queue-survives-reboot PASS "queue sha256 unchanged ($expected_queue), $expected_items items"
  else
    record queue-survives-reboot FAIL "queue changed across reboot (sha ${expected_queue:0:12} -> $(queue_sha "$QUEUE" | cut -c1-12), items $expected_items -> $(queue_total "$QUEUE"))"
  fi

  if [[ "$checkpoint_now" == "$expected_cp" ]]; then
    record checkpoint-survives-reboot PASS "checkpoint unchanged: ${checkpoint_now:0:100}"
  else
    record checkpoint-survives-reboot FAIL "checkpoint ${expected_cp:0:80} -> ${checkpoint_now:0:80}"
  fi

  if [[ "$stop_present" == "true" && -f "$CONTROL/STOP" ]]; then
    record stop-survives-reboot PASS "control/STOP is still present"
  else
    record stop-survives-reboot FAIL "STOP was expected before reboot (present=$stop_present) and now $([[ -f "$CONTROL/STOP" ]] && echo present || echo absent)"
  fi

  as_service_plan "$TMPD/plan-after.json"
  if [[ "$(plan_action "$TMPD/plan-after.json")" == "stopped" ]]; then
    record stopped-after-reboot PASS "plan action=stopped"
  else
    record stopped-after-reboot FAIL "plan action=$(plan_action "$TMPD/plan-after.json")"
  fi

  local status_tmp age
  status_tmp="$(mktemp)"
  as_service "$NODE" "$OPSD" status --root "$DATA_ROOT" >"$status_tmp" 2>/dev/null
  age="$(json_get "$status_tmp" heartbeatAgeSec)"
  rm -f "$status_tmp"
  if [[ -n "$age" && "$age" -lt 300 ]]; then
    record heartbeat-after-reboot PASS "heartbeat age ${age}s"
  else
    record heartbeat-after-reboot FAIL "heartbeat age ${age:-unknown} (seconds)"
  fi

  if [[ "$KEEP_STOPPED" -eq 1 ]]; then
    record operator-resume SKIP "--keep-stopped: STOP left in place on purpose"
    return
  fi

  local out code signed all_valid verify_tmp
  out="$("$NODE" "$OPERATOR" resume --root "$DATA_ROOT" 2>&1)"; code=$?
  if [[ "$code" -eq 0 && ! -f "$CONTROL/STOP" ]]; then
    record operator-resume PASS "signed resume: $(printf '%s' "$out" | tr -d '\n' | cut -c1-120)"
  else
    record operator-resume FAIL "exit=$code: $(printf '%s' "$out" | head -n1)"
  fi

  verify_tmp="$(mktemp)"
  "$NODE" "$OPERATOR" verify --root "$DATA_ROOT" >"$verify_tmp" 2>/dev/null
  code=$?
  signed="$(json_get "$verify_tmp" signed)"
  all_valid="$(json_get "$verify_tmp" allValid)"
  rm -f "$verify_tmp"
  if [[ "${signed:-0}" -ge 2 && "$all_valid" == "true" && "$code" -eq 0 ]]; then
    record operator-ledger-after-reboot PASS "$signed signed events, all valid"
  else
    record operator-ledger-after-reboot FAIL "$signed events, allValid=${all_valid:-unknown}, exit=$code"
  fi

  as_service_plan "$TMPD/plan-resumed.json"
  local action
  action="$(plan_action "$TMPD/plan-resumed.json")"
  if [[ -n "$action" && "$action" != "stopped" && "$action" != plan\ failed:* ]]; then
    record resume-unblocks-planner PASS "plan action=$action after resume"
  else
    record resume-unblocks-planner FAIL "plan action='${action:-none}' after operator resume (expected idle/none/enqueued)"
  fi
}

teardown() {
  section "11. rollback and uninstall keep the data"
  local release_before release_after out code
  release_before="$(readlink -f "$CODE")"
  out="$(bash "$ORCH/service/install.sh" --rollback 2>&1)"; code=$?
  release_after="$(readlink -f "$CODE")"
  if [[ "$code" -eq 0 && "$release_after" != "$release_before" && -d "$release_after/orchestrator" ]]; then
    record rollback PASS "current -> $(basename "$release_after") (was $(basename "$release_before"))"
  else
    record rollback FAIL "exit=$code, current $(basename "$release_before") -> $(basename "$release_after")"
  fi

  local marker="$DATA_ROOT/project-memory/acceptance-marker.txt"
  printf 'data must survive uninstall\n' >"$marker"
  chown "$SERVICE_USER:$SERVICE_USER" "$marker" 2>/dev/null || true
  out="$(bash "$ORCH/service/install.sh" --uninstall 2>&1)"; code=$?
  if [[ "$code" -eq 0 && ! -e "$CODE" && -f "$marker" ]]; then
    record uninstall-keeps-data PASS "code removed, data marker kept"
  else
    record uninstall-keeps-data FAIL "exit=$code, current present=$([[ -e "$CODE" ]] && echo yes || echo no), marker=$([[ -f "$marker" ]] && echo yes || echo no)"
  fi
  say ""
  say "  Сервис снят. Вернуть: sudo ./service/install.sh && sudo ./service/install.sh --enable"
}

main() {
  say "== C2 host acceptance"
  say "   host=$(hostname 2>/dev/null || echo unknown) phase=$PHASE"
  say "   data=$DATA_ROOT"
  say "   code=$REAL_CODE"
  say "   service user=$SERVICE_USER"

  TMPD="$(mktemp -d)"

  checks_core

  case "$PHASE" in
    pre)
      checks_pre_service
      [[ "$WITH_QUEUE" -eq 1 ]] && queue_test
      [[ "$WITH_QUEUE" -eq 0 ]] && record queue-single-creation SKIP "run with --with-queue-test to prove one creation per registry gap"
      if [[ "$WITH_TEARDOWN" -eq 1 ]]; then
        teardown
      else
        record rollback SKIP "run with --with-teardown at the end of the acceptance"
        record uninstall-keeps-data SKIP "run with --with-teardown at the end of the acceptance"
      fi
      record stop-survives-reboot PENDING "run --stop-and-reboot, reboot, then --after-reboot"
      record queue-survives-reboot PENDING "run --stop-and-reboot, reboot, then --after-reboot"
      record checkpoint-survives-reboot PENDING "run --stop-and-reboot, reboot, then --after-reboot"
      ;;
    stop) stop_and_reboot ;;
    post) after_reboot ;;
  esac

  local summary
  summary="$(awk -F'\t' '{count[$2]++} END {printf "%d pass, %d fail, %d skip, %d pending", count["PASS"], count["FAIL"], count["SKIP"], count["PENDING"]}' "$RESULTS")"
  say ""
  say "== summary: $summary"

  "$NODE" - "$RESULTS" "$JSON_OUT" "$DATA_ROOT" "$REAL_CODE" "$SERVICE_USER" "$PHASE" "$(hostname 2>/dev/null || echo unknown)" <<'NODE'
const fs = require('node:fs');
const [resFile, outFile, root, code, serviceUser, phase, host] = process.argv.slice(2);
const results = fs.readFileSync(resFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
  const [id, status, ...detail] = line.split('\t');
  return { id, status, detail: detail.join('\t') };
});
fs.writeFileSync(outFile, `${JSON.stringify({ at: new Date().toISOString(), host, phase, dataRoot: root, codeRoot: code, serviceUser, results }, null, 2)}\n`);
NODE
  say "evidence: $OUT"
  say "evidence: $JSON_OUT"
}

main 2>&1 | tee "$OUT.tmp"
STATUS="${PIPESTATUS[0]}"
if grep -q $'\tFAIL\t' "$OUT.tmp"; then STATUS=1; fi
mv "$OUT.tmp" "$OUT"
exit "$STATUS"
