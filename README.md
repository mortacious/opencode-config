# opencode config

Personal opencode configuration. Managed as a public git repo for deployment across machines.

## Requirements

- opencode >= 2.3.0 (tested on 2.3.2). The pinned context plugin `opencode-dcp@2.0.5`
  targets the 2.3 API line; `install.sh` aborts early on older versions
  (`SKIP_OPENCODE_VERSION_CHECK=1` bypasses the check, unsupported).
- Node.js >= 22 with npm - for `scripts/` and the plugin packages.
- Python, per environment: the interpreter you point the kernel at needs `ipykernel` (it ships
  `debugpy`), and whichever Python launches the kernel host needs `jupyter_client`. The kernel
  does not create or manage an environment.
- Optional, for C/C++ PID attach only: ptrace permission (`kernel.yama.ptrace_scope=0`). Launch
  mode, Python launch, and Python TCP attach do not need it.

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
15. The local plugin package `plugin-src/kernel` adds the `kernel` and `kernel_export` tools (one persistent Python kernel per session, plus nbformat 4.5 export); the `debugger` MCP server (`@debugmcp/mcp-debugger@0.26.0`) is configured in `opencode.jsonc`. Both are covered in "Kernel and debugger" below, and `scripts/check-runtime.sh` reports whether their Python prerequisites are present.

## Kernel and debugger

Two additions cover work that outlives one tool call: a session-scoped Python kernel, and a DAP
debugger for Python and C/C++.

- **`kernel`** runs one Python cell per call in a persistent Jupyter kernel owned by
  `plugin-src/kernel/` (plugin + `host.py`). State persists across calls and compaction, each
  session has its own kernel, and a subagent never shares the parent's. Arguments: `code`,
  `timeout` (seconds, 30 default, 0 disables, max 3600), `reset`, and `kernel` (an absolute
  Python path or a kernelspec name; empty auto-discovers `KERNEL_PYTHON`, the active venv/conda
  env, the project `.venv`/`venv`, then `python3`, taking the first with `ipykernel`). Inline
  output is capped at 50 KiB with the full text left in a log file; images are saved and returned
  as paths. One timeout keeps the kernel when SIGINT is acknowledged and kills it only when the
  kernel is unresponsive, in which case its state is lost. `reset` wipes state on purpose, and
  is the way to switch interpreters.
- **`kernel_export({path, title})`** writes the session journal as an nbformat 4.5 `.ipynb`,
  relative to the project root, adding `.ipynb` when missing and using `notebooks/<topic>.ipynb`
  by convention. It carries full outputs and images, records reset boundaries, and refuses past
  1000 code cells or 2 MiB per cell. `--export-only` also works from a bare `python3`, since the
  journal and metadata are the only inputs; set `PYTHON_EXPORT` to an absolute interpreter path to
  override which Python performs the export (export-only - it does not select the kernel, and the
  export needs only the standard library).
- **`debugger`** is the MCP server configured as
  `npx -y @debugmcp/mcp-debugger@0.26.0 stdio --log-level error`. It creates sessions, sets
  breakpoints, launches or attaches to Python and C/C++ targets, and exposes stack traces,
  scopes, locals, and expression evaluation. Python launch needs `executablePath` pointing at
  the env interpreter (which must have `debugpy`, normally installed with `ipykernel`); C/C++
  launch needs `-g -O0` and the binary as the script path; Python TCP attach needs a target
  started with `python -m debugpy --listen 127.0.0.1:5678` that stays alive; C++ PID attach
  needs ptrace permission. `get_output` reflects DAP output events, not every byte the target
  writes, so read a launched program's own stdout from the terminal.

`/kernel` opens the `Kernel cells` session panel: syntax-highlighted cells, their outputs,
images, and reset dividers for the current session, updating live through the plugin's `kernel`
RPC (`cell` and `reset` events). It reads the same `meta.json` / `cells.jsonl` as export, so a
new session shows an empty panel instead of an error. The panel renders PNG and JPEG outputs
from the journal in place, up to 3 images per cell. Inline previews of saved image files in the
transcript (PNG/JPEG, 3 per cell, 2 MiB each, 6 MiB total) separately need
`"session": { "image_preview": true }` at the top level of `opencode.jsonc`; the saved image
paths stay in the tool metadata either way.

Prerequisites are per environment, not vendored: `ipykernel` in each kernel env,
`jupyter_client` in the host interpreter, and `debugpy` (from `ipykernel`) in each debug launch
env. Run `scripts/check-runtime.sh` to report which are present; pass `--python <path>` to check
a specific interpreter instead of the auto-discovered one. `./install.sh` runs this check as a
hard gate: the bootstrap fails when no selected interpreter has `ipykernel`. The remedy is to
activate a conda/venv env with `ipykernel`, set `KERNEL_PYTHON` to that env's interpreter, or run
`scripts/check-runtime.sh --python <env>/bin/python`. `KERNEL_HOST_PYTHON` is the optional host
interpreter for named kernelspecs and must import `jupyter_client` when set.

The `kernel` and `kernel_export` tools are granted to both `orchestrator` and `sidekick`. They
are a code-execution surface with the same trust as `shell`: a kernel cell runs arbitrary Python
in the selected environment.

State lives in `$XDG_STATE_HOME/opencode/kernel` (or
`~/.local/state/opencode/kernel/<sessionID>` when `XDG_STATE_HOME` is unset): the per-session
journal, metadata, and ephemeral kernelspec. It is safe to delete when no session is running.
Exported notebooks are written under the project, not the state dir.

For existing `.ipynb` files, the community `opencode-ipynb` plugin, if installed, is the right
tool for inspecting, reading, editing, running, cleaning, and LSP-checking notebook files. This
kernel is session-scoped and does not require a notebook file to exist. `kernel_export` writes a
standard nbformat notebook that such a tool, or Jupyter itself, can then open and edit.

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
