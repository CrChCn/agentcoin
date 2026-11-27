#!/usr/bin/env bash
# Сборка пакета ноды: граф зависимостей node.mjs + tar.gz для чужого хоста.
#   bash packaging/node/build.sh
set -euo pipefail

VERSION="${VERSION:-0.1.0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DIST="$ROOT/dist/node"

[ -f "$ROOT/node.mjs" ] || { echo "node.mjs not found in $ROOT" >&2; exit 1; }

# src/ собирается по реальному графу: node.mjs + 30 модулей (core, ws, sync, ...).
node "$HERE/collect.mjs"
CLOSURE_FILES="$(grep -c . "$HERE/src/SHA256SUMS")"
NODE_SHA="$(awk '$2=="node.mjs" {print $1}' "$HERE/src/SHA256SUMS")"
head -c 40 "$HERE/src/node.mjs" | od -c | head -2 | sed 's/^/  shebang: /'
[ -n "$NODE_SHA" ] || { echo "node.mjs missing from SHA256SUMS" >&2; exit 1; }

mkdir -p "$DIST"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/agentcoin-node"
cp -a "$HERE/install.sh" "$HERE/node-env.example" "$HERE/systemd" "$HERE/src" "$HERE/README.md" "$STAGE/agentcoin-node/"

# Windows-дерево даёт CRLF: shebang node.mjs и значения env ломаются на хосте.
find "$STAGE/agentcoin-node" -type f \( -name '*.mjs' -o -name '*.sh' -o -name '*.md' \
  -o -name '*.service' -o -name '*.example' -o -name '*.txt' -o -name 'SHA256SUMS' \) \
  -exec sed -i 's/\r$//' {} +
chmod 0755 "$STAGE/agentcoin-node/install.sh"
# Ловим именно CR в конце строки (CRLF). Одиночный CR внутри строки кода —
# не перевод строки и на хосте безвреден.
if grep -rl $'\r$' "$STAGE/agentcoin-node" >/dev/null 2>&1; then
  echo "refusing: CRLF line endings still present in package:" >&2
  grep -rl $'\r$' "$STAGE/agentcoin-node" >&2
  exit 1
fi

TARBALL="$DIST/agentcoin-node-$VERSION.tar.gz"
tar czf "$TARBALL" -C "$STAGE" agentcoin-node
( cd "$DIST" && sha256sum "agentcoin-node-$VERSION.tar.gz" > "agentcoin-node-$VERSION.sha256" )

cat > "$DIST/RELEASE.json" <<JSON
{
  "schema": "agentcoin/release@1",
  "layer": "node",
  "package": "agentcoin-node",
  "version": "$VERSION",
  "file": "agentcoin-node-$VERSION.tar.gz",
  "bytes": $(stat -c '%s' "$TARBALL"),
  "sha256": "$(sha256sum "$TARBALL" | awk '{print $1}')",
  "nodeMjsSha256": "$NODE_SHA",
  "nodeMjsBytes": $(stat -c '%s' "$HERE/src/node.mjs"),
  "codeFiles": $CLOSURE_FILES,
  "runtime": "Node 20+ (проверено на v24.22.2)",
  "optionalVendor": "/opt/agentcoin-node/vendor/node_modules/snarkjs (PoUW ZK; без него 503)",
  "contents": ["install.sh", "node-env.example", "systemd/agentcoin-node.service", "src/** (весь граф импортов)", "README.md"]
}
JSON

echo "closure: $CLOSURE_FILES files ($(du -sh "$HERE/src" | cut -f1))"
echo "tarball: $TARBALL ($(stat -c '%s' "$TARBALL") b)"
echo "node.mjs sha256: $NODE_SHA"
sha256sum "$TARBALL"
