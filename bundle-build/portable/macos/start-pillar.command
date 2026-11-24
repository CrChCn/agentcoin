#!/bin/bash
# Pillar Agentcoin: node + built-in mining. Who holds a node, mines.
#   ./start-pillar.command                                    - copy behind NAT (default port), mines to own wallet
#   ./start-pillar.command 9340 --public http://YOUR-IP:9340  - real pillar (needs port forward + white IP)
set -uo pipefail
cd "$(dirname "$0")" || exit 1

PORT="${1:-@PORT@}"
if [ -n "${1:-}" ]; then shift; fi
SEED="@SEED@"

[ -x ./node ] || { echo "[FAIL] ./node is missing next to start-pillar.command"; exit 66; }
[ -f pillar/pillar.mjs ] || { echo "[FAIL] pillar/pillar.mjs is missing - the bundle is incomplete"; exit 66; }
[ -f app/node.mjs ] || { echo "[FAIL] app/node.mjs is missing - the bundle is incomplete"; exit 66; }

echo "== PILLAR: node + mining | port $PORT | seed $SEED"
echo "== data: $PWD/data-pillar | stop: Ctrl+C"
echo
exec ./node pillar/pillar.mjs --port "$PORT" --bind 127.0.0.1 "$@"
