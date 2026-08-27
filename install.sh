#!/usr/bin/env bash
# opencode config bootstrap.
# Run this after cloning the repo to ~/.config/opencode/ (or your XDG opencode dir).
# Idempotent: safe to re-run.
set -euo pipefail

CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$CONFIG_DIR/bin"
VENV_DIR="$CONFIG_DIR/.venv"

echo "=== opencode config bootstrap ==="

# --- codegraph (MCP server dependency) ---
# The codegraph binary must be on PATH for the codegraph MCP server to work.
# This script does NOT install it - install it yourself via your package manager
# (on Arch: sudo pacman -S codegraph, or whichever source you prefer).
if ! command -v codegraph >/dev/null 2>&1; then
  echo "WARNING: codegraph is not on PATH." >&2
  echo "  The codegraph MCP server (configured in opencode.jsonc) will not start." >&2
  echo "  Install it yourself (e.g. on Arch: sudo pacman -S codegraph) and re-run opencode." >&2
else
  echo "OK: codegraph found at $(command -v codegraph)."
fi

mkdir -p "$BIN_DIR"

# --- github-mcp-server (official GitHub MCP; used by sparring + research) ---
# Self-contained: the binary lives in ./bin/. opencode.jsonc references it via
# {env:HOME}/.config/opencode/bin/github-mcp-server (opencode expands {env:HOME}).
install_github_mcp() {
  local target="$BIN_DIR/github-mcp-server"
  if [ -x "$target" ]; then
    echo "OK: github-mcp-server present at $target."
    return 0
  fi
  # If a system binary exists, symlink it in (self-contained, no download).
  if command -v github-mcp-server >/dev/null 2>&1; then
    ln -sf "$(command -v github-mcp-server)" "$target"
    echo "OK: symlinked system github-mcp-server to $target."
    return 0
  fi
  # Otherwise download the latest release.
  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    echo "WARNING: curl or tar is missing; cannot auto-install github-mcp-server." >&2
    echo "  The github MCP server will not start. Install curl+tar and re-run," >&2
    echo "  or drop the binary at $target (from https://github.com/github/github-mcp-server/releases)." >&2
    return 0
  fi
  local os arch tag asset_url tmp bin asset_os asset_arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"   # linux / darwin
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "WARNING: unsupported arch $(uname -m) for github-mcp-server; skipping." >&2; return 0 ;;
  esac
  # Get latest tag from the releases/latest redirect (avoids parsing JSON).
  if ! tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
        https://github.com/github/github-mcp-server/releases/latest 2>/dev/null \
        | sed -E 's|.*/||'); then
    echo "WARNING: could not resolve github-mcp-server latest release tag." >&2
    return 0
  fi
  # Asset URL pattern (verified from the releases page):
  #   github-mcp-server_${OS}_${ARCH}.tar.gz  (OS capitalized: Linux/Darwin; ARCH: x86_64|arm64)
  case "$os" in
    linux)  asset_os="Linux"  ;;
    darwin) asset_os="Darwin" ;;
  esac
  case "$arch" in
    amd64) asset_arch="x86_64" ;;
    arm64) asset_arch="arm64" ;;
  esac
  asset_url="https://github.com/github/github-mcp-server/releases/download/${tag}/github-mcp-server_${asset_os}_${asset_arch}.tar.gz"
  echo "Downloading github-mcp-server ${tag} (${os}/${arch}) ..."
  tmp="$(mktemp -d)"
  if ! curl -fsSL "$asset_url" | tar -xz -C "$tmp"; then
    echo "WARNING: download/extract failed for $asset_url." >&2
    echo "  Install manually into $target from https://github.com/github/github-mcp-server/releases" >&2
    rm -rf "$tmp"
    return 0
  fi
  # Find the binary regardless of archive internal layout.
  bin="$(find "$tmp" -name github-mcp-server -type f 2>/dev/null || true)"
  bin="${bin%%$'\n'*}"
  if [ -n "$bin" ]; then
    mv "$bin" "$target"
    chmod +x "$target"
    echo "OK: github-mcp-server ${tag} installed at $target."
  else
    echo "WARNING: archive did not contain a github-mcp-server binary." >&2
    echo "  Inspect the asset layout at $asset_url and install manually into $target." >&2
  fi
  rm -rf "$tmp"
}
install_github_mcp

# --- uv (Python package manager; for the dblp MCP venv) ---
# uv ships with uvx. The user already has uvx/uv. If missing, warn.
if ! command -v uv >/dev/null 2>&1; then
  echo "WARNING: uv is not on PATH." >&2
  echo "  The dblp MCP server (and sourcegraph, if enabled) will not start." >&2
  echo "  Install uv (pip install uv, or https://docs.astral.sh/uv/) and re-run opencode." >&2
