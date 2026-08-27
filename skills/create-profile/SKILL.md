---
name: create-profile
description: Use ONLY when editing or creating opencode profile overlays under profiles/ via the `oc` wrapper - creating a new profile from scratch, forking an existing one (optionally with a model swap), deleting, or renaming profiles. Trigger on phrases like "create a profile", "fork profile", "new profile with model", "switch models cheap", "rename profile", "delete profile". Do not use for editing opencode.jsonc directly, for installing external bundles (use `oc profile install`), or for project-local .opencode/ work.
---

# Create / fork / delete / rename opencode profiles

Profiles live under `~/.config/opencode/profiles/<name>/opencode.jsonc` and are deep-merged on top of the base `opencode.jsonc` when opencode starts under `OPENCODE_CONFIG=.../profiles/<name>/opencode.jsonc` (the `oc` wrapper sets this). All profile management goes through the `oc` wrapper at `bin/oc`; do not hand-edit profile JSON during creation - use the subcommands.

## Subcommand reference

- `oc profile list` - list profiles, marking the active one with `*`.
- `oc profile current` - print the effective active profile name.
- `oc profile switch <name>` - set the default profile (writes `.active-profile`).
- `oc profile add <name> [--clone <src>] [--swap-model "<provider/model>"]` - create a new profile.
  - With no flags: a new identity overlay (just `$schema`, equivalent to `default`).
  - With `--clone <src>`: copies `profiles/<src>/opencode.jsonc` as the starting point.
  - With `--swap-model "<provider/model>"`: rewrites EVERY `agent.*.model` and `small_model` to the given id, and strips any `variant` fields (since variants are model-specific). jq-based; full-line `//` comments are stripped first so JSONC sources parse.
  - `--clone` and `--swap-model` compose: fork + swap.
- `oc profile delete <name>` - remove a profile (refuses `default`; clears `.active-profile` if it pointed at the deleted profile).
- `oc profile rename <old> <new>` - rename a profile (refuses `default`; refuses to clobber an existing name; updates `.active-profile` if it pointed at the old name).
- `oc profile install <bundle> <target-dir>` - NOT part of this skill (installs an external project-local bundle like agentic-vault).

## Workflow

1. Decide whether the user wants scratch or fork:
   - "Create a profile like X but with model Y" -> fork + swap: `oc profile add <new> --clone <src> --swap-model "<provider/model>"`.
   - "A new profile with everything on model Y" -> fork from a profile that already enumerates the agents: `oc profile add <new> --clone cheap-local --swap-model "<provider/model>"`. Note: a scratch profile (no `--clone`) has no `.agent` block, so `--swap-model` on scratch ONLY sets `small_model` - the base config's `agent.*.model` values then take effect unchanged. The cheap-local profile enumerates all 8 agents, so forking it (and then swapping) is the way to override every agent.
   - "A new empty profile" -> `oc profile add <new>` (identity overlay; user edits later).
2. Model id format: `<provider>/<model-key>` where `<model-key>` is the key registered in the `provider.<name>.models` map of `opencode.jsonc`, NOT the display name. For example `Amenable Thor 1/unsloth/Qwen3.8-27B-NVFP4` (provider name + `/` + model key). Using the display name silently falls back to the base config.
3. After creating, offer to switch: `oc profile switch <new>`. Note that a running opencode session keeps its already-loaded config; the user must restart opencode for the new profile to take effect.
4. For delete/rename: confirm the target with `oc profile list` first when in doubt. Default is protected.

## Constraints

- Use the `oc` subcommands; do not hand-write `profiles/<name>/opencode.jsonc` files during creation (the jq-based swap is the one path that handles JSONC comment stripping correctly).
- Never delete or rename `default`.
- Profile overlays are pure config deep-merges; they cannot ship per-profile `agents/`, `skills/`, or `knowledge/` (those are shared across all profiles at the repo root). If the user needs per-project agents/skills, that is `oc profile install <bundle>`, not a profile.
- ASCII only in all profile JSON and skill text.
