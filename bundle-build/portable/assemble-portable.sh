#!/usr/bin/env bash
# Portable-сборка ноды для Windows и macOS: папка, которая запускается двойным кликом.
# Без установки, без root, без systemd: node + app/ + снимок + data/ рядом.
#
#   bash bundle-build/portable/assemble-portable.sh
#
# Входы: официальные архивы Node в bundle-build/portable/cache (сверяются по SHASUMS256.txt),
# пакет ноды packaging/node/src (31 файл, собран collect.mjs), снимок bundle-build/payload/chain.json.
set -euo pipefail

VERSION="${VERSION:-0.1.0}"
NODE_VERSION="${NODE_VERSION:-24.22.2}"
SEED="${SEED:-https://agentcoin.work}"
PORT="${PORT:-9333}"
# Окружение сборки может нести PORT=0 (так делают dev-серверы), а нода трактует 0
# как "порт по умолчанию". В бандл попадает только настоящий порт 1..65535.
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then PORT=9333; fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="$HERE/cache"
SRC="$ROOT/packaging/node/src"
SNAP="${SNAP:-$CACHE/chain.json}"
OUT="$ROOT/dist/portable"

WIN_ZIP="node-v$NODE_VERSION-win-x64.zip"
MAC_TGZ="node-v$NODE_VERSION-darwin-arm64.tar.gz"

say() { printf '%s\n' "$*"; }
die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

[ -f "$SRC/node.mjs" ] || die "нет $SRC/node.mjs (сначала bash packaging/node/build.sh)"
[ -f "$SRC/SHA256SUMS" ] || die "нет $SRC/SHA256SUMS"
[ -f "$SNAP" ] || die "нет снимка $SNAP"
[ -f "$CACHE/SHASUMS256.txt" ] || die "нет $CACHE/SHASUMS256.txt"

# --- официальные рантаймы: сверка по опубликованному SHASUMS256.txt ----------
for f in "$WIN_ZIP" "$MAC_TGZ"; do
  [ -f "$CACHE/$f" ] || die "нет $CACHE/$f"
  want="$(awk -v n="$f" '$2==n {print $1}' "$CACHE/SHASUMS256.txt")"
  [ -n "$want" ] || die "$f отсутствует в официальном SHASUMS256.txt"
  got="$(sha256sum "$CACHE/$f" | awk '{print $1}')"
  [ "$got" = "$want" ] || die "$f: sha256 не совпал с nodejs.org ($got != $want)"
  say "  $f  sha256 ok ($(printf '%.16s' "$got")…)"
done

PILLAR_FILES="$(ls "$ROOT/packaging/pillar" | wc -l)"
[ "$PILLAR_FILES" -ge 3 ] || die "pillar неполон: нет файлов в packaging/pillar"
[ -f "$HERE/win/start-pillar.cmd" ] || die "нет win/start-pillar.cmd"
[ -f "$HERE/macos/start-pillar.command" ] || die "нет macos/start-pillar.command"
say "  pillar: $PILLAR_FILES файлов пойдут в архив"

SNAP_SHA="$(sha256sum "$SNAP" | awk '{print $1}')"
SNAP_H="$(node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const a=d.chain||d;process.stdout.write(`${a.length} ${a[a.length-1].hash}`)' "$SNAP")"
say "  снимок: $(printf '%s' "$SNAP_H" | cut -d' ' -f1) бл., tip $(printf '%.16s' "$(printf '%s' "$SNAP_H" | cut -d' ' -f2)")…"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

unzip_into() { # zip -> dir (unzip, иначе bsdtar из Windows)
  if command -v unzip >/dev/null 2>&1; then unzip -q -o "$1" -d "$2"
  else /c/Windows/System32/tar.exe -xf "$1" -C "$2"; fi
}

