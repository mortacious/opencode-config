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
   This installs the local plugin-authoring dependency (`@opencode-ai/plugin`) into `./node_modules` (nothing global), auto-installs the `github-mcp-server` Go binary into `./bin/`, a self-contained Python venv with `mcp-dblp` at `./.venv/`, and a second venv with `ddgs[mcp]` at `./.venv-ddgs/` (ddgs gets its own venv because mcp-dblp pins `mcp<2` while `ddgs[mcp]` requires `mcp>=2.0`), checks that `codegraph` is available on PATH, and reminds you to set `NEURALWATT_API_KEY`.
5. Install `codegraph` yourself if the script warned it is missing (on Arch: `sudo pacman -S codegraph`). The codegraph MCP server configured in `opencode.jsonc` will not start without it.
6. `install.sh` now auto-installs the `github-mcp-server` Go binary into `./bin/` (symlinks a system one if present, otherwise downloads the latest release from GitHub) and creates a self-contained Python venv at `./.venv/` with `mcp-dblp` installed via `uv`. Run `./install.sh` on each deployed machine; re-running is safe.
7. `install.sh` creates empty placeholder files in `secrets/` for the research-API keys. Paste each key into its file (just the key, no `var=` prefix or quotes): `secrets/semantic_scholar_api_key` (optional, https://www.semanticscholar.org/product/api) and `secrets/github_personal_access_token` (recommended, https://github.com/settings/tokens). No shell sourcing needed - opencode reads these files directly at startup.
8. Export `NEURALWATT_API_KEY` in your shell (e.g. add to `~/.bashrc` or `~/.zshrc`).
9. Start opencode. It will resolve the plugins listed in `opencode.jsonc` (`@tarquinen/opencode-dcp`, `caveman-opencode-plugin`) on first run.

## What lives where

See `AGENTS.md` for the authoritative layout map and the Fusion delegation pattern that governs how the agents (`build`, `plan`, `sidekick`, `explore`, `research`, `design`, `reviewer`, `sparring`, `vision`) divide planning from execution.

## Profiles

A home-grown profile system lets you launch opencode under different model/config overlays. `bin/oc` is a small bash wrapper that sets `OPENCODE_CONFIG` to a profile's `opencode.jsonc` overlay (opencode deep-merges it on top of the base config). Profiles live in `profiles/<name>/opencode.jsonc` and travel with the repo via `git pull`.

### Install

`./install.sh` symlinks `bin/oc` into `~/.local/bin/oc` (or `/usr/local/bin/oc` if that is writable). Make sure `~/.local/bin` is on your PATH (add `export PATH="$HOME/.local/bin:$PATH"` to your shell rc if not). `install.sh` also ensures `profiles/default/opencode.jsonc` exists.

### Use

Launch opencode with a specific profile:
```
oc cheap-local           # uses profiles/cheap-local/opencode.jsonc
oc default               # identity overlay, base config unchanged
oc                       # uses .active-profile or 'default'
```

Set the default profile (persisted in `.active-profile`):
```
oc profile switch cheap-local
```

List profiles:
```
oc profile list
```

### Fork a profile (optionally swapping every model)

Create a new cheap-local-style overlay by forking `default` and rewriting every agent model + `small_model` to a different model id (requires `jq`):
```
oc profile add experimental --clone default --swap-model "Amenable Thor 1/qwen3.8-27b"
```

`--swap-model` also strips `variant` fields (the new provider may not define any).

### Install an external project-local bundle

This launches an external bundle's `setup.sh` against a target directory (the bundle owns its own install - the global profile system does NOT carry its agents/skills/knowledge; this command only clones and runs the setup):
```
oc profile install agentic-vault ~/my-vault
```
Clones `agentic-vault` into `~/my-vault/.agentic-vault` and runs its `setup.sh`, which writes the bundle's agents/skills/knowledge/opencode.json into `~/my-vault/.opencode/` (per-vault, project-local).

### Adding a new model for cheap experiments

If the model is not yet registered as a provider model in `opencode.jsonc`, add it under the relevant `provider.<name>.models` block first. Then either edit `profiles/cheap-local/opencode.jsonc` directly, or fork:
```
oc profile add cheap-qwen --clone default --swap-model "<provider>/<model-id>"
oc cheap-qwen
```

## Secret handling

This repo is private. The `Amenable Thor 1` provider block in `opencode.jsonc` reaches a LAN-only server and contains an inline API key; that block is safe to keep in the private repo as long as the LAN/VPN boundary holds. The `neuralwatt` provider key is NOT in the repo - it is read from the environment (`NEURALWATT_API_KEY`) and must be set per machine.

The research-API keys (Semantic Scholar, GitHub PAT) live in the gitignored `secrets/` directory as one file per key, referenced from `opencode.jsonc` via `{file:secrets/<name>}` interpolation - opencode reads them directly at startup, so no shell sourcing is needed. `install.sh` creates empty placeholders. Sourcegraph keys (if enabled later) use `{env:SRC_ENDPOINT}`/`{env:SRC_ACCESS_TOKEN}` environment variables instead.

## Updating a deployed machine

```
cd ~/.config/opencode
git pull
./install.sh
```

Restart opencode after pulling - config is loaded once at session start and is not hot-reloaded.
