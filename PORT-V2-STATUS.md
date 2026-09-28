# OpenCode v2 Port - Status and Handoff

## What this branch is

This is the `v2-port` branch: the user's OpenCode configuration (written for
OpenCode v1.18.31), reshaped into the native OpenCode 2 configuration format.
The `main` branch stays on the v1 shape until OpenCode 2.0 is stable, so the
checkout branch alone decides which config shape loads.

Current port commit:

    7f35fc0 Port configuration to OpenCode v2 (native config shape, v2 plugin API, cli.json)

## What was ported

- `opencode.jsonc` rewritten to native v2 shape:
  - `plugin` -> `plugins`, `agent` -> `agents`, `provider` -> `providers` (with `settings`).
  - Model variants as arrays; variant folded into model refs, e.g. `gpt-5.6-luna#max`.
  - Permissions expressed as an ordered array (v1 map -> v2 list).
  - MCP config nested under `mcp.servers`; the old `enabled: true` became
    `disabled: false` (inverted semantics).
  - `experimental.subagent_depth` now lives under `experimental.`.
- `profiles/cheap-local` overlay updated: `agent` keys -> `agents` (all agents
  pointed at Amenable Thor 1 (local OpenAI-compatible provider block) /
  qwen38-flash-next).
- `plugins/fusion-audit.js` rewritten to the `@opencode/plugin` `Plugin.define`
  API, using `session.step.started/ended/failed` for token accounting
  (v2 removed `message.updated`).
- `cli.json` created (DCP-only plugin list) for the v2 terminal client.
- `tui.json` intentionally left v1-correct; v2 ignores it.
- `AGENTS.md`, `README.md`, `install.sh` updated to v2 key names.
- `package.json` carries both plugin packages: `@opencode-ai/plugin` 1.14.20
  (for v1 authoring) and `@opencode/plugin` ^2.0.18 (for v2).

## Run it

- Install globally: `npm install -g @opencode/cli` (provides both `opencode`
  and `opencode2` binaries).
- Run the v1 shape via `opencode`; run the v2 shape via `opencode2`.
- Do NOT use the curl installer: it replaces the v1 binary in place.
- v1 and v2 share `~/.config/opencode`, so `git switch` between `main` and
  `v2-port` selects which configuration shape loads.
- Config and agent/skill definitions load at session start: restart after
  changes.

## Rollback

`git switch main` restores the exact v1 configuration. Nothing on `main` was
changed by the port, so switching back is lossless.

## First-run verification checklist (still to validate)

- All MCP servers come up and authenticate. `{env:}` key interpolation may not
  reach the v2 background service (github issue #44914).
- DCP loads: requires `@tarquinen/opencode-dcp` >= 3.2.0.
- `experimental.subagent_depth: 2` behavior: known GUI bug #48515 - drop to 1
  if navigation misbehaves.
- caveman-opencode-plugin loads: v2 support unverified; v1-only plugins
  hard-break v2 startup (issue #48365). If startup fails, remove it from the
  `plugins` array.
- DCP compress `ask` permission is unsupported in v2 (DCP v2 supports only
  allow/deny). `dcp.jsonc` currently has no permission overrides, so this is
  likely moot.
- Per-agent `request.body` is accepted but inert in v2.
- TUI memory growth on long sessions (issue #51620).
- The published schema may reject documented v2 fields (issue #43748,
  editor-side validation only).

## What is still needed in v2 vs native

- DCP is still needed: v2 native compaction (`compaction.auto` /
  `keep.tokens` / `buffer`) is summarization-based and does not provide DCP's
  surgical tool-output pruning or the `compress` tool.
- All seven MCP servers (codegraph, ddgs, github, dblp, semantic-scholar,
  arxiv, sourcegraph) have no native replacements and stay.
- fusion-audit has no native equivalent and was ported.
- caveman is the only plugin candidate to drop if it does not run on v2.

## Pending items

- Validate a fresh v2 session end to end (checklist above).
- Decide whether to keep or drop caveman after the first run.
- `bin/oc` currently invokes the v1 `opencode` binary; adapt it or invoke
  `opencode2` for v2 profile use.
- Migrate the profile overlays fully once v2 proves stable.
