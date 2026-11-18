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
- Permissions are V2 `permissions` arrays only, evaluated findLast (last matching rule wins):
  write the most general rule first and the specific exceptions last, so a deny-list policy reads
  blanket allow -> denies -> re-allows. Canonical action names are
  `read`, `edit`, `shell`, `subagent`, `skill`, `webfetch`, `websearch`, `external_directory`,
  `execute`, and MCP tool ids such as `ddgs_search_text`. Legacy names (`bash`, `task`, `write`,
  `apply_patch`) are silent no-ops inside an array.
- Frontmatter carries `description`, `mode`, and the V2 `permissions` array. `temperature`,
  `mcps:`, `skills:`, and `model:` are unsupported fields on opencode 2.2.6 and must not
  reappear.
- Models resolve from `opencode.jsonc` `agents.*` pins and profile overlays - never from agent
  frontmatter.
- Skills are advertised session-wide and filtered only by `skill` permission rules. An agent that
  needs a method loads it with the `skill` tool; restrict exposure with `skill` rules if needed.
- Branch plan logs follow the `fusion-plan-log` skill: `.plans/<branch>.md`, live sections
  (`Plan`, `Open issues`, `Next step`) rewritten by the primary, cumulative sections
  (`Decisions`, `Progress log`, `Implemented`) append-only, `.plans/` never tracked.
- `compress` takes `{topic, content}` where `content` is an array of `{startId, endId, summary}`
  ranges - never a plain string.
- Output is ASCII only across all agents: ` - ` not em-dashes, straight quotes, `...`.
- The `Amenable Thor 1` provider block in `opencode.jsonc` contains a hardcoded API key and an
  internal-IP base URL. Treat it as a secret; never echo it into commits, diffs, or summaries.
