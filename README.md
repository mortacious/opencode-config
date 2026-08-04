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
   This installs the local plugin-authoring dependency (`@opencode-ai/plugin`) into `./node_modules` (nothing global), checks that `codegraph` is available on PATH, and reminds you to set `NEURALWATT_API_KEY`.
5. Install `codegraph` yourself if the script warned it is missing (on Arch: `sudo pacman -S codegraph`). The codegraph MCP server configured in `opencode.jsonc` will not start without it.
6. Export `NEURALWATT_API_KEY` in your shell (e.g. add to `~/.bashrc` or `~/.zshrc`).
7. Start opencode. It will resolve the plugins listed in `opencode.jsonc` (`@tarquinen/opencode-dcp`, `caveman-opencode-plugin`) on first run.

## What lives where

See `AGENTS.md` for the authoritative layout map and the Fusion delegation pattern that governs how the agents (`build`, `plan`, `sidekick`, `explore`, `research`, `design`, `reviewer`, `sparring`, `vision`) divide planning from execution.

## Secret handling

This repo is private. The `Amenable Thor 1` provider block in `opencode.jsonc` reaches a LAN-only server and contains an inline API key; that block is safe to keep in the private repo as long as the LAN/VPN boundary holds. The `neuralwatt` provider key is NOT in the repo - it is read from the environment (`NEURALWATT_API_KEY`) and must be set per machine.

## Updating a deployed machine

```
cd ~/.config/opencode
git pull
./install.sh
```

Restart opencode after pulling - config is loaded once at session start and is not hot-reloaded.
