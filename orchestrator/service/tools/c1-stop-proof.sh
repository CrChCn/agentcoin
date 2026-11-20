#!/usr/bin/env bash
# Доказательство C1.1 для STOP, loopback и deployer.
#
#   1. STOP существует → planner не создаёт задачи, scheduler не берёт lease
#      (item остаётся pending), implementer/reviewer не запускаются
#      (logs/ и workspaces/ пусты);
#   2. новый процесс видит тот же STOP (файл на диске, не память);
#   3. resume пишет подписанное событие, подпись проверяется ключом машины;
#   4. после resume планировщик снова выдаёт задание;
#   5. API слушает только 127.0.0.1 и ::1 — проверка через ss -ltnp;
#   6. deployer остаётся выключенным: юнит с ConditionPathExists, скрипт
#      отказывает кодом 3.

set -uo pipefail

ORCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${1:-/tmp/c1-stop-proof}"
MISSION="$ROOT/queue/mission.json"
NODE="${NODE:-node}"

echo "== workspace"
rm -rf "$ROOT"
mkdir -p "$ROOT/queue/backlog" "$ROOT/state" "$ROOT/logs"

"$NODE" -e '
const fs = require("node:fs");
const [orch, out, backlog] = process.argv.slice(1);
const mission = JSON.parse(fs.readFileSync(orch + "/service/mission.json", "utf8"));
fs.writeFileSync(out, JSON.stringify(mission, null, 2) + "\n");
const base = JSON.parse(fs.readFileSync(orch + "/fixtures/tasks/lesson-01.json", "utf8"));
const task = { ...base, taskId: "stop-01", title: base.title + " — stop proof" };
fs.writeFileSync(backlog + "/stop-01.json", JSON.stringify(task, null, 2) + "\n");
' "$ORCH" "$MISSION" "$ROOT/queue/backlog"

echo "== STOP"
"$NODE" "$ORCH/service/opsd.mjs" stop --root "$ROOT" --reason "c1.1 stop proof"

echo "== planner with STOP"
"$NODE" "$ORCH/service/opsd.mjs" plan --root "$ROOT" --mission "$MISSION"
echo "== scheduler tick with STOP"
"$NODE" "$ORCH/service/opsd.mjs" tick --root "$ROOT" --mission "$MISSION"
echo "== loop --once with STOP"
"$NODE" "$ORCH/service/opsd.mjs" loop --root "$ROOT" --mission "$MISSION" --once

echo "== side effects (must be empty)"
"$NODE" -e '
const fs = require("node:fs");
const [root] = process.argv.slice(1);
for (const dir of ["logs", "workspaces"]) {
  const path = root + "/" + dir;
  const entries = fs.existsSync(path) ? fs.readdirSync(path).filter((n) => n !== ".gitkeep") : [];
  console.log(`  ${dir}/: ${entries.length ? entries.join(", ") : "empty"}`);
}
const queue = JSON.parse(fs.readFileSync(root + "/queue/queue.json", "utf8"));
console.log("  queue:", queue.items.length ? queue.items.map((i) => `${i.taskId}:${i.status}`).join(", ") : "empty (planner stayed idle)");
console.log("  backlog untouched:", fs.readdirSync(root + "/queue/backlog").join(", ") || "none");
' "$ROOT"

echo "== restart sees the same STOP"
ORCH="$ORCH" ROOT="$ROOT" "$NODE" --input-type=module -e '
const { OpsStore } = await import("file://" + process.env.ORCH + "/service/store.mjs");
const store = new OpsStore(process.env.ROOT);
console.log("  stopRequested in a new process:", store.stopRequested());
console.log("  stop file:", store.paths.stopFile);
'

echo "== deployer stays disabled"
OPS_ROOT="$ROOT" "$NODE" "$ORCH/service/deployer.mjs" > "$ROOT/logs/deployer.json" 2>&1
DEP=$?
head -12 "$ROOT/logs/deployer.json"
echo "  deployer exit code: $DEP"
grep -q "ConditionPathExists=/etc/agentcoin/deploy-enabled" "$ORCH/service/systemd/agt-deployer.service" \
  && echo "  unit guard present: ConditionPathExists" || echo "  unit guard MISSING"

echo "== resume (signed event)"
RESUME_OUT="$("$NODE" "$ORCH/service/opsd.mjs" resume --root "$ROOT")"
echo "$RESUME_OUT"
ORCH="$ORCH" ROOT="$ROOT" "$NODE" --input-type=module -e '
const { OpsStore } = await import("file://" + process.env.ORCH + "/service/store.mjs");
const fs = await import("node:fs");
const store = new OpsStore(process.env.ROOT);
const events = fs.readFileSync(store.paths.queueJournal, "utf8").trim().split("\n").map(JSON.parse);
const resume = events.filter((e) => e.event === "service.resume_signed").at(-1);
const stop = events.filter((e) => e.event === "service.stop_signed").at(-1);
console.log("  stop event signed:", Boolean(stop && store.verifySignature(stop)), "keyId:", stop && stop.keyId);
console.log("  resume event signed:", Boolean(resume && store.verifySignature(resume)), "keyId:", resume && resume.keyId);
const tampered = { ...resume, detail: { by: "intruder" } };
console.log("  tampered resume verifies:", store.verifySignature(tampered));
'

echo "== planner after resume"
"$NODE" "$ORCH/service/opsd.mjs" plan --root "$ROOT" --mission "$MISSION"

echo "== api listens on loopback only"
"$NODE" "$ORCH/service/opsd.mjs" api --root "$ROOT" --port 8797 >"$ROOT/logs/api.log" 2>&1 &
APIPID=$!
for _ in $(seq 1 50); do curl -sf -o /dev/null http://127.0.0.1:8797/ops/health && break; sleep 0.2; done
if command -v ss >/dev/null 2>&1; then
  ss -ltnp 2>/dev/null | grep 8797 || echo "  ss found no listener (unexpected)"
else
  echo "  ss not available in this environment"
fi
curl -s -o /dev/null -w "  GET /ops/status -> %{http_code}\n" http://127.0.0.1:8797/ops/status
curl -s -o /dev/null -w "  POST /ops/status -> %{http_code} (read-only)\n" -X POST http://127.0.0.1:8797/ops/status
curl -s http://127.0.0.1:8797/ops/status | head -c 300; echo
kill -TERM "$APIPID" 2>/dev/null; wait "$APIPID" 2>/dev/null

echo "== done"
