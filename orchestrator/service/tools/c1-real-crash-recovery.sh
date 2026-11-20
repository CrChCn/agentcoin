#!/usr/bin/env bash
# C1.1 п.2: crash-recovery на НАСТОЯЩИХ агентах (Codex + bwrap), не на дублёрах.
#
# Сценарий:
#   1. preflight обязан быть READY (codex установлен, авторизован, изоляция
#      доказана: adapterEndToEnd=true, blockers=[]);
#   2. задача идёт реальными адаптерами; процесс убивается SIGKILL в середине
#      implementer-шага;
#   3. проверяется гигиена после падения: нет осиротевших codex/node/bwrap,
#      broker-сокет удалён, временный CODEX_HOME удалён;
#   4. второй процесс продолжает задание с журнала: ровно один коммит, тот же
#      артефакт, reviewer не принимает чужой artifact.
#
# Если preflight не READY — скрипт печатает BLOCKED с точной причиной и выходит
# с кодом 3: подделывать доказательство дублёром запрещено.

set -uo pipefail

ORCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${1:-/tmp/c1-real-crash}"
NODE="${NODE:-node}"
MISSION="$ROOT/queue/mission.json"

echo "== preflight (real adapters)"
"$NODE" "$ORCH/orchestrator.mjs" preflight --task "$ORCH/fixtures/tasks/lesson-01.json" --root "$ROOT/engine" > "$ROOT-preflight.json" 2>&1
PF=$?
"$NODE" -e '
const fs = require("node:fs");
const file = process.argv[1];
try {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log("  status:", j.status, "| blockers:", (j.blockers || []).map((b) => b.code).join(",") || "none");
  console.log("  levels:", JSON.stringify(j.isolation && j.isolation.levels));
  console.log("  nextCommand:", j.nextCommand);
  process.exit(j.ready ? 0 : 3);
} catch (err) {
  console.log("  preflight output is not JSON:", String(err.message || err));
  process.exit(3);
}
' "$ROOT-preflight.json"
READY=$?

if [[ "$READY" -ne 0 || "$PF" -ne 0 ]]; then
  cat <<'EOF'
BLOCKED: real crash-recovery cannot run on this host.
  Reason: preflight is not READY (see status/blockers above).
  Required on the target machine: codex installed, `codex login`, then
  `node tools/agent-hostile-check.mjs --real` producing adapterEndToEnd=true.
  A fixture double is NOT accepted as proof for this item.
EOF
  exit 3
fi

echo "== workspace"
rm -rf "$ROOT"
mkdir -p "$ROOT/queue/backlog" "$ROOT/state" "$ROOT/logs"

"$NODE" -e '
const fs = require("node:fs");
const [orch, out, backlog] = process.argv.slice(1);
const mission = JSON.parse(fs.readFileSync(orch + "/service/mission.json", "utf8"));
mission.adapters.mode = "real";
mission.allowRealAgents = true;
mission.loop.intervalSec = 5;
mission.loop.maxStepsPerTick = 4;
fs.writeFileSync(out, JSON.stringify(mission, null, 2) + "\n");
const base = JSON.parse(fs.readFileSync(orch + "/fixtures/tasks/lesson-01.json", "utf8"));
const task = { ...base, taskId: "real-01", title: base.title + " — real recovery" };
fs.writeFileSync(backlog + "/real-01.json", JSON.stringify(task, null, 2) + "\n");
' "$ORCH" "$MISSION" "$ROOT/queue/backlog"

snapshot_processes() {
  pgrep -a -f 'codex|bwrap' 2>/dev/null | grep -v pgrep || true
}

echo "== before"
snapshot_processes

echo "== process 1 (real agents), kill during implementer"
"$NODE" "$ORCH/service/opsd.mjs" loop --root "$ROOT" --mission "$MISSION" >> "$ROOT/logs/service.log" 2>&1 &
PID1=$!
for _ in $(seq 1 1200); do
  STATE=$("$NODE" -e 'try{process.stdout.write(require(process.argv[1]).state||"none")}catch(e){process.stdout.write("none")}' "$ROOT/state/checkpoint.json")
  if [[ "$STATE" == "IMPLEMENTING" || "$STATE" == "REVIEWING" ]]; then break; fi
  sleep 0.2
done
echo "  pid1=$PID1 state=$STATE"
kill -9 "$PID1" 2>/dev/null
wait "$PID1" 2>/dev/null
echo "  killed: exit=$?"

echo "== hygiene after crash"
sleep 2
echo "  surviving agent processes:"; snapshot_processes | sed 's/^/    /'
echo "  leftover codex homes:"; ls -d /tmp/agentcoin-codex-* 2>/dev/null | sed 's/^/    /' || echo "    none"
echo "  leftover broker sockets:"; find /tmp -maxdepth 2 -name '*.sock' -newermt '-30 minutes' 2>/dev/null | sed 's/^/    /' || echo "    none"

echo "== process 2 (resume on the same journal)"
"$NODE" "$ORCH/service/opsd.mjs" loop --root "$ROOT" --mission "$MISSION" >> "$ROOT/logs/service.log" 2>&1 &
PID2=$!
for _ in $(seq 1 1800); do
  DONE=$("$NODE" -e 'const fs=require("node:fs");try{const q=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(q.items.filter(i=>i.status==="done").length))}catch(e){process.stdout.write("0")}' "$ROOT/queue/queue.json")
  if [[ "$DONE" -ge 1 ]]; then break; fi
  sleep 0.5
done
echo "  pid2=$PID2 done=$DONE"
kill -TERM "$PID2" 2>/dev/null
wait "$PID2" 2>/dev/null

echo "== commits and artifacts"
"$NODE" -e '
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const [root] = process.argv.slice(1);
const queue = JSON.parse(fs.readFileSync(root + "/queue/queue.json", "utf8"));
for (const item of queue.items) {
  const dir = `${root}/workspaces/${item.taskId}/implementer`;
  let commits = [];
  try { commits = execSync(`git -C "${dir}" log --format=%H`, { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch {}
  const events = fs.existsSync(`${root}/logs/${item.taskId}/events.jsonl`)
    ? fs.readFileSync(`${root}/logs/${item.taskId}/events.jsonl`, "utf8").trim().split("\n").map(JSON.parse) : [];
  console.log(`  ${item.taskId}: status=${item.status} state=${(item.result||{}).state} commits_in_workspace=${commits.length} created_events=${events.filter(e=>e.to==="CREATED").length}`);
  console.log(`    accepted artifact: ${((item.result||{}).artifactSha||"").slice(0,16)} review artifact: ${(events.at(-1)?.payload?.patch?.acceptedArtifactSha256||"").slice(0,16)}`);
}
' "$ROOT"

echo "== real crash-recovery done"
