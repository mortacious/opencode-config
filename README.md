# opencode config

Personal opencode configuration. Managed as a public git repo for deployment across machines.

## Requirements

- opencode >= 2.3.0 (tested on 2.3.2). The pinned context plugin `opencode-dcp@2.0.5`
  targets the 2.3 API line; `install.sh` aborts early on older versions
  (`SKIP_OPENCODE_VERSION_CHECK=1` bypasses the check, unsupported).
- Node.js >= 22 with npm - for `scripts/` and the plugin packages.

## Deploy to a new machine

1. Install opencode itself (>= 2.3.0; out of scope for this repo).
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
   This installs the local plugin-authoring dependencies (`@opencode-ai/plugin`, `@opencode/plugin`) into `./node_modules` (nothing global), auto-installs the `github-mcp-server` Go binary into `./bin/`, a self-contained Python venv with `mcp-dblp` at `./.venv/`, and a second venv with `ddgs[mcp]` at `./.venv-ddgs/` (ddgs gets its own venv because mcp-dblp pins `mcp<2` while `ddgs[mcp]` requires `mcp>=2.0`), checks that `codegraph` is available on PATH, and reminds you to set `NEURALWATT_API_KEY`.
5. Install `codegraph` yourself if the script warned it is missing (on Arch: `sudo pacman -S codegraph`). The codegraph MCP server configured in `opencode.jsonc` will not start without it.
6. `install.sh` now auto-installs the `github-mcp-server` Go binary into `./bin/` (symlinks a system one if present, otherwise downloads the latest release from GitHub) and creates a self-contained Python venv at `./.venv/` with `mcp-dblp` installed via `uv`. Run `./install.sh` on each deployed machine; re-running is safe.
7. `install.sh` creates empty placeholder files in `secrets/` for the research-API keys. Paste each key into its file (just the key, no `var=` prefix or quotes): `secrets/semantic_scholar_api_key` (optional, https://www.semanticscholar.org/product/api) and `secrets/github_personal_access_token` (recommended, https://github.com/settings/tokens). No shell sourcing needed - opencode reads these files directly at startup.
8. Export `NEURALWATT_API_KEY` in your shell (e.g. add to `~/.bashrc` or `~/.zshrc`).
9. Start opencode. It will resolve `opencode-dcp@2.0.5` (listed in `opencode.jsonc`) on first run; the local plugin package `plugin-src/fusion-audit` is also listed there and its dependencies are installed by `./install.sh`.
10. The local plugin package `plugin-src/profile-switcher` (also listed in `opencode.jsonc`) is installed by `./install.sh` and provides in-session profile switching: `/profile` in the TUI plus a `Profile:` sidebar indicator, hot-swapping agent models without a service restart. Profile state is per opencode window directory in `<CONFIG_DIR>/.active-profile` (format v1: an optional machine-wide `global\t<name>` fallback record plus one `location\t<absDir>\t<name>` record per directory; an explicit per-directory `default` overrides the global fallback; a legacy single-line file is read as the global record). The plugin resolves the active profile when opencode starts (launched `OPENCODE_CONFIG` overlay, then `OC_PROFILE`, then the directory's `location` record, then the last global record, then `default`) and applies it at runtime, so plain `opencode` launches under the directory's profile; for a tier-managed profile it first regenerates the overlay from `tiers.json` (an `OPENCODE_CONFIG` launch skips that: its overlay is already merged). `opencode-profile switch <name>` sets the CURRENT directory's profile; `opencode-profile switch --global <name>` writes the machine-wide fallback. Windows in different directories are fully independent, with separate profile records and no cross-window model migration; windows on the same directory share that directory's record and, within one shared service, converge with each other. A live switch rewrites the persisted models of the sessions the switching window currently has open as tabs (plus sessions created in that location afterward) - not the whole history - and only sessions whose model matches the previous profile target for their agent migrate: sessions manually moved to a different model are left alone, and sessions running at switch time pick up the new model once idle.
11. The local plugin package `plugin-src/subagent-view` restores the v1-style live subagent model/token sidebar section. Its dependencies are installed by `./install.sh`.
12. The local plugin package `plugin-src/fusion-bootstrap` injects the Fusion skill reminder as an extra system part (primaries get the delegation-template nudge, children get the "task prompt is the full spec" reminder). Its dependencies are installed by `./install.sh`.
13. The local plugin package `plugin-src/fusion-channel` provides the steer/report channel (`/steer` command, `steer` tool, durable inbox log). It has no external dependencies; `./install.sh` installs it like the others.
14. The local plugin package `plugin-src/subagent-cap` caps concurrent subagent spawns per profile (unlimited by default). Its dependencies are installed by `./install.sh`.

## What lives where

See `REPO.md` for the authoritative layout map and `AGENTS.md` for the Fusion delegation pattern that governs how the agents (`orchestrator` as the single entrypoint, then `sidekick` for execution and commits, `analyst` for read-only exploration/research/planning/visual inspection/red-team, and `reviewer` for the audit gate) divide planning from execution.

## Profiles

A home-grown profile system lets you launch opencode under different model/config overlays. Each profile authors `profiles/<name>/tiers.json`, which defines the tier names, their models, one-line descriptions, and a default tier per agent; a profile may define different or additional tiers. `scripts/tiers-sync.mjs` expands it into a GENERATED `profiles/<name>/opencode.jsonc`. An empty tier model marks that tier unavailable in the profile rather than invalid: `cheap-local` ships its vision tier unset because its local model has no vision support, and only an unmapped tier may be empty. The shipped profiles map the hidden `compaction` agent to the `small` tier, so a non-default profile compacts on its small tier; the base `opencode.jsonc` leaves it unset, so the `default` profile - which mirrors the base pins - and an unconfigured profile compact with the session model. The bootstrap tier table resolves the profile per session directory (launched `OPENCODE_CONFIG` overlay, then `OC_PROFILE`, then that directory's `location` record in `.active-profile`, then the last global record, then `default`), renders an unavailable tier as `unavailable`, and tells the primary not to route work that needs that modality to any model and to tell the user it is unavailable. The `profile-switcher` plugin applies the resolved profile's model subset at runtime, so no launcher is needed. Edit `tiers.json`, never the generated overlay: a hand-edited `tiers.json` is synced on the next `./install.sh` (which runs `scripts/tiers-sync.mjs --all`), `opencode-profile add`, profile switch, or plain `opencode` launch (the profile-switcher plugin regenerates the resolved profile's overlay at setup; an `OPENCODE_CONFIG` launch skips that because its overlay is already merged). Profiles travel with the repo via `git pull`.

### Install

`./install.sh` symlinks `bin/opencode-profile` into `~/.local/bin/opencode-profile` (or `/usr/local/bin/opencode-profile` if that is writable) and removes an `oc` symlink left by an older install. Make sure `~/.local/bin` is on your PATH (add `export PATH="$HOME/.local/bin:$PATH"` to your shell rc if not). It also runs `scripts/tiers-sync.mjs --all` to regenerate every tier-managed overlay, and ensures `profiles/default/opencode.jsonc` exists; it is tracked and generated from `profiles/default/tiers.json`, so a normal checkout already has it. `opencode-profile` only manages profiles - it never launches opencode.

### Use

Plain `opencode` applies the active profile for the current directory - the `profile-switcher` plugin resolves it at startup. For a one-off launch under another profile (not persisted):
```
OC_PROFILE=cheap-local opencode   # cheap-local tier models: every agent on the Thor flash id
OC_PROFILE=default opencode       # deepseek-v4.1-flash tiers, vision on glm-5.3-flash
opencode                          # uses .active-profile or 'default'
```
`OC_PROFILE` is a launch-only override: it is never written to `.active-profile`.

Set the default profile for this directory (persisted in `.active-profile`):
```
opencode-profile switch cheap-local
```

List profiles:
```
opencode-profile list
```

Print the effective profile for the current directory:
```
opencode-profile current
```

### Fork a profile (optionally swapping every model)

Create a new cheap-local-style profile by cloning a tier-managed profile and retargeting every tier entry to one id (requires `jq`). The clone copies `tiers.json`; the overlay is regenerated from it, so the clone stays tier-managed:
```
opencode-profile add experimental --clone default --swap-model "<provider>/<model-id>"
```

For a tier-managed profile `--swap-model` rewrites all tier entries, so variants come from the new id. A legacy overlay without `tiers.json` instead has every `agents.*.model` plus `small_model` rewritten and `variant` fields stripped (the new provider may not define any).

### Install an external project-local bundle

This repo no longer carries a bundle-install command. Clone the bundle into the target project and run the bundle's own setup script, which installs its agents/skills/knowledge/opencode.json into that project (per-project, project-local; the global profile system does NOT carry them):
```
git clone <bundle-url> ~/my-vault/.agentic-vault
~/my-vault/.agentic-vault/setup.sh
```
For `agentic-vault` the result lands in `~/my-vault/.opencode/`.

### Adding a new model for cheap experiments

If the model is not yet registered as a provider model in `opencode.jsonc`, add it under the relevant `provider.<name>.models` block first. Then edit the relevant `profiles/<name>/tiers.json` tier value (synced by the next `./install.sh`, `opencode-profile add`, or profile switch), or fork:
```
opencode-profile add cheap-qwen --clone default --swap-model "<provider>/<model-id>"
OC_PROFILE=cheap-qwen opencode
```

## Secret handling

This repo is public. The `Amenable Thor 1` provider block in `opencode.jsonc` reaches a LAN-only server; its API key and base URL are not in the tree - they live in the gitignored `secrets/lan_api_key` and `secrets/lan_base_url` files and are pulled in via `{file:...}` references. The `neuralwatt` provider key is NOT in the repo - it is read from the environment (`NEURALWATT_API_KEY`) and must be set per machine.

The research-API keys (Semantic Scholar, GitHub PAT) live in the gitignored `secrets/` directory as one file per key, referenced from `opencode.jsonc` via `{file:secrets/<name>}` interpolation - opencode reads them directly at startup, so no shell sourcing is needed. `install.sh` creates empty placeholders. Sourcegraph keys (if enabled later) use `{env:SRC_ENDPOINT}`/`{env:SRC_ACCESS_TOKEN}` environment variables instead.

## Updating a deployed machine

```
cd ~/.config/opencode
git pull
./install.sh
```

Restart opencode after pulling - config is loaded once at session start and is not hot-reloaded.
