#!/usr/bin/env bash
# Pillar Agentcoin: нода + встроенный майнинг. Как у Bitcoin: держишь ноду — майнишь.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
command -v node >/dev/null || { echo "[FAIL] нужен Node 20+ в PATH"; exit 66; }
mkdir -p data-pillar
echo "== PILLAR: нода + майнинг | данные: $PWD/data-pillar"
echo "== Остановка: Ctrl+C"
echo
exec node packaging/pillar/pillar.mjs "$@"
