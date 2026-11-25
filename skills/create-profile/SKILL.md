---
name: create-profile
description: Use ONLY when editing or creating opencode profiles under profiles/ via the `opencode-profile` tool - creating a new profile from scratch, forking an existing one (optionally with a model swap), deleting, or renaming profiles. Trigger on phrases like "create a profile", "fork profile", "new profile with model", "switch models cheap", "rename profile", "delete profile". Do not use for editing opencode.jsonc directly, for installing external project-local bundles, or for project-local .opencode/ work.
---

# Create / fork / delete / rename opencode profiles

Profiles live under `~/.config/opencode/profiles/<name>/`. The authored source of each profile is `tiers.json`: `tiers` maps each tier name to an entry with a literal `model` id and a one-line `description` (tier names are arbitrary - the shipped profile uses `big`, `medium`, `small`, `vision`), and `agents` maps every agent to its default tier. `scripts/tiers-sync.mjs` expands that mapping into the GENERATED `opencode.jsonc` overlay, which opencode deep-merges on top of the base `opencode.jsonc` while that profile is active. The sync runs at four points: `./install.sh` (every profile), `opencode-profile add`, a profile switch, and a plain `opencode` launch - the profile-switcher plugin regenerates the resolved profile's overlay at setup, so a hand-edited `tiers.json` is never applied stale; an `OPENCODE_CONFIG` launch skips it because that overlay is already merged. The active profile is resolved with one precedence order everywhere: a launched `OPENCODE_CONFIG` overlay first, then `OC_PROFILE`, then the per-directory record in `.active-profile`, then the machine-wide fallback, then `default`. A one-off run is `OC_PROFILE=<name> opencode`. All profile management goes through `bin/opencode-profile` (on PATH as `opencode-profile`); never hand-edit a generated overlay.

## Subcommand reference

- `opencode-profile list` - list profiles, marking the active one for the current directory with `*`.
- `opencode-profile current` - print the effective active profile name for the current directory.
- `opencode-profile switch [--global] <name>` - set the profile for the CURRENT directory (writes a `location` record in `.active-profile`); `--global` writes the machine-wide fallback record instead.
- `opencode-profile add <name> [--clone <src>] [--swap-model "<provider>/<model>"]` - create a new profile.
  - With no flags: a bare overlay (just `$schema`). It has no `tiers.json`, so the base `opencode.jsonc` pins apply until you author one.
  - With `--clone <src>`: copies the source overlay, copies `profiles/<src>/tiers.json` when the source is tier-managed, and re-syncs the clone so it stays tier-managed.
  - With `--swap-model "<provider>/<model>"`: on a tier-managed profile, rewrites every tier entry to the given id (so variants come from the new id) and regenerates the overlay; on a legacy overlay without `tiers.json`, rewrites every `agents.*.model` and `small_model` and strips `variant` fields. jq-based; full-line `//` comments are stripped first so JSONC sources parse.
  - `--clone` and `--swap-model` compose: fork + swap.
- `opencode-profile delete <name>` - remove a profile (refuses `default`; scrubs every `.active-profile` record, global or per-directory, that named the deleted profile).
- `opencode-profile rename <old> <new>` - rename a profile (refuses `default`; refuses to clobber an existing name; rewrites every `.active-profile` record that named the old name).
- External project-local setups (`.opencode/`) are out of scope for this skill; the profile tooling manages `profiles/` only.

## Workflow

1. Creating a profile means choosing a model for every tier entry and each agent's default tier, so start by deciding the mapping. The hidden `compaction` agent is a valid mapping; point it at the tier whose description covers cheap, mechanical work (the shipped profiles name it `small`), so compaction summary runs on that tier:
   - "A profile like X but on model Y" -> fork + swap all tier entries, then differentiate if needed: `opencode-profile add <new> --clone <src> --swap-model "<provider>/<model>"`. Edit the new `tiers.json` afterwards if the vision tier needs a vision-capable id or an agent should move a size.
   - "A new tier profile from scratch" -> `opencode-profile add <new>` (bare overlay), write `profiles/<new>/tiers.json`, then run `node scripts/tiers-sync.mjs --profile <new>` to generate the overlay.
   - "A bare profile on base pins" -> `opencode-profile add <new>` and stop; leave `tiers.json` absent.
2. Tier values are literal `<provider>/<model-key>[#variant]`, where `<model-key>` is the key registered in the `provider.<name>.models` map of `opencode.jsonc`, NOT the display name. Every `agents` key needs an `agents/<name>.md` file except the built-in `title` and `compaction`. Validate with `node scripts/tiers-sync.mjs --check --all` and `node scripts/validate-config.mjs`.
3. After creating, offer to switch: `opencode-profile switch <new>` sets this directory's profile for future launches (add `--global` to set the machine-wide fallback instead). For a running session use the in-session `/profile` command instead: the profile-switcher plugin applies agent models live and rewrites the persisted models of the sessions this window currently has open as tabs (plus sessions created here afterward) to the new profile's targets without a restart. Sessions where you manually picked a model (ctrl+x m) keep that pick: the label stays pinned and the pick re-asserts on your next prompt; re-pick once after switching if you want the session to follow profiles again. Only the model subset is hot-swappable; any other config change still needs a restart.
4. For delete/rename: confirm the target with `opencode-profile list` first when in doubt. Default is protected.

## Constraints

- Use the `opencode-profile` subcommands for profile lifecycle; author `tiers.json` and never hand-edit the generated `opencode.jsonc` (`opencode-profile` owns the jq-based swap and regeneration).
- Never delete or rename `default`.
- Profiles cannot ship per-profile `agents/`, `skills/`, or `knowledge/` (those are shared across all profiles at the repo root). If the user needs per-project agents/skills, that is a project-local `.opencode/` setup, not a profile.
- ASCII only in all profile JSON and skill text.
