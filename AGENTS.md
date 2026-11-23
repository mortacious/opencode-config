# AGENTS.md

This repository is the user's personal OpenCode configuration directory (`~/.config/opencode/`),
not an application. Every file here loads at session start and shapes future sessions. Working in
this repository itself also means reading REPO.md (layout, gitignore policy, editing rules).

## The Fusion pattern

One visible `mode: primary` agent (`orchestrator`) owns the plan, ambiguity calls, and final
review. It cannot edit files; every change is delegated to a `mode: subagent` shell and reviewed
before it is accepted. The roster is four capability shells plus the fanout worker: `sidekick`
(execution, visual work, and commits), `analyst` (read-only generalist: exploration, research,
planning, visual inspection, red-team), `reviewer` (audit gate), and `worker` (fanout only). Method
knowledge lives in `skills/`; agent files are thin capability shells that point at it. Subagents
cannot ask the user, so the interactive settle loop stays with the orchestrator.

## Invariants

- Primaries never edit. `orchestrator` decides when and what to commit, push, or merge, then
  delegates execution to `sidekick` through the `fusion-commit` skill and
  `skills/fusion-delegation-spec/templates/commit-task.md`. No other agent runs `git add`,
  `git commit`, or `git push`, and `sidekick` never amends or forces.
- The built-in `build` and `plan` primaries are disabled in `opencode.jsonc`
  (`agents.build.disabled`, `agents.plan.disabled`); `default_agent` is `orchestrator`, so a bare
  session starts in the single visible primary. `analyst` is not a picker entry: the orchestrator
  dispatches it as a read-only subagent.
- Primary `subagent` allowlist: `sidekick`, `analyst`, `reviewer`. `worker` is fanout-only and is
  created by the plugin, never dispatched by an agent. The built-in `general` subagent is excluded
  - do not route to it.
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
  the `subagent` call's `model` parameter. Agent default tiers are `orchestrator=big`,
  `sidekick`/`analyst`/`reviewer`/`worker`/`advisor=medium`, and `title=small`. `vision` is a
  modality constraint (image input), not a reasoning size: a visual or visual-inspection task
  runs on that tier. Agent frontmatter never carries a model.
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
