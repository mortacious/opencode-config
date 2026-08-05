# opencode config

Personal opencode configuration. Managed as a private git repo for deployment across machines.

## Deploy to a new machine

1. Install opencode itself (out of scope for this repo).
2. Install Node.js + npm if not present (on Arch: `sudo pacman -S nodejs npm`).
3. Clone this repo directly into your opencode config directory:
   ```
   git clone <repo-url> ~/.config/opencode
   ```
4. Run the bootstrap script:
   ```
   cd ~/.config/opencode
   ./install.sh
   ```
   This installs the local plugin-authoring dependency (`@opencode-ai/plugin`) into `./node_modules` (nothing global), auto-installs the `github-mcp-server` Go binary into `./bin/` and a self-contained Python venv with `mcp-dblp` at `./.venv/`, checks that `codegraph` is available on PATH, and reminds you to set `NEURALWATT_API_KEY`.
5. Install `codegraph` yourself if the script warned it is missing (on Arch: `sudo pacman -S codegraph`). The codegraph MCP server configured in `opencode.jsonc` will not start without it.
6. `install.sh` now auto-installs the `github-mcp-server` Go binary into `./bin/` (symlinks a system one if present, otherwise downloads the latest release from GitHub) and creates a self-contained Python venv at `./.venv/` with `mcp-dblp` installed via `uv`. Run `./install.sh` on each deployed machine; re-running is safe.
7. Copy `.env.example` to `.env` and fill in `SEMANTIC_SCHOLAR_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`, and (if using Sourcegraph) `SRC_ENDPOINT` + `SRC_ACCESS_TOKEN`. Source-load it before launching opencode: `set -a; source ~/.config/opencode/.env; set +a` (add to your shell rc).
8. Export `NEURALWATT_API_KEY` in your shell (e.g. add to `~/.bashrc` or `~/.zshrc`).
9. Start opencode. It will resolve the plugins listed in `opencode.jsonc` (`@tarquinen/opencode-dcp`, `caveman-opencode-plugin`) on first run.

## What lives where

See `AGENTS.md` for the authoritative layout map and the Fusion delegation pattern that governs how the agents (`build`, `plan`, `sidekick`, `explore`, `research`, `design`, `reviewer`, `sparring`, `vision`) divide planning from execution.

## Secret handling

This repo is private. The `Amenable Thor 1` provider block in `opencode.jsonc` reaches a LAN-only server and contains an inline API key; that block is safe to keep in the private repo as long as the LAN/VPN boundary holds. The `neuralwatt` provider key is NOT in the repo - it is read from the environment (`NEURALWATT_API_KEY`) and must be set per machine.

The research-API tokens (Semantic Scholar, GitHub PAT, Sourcegraph) are NOT committed; they live in the gitignored `.env` and are referenced from `opencode.jsonc` via `{env:VAR}` interpolation. opencode reads them from its process environment, so the shell must source `.env` before launching opencode.

## Updating a deployed machine

```
cd ~/.config/opencode
git pull
./install.sh
```

Restart opencode after pulling - config is loaded once at session start and is not hot-reloaded.
