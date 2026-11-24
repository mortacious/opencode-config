#!/usr/bin/env bash
# opencode config bootstrap.
# Run this after cloning the repo to ~/.config/opencode/ (or your XDG opencode dir).
# Idempotent: safe to re-run.
set -euo pipefail

CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$CONFIG_DIR/bin"
VENV_DIR="$CONFIG_DIR/.venv"
VENV_DDGS="$CONFIG_DIR/.venv-ddgs"
SECRETS_DIR="$CONFIG_DIR/secrets"

echo "=== opencode config bootstrap ==="

# --- opencode version gate ---
# The context plugin pinned in opencode.jsonc (opencode-dcp@2.0.5) targets the
# opencode 2.3 API line, so anything older is unsupported. Abort before any
# install work. Escape hatch (unsupported): SKIP_OPENCODE_VERSION_CHECK=1.
if [ "${SKIP_OPENCODE_VERSION_CHECK:-0}" != "1" ]; then
  "$CONFIG_DIR/scripts/check-opencode-version.sh" --quiet
fi

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
mkdir -p "$SECRETS_DIR"

# --- LAN provider secrets ({file:} placeholders) ---
# opencode.jsonc reads the Amenable Thor 1 provider's baseURL and apiKey via
# {file:secrets/lan_base_url} and {file:secrets/lan_api_key}. A missing file
# hard-fails opencode startup, so create empty placeholders (mode 600) when
# absent. Real values are machine-local and must be provisioned by hand on
# each machine (never committed, never echoed here); an existing file is
# never overwritten.
for secret in lan_base_url lan_api_key; do
  if [ ! -f "$SECRETS_DIR/$secret" ]; then
    : > "$SECRETS_DIR/$secret"
    chmod 600 "$SECRETS_DIR/$secret"
  fi
done

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
  # Always (re)install: uv pip install is idempotent and exits 0 when already
  # satisfied. Avoids probing the entry point (--help starts the MCP stdio
  # server and blocks on stdin) and avoids the ddgs-style extras gap where
  # `uv pip show ddgs` succeeds even when the [mcp] extras are missing.
  echo "Installing mcp-dblp into $VENV_DIR ..."
  if ! uv pip install --python "$VENV_DIR/bin/python" mcp-dblp >/dev/null 2>&1; then
    echo "WARNING: failed to install mcp-dblp. The dblp MCP server will not start." >&2
  else
    echo "OK: mcp-dblp installed in $VENV_DIR."
  fi
  # ddgs: metasearch MCP (search_text, search_images, search_news, search_videos,
  # search_books, extract_content). No key required (scrapes DuckDuckGo).
  # Used by sparring + research for general web lookups (Exa-quota-free).
  # ddgs gets its own venv (.venv-ddgs): mcp-dblp pins mcp>=1.20,<2, while
  # ddgs[mcp] requires mcp>=2.0 - the two cannot share one venv. opencode.jsonc
  # references it via {env:HOME}/.config/opencode/.venv-ddgs/bin/ddgs.
  # Always (re)install ddgs[mcp]: ensures the [mcp] extras are present even if
  # bare ddgs was previously installed without them. uv pip install is idempotent.
  if [ ! -d "$VENV_DDGS" ]; then
    echo "Creating Python venv at $VENV_DDGS ..."
    if ! uv venv "$VENV_DDGS" >/dev/null 2>&1; then
      echo "WARNING: failed to create venv at $VENV_DDGS. The ddgs MCP server will not start." >&2
    fi
  fi
  if [ -d "$VENV_DDGS" ]; then
    echo "Installing ddgs[mcp] into $VENV_DDGS ..."
    if ! uv pip install --python "$VENV_DDGS/bin/python" "ddgs[mcp]" >/dev/null 2>&1; then
      echo "WARNING: failed to install ddgs[mcp]. The ddgs MCP server will not start." >&2
    else
      echo "OK: ddgs[mcp] installed in $VENV_DDGS."
    fi
  fi
  # NOTE: sourcegraph-mcp is NOT auto-installed. It is disabled in opencode.jsonc
  # because akbad/sourcegraph-mcp only supports HTTP/SSE transports (no stdio).
  # See AGENTS.md and skills/fusion-research-methodology/references/tool-matrix.md
  # for manual setup.
fi

