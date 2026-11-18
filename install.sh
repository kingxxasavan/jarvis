#!/usr/bin/env bash
# Installs Anexis on a Linux server. No questions, no keys needed.
#
#   bash install.sh             install or update, then run the checkup
#   bash install.sh --no-node   skip installing Node (npm tool servers stay off)
#
# Safe to run again: it only does what is still missing.
set -euo pipefail
cd "$(dirname "$0")"

LOCAL_BIN="$HOME/.local/bin"
NODE_DIR="$HOME/.local/share/anexis/node"
WANT_NODE=1
for arg in "$@"; do
  case "$arg" in
    --no-node) WANT_NODE=0 ;;
    *) echo "unknown option: $arg"; exit 2 ;;
  esac
done

ok()   { printf '  \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '  \033[33m--\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31m!!\033[0m  %s\n' "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
export PATH="$LOCAL_BIN:$PATH"

echo
echo "  installing anexis"
echo

# 1. uv, which brings its own Python, so the system Python does not matter.
if ! have uv; then
  have curl || die "curl is needed to download uv. Install curl first."
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || die "Could not install uv. See https://docs.astral.sh/uv/"
fi
have uv || die "uv was installed but is not on PATH. Open a new terminal and run this again."
ok "uv $(uv --version | awk '{print $2}')"

# 2. Anexis itself, as the `anexis` (and `jarvis`) command.
uv tool install --quiet --force --python ">=3.11" --editable . || die "Could not install the anexis command."
ok "anexis command in $LOCAL_BIN"

# 3. Node for the npm tool servers. Optional: without it those just stay off.
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
install_node() {
  local arch base sums file tmp
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  base="https://nodejs.org/dist/latest-v22.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")" || return 1
  file="$(printf '%s\n' "$sums" | awk -v want="linux-$arch.tar.xz" 'index($2, want) && $2 ~ /^node-v/ {print $2; exit}')"
  [ -n "$file" ] || return 1
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file" || { rm -rf "$tmp"; return 1; }
  # Check the download against the published checksum before unpacking it.
  (cd "$tmp" && printf '%s\n' "$sums" | grep -F "  $file" | sha256sum -c - >/dev/null 2>&1) || { rm -rf "$tmp"; return 1; }
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1 || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}
if have node && [ "$(node_major node)" -ge 20 ]; then
  ok "node $(node --version)"
elif [ -x "$NODE_DIR/bin/node" ] && [ "$(node_major "$NODE_DIR/bin/node")" -ge 20 ]; then
  ok "node $("$NODE_DIR/bin/node" --version) (installed earlier)"
elif [ "$WANT_NODE" = 1 ]; then
  if install_node; then ok "node $("$NODE_DIR/bin/node" --version) (just for anexis, in $NODE_DIR)"
  else warn "node did not install. The npm tool servers stay off until Node 20+ is there."; fi
else
  warn "node skipped. The npm tool servers stay off."
fi

# 4. Settings and keys files, only when there are none yet. Neither needs editing.
mkdir -p "$HOME/.anexis"
[ -f "$HOME/.anexis/anexis.toml" ] || cp anexis.toml.example "$HOME/.anexis/anexis.toml"
if [ ! -f "$HOME/.anexis/.env" ]; then
  cp .env.example "$HOME/.anexis/.env"
  chmod 600 "$HOME/.anexis/.env"
fi
ok "settings in ~/.anexis (anexis.toml and .env)"

# 5. Restart a running copy so it picks up the new code, then check everything.
"$LOCAL_BIN/anexis" stop >/dev/null 2>&1 || true
echo
echo "  checkup (the first run downloads the tool servers, give it a minute)"
echo
"$LOCAL_BIN/anexis" doctor || true
echo
echo "  done. type: anexis"
case ":$PATH:" in *":$LOCAL_BIN:"*) ;; *) echo "  (open a new terminal first so $LOCAL_BIN is on your PATH)";; esac
