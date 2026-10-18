#!/bin/sh
# Official-source bootstrap. User-level files only; no sudo, shell profiles or firewall changes.
set -eu
umask 077
unset NODE_OPTIONS NODE_PATH
for task_env in $(env | sed -n 's/^\(AGT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$task_env"; done
task_base=${AGENTCOIN_BASE:-"$HOME/.agentcoin"}
task_peer=${AGENTCOIN_PEER_URL:-}
task_ref=${AGENTCOIN_SOURCE_REF:-}
task_mode=node
task_noninteractive=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --peer-url) [ "$#" -ge 2 ] || exit 2; task_peer=$2; shift 2;;
    --client-only) task_mode=client; shift;;
    --non-interactive) task_noninteractive=1; shift;;
    *) echo 'Unknown installation option.' >&2; exit 2;;
  esac
done
[ -n "$task_peer" ] || { echo 'Supply --peer-url with the selected trusted node HTTPS origin.' >&2; exit 2; }
if [ -n "${PREFIX:-}" ] && command -v pkg >/dev/null 2>&1; then
  # Termux supplies Android/Bionic-compatible Node; desktop Linux binaries are unsuitable.
  if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)'; then
    pkg install -y nodejs-lts curl tar coreutils
  fi
fi
command -v curl >/dev/null 2>&1 || { echo 'Install curl using your operating system package manager.' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo 'Install tar using your operating system package manager.' >&2; exit 1; }
case "$task_base" in /*) ;; *) echo 'AGENTCOIN_BASE must be an absolute path.' >&2; exit 2;; esac
[ ! -L "$task_base" ] || { echo 'Refusing a symbolic-link install directory.' >&2; exit 1; }
mkdir -p "$task_base/programs"
task_stage=$(mktemp -d "$task_base/programs/.download-XXXXXXXX")
trap 'rm -rf "$task_stage"' EXIT HUP INT TERM
download() { curl --proto '=https' --proto-redir '=https' --fail --location --silent --show-error --connect-timeout 15 --max-time 180 "$1" -o "$2"; }
if [ -z "$task_ref" ]; then
  download 'https://api.github.com/repos/CrChCn/agentcoin/git/ref/heads/main' "$task_stage/ref.json"
  task_ref=$(sed -n 's/.*"sha": *"\([a-f0-9]\{40\}\)".*/\1/p' "$task_stage/ref.json")
fi
case "$task_ref" in ''|*[!a-f0-9]*) echo 'Invalid approved source reference.' >&2; exit 1;; esac
[ "${#task_ref}" -eq 40 ] || { echo 'Expected a full 40-character source commit.' >&2; exit 1; }
task_release="$task_base/programs/$task_ref"
if [ ! -d "$task_release" ]; then
  download "https://codeload.github.com/CrChCn/agentcoin/tar.gz/$task_ref" "$task_stage/source.tgz"
  tar -tzf "$task_stage/source.tgz" > "$task_stage/files.txt"
  if ! awk -v prefix="agentcoin-$task_ref/" 'index($0,prefix)!=1 || $0 ~ /(^|\/)\.\.(\/|$)/ {bad=1} END {exit bad}' "$task_stage/files.txt"; then
    echo 'Unexpected source archive paths.' >&2; exit 1
  fi
  tar -xzf "$task_stage/source.tgz" -C "$task_stage"
  [ -f "$task_stage/agentcoin-$task_ref/tools/easy-install.mjs" ] || { echo 'This approved release has no easy installer.' >&2; exit 1; }
  mv "$task_stage/agentcoin-$task_ref" "$task_release"
fi
[ ! -L "$task_release" ] && [ -f "$task_release/tools/easy-install.mjs" ] || { echo 'Invalid local source directory.' >&2; exit 1; }
task_node=
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' >/dev/null 2>&1; then task_node=$(command -v node); fi
if [ -z "$task_node" ]; then
  case "$(uname -s)" in Darwin) task_os=darwin;; Linux) task_os=linux;; *) echo 'This system needs an existing Node.js 24+ runtime.' >&2; exit 1;; esac
  case "$(uname -m)" in x86_64|amd64) task_arch=x64;; aarch64|arm64) task_arch=arm64;; *) echo 'Automatic runtime download supports x64 and ARM64; install Node.js 24+ yourself on this CPU.' >&2; exit 1;; esac
  task_sumline=$(awk -v suffix="-$task_os-$task_arch.tar.gz" 'substr($2,length($2)-length(suffix)+1)==suffix {print $1" "$2}' "$task_release/install/runtime-shasums.txt")
  task_sum=${task_sumline%% *}; task_file=${task_sumline#* }
  case "$task_sum" in ''|*[!a-f0-9]*) echo 'Invalid runtime checksum.' >&2; exit 1;; esac
  [ "${#task_sum}" -eq 64 ] || exit 1
  task_version=$(printf '%s' "$task_file" | sed -n 's/^node-\(v24\.[0-9][0-9]*\.[0-9][0-9]*\)-[a-z0-9-]*\.tar\.gz$/\1/p')
  [ -n "$task_version" ] || exit 1
  download "https://nodejs.org/dist/$task_version/$task_file" "$task_stage/node.tgz"
  if command -v sha256sum >/dev/null 2>&1; then task_actual=$(sha256sum "$task_stage/node.tgz" | cut -d ' ' -f 1);
  elif command -v shasum >/dev/null 2>&1; then task_actual=$(shasum -a 256 "$task_stage/node.tgz" | cut -d ' ' -f 1);
  else echo 'A SHA-256 utility is required.' >&2; exit 1; fi
  [ "$task_actual" = "$task_sum" ] || { echo 'Node.js checksum mismatch; nothing executed.' >&2; exit 1; }
  mkdir -p "$task_base/runtimes"
  task_runtime="$task_base/runtimes/node-$task_version-$task_os-$task_arch"
  if [ ! -d "$task_runtime" ]; then tar -xzf "$task_stage/node.tgz" -C "$task_stage"; mv "$task_stage/node-$task_version-$task_os-$task_arch" "$task_runtime"; fi
  task_node="$task_runtime/bin/node"
fi
"$task_node" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo 'Node.js 24+ is required; check your system runtime compatibility.' >&2; exit 1; }
export AGENTCOIN_SOURCE_REF="$task_ref"
export AGENTCOIN_INSTALL_ROOT="${AGENTCOIN_INSTALL_ROOT:-$task_base/agent}"
set -- "$task_release/tools/easy-install.mjs" install --peer-url "$task_peer"
[ "$task_mode" != client ] || set -- "$@" --client-only
[ -z "$task_noninteractive" ] || set -- "$@" --non-interactive
"$task_node" "$@"
