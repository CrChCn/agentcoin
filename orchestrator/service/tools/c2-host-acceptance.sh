#!/usr/bin/env bash
# Приёмка C2 на реальном ops-host: только то, что нельзя доказать локально.
#
#   sudo ./service/tools/c2-host-acceptance.sh                  # юниты, внешний отказ,
#                                                              # код, deployer
#   sudo ./service/tools/c2-host-acceptance.sh --stop-and-reboot
#   sudo reboot
#   sudo ./service/tools/c2-host-acceptance.sh --after-reboot  # STOP, очередь, checkpoint
#   sudo ./service/tools/c2-host-acceptance.sh --with-teardown # rollback и uninstall, в конце
#
# Внешний отказ API проверяется с другой машины, потому что на самом хосте
# loopback ничего не доказывает:
#   ./c2-host-acceptance.sh --probe-remote=ops-host:8799 --probe-out=probe.json
#   scp probe.json ops-host:/tmp/probe.json
#   sudo ./service/tools/c2-host-acceptance.sh --external-probe=/tmp/probe.json
#
# Локальные пункты (IDLE, одна задача по registry evidence, symlink containment,
# lifecycle инцидента, подписи STOP/resume, allowlist API, pinned runtime) уже
# доказывает service/tools/c2-acceptance.mjs и здесь не повторяются.
#
# Результат дописывается в evidence/c2-host-acceptance.txt (каждый прогон —
# отдельный блок), рядом — evidence/c2-host-acceptance.json, по строке на прогон.
# PASS ставится только за фактически выполненную проверку, иначе FAIL/SKIP/PENDING.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH="$(cd "$HERE/../.." && pwd)"

CODE_ROOT="${CODE_ROOT:-/opt/agentcoin-orchestrator}"
DATA_ROOT="${OPS_ROOT:-/var/lib/agentcoin-orchestrator}"
LOG_ROOT="${OPS_LOG_DIR:-/var/log/agentcoin-orchestrator}"
ENV_DIR="${ENV_DIR:-/etc/agentcoin}"
API_PORT="${OPS_API_PORT:-8799}"
PHASE="pre"
OUT=""
SERVICE_USER=""
EXTERNAL_PROBE=""
PROBE_TARGET=""
PROBE_OUT=""
WITH_TEARDOWN=0
KEEP_STOPPED=0
RESET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root=*) DATA_ROOT="${1#*=}" ;;
    --code=*) CODE_ROOT="${1#*=}" ;;
    --logs=*) LOG_ROOT="${1#*=}" ;;
    --port=*) API_PORT="${1#*=}" ;;
    --out=*) OUT="${1#*=}" ;;
    --service-user=*) SERVICE_USER="${1#*=}" ;;
    --external-probe=*) EXTERNAL_PROBE="${1#*=}" ;;
    --probe-remote=*) PROBE_TARGET="${1#*=}" ;;
    --probe-out=*) PROBE_OUT="${1#*=}" ;;
    --stop-and-reboot) PHASE="stop" ;;
    --after-reboot) PHASE="post" ;;
    --with-teardown) WITH_TEARDOWN=1 ;;
    --keep-stopped) KEEP_STOPPED=1 ;;
    --reset) RESET=1 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

