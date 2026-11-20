#!/usr/bin/env bash
# Доказательство C1: сервис переживает потерю процесса (SIGKILL) и продолжает
# очередь с последнего подтверждённого состояния журнала.
#
#   1. чистый OPS_ROOT, mission с детерминированными дублёрами агентов;
#   2. первый процесс доходит до нетерминального состояния и убивается -9
#      (имитация выключения машины, без SIGTERM и без уборки lock);
#   3. второй процесс видит мёртвую аренду и мёртвый lock, снимает lock по
#      журналу, продолжает то же задание до ACCEPTED, затем planner ставит
#      следующее задание — очередь не дублируется;
#   4. третий шаг — штатная остановка SIGTERM (код 0).
#
# Настоящие агенты не запускаются: adapters.mode=fixture.

set -uo pipefail

ORCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${1:-/tmp/c1-proof}"
MISSION="$ROOT/queue/mission.json"
LOG="$ROOT/logs/service.log"
NODE="${NODE:-node}"

echo "== workspace"
rm -rf "$ROOT"
mkdir -p "$ROOT/queue/backlog" "$ROOT/state" "$ROOT/logs"

# Два задания владельца в backlog: planner больше не клонирует шаблон сам,
# поэтому доказательство строится на настоящих очередных заданиях.
"$NODE" -e '
const fs = require("node:fs");
const [orch, out, backlog] = process.argv.slice(1);
const mission = JSON.parse(fs.readFileSync(orch + "/service/mission.json", "utf8"));
mission.loop.intervalSec = 5;
mission.loop.maxStepsPerTick = 3;
mission.loop.maxTaskMinutes = 20;
fs.writeFileSync(out, JSON.stringify(mission, null, 2) + "\n");
const base = JSON.parse(fs.readFileSync(orch + "/fixtures/tasks/lesson-01.json", "utf8"));
for (const id of ["proof-a", "proof-b"]) {
  const task = { ...base, taskId: id, title: base.title + " — " + id };
  fs.writeFileSync(backlog + "/" + id + ".json", JSON.stringify(task, null, 2) + "\n");
}
' "$ORCH" "$MISSION" "$ROOT/queue/backlog"

state_of() {
  "$NODE" -e 'try{const c=require(process.argv[1]);process.stdout.write(c.state||"none")}catch(e){process.stdout.write("none")}' "$ROOT/state/checkpoint.json"
}

# --- процесс 1: до первого не-idle чекпойнта, затем SIGKILL ---------------
echo "== process 1"
"$NODE" "$ORCH/service/opsd.mjs" loop --root "$ROOT" --mission "$MISSION" >>"$LOG" 2>&1 &
PID1=$!
for _ in $(seq 1 600); do
  STATE="$(state_of)"
  if [[ "$STATE" != "none" && "$STATE" != "idle" ]]; then break; fi
  sleep 0.2
done
echo "  pid1=$PID1 reached state=$(state_of)"
kill -9 "$PID1" 2>/dev/null
wait "$PID1" 2>/dev/null
echo "  killed with SIGKILL; exit=$?"

echo "== after crash"
"$NODE" -e '
const fs = require("node:fs");
const [root] = process.argv.slice(1);
const queue = JSON.parse(fs.readFileSync(root + "/queue/queue.json", "utf8"));
console.log("  queue:", queue.items.map((i) => `${i.taskId}:${i.status}:attempts=${i.attempts}`).join(", "));
const locks = fs.readdirSync(root + "/locks").filter((n) => !n.startsWith("."));
console.log("  leftover locks:", locks.join(", ") || "none");
for (const id of locks) {
  const lock = JSON.parse(fs.readFileSync(`${root}/locks/${id}/lock.json`, "utf8"));
  console.log(`  lock ${id} owned by pid ${lock.pid}`);
}
' "$ROOT"

# --- процесс 2: восстановление и продолжение очереди ----------------------
echo "== process 2"
"$NODE" "$ORCH/service/opsd.mjs" loop --root "$ROOT" --mission "$MISSION" >>"$LOG" 2>&1 &
PID2=$!
DONE=0
for _ in $(seq 1 900); do
  DONE="$("$NODE" -e 'const fs=require("node:fs");try{const q=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(q.items.filter(i=>i.status==="done").length))}catch(e){process.stdout.write("0")}' "$ROOT/queue/queue.json")"
  if [[ "$DONE" -ge 2 ]]; then break; fi
  sleep 0.3
done
echo "  pid2=$PID2 done_items=$DONE"
kill -TERM "$PID2" 2>/dev/null
wait "$PID2"; echo "  graceful exit=$?"

# --- отчёт ----------------------------------------------------------------
echo "== state"
"$NODE" "$ORCH/service/opsd.mjs" status --root "$ROOT"
echo "== watchdog"
"$NODE" "$ORCH/service/opsd.mjs" watchdog --root "$ROOT" || true
echo "== queue journal"
tail -n 12 "$ROOT/queue/journal.jsonl"
echo "== task journal shape"
"$NODE" -e '
const fs = require("node:fs");
const [root] = process.argv.slice(1);
const queue = JSON.parse(fs.readFileSync(root + "/queue/queue.json", "utf8"));
for (const item of queue.items) {
  const file = `${root}/logs/${item.taskId}/events.jsonl`;
  if (!fs.existsSync(file)) { console.log(`  ${item.taskId}: no journal`); continue; }
  const events = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  const created = events.filter((e) => e.to === "CREATED").length;
  console.log(`  ${item.taskId}: events=${events.length} created=${created} states=${events.map((e) => e.to).join("->")}`);
  console.log(`    result commit=${(item.result && item.result.commit) || "-"} artifact=${((item.result && item.result.artifactSha) || "").slice(0, 16)}`);
}
' "$ROOT"
echo "== memory facts"
"$NODE" -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(m.facts,null,2));console.log("lessons:", (m.lessons||[]).length)' "$ROOT/project-memory/memory.json"
echo "== service log tail"
tail -n 6 "$LOG"

echo "== ops api (read-only)"
"$NODE" "$ORCH/service/opsd.mjs" api --root "$ROOT" --port 8798 >"$ROOT/logs/api.log" 2>&1 &
APIPID=$!
for _ in $(seq 1 50); do curl -sf -o /dev/null http://127.0.0.1:8798/ops/health && break; sleep 0.2; done
curl -s http://127.0.0.1:8798/ops/status | head -c 400; echo
curl -s -o /dev/null -w "GET /ops/queue -> %{http_code}\n" http://127.0.0.1:8798/ops/queue
curl -s -o /dev/null -w "POST /ops/queue -> %{http_code} (read-only)\n" -X POST http://127.0.0.1:8798/ops/queue
kill -TERM "$APIPID" 2>/dev/null; wait "$APIPID" 2>/dev/null

echo "== done"
