---
name: create-profile
description: Use ONLY when editing or creating opencode profiles under profiles/ via the `oc` wrapper - creating a new profile from scratch, forking an existing one (optionally with a model swap), deleting, or renaming profiles. Trigger on phrases like "create a profile", "fork profile", "new profile with model", "switch models cheap", "rename profile", "delete profile". Do not use for editing opencode.jsonc directly, for installing external bundles (use `oc profile install`), or for project-local .opencode/ work.
---

# Create / fork / delete / rename opencode profiles

Profiles live under `~/.config/opencode/profiles/<name>/`. The authored source of each profile is `tiers.json`: `tiers` maps each tier name to an entry with a literal `model` id and a one-line `description` (tier names are arbitrary - the shipped profile uses `big`, `medium`, `small`, `vision`), and `agents` maps every agent to its default tier. `scripts/tiers-sync.mjs` expands that mapping into the GENERATED `opencode.jsonc` overlay, which opencode deep-merges on top of the base `opencode.jsonc` when started under `OPENCODE_CONFIG=.../profiles/<name>/opencode.jsonc` (the `oc` wrapper sets this and re-syncs the overlay first). All profile management goes through the `oc` wrapper at `bin/oc`; never hand-edit a generated overlay.

## Subcommand reference

- `oc profile list` - list profiles, marking the active one for the current directory with `*`.
- `oc profile current` - print the effective active profile name for the current directory.
- `oc profile switch [--global] <name>` - set the profile for the CURRENT directory (writes a `location` record in `.active-profile`); `--global` writes the machine-wide fallback record instead.
- `oc profile add <name> [--clone <src>] [--swap-model "<provider>/<model>"]` - create a new profile.
  - With no flags: a bare overlay (just `$schema`). It has no `tiers.json`, so the base `opencode.jsonc` pins apply until you author one.
  - With `--clone <src>`: copies the source overlay, copies `profiles/<src>/tiers.json` when the source is tier-managed, and re-syncs the clone so it stays tier-managed.
  - With `--swap-model "<provider>/<model>"`: on a tier-managed profile, rewrites every tier entry to the given id (so variants come from the new id) and regenerates the overlay; on a legacy overlay without `tiers.json`, rewrites every `agents.*.model` and `small_model` and strips `variant` fields. jq-based; full-line `//` comments are stripped first so JSONC sources parse.
  - `--clone` and `--swap-model` compose: fork + swap.
- `oc profile delete <name>` - remove a profile (refuses `default`; scrubs every `.active-profile` record, global or per-directory, that named the deleted profile).
- `oc profile rename <old> <new>` - rename a profile (refuses `default`; refuses to clobber an existing name; rewrites every `.active-profile` record that named the old name).
- `oc profile install <bundle> <target-dir>` - NOT part of this skill (installs an external project-local bundle like agentic-vault).

## Workflow

1. Creating a profile means choosing a model for every tier entry and each agent's default tier, so start by deciding the mapping:
   - "A profile like X but on model Y" -> fork + swap all tier entries, then differentiate if needed: `oc profile add <new> --clone <src> --swap-model "<provider>/<model>"`. Edit the new `tiers.json` afterwards if the vision tier needs a vision-capable id or an agent should move a size.
   - "A new tier profile from scratch" -> `oc profile add <new>` (bare overlay), write `profiles/<new>/tiers.json`, then run `node scripts/tiers-sync.mjs --profile <new>` (or just launch with `oc <new>`, which syncs first).
   - "A bare profile on base pins" -> `oc profile add <new>` and stop; leave `tiers.json` absent.
2. Tier values are literal `<provider>/<model-key>[#variant]`, where `<model-key>` is the key registered in the `provider.<name>.models` map of `opencode.jsonc`, NOT the display name. Every `agents` key needs an `agents/<name>.md` file except the built-in `title`. Validate with `node scripts/tiers-sync.mjs --check --all` and `node scripts/validate-config.mjs`.
3. After creating, offer to switch: `oc profile switch <new>` sets this directory's profile for future launches (add `--global` to set the machine-wide fallback instead). For a running session use the in-session `/profile` command instead: the profile-switcher plugin applies agent models live and rewrites the persisted models of the sessions this window currently has open as tabs (plus sessions created here afterward) to the new profile's targets without a restart. Sessions where you manually picked a model (ctrl+x m) keep that pick: the label stays pinned and the pick re-asserts on your next prompt; re-pick once after switching if you want the session to follow profiles again. Only the model subset is hot-swappable; any other config change still needs a restart.
4. For delete/rename: confirm the target with `oc profile list` first when in doubt. Default is protected.

## Constraints

- Use the `oc` subcommands for profile lifecycle; author `tiers.json` and never hand-edit the generated `opencode.jsonc` (`oc` owns the jq-based swap and regeneration).
- Never delete or rename `default`.
- Profiles cannot ship per-profile `agents/`, `skills/`, or `knowledge/` (those are shared across all profiles at the repo root). If the user needs per-project agents/skills, that is `oc profile install <bundle>`, not a profile.
- ASCII only in all profile JSON and skill text.