stage_common() { # $1=stage dir
  local stage="$1"
  mkdir -p "$stage/app" "$stage/data"
  cp "$SRC"/*.mjs "$SRC/SHA256SUMS" "$SRC/PROVENANCE.txt" "$stage/app/"
  cp "$SNAP" "$stage/chain.json"
  : > "$stage/data/.keep"
}

write_sums() { # LF, относительные имена, проверяется штатным sha256sum -c
  local stage="$1"
  ( cd "$stage" && find . -type f ! -name SHA256SUMS ! -name RELEASE.json -printf '%P\n' \
      | sort | while read -r f; do printf '%s  %s\n' "$(sha256sum "$f" | awk '{print $1}')" "$f"; done ) > "$stage/SHA256SUMS"
}

stage_pillar() { # $1=stage dir: столп внутрь архива (нода + встроенный майнинг)
  local stage="$1"
  mkdir -p "$stage/pillar"
  cp "$ROOT/packaging/pillar/pillar.mjs" "$ROOT/packaging/pillar/pillar-config.sample" \
     "$ROOT/packaging/pillar/README.md" "$stage/pillar/"
  [ -f "$stage/pillar/pillar.mjs" ] || die "pillar.mjs не скопировался в $stage"
}

# --- Windows ----------------------------------------------------------------
WIN="agentcoin-portable-$VERSION-win-x64"
STAGE="$OUT/$WIN"
rm -rf "$STAGE"
stage_common "$STAGE"
unzip_into "$CACHE/$WIN_ZIP" "$TMP/win"
cp "$TMP/win/node-v$NODE_VERSION-win-x64/node.exe" "$STAGE/node.exe"
sed 's/$/\r/' "$HERE/win/start.cmd" | sed "s|@PORT@|$PORT|g; s|@SEED@|$SEED|g" > "$STAGE/start.cmd"
# Подстановка обязана случиться: с литеральным @SEED@ нода не добавит сид в peers.json.
grep -qF "$SEED" "$STAGE/start.cmd" || die "start.cmd: сид не подставился"
! grep -qF '@SEED@' "$STAGE/start.cmd" || die "start.cmd: остался плейсхолдер @SEED@"
sed 's/$/\r/' "$HERE/win/README.txt" | sed "s|@PORT@|$PORT|g; s|@SEED@|$SEED|g" > "$STAGE/README.txt"
stage_pillar "$STAGE"
sed 's/$/\r/' "$HERE/win/start-pillar.cmd" | sed "s|@PORT@|$PORT|g; s|@SEED@|$SEED|g" > "$STAGE/start-pillar.cmd"
grep -qF "$SEED" "$STAGE/start-pillar.cmd" || die "start-pillar.cmd: сид не подставился"
! grep -qF '@SEED@' "$STAGE/start-pillar.cmd" || die "start-pillar.cmd: остался плейсхолдер @SEED@"

# Бинарь проверяем тем же exe, который уедет другу: снимок должен читаться.
CHECK="$("$STAGE/node.exe" -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const a=d.chain||d;process.stdout.write(`${a.length} ${a[a.length-1].hash}`)' "$STAGE/chain.json")"
[ "$CHECK" = "$SNAP_H" ] || die "windows node.exe не прочитал снимок как ожидалось: $CHECK"
say "  windows: node.exe $(printf '%.16s' "$(sha256sum "$STAGE/node.exe" | awk '{print $1}')")…, снимок сверен exe-шкой"

cat > "$STAGE/RELEASE.json" <<JSON
{
  "schema": "agentcoin/release@1",
  "layer": "portable",
  "platform": "windows-x64",
  "version": "$VERSION",
  "node": "$NODE_VERSION",
  "seed": "$SEED",
  "port": $PORT,
  "entry": "start.cmd",
  "snapshot": { "height": $(printf '%s' "$SNAP_H" | cut -d' ' -f1), "tip": "$(printf '%s' "$SNAP_H" | cut -d' ' -f2)", "sha256": "$SNAP_SHA" },
  "pillar": true,
  "codeFiles": $(($(grep -c . "$SRC/SHA256SUMS") + PILLAR_FILES)),
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
write_sums "$STAGE"

# --- macOS (Apple Silicon) ---------------------------------------------------
MAC="agentcoin-portable-$VERSION-macos-arm64"
MSTAGE="$OUT/$MAC"
rm -rf "$MSTAGE"
stage_common "$MSTAGE"
tar xzf "$CACHE/$MAC_TGZ" -C "$TMP"
cp "$TMP/node-v$NODE_VERSION-darwin-arm64/bin/node" "$MSTAGE/node"
chmod 0755 "$MSTAGE/node"
sed "s|@PORT@|$PORT|g; s|@SEED@|$SEED|g" "$HERE/macos/start.command" > "$MSTAGE/start.command"
chmod 0755 "$MSTAGE/start.command"
stage_pillar "$MSTAGE"
sed "s|@PORT@|$PORT|g; s|@SEED@|$SEED|g" "$HERE/macos/start-pillar.command" > "$MSTAGE/start-pillar.command"
chmod 0755 "$MSTAGE/start-pillar.command"
sed "s|@PORT@|$PORT|g; s|@SEED@|$SEED|g" "$HERE/macos/README.txt" > "$MSTAGE/README.txt"

cat > "$MSTAGE/RELEASE.json" <<JSON
{
  "schema": "agentcoin/release@1",
  "layer": "portable",
  "platform": "macos-arm64",
  "version": "$VERSION",
  "node": "$NODE_VERSION",
  "seed": "$SEED",
  "port": $PORT,
  "entry": "start.command",
  "snapshot": { "height": $(printf '%s' "$SNAP_H" | cut -d' ' -f1), "tip": "$(printf '%s' "$SNAP_H" | cut -d' ' -f2)", "sha256": "$SNAP_SHA" },
  "pillar": true,
  "codeFiles": $(($(grep -c . "$SRC/SHA256SUMS") + PILLAR_FILES)),
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
write_sums "$MSTAGE"

# --- архивы ----------------------------------------------------------------
say "== архивы"
rm -f "$OUT/$WIN.zip"
# PowerShell не понимает POSIX-пути Git Bash: передаём Windows-форму.
WIN_STAGE_W="$(cygpath -w "$STAGE")"
WIN_ZIP_W="$(cygpath -w "$OUT/$WIN.zip")"
powershell -NoProfile -Command "Compress-Archive -LiteralPath '$WIN_STAGE_W' -DestinationPath '$WIN_ZIP_W' -CompressionLevel Optimal -Force" \
  || die "Compress-Archive не сработал"
tar czf "$OUT/$MAC.tar.gz" -C "$OUT" "$MAC"
( cd "$OUT" && sha256sum "$WIN.zip" "$MAC.tar.gz" > SHA256SUMS.downloads )

say ""
say "папки (можно отдавать как есть):"
du -sh "$STAGE" "$MSTAGE" | sed 's/^/  /'
say "архивы:"
ls -l "$OUT/$WIN.zip" "$OUT/$MAC.tar.gz" | awk '{print "  "$9" "$5" b"}'
say "снимок: высота $(printf '%s' "$SNAP_H" | cut -d' ' -f1), tip $(printf '%s' "$SNAP_H" | cut -d' ' -f2 | cut -c1-16)…"