else
  echo "OK: uv found at $(command -v uv)."
  # Self-contained venv in the config dir; opencode.jsonc references it via
  # {env:HOME}/.config/opencode/.venv/bin/mcp-dblp.
  if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python venv at $VENV_DIR ..."
    if ! uv venv "$VENV_DIR" >/dev/null 2>&1; then
      echo "WARNING: failed to create venv at $VENV_DIR. The dblp MCP server will not start." >&2
    fi
  fi
  # mcp-dblp: used by sparring + research. Entry point name verified from PyPI.
  if ! "$VENV_DIR/bin/mcp-dblp" --help >/dev/null 2>&1; then
    echo "Installing mcp-dblp into $VENV_DIR ..."
    if ! uv pip install --python "$VENV_DIR/bin/python" mcp-dblp >/dev/null 2>&1; then
      echo "WARNING: failed to install mcp-dblp. The dblp MCP server will not start." >&2
    else
      echo "OK: mcp-dblp installed in $VENV_DIR."
    fi
  else
    echo "OK: mcp-dblp already installed in $VENV_DIR."
  fi
  # ddgs: metasearch MCP (search_text, search_images, search_news, search_videos,
  # search_books, extract_content). No key required (scrapes DuckDuckGo).
  # Used by sparring + research for general web lookups (Exa-quota-free).
  if ! "$VENV_DIR/bin/ddgs" --help >/dev/null 2>&1; then
    echo "Installing ddgs[mcp] into $VENV_DIR ..."
    if ! uv pip install --python "$VENV_DIR/bin/python" "ddgs[mcp]" >/dev/null 2>&1; then
      echo "WARNING: failed to install ddgs[mcp]. The ddgs MCP server will not start." >&2
    else
      echo "OK: ddgs[mcp] installed in $VENV_DIR."
    fi
  else
    echo "OK: ddgs[mcp] already installed in $VENV_DIR."
  fi
  # NOTE: sourcegraph-mcp is NOT auto-installed. It is disabled in opencode.jsonc
  # because akbad/sourcegraph-mcp only supports HTTP/SSE transports (no stdio).
  # See AGENTS.md and knowledge/web-search-modules/research-apis.md for manual setup.
fi

# --- node / npm ---
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not on PATH. Install Node.js first (on Arch: sudo pacman -S nodejs npm)." >&2
  exit 1
fi

# --- local deps (plugin authoring; @opencode-ai/plugin) ---
# Installs to ./node_modules in this config dir. Nothing global.
echo "Running npm install (local deps only, no -g)..."
npm install --no-audit --no-fund

# --- opencode plugins ---
# Note: the plugins listed in opencode.jsonc "plugin" array (@tarquinen/opencode-dcp,
# caveman-opencode-plugin) are resolved by opencode itself on first run - they do
# not need to be pre-installed by this script.

# --- provider API keys ---
# The neuralwatt provider needs an API key available to opencode. opencode looks
# this up via the standard env-var convention (NEURALWATT_API_KEY). This script
# does not set it - keep keys out of the repo.
if [ -z "${NEURALWATT_API_KEY:-}" ]; then
  echo "NOTE: NEURALWATT_API_KEY is not set in the environment." >&2
  echo "  The neuralwatt provider will not authenticate until you export it (e.g. in ~/.bashrc)." >&2
else
  echo "OK: NEURALWATT_API_KEY is set."
fi

# --- research-API .env ---
# The research-API MCP servers (semantic-scholar, github) read their keys from the
# process environment via {env:VAR} interpolation in opencode.jsonc. Source-load .env
# before launching opencode.
if [ ! -f "$CONFIG_DIR/.env" ]; then
  echo "NOTE: $CONFIG_DIR/.env does not exist." >&2
  echo "  The research-API MCP servers need their keys." >&2
  echo "  Copy .env.example to .env, fill in values, then source-load it:" >&2
  echo "    cp $CONFIG_DIR/.env.example $CONFIG_DIR/.env && \${EDITOR:-vi} $CONFIG_DIR/.env" >&2
  echo "    set -a; source $CONFIG_DIR/.env; set +a" >&2
else
  echo "OK: .env present at $CONFIG_DIR/.env."
fi

# --- oc wrapper (profile launcher) ---
# bin/oc lives in this repo; symlink it onto PATH so 'oc' works from anywhere.
# Profiles live in ./profiles/ alongside opencode.jsonc and travel via git pull.
OC_SRC="$CONFIG_DIR/bin/oc"
if [ ! -f "$OC_SRC" ]; then
  echo "WARNING: bin/oc missing at $OC_SRC - profile system unavailable." >&2
else
  chmod +x "$OC_SRC"
  # Prefer ~/.local/bin (common user PATH); fall back to /usr/local/bin if writable.
  for candidate in "$HOME/.local/bin" "/usr/local/bin"; do
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then
      ln -sf "$OC_SRC" "$candidate/oc"
      echo "OK: 'oc' wrapper symlinked into $candidate."
      break
    fi
  done
  if [ ! -e "$HOME/.local/bin/oc" ] && [ ! -e "/usr/local/bin/oc" ]; then
    echo "NOTE: no writable PATH dir found for 'oc' symlink." >&2
    echo "  Create ~/.local/bin (mkdir -p ~/.local/bin) and add it to PATH, then re-run." >&2
    echo "  Or invoke directly: $OC_SRC" >&2
  fi
fi

# --- profiles dir ---
# Default profile overlay must exist; create it if missing (never overwrite).
mkdir -p "$CONFIG_DIR/profiles/default"
if [ ! -f "$CONFIG_DIR/profiles/default/opencode.jsonc" ]; then
  cat > "$CONFIG_DIR/profiles/default/opencode.jsonc" <<'PROFILE_EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
PROFILE_EOF
  echo "OK: created default profile overlay."
fi

echo "=== bootstrap complete ==="
echo "Restart (or start) opencode to load the config."