# --- research-API secrets ({file:} placeholders) ---
# opencode.jsonc reads these via {file:secrets/<name>} at config load.
# A missing file hard-fails opencode startup, so we create empty placeholders.
# Edit each file to paste in the real key (no quotes, no var= prefix, just the key).
for secret in semantic_scholar_api_key github_personal_access_token; do
  if [ ! -f "$SECRETS_DIR/$secret" ]; then
    touch "$SECRETS_DIR/$secret"
  fi
done

# --- node / npm ---
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not on PATH. Install Node.js first (on Arch: sudo pacman -S nodejs npm)." >&2
  exit 1
fi

# --- local deps (plugin authoring; @opencode-ai/plugin, @opencode/plugin) ---
# Installs to ./node_modules in this config dir. Nothing global.
echo "Running npm install (local deps only, no -g)..."
npm install --no-audit --no-fund

# --- fusion-audit plugin package (plugin-src/fusion-audit) ---
# Registered in opencode.jsonc "plugins" as "./plugin-src/fusion-audit". It is a
# local plugin package with its own dependency (@opencode/plugin), resolved from
# its own node_modules - so it needs its own install step here.
echo "Installing fusion-audit plugin deps (plugin-src/fusion-audit)..."
if ! ( cd "$CONFIG_DIR/plugin-src/fusion-audit" && npm install --no-audit --no-fund ); then
  echo "WARNING: failed to install fusion-audit plugin deps; the plugin will not load." >&2
else
  echo "OK: fusion-audit plugin deps installed."
fi

# --- fusion-bootstrap plugin package (plugin-src/fusion-bootstrap) ---
# Registered in opencode.jsonc "plugins" as "./plugin-src/fusion-bootstrap". It
# is a local plugin package with its own dependency (@opencode/plugin),
# resolved from its own node_modules - so it needs its own install step here.
echo "Installing fusion-bootstrap plugin deps (plugin-src/fusion-bootstrap)..."
if ! ( cd "$CONFIG_DIR/plugin-src/fusion-bootstrap" && npm install --no-audit --no-fund ); then
  echo "WARNING: failed to install fusion-bootstrap plugin deps; the plugin will not load." >&2
else
  echo "OK: fusion-bootstrap plugin deps installed."
fi

# --- fusion-channel plugin package (plugin-src/fusion-channel) ---
# Registered in opencode.jsonc "plugins" as the plain string
# "./plugin-src/fusion-channel". It is a local
# plugin package with its own dependency (@opencode/plugin), resolved from
# its own node_modules - so it needs its own install step here.
echo "Installing fusion-channel plugin deps (plugin-src/fusion-channel)..."
if ! ( cd "$CONFIG_DIR/plugin-src/fusion-channel" && npm install --no-audit --no-fund ); then
  echo "WARNING: failed to install fusion-channel plugin deps; the plugin will not load." >&2
else
  echo "OK: fusion-channel plugin deps installed."
fi

# --- profile-switcher plugin package (plugin-src/profile-switcher) ---
# Registered in opencode.jsonc "plugins" as the plain string
# "./plugin-src/profile-switcher". It is a local plugin package with its own
# dependencies (@opencode/plugin plus the
# OpenTUI/solid peers for its ./tui entry), resolved from its own
# node_modules - so it needs its own install step here.
echo "Installing profile-switcher plugin deps (plugin-src/profile-switcher)..."
if ! ( cd "$CONFIG_DIR/plugin-src/profile-switcher" && npm install --no-audit --no-fund ); then
  echo "WARNING: failed to install profile-switcher plugin deps; the plugin will not load." >&2
else
  echo "OK: profile-switcher plugin deps installed."
fi

# --- subagent-view plugin package (plugin-src/subagent-view) ---
# Registered in opencode.jsonc "plugins" as "./plugin-src/subagent-view". It is
# a local plugin package with its own dependencies (@opencode/plugin plus the
# OpenTUI/solid peers for its ./tui entry), resolved from its own node_modules -
# so it needs its own install step here.
echo "Installing subagent-view plugin deps (plugin-src/subagent-view)..."
if ! ( cd "$CONFIG_DIR/plugin-src/subagent-view" && npm install --no-audit --no-fund ); then
  echo "WARNING: failed to install subagent-view plugin deps; the plugin will not load." >&2
else
  echo "OK: subagent-view plugin deps installed."
fi

