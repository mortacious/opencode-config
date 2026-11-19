# AGENTS.md

This repository is the user's personal OpenCode configuration directory (`~/.config/opencode/`),
not an application. Every file here loads at session start and shapes future sessions. Working in
this repository itself also means reading REPO.md (layout, gitignore policy, editing rules).

## The Fusion pattern

Two `mode: primary` agents (`build`, `plan`) own the plan, ambiguity calls, and final review. They
cannot edit files; every change is delegated to a `mode: subagent` shell and reviewed before it is
accepted. Method knowledge lives in `skills/`; agent files are thin capability shells that point
at it.

## Invariants

- Primaries never edit. Execution agents (`sidekick`, `design`, `worker`) never commit or push.
  `build` is the only agent allowed to run `git add`, `git commit`, `git push`, and merges.
- Primary `subagent` allowlist: `sidekick`, `explore`, `research`, `design`, `reviewer`,
  `vision`, `sparring`. The built-in `general` subagent is excluded - do not route to it.
- Primaries steer a running child with the `steer` tool (target by session id or agent name);
  subagents report important mid-task discoveries to the orchestrator with the `report` tool
  (kind `note|question|blocker`) - the inbox plus live channel in `fusion-tools`.
- Permissions are V2 `permissions` arrays only, evaluated findLast (last matching rule wins):
  write the most general rule first and the specific exceptions last, so a deny-list policy reads
  blanket allow -> denies -> re-allows. Canonical action names are
  `read`, `edit`, `shell`, `subagent`, `skill`, `webfetch`, `websearch`, `external_directory`,
  `execute`, and MCP tool ids such as `ddgs_search_text`. Legacy names (`bash`, `task`, `write`,
  `apply_patch`) are silent no-ops inside an array.
- Frontmatter carries `description`, `mode`, and the V2 `permissions` array. `temperature`,
  `mcps:`, `skills:`, and `model:` are unsupported fields on opencode 2.2.6 and must not
  reappear.
- Model tiers are the source of truth: each profile authors `profiles/<name>/tiers.json` with the
  four tier models (`big`, `medium`, `small`, `vision`) and a default tier per agent.
  `scripts/tiers-sync.mjs` GENERATES the profile's `agents.*.model` pins from it - those pins are
  generated and must not be hand-edited. `bin/oc` re-syncs at launch and refuses to launch when
  the sync fails (invalid `tiers.json`, unwritable overlay). A profile with no `tiers.json` falls
  back to the base `opencode.jsonc` pins. Primaries choose a tier per delegation, default to the
  delegating agent's tier, and may override one step; the chosen tier's literal model id goes in
  the `subagent` call's `model` parameter. `vision` is a modality constraint (image input), not a
  reasoning size. Agent frontmatter never carries a model.
- Skills are advertised session-wide and filtered only by `skill` permission rules. An agent that
  needs a method loads it with the `skill` tool; restrict exposure with `skill` rules if needed.
- Branch plan logs follow the `fusion-plan-log` skill: `.plans/<branch>.md`, live sections
  (`Plan`, `Open issues`, `Next step`) rewritten by the primary, cumulative sections
  (`Decisions`, `Progress log`, `Implemented`) append-only, `.plans/` never tracked.
- `prune` (the DCP tool) takes `{topic, content}` where `content` is an array of
  `{startId, endId, summary}` ranges - never a plain string. A summary carries a previously
  pruned block forward with a `(bN)` placeholder; the `mNNNN`/`bN` boundary ids are renumbered
  every dispatch, so ids copied from an earlier call throw - use the currently visible tags.
- Output is ASCII only across all agents: ` - ` not em-dashes, straight quotes, `...`.
- The `Amenable Thor 1` provider block in `opencode.jsonc` contains a hardcoded API key and an
  internal-IP base URL. Treat it as a secret; never echo it into commits, diffs, or summaries.
