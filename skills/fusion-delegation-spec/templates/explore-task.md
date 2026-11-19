# Explore Task Template

Copy this into a `subagent` delegation for explore. Every section is required: fill it, or write "none" with a reason. Delete the guidance italic lines before sending.

## Objective

<!-- The question about the codebase, in one or two sentences. State what decision the answer feeds. -->

_Map <area> so that <decision> can be made._

## Files

<!-- Where to start and where not to waste time. Exact paths when known; directory hints when not. Explore reads, never edits. -->

- Start at: `path/to/dir-or-file`
- Likely relevant: `path/to/file`
- Ignore: `generated/`, `vendored/`
- Report paths as `path:line` for every claim.

## Interfaces

<!-- The symbols, entry points, or boundaries the answer must cover: functions, types, config keys, module boundaries, call paths. -->

- Symbols or areas to cover: `<symbol>`, `<symbol>`
- Call path needed: <e.g. "request handler -> service -> store">
- What to report per symbol: file, signature, one-line role, and its callers when relevant.

## Constraints

<!-- Search boundaries, read-only rules, and what not to do. -->

- Read-only: do not edit, create, or delete files.
- Grep and glob skip gitignored paths; if an ignored area matters, read explicit paths and say the answer rests on that.
- Do not redesign or recommend changes - report what exists.

## Thoroughness

<!-- REQUIRED: pick exactly one level. Do not leave this open - the level decides when the search stops. -->

- Level: quick | medium | very thorough
- quick: a single targeted search; answer with the direct hits and stop.
- medium: follow imports and callers one hop; confirm the answer against at least one read of the actual code.
- very thorough: trace the full call path, check tests and config, and list anything suspicious found along the way.

## Verification

<!-- How the explorer confirms the answer is complete rather than a lucky hit. -->

- Every claimed location was opened and read, not inferred from a filename.
- Every call edge reported was confirmed in the source.
- State which searches were run when the answer depends on absence of matches.

## Skills to load

<!-- Skill names the explorer must load before starting. -->

- none

## Model tier

<!-- REQUIRED: one of big | medium | small | vision. Explorer's default tier is medium; a narrow single-file lookup may use small. Name the overriding tier's model id from the injected Model tiers table. -->

- Tier: big | medium | small | vision
- Model override: `<provider>/<model>` from the injected table, or "none - default"

## Report contract

<!-- What the explorer must return. -->

- **SKILLS**: comma-separated ids of the skills you loaded before starting, or "none" (usually "none" - skill loads are not part of exploration)
- **STATUS**: complete | partial | blocked
- **FINDINGS**: the answer first, then the map: files, `path:line` locations, call paths, and one-line roles
- **VERIFIED**: what was read or run to confirm, separated from inference
- **GAPS**: what was not covered at the requested thoroughness and why, or "none"

## Stop conditions

<!-- Stop and escalate instead of guessing when any of these is true. -->

- The requested area does not exist under the given paths - report where the search was run.
- The question requires running code or tests (outside the read-only explore role).
- Two files disagree about the contract and no single answer is possible.
- The requested thoroughness cannot be met within reasonable effort - report the partial map.
- The work outgrows the spec - more files, different files, or a concern the spec did not name. Stop and report partial instead of expanding scope silently.