# --- subagent-cap plugin package (plugin-src/subagent-cap) ---
# Registered in opencode.jsonc "plugins" as an object entry with options:
# { "package": "./plugin-src/subagent-cap", options: {...} }. It is a local
# plugin package with its own dependency (@opencode/plugin), resolved from its
# own node_modules - so it needs its own install step here.
echo "Installing subagent-cap plugin deps (plugin-src/subagent-cap)..."
if ! ( cd "$CONFIG_DIR/plugin-src/subagent-cap" && npm install --no-audit --no-fund ); then
  echo "WARNING: failed to install subagent-cap plugin deps; the plugin will not load." >&2
else
  echo "OK: subagent-cap plugin deps installed."
fi

# --- opencode plugins ---
# Note: the npm-listed plugin in opencode.jsonc "plugins" array
# (opencode-dcp@2.0.5) is resolved by opencode itself on first run - it does
# not need to be pre-installed by this script. The local plugin package
# plugin-src/fusion-audit in the same array gets its dependencies installed in
# the step above.

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

# --- research-API secrets ---
# opencode reads these via {file:secrets/<name>} in opencode.jsonc. No shell
# sourcing needed - just paste each key into its file.
empty=""
for secret in semantic_scholar_api_key github_personal_access_token; do
  if [ ! -s "$SECRETS_DIR/$secret" ]; then
    empty="$empty $secret"
  fi
done
if [ -n "$empty" ]; then
  echo "NOTE: these secret files are empty:$empty" >&2
  echo "  Paste each key into its file under $SECRETS_DIR/ (just the key, no quotes/var prefix)." >&2
  echo "  semantic_scholar_api_key - https://www.semanticscholar.org/product/api (optional)" >&2
  echo "  github_personal_access_token - https://github.com/settings/tokens (recommended)" >&2
else
  echo "OK: all research-API secret files are populated."
fi

# --- opencode-profile (profile management) ---
# bin/opencode-profile lives in this repo; symlink it onto PATH so
# 'opencode-profile' works from anywhere. It only manages profiles - the
# profile is applied by launching plain opencode (profile-switcher plugin) or
# one-off with OC_PROFILE=<name> opencode. Profiles live in ./profiles/
# alongside opencode.jsonc and travel via git pull.
PROFILE_SRC="$CONFIG_DIR/bin/opencode-profile"
if [ ! -f "$PROFILE_SRC" ]; then
  echo "WARNING: bin/opencode-profile missing at $PROFILE_SRC - profile management unavailable." >&2
else
  chmod +x "$PROFILE_SRC"
  # Prefer ~/.local/bin (common user PATH); fall back to /usr/local/bin if writable.
  for candidate in "$HOME/.local/bin" "/usr/local/bin"; do
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then
      # Drop a stale 'oc' launcher symlink, but only when it points at this
      # config's own bin/oc (never remove an unrelated file). Both sides are
      # canonicalized so a symlinked config dir still matches.
      if [ -L "$candidate/oc" ] && \
        [ "$(readlink -f "$candidate/oc" 2>/dev/null)" = "$(readlink -f "$CONFIG_DIR/bin/oc" 2>/dev/null)" ]; then
        rm -f "$candidate/oc"
        echo "OK: removed stale 'oc' launcher symlink from $candidate."
      fi
      ln -sf "$PROFILE_SRC" "$candidate/opencode-profile"
      echo "OK: 'opencode-profile' symlinked into $candidate."
      break
    fi
  done
  if [ ! -e "$HOME/.local/bin/opencode-profile" ] && [ ! -e "/usr/local/bin/opencode-profile" ]; then
    echo "NOTE: no writable PATH dir found for 'opencode-profile' symlink." >&2
    echo "  Create ~/.local/bin (mkdir -p ~/.local/bin) and add it to PATH, then re-run." >&2
    echo "  Or invoke directly: $PROFILE_SRC" >&2
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

# --- tier overlays ---
# Tier-managed profiles author tiers.json; their opencode.jsonc overlay is
# GENERATED from it. Regenerate every tier-managed overlay so no launch reads a
# stale expansion (the profile-switcher plugin only applies pins from the
# overlay). A sync failure aborts the bootstrap.
echo "Syncing tier-managed profile overlays..."
node "$CONFIG_DIR/scripts/tiers-sync.mjs" --all

echo "=== bootstrap complete ==="
echo "Restart (or start) opencode to load the config."
