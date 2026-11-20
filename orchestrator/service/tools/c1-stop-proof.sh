#!/usr/bin/env bash
# Доказательство STOP/loopback/deployer для C1.1 + C2-модель владения:
#   STOP ставит оператор (приватный ключ Ed25519), сервис только читает его;
#   сервис не может снять STOP; resume — только операторская команда;
#   подпись проверяется публичным ключом, подделка и чужой ключ не проходят.
#
# Локальная репетиция без root: OPS_OPERATOR_ALLOW_UNPRIVILEGED=1. На ops-host
# эта переменная не выставляется, и команды требуют root.

set -uo pipefail

ORCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${1:-/tmp/c1-stop-proof}"
NODE="${NODE:-node}"

export OPS_ROOT="$ROOT"
export OPS_CONTROL_DIR="$ROOT/control"
export OPS_OPERATOR_KEY="$ROOT/operator.key"
export OPS_OPERATOR_PUB="$ROOT/state/operator.pub"
export OPS_OPERATOR_ALLOW_UNPRIVILEGED=1
MISSION="$ROOT/queue/mission.json"

echo "== workspace"
rm -rf "$ROOT"
mkdir -p "$ROOT/queue/backlog" "$ROOT/state" "$ROOT/logs" "$ROOT/control"

"$NODE" -e '
const fs = require("node:fs");
const [orch, out, backlog] = process.argv.slice(1);
const mission = JSON.parse(fs.readFileSync(orch + "/service/mission.json", "utf8"));
fs.writeFileSync(out, JSON.stringify(mission, null, 2) + "\n");
const base = JSON.parse(fs.readFileSync(orch + "/fixtures/tasks/lesson-01.json", "utf8"));
const task = { ...base, taskId: "stop-01", title: base.title + " — stop proof" };
fs.writeFileSync(backlog + "/stop-01.json", JSON.stringify(task, null, 2) + "\n");
' "$ORCH" "$MISSION" "$ROOT/queue/backlog"

echo "== operator key"
"$NODE" "$ORCH/service/operator.mjs" init-key --root "$ROOT"

echo "== STOP (operator, signed)"
"$NODE" "$ORCH/service/operator.mjs" stop --root "$ROOT" --reason "c1.1 stop proof"

echo "== planner with STOP"
"$NODE" "$ORCH/service/opsd.mjs" plan --root "$ROOT" --mission "$MISSION"
echo "== scheduler tick with STOP"
"$NODE" "$ORCH/service/opsd.mjs" tick --root "$ROOT" --mission "$MISSION"
echo "== loop --once with STOP"
"$NODE" "$ORCH/service/opsd.mjs" loop --root "$ROOT" --mission "$MISSION" --once

echo "== side effects (must be empty)"
"$NODE" --input-type=module -e '
const fs = await import("node:fs");
const root = process.env.OPS_ROOT;
for (const dir of ["logs", "workspaces"]) {
  const path = root + "/" + dir;
  const entries = fs.existsSync(path) ? fs.readdirSync(path).filter((n) => n !== ".gitkeep") : [];
  console.log(`  ${dir}/: ${entries.length ? entries.join(", ") : "empty"}`);
}
const queue = JSON.parse(fs.readFileSync(root + "/queue/queue.json", "utf8"));
console.log("  queue:", queue.items.length ? queue.items.map((i) => `${i.taskId}:${i.status}`).join(", ") : "empty (planner stayed idle)");
console.log("  backlog untouched:", fs.readdirSync(root + "/queue/backlog").join(", ") || "none");
'

echo "== restart sees the same STOP"
"$NODE" --input-type=module -e '
const { OpsStore } = await import("file://" + process.cwd() + "/service/store.mjs");
const store = new OpsStore(process.env.OPS_ROOT);
console.log("  stopRequested in a new process:", store.stopRequested());
console.log("  stop file:", store.paths.stopFile);
console.log("  control dir:", store.paths.controlDir);
'

echo "== the service cannot resume"
"$NODE" "$ORCH/service/opsd.mjs" resume --root "$ROOT"; echo "  opsd resume exit=$?"

echo "== deployer stays disabled"
"$NODE" "$ORCH/service/deployer.mjs" > "$ROOT/logs/deployer.json" 2>&1
DEP=$?
head -8 "$ROOT/logs/deployer.json"
echo "  deployer exit code: $DEP"
grep -q "ConditionPathExists=/etc/agentcoin/deploy-enabled" "$ORCH/service/systemd/agt-deployer.service" \
  && echo "  unit guard present: ConditionPathExists" || echo "  unit guard MISSING"

echo "== resume (operator, signed)"
"$NODE" "$ORCH/service/operator.mjs" resume --root "$ROOT"
"$NODE" "$ORCH/service/operator.mjs" verify --root "$ROOT"

echo "== tampering and a foreign key are rejected"
"$NODE" --input-type=module -e '
const fs = await import("node:fs");
const path = await import("node:path");
const { OpsStore } = await import("file://" + process.cwd() + "/service/store.mjs");
const { initOperatorKey, loadOperatorPrivateKey, signEntry } = await import("file://" + process.cwd() + "/lib/opsauth.mjs");
const store = new OpsStore(process.env.OPS_ROOT);
const events = fs.readFileSync(store.paths.queueJournal, "utf8").trim().split("\n").map(JSON.parse);
const resume = events.filter((e) => e.event === "service.resume_signed").at(-1);
const stop = events.filter((e) => e.event === "service.stop_signed").at(-1);
console.log("  stop signed:", store.verifySignature(stop), "alg:", stop.alg, "keyId:", stop.keyId);
console.log("  resume signed:", store.verifySignature(resume), "alg:", resume.alg);
const tampered = { ...resume, detail: { by: "intruder" } };
console.log("  tampered resume verifies:", store.verifySignature(tampered));
const foreignKey = path.join(process.env.OPS_ROOT, "foreign.key");
initOperatorKey({ privateKeyPath: foreignKey, publicKeyPath: path.join(process.env.OPS_ROOT, "foreign.pub") });
const foreign = signEntry(store.nextEntry("service.resume_signed"), loadOperatorPrivateKey(foreignKey));
console.log("  foreign key verifies:", store.verifySignature(foreign));
'

echo "== planner after resume"
"$NODE" "$ORCH/service/opsd.mjs" plan --root "$ROOT" --mission "$MISSION"

echo "== api listens on loopback only"
"$NODE" "$ORCH/service/opsd.mjs" api --root "$ROOT" --port 8797 >"$ROOT/logs/api.log" 2>&1 &
APIPID=$!
for _ in $(seq 1 50); do curl -sf -o /dev/null http://127.0.0.1:8797/ops/health && break; sleep 0.2; done
if command -v ss >/dev/null 2>&1; then
  ss -ltn 2>/dev/null | grep 8797 || echo "  ss found no listener (unexpected)"
else
  echo "  ss not available in this environment"
fi
curl -s -o /dev/null -w "  GET /ops/status -> %{http_code}\n" http://127.0.0.1:8797/ops/status
curl -s -o /dev/null -w "  POST /ops/status -> %{http_code} (read-only)\n" -X POST http://127.0.0.1:8797/ops/status
kill -TERM "$APIPID" 2>/dev/null; wait "$APIPID" 2>/dev/null

echo "== done"
