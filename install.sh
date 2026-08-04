#!/usr/bin/env bash
# opencode config bootstrap.
# Run this after cloning the repo to ~/.config/opencode/ (or your XDG opencode dir).
# Idempotent: safe to re-run.
set -euo pipefail

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

echo "=== bootstrap complete ==="
echo "Restart (or start) opencode to load the config."