# --- режим зонда: выполняется на другой машине, root не нужен -----------------
if [[ -n "$PROBE_TARGET" ]]; then
  host="${PROBE_TARGET%:*}"
  port="${PROBE_TARGET##*:}"
  if [[ -z "$host" || -z "$port" || "$host" == "$PROBE_TARGET" ]]; then
    echo "--probe-remote expects host:port, got '$PROBE_TARGET'" >&2
    exit 64
  fi
  PROBE_OUT="${PROBE_OUT:-$PWD/c2-external-probe.json}"
  connected=0
  tool="bash"
  detail="tcp refused or timed out"
  if command -v curl >/dev/null 2>&1; then
    tool="curl"
    if curl -sS --max-time 4 -o /dev/null "http://$host:$port/ops/status" 2>/tmp/c2-probe.err; then
      connected=1
      detail="answered over the network"
    else
      detail="$(head -n1 /tmp/c2-probe.err 2>/dev/null | cut -c1-160)"
      [[ -z "$detail" ]] && detail="curl failed"
    fi
    rm -f /tmp/c2-probe.err
  elif (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
    connected=1
    detail="tcp connected"
  fi
  detail="$(printf '%s' "${detail:-no detail}" | tr '\n' ' ' | tr -d '"')"
  printf '{"at":"%s","target":"%s","tool":"%s","connected":%s,"detail":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$PROBE_TARGET" "$tool" "$([[ "$connected" -eq 1 ]] && echo true || echo false)" "$detail" >"$PROBE_OUT"
  if [[ "$connected" -eq 1 ]]; then
    echo "FAIL: $PROBE_TARGET answered ($detail); the API is reachable from this machine"
  else
    echo "PASS: $PROBE_TARGET refused/timed out ($detail)"
  fi
  echo "probe written: $PROBE_OUT (copy it to the ops-host and use --external-probe)"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "c2-host-acceptance.sh must run as root (unit paths, root-owned code, operator key)" >&2
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
CONTROL="$DATA_ROOT/control"
QUEUE="$DATA_ROOT/queue/queue.json"
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
if [[ "$RESET" -eq 1 ]]; then : >"$OUT"; : >"$JSON_OUT"; fi

UNITS=(agt-orchestrator.service agt-orchestrator-api.service agt-orchestrator-scheduler.timer agt-orchestrator-watchdog.timer)
RESULTS="$(mktemp)"
TMPD="$(mktemp -d)"
cleanup() { rm -f "$RESULTS"; rm -rf "$TMPD"; }
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

record() { # id status detail...
  local id="$1" status="$2" detail
  shift 2
  detail="${*//$'\t'/ }"
  detail="${detail//$'\n'/ }"
  printf '%s\t%s\t%s\n' "$id" "$status" "$detail" >>"$RESULTS"
  printf '  %-7s %-28s %s\n' "$status" "$id" "$detail"
}

json_get() { # file dotted.path
  "$NODE" -e 'const fs=require("node:fs");const [f,p]=process.argv.slice(1);let v=JSON.parse(fs.readFileSync(f,"utf8"));for(const k of String(p||"").split(".").filter(Boolean))v=v==null?undefined:v[k];process.stdout.write(v==null?"":String(v));' "$1" "$2" 2>/dev/null
}

queue_total() {
  "$NODE" -e 'const fs=require("node:fs");const f=process.argv[1];if(!fs.existsSync(f)){process.stdout.write("0");process.exit(0)}const q=JSON.parse(fs.readFileSync(f,"utf8"));process.stdout.write(String((q.items||[]).length));' "$1" 2>/dev/null
}

queue_sha() { if [[ -f "$1" ]]; then sha256sum "$1" | awk '{print $1}'; else echo absent; fi; }

checkpoint_json() {
  "$NODE" -e 'const fs=require("node:fs");const f=process.argv[1];process.stdout.write(fs.existsSync(f)?JSON.stringify(JSON.parse(fs.readFileSync(f,"utf8"))):"null");' "$1" 2>/dev/null
}

as_service() {
  if [[ "$SERVICE_USER" == "$(id -un)" ]]; then
    env OPS_ROOT="$DATA_ROOT" OPS_LOG_DIR="$LOG_ROOT" OPS_CONTROL_DIR="$CONTROL" \
      OPS_OPERATOR_PUB="$DATA_ROOT/state/operator.pub" "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- env OPS_ROOT="$DATA_ROOT" OPS_LOG_DIR="$LOG_ROOT" \
      OPS_CONTROL_DIR="$CONTROL" OPS_OPERATOR_PUB="$DATA_ROOT/state/operator.pub" "$@"
  else
    sudo -n -u "$SERVICE_USER" env OPS_ROOT="$DATA_ROOT" OPS_LOG_DIR="$LOG_ROOT" \
      OPS_CONTROL_DIR="$CONTROL" OPS_OPERATOR_PUB="$DATA_ROOT/state/operator.pub" "$@"
  fi
}

plan_action() { # json file (+ .err)
  local action
  action="$(json_get "$1" action)"
  if [[ -z "$action" && -f "$1.err" ]]; then
    action="plan failed: $(head -n1 "$1.err" | cut -c1-120)"
  fi
  printf '%s' "$action"
}

UNIT_USER="$(systemctl show -p User --value agt-orchestrator.service 2>/dev/null | tr -d '[:space:]')"
SERVICE_USER="${SERVICE_USER:-${UNIT_USER:-agt-orchestrator}}"

# install.sh вызывается с --prefix только если раскладка нестандартная (репетиция),
# чтобы откат не ушёл в /opt на реальном хосте.
INSTALL_ARGS=()
if [[ "$CODE_ROOT" != "/opt/agentcoin-orchestrator" ]]; then
  INSTALL_ARGS+=("--prefix=$(dirname "$(dirname "$CODE_ROOT")")")
fi

checks_units() {
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
}

checks_external() {
  section "2. API refuses connections from another machine"
  if [[ -z "$EXTERNAL_PROBE" ]]; then
    record external-refusal PENDING "run on another machine: $0 --probe-remote=<ops-host>:$API_PORT --probe-out=probe.json; copy it here and rerun with --external-probe=probe.json"
    return
  fi
  if [[ ! -f "$EXTERNAL_PROBE" ]]; then
    record external-refusal FAIL "probe file not found: $EXTERNAL_PROBE"
    return
  fi
  local probe target connected detail
  probe="$("$NODE" -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(`${p.target||""}\t${p.connected===true?"true":"false"}\t${p.detail||""}`)' "$EXTERNAL_PROBE" 2>/dev/null)"
  IFS=$'\t' read -r target connected detail <<<"$probe"
  if [[ -z "${target:-}" ]]; then
    record external-refusal FAIL "probe file is not readable JSON: $EXTERNAL_PROBE"
  elif [[ "$target" != *":$API_PORT" ]]; then
    record external-refusal FAIL "probe target '$target' is not port $API_PORT"
  elif [[ "$connected" == "true" ]]; then
    record external-refusal FAIL "probe from another machine reached $target"
  else
    record external-refusal PASS "probe from another machine could not reach $target (${detail:-no detail})"
  fi
}

checks_code() {
  section "3. code is root-owned and read-only"
  local owner modes writable foreign
  owner="$(stat -c '%U:%G' "$REAL_CODE" 2>/dev/null || echo '?')"
  writable="$(find "$REAL_CODE" -type f -perm -u+w 2>/dev/null | head -n 3 | tr '\n' ' ')"
  foreign="$(find "$REAL_CODE" ! -user root 2>/dev/null | head -n 3 | tr '\n' ' ')"
  if [[ "$REAL_CODE" == "$CODE_ROOT/releases/"* && "$owner" == "root:root" && -z "${writable// /}" && -z "${foreign// /}" ]]; then
    record code-root-owned-read-only PASS "current -> $REAL_CODE ($owner, no writable or foreign files)"
  else
    record code-root-owned-read-only FAIL "current -> $REAL_CODE, owner=$owner, writable='${writable:-none}', not-root='${foreign:-none}'"
  fi
}

checks_deployer() {
  section "4. deployer stays disabled"
  local condition active
  if ! command -v systemctl >/dev/null 2>&1; then
    record deployer-disabled PENDING "systemctl is not available on this host"
    return
  fi
  if ! systemctl cat agt-deployer.service >/dev/null 2>&1; then
    record deployer-disabled FAIL "unit agt-deployer.service is not installed"
    return
  fi
  condition="$(systemctl show -p ConditionResult --value agt-deployer.service 2>/dev/null | tr -d '[:space:]')"
  if [[ -f "$ENV_DIR/deploy-enabled" ]]; then
    record deployer-disabled FAIL "$ENV_DIR/deploy-enabled exists: the deployer is allowed"
  elif [[ "$condition" == "no" ]]; then
    record deployer-disabled PASS "unit condition is not met (deploy-enabled absent)"
  else
    systemctl start agt-deployer.service >/dev/null 2>&1
    active="$(systemctl is-active agt-deployer.service 2>/dev/null)"
    if [[ "$active" != "active" ]]; then
      record deployer-disabled PASS "start skipped, is-active=${active:-unknown}"
    else
      record deployer-disabled FAIL "deployer became active"
    fi
  fi
}

stop_and_reboot() {
  section "5. signed STOP before reboot"
  "$NODE" "$OPERATOR" stop --root "$DATA_ROOT" --reason "c2 host acceptance: reboot test" >"$TMPD/stop.json" 2>"$TMPD/stop.err"
  if [[ $? -ne 0 || ! -f "$CONTROL/STOP" ]]; then
    record stop FAIL "operator stop failed: $(head -n1 "$TMPD/stop.err" 2>/dev/null)"
    record reboot-marker FAIL "not ready for reboot: fix the signed STOP first"
    return
  fi
  record stop PASS "signed STOP: $(tr -d '\n' <"$TMPD/stop.json" | cut -c1-120)"

  "$NODE" - "$REBOOT_STATE" "$QUEUE" "$CHECKPOINT" "$CONTROL/STOP" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [outFile, queueFile, checkpointFile, stopFile] = process.argv.slice(2);
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent');
const queue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : { items: [] };
fs.writeFileSync(outFile, `${JSON.stringify({
  at: new Date().toISOString(),
  queueSha256: sha(queueFile),
  queueItems: (queue.items || []).length,
  checkpoint: fs.existsSync(checkpointFile) ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) : null,
  stopContent: fs.readFileSync(stopFile, 'utf8').trim(),
}, null, 2)}\n`);
NODE
  if [[ -f "$REBOOT_STATE" ]]; then
    record reboot-marker PASS "state saved to $REBOOT_STATE; reboot, then rerun with --after-reboot"
    say ""
    say "  STOP записан. Перезагрузите хост и повторите скрипт с --after-reboot."
  else
    record reboot-marker FAIL "cannot write $REBOOT_STATE"
  fi
}

after_reboot() {
  section "5. STOP, queue and checkpoint survived the reboot"
  if [[ ! -f "$REBOOT_STATE" ]]; then
    record reboot-marker FAIL "missing $REBOOT_STATE (run --stop-and-reboot before rebooting)"
    return
  fi
  local expected_queue expected_items expected_checkpoint expected_stop stop_now
  expected_queue="$(json_get "$REBOOT_STATE" queueSha256)"
  expected_items="$(json_get "$REBOOT_STATE" queueItems)"
  expected_checkpoint="$("$NODE" -e 'const s=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(s.checkpoint ?? null))' "$REBOOT_STATE" 2>/dev/null)"
  expected_stop="$(json_get "$REBOOT_STATE" stopContent)"
  stop_now="$(head -n1 "$CONTROL/STOP" 2>/dev/null || true)"

  if [[ -f "$CONTROL/STOP" && "$stop_now" == "$expected_stop" ]]; then
    record stop-survives-reboot PASS "control/STOP unchanged: ${stop_now:0:80}"
  else
    record stop-survives-reboot FAIL "STOP before reboot '${expected_stop:0:60}', now '${stop_now:0:60}'"
  fi

  if [[ "$(queue_sha "$QUEUE")" == "$expected_queue" && "$(queue_total "$QUEUE")" == "$expected_items" ]]; then
    record queue-survives-reboot PASS "queue sha256 unchanged, $expected_items items"
  else
    record queue-survives-reboot FAIL "queue sha ${expected_queue:0:12} -> $(queue_sha "$QUEUE" | cut -c1-12), items $expected_items -> $(queue_total "$QUEUE")"
  fi

  if [[ "$(checkpoint_json "$CHECKPOINT")" == "$expected_checkpoint" ]]; then
    record checkpoint-survives-reboot PASS "checkpoint unchanged: ${expected_checkpoint:0:100}"
  else
    record checkpoint-survives-reboot FAIL "checkpoint ${expected_checkpoint:0:80} -> $(checkpoint_json "$CHECKPOINT" | cut -c1-80)"
  fi

  as_service "$NODE" "$OPSD" plan --root "$DATA_ROOT" >"$TMPD/plan-after.json" 2>"$TMPD/plan-after.json.err"
  if [[ "$(plan_action "$TMPD/plan-after.json")" == "stopped" ]]; then
    record stopped-after-reboot PASS "planner action=stopped after reboot"
  else
    record stopped-after-reboot FAIL "planner action='$(plan_action "$TMPD/plan-after.json")'"
  fi

  if [[ "$KEEP_STOPPED" -eq 1 ]]; then
    record resume SKIP "--keep-stopped: STOP left in place"
    return
  fi

  "$NODE" "$OPERATOR" resume --root "$DATA_ROOT" >"$TMPD/resume.json" 2>"$TMPD/resume.err"
  if [[ $? -eq 0 && ! -f "$CONTROL/STOP" ]]; then
    record resume PASS "signed resume: $(tr -d '\n' <"$TMPD/resume.json" | cut -c1-120)"
  else
    record resume FAIL "operator resume failed: $(head -n1 "$TMPD/resume.err" 2>/dev/null)"
  fi
}

teardown() {
  section "6. rollback and uninstall keep the data"
  local release_before release_after out code
  release_before="$(readlink -f "$CODE")"
  out="$(bash "$ORCH/service/install.sh" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} --rollback 2>&1)"
  code=$?
  release_after="$(readlink -f "$CODE")"
  if [[ "$code" -eq 0 && "$release_after" != "$release_before" && -d "$release_after/orchestrator" ]]; then
    record rollback PASS "current -> $(basename "$release_after") (was $(basename "$release_before"))"
  else
    record rollback FAIL "exit=$code, $(basename "$release_before") -> $(basename "$release_after"): $(printf '%s' "$out" | head -n1)"
  fi

  local marker="$DATA_ROOT/project-memory/acceptance-marker.txt"
  printf 'data must survive uninstall\n' >"$marker"
  chown "$SERVICE_USER:$SERVICE_USER" "$marker" 2>/dev/null || true
  out="$(bash "$ORCH/service/install.sh" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} --uninstall 2>&1)"
  code=$?
  if [[ "$code" -eq 0 && ! -e "$CODE" && -f "$marker" ]]; then
    record uninstall-keeps-data PASS "code removed, data marker kept"
  else
    record uninstall-keeps-data FAIL "exit=$code, current present=$([[ -e "$CODE" ]] && echo yes || echo no), marker=$([[ -f "$marker" ]] && echo yes || echo no): $(printf '%s' "$out" | head -n1)"
  fi
  say ""
  say "  Сервис снят. Вернуть: sudo ./service/install.sh && sudo ./service/install.sh --enable"
}

main() {
  say ""
  say "== C2 host acceptance | $(date -u +%FT%TZ) | host=$(hostname 2>/dev/null || echo unknown) | phase=$PHASE"
  say "   code=$REAL_CODE data=$DATA_ROOT service user=$SERVICE_USER"

  case "$PHASE" in
    pre)
      checks_units
      checks_external
      checks_code
      checks_deployer
      if [[ "$WITH_TEARDOWN" -eq 1 ]]; then
        teardown
      else
        record rollback SKIP "run --with-teardown at the end of the acceptance"
        record uninstall-keeps-data SKIP "run --with-teardown at the end of the acceptance"
      fi
      record stop-survives-reboot PENDING "run --stop-and-reboot, reboot, then --after-reboot"
      record queue-survives-reboot PENDING "run --stop-and-reboot, reboot, then --after-reboot"
      record checkpoint-survives-reboot PENDING "run --stop-and-reboot, reboot, then --after-reboot"
      ;;
    stop)
      checks_units
      stop_and_reboot
      ;;
    post)
      checks_units
      after_reboot
      ;;
  esac

  local summary
  summary="$(awk -F'\t' '{count[$2]++} END {printf "%d pass, %d fail, %d skip, %d pending", count["PASS"], count["FAIL"], count["SKIP"], count["PENDING"]}' "$RESULTS")"
  say ""
  say "== summary: $summary"

  "$NODE" - "$RESULTS" "$JSON_OUT" "$DATA_ROOT" "$REAL_CODE" "$SERVICE_USER" "$PHASE" "$(hostname 2>/dev/null || echo unknown)" <<'NODE' >>"$JSON_OUT"
const fs = require('node:fs');
const [resFile, outFile, root, code, serviceUser, phase, host] = process.argv.slice(2);
const results = fs.readFileSync(resFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
  const [id, status, ...detail] = line.split('\t');
  return { id, status, detail: detail.join('\t') };
});
process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), host, phase, dataRoot: root, codeRoot: code, serviceUser, results })}\n`);
NODE
  say "evidence: $OUT"
  say "evidence: $JSON_OUT"
}

# main выполняется в текущем shelle: в конвейере он оказался бы в subshell,
# и EXIT-trap удалил бы результаты до подсчёта FAIL.
main >"$TMPD/run.log" 2>&1
STATUS=$?
tee -a "$OUT" <"$TMPD/run.log" >/dev/null
cat "$TMPD/run.log"
if [[ "$STATUS" -eq 0 ]] && grep -q $'\tFAIL\t' "$RESULTS"; then STATUS=1; fi
exit "$STATUS"
