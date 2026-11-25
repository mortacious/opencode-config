# Executor Task Template

Copy this into a `subagent` delegation for sidekick. Every section is required: fill it, or write "none" with a reason. Delete the guidance italic lines before sending.

## Objective

<!-- One or two sentences: what to build or change, and why. State the outcome, not the steps. -->

_What changes, observed how._

## Working directory

<!-- REQUIRED: where the executor runs. Default is the current worktree (write "current worktree"). For an isolated-worktree task, name the explicit absolute path the orchestrator created with `git worktree add` and repeat it in the `subagent` call's `workdir` parameter. -->

_Current worktree, or `/abs/path/to/worktree`._

## Files

<!-- Exact paths to create and exact paths to modify, marked as such. Name files that must not change when scope is the risk. -->

- Create: `path/to/new-file`
- Modify: `path/to/existing-file`
- Do not touch: `path/to/out-of-scope-file`

## Interfaces

<!-- Public names, single-line signatures, type declarations, API shapes, config keys that other code or tests depend on. Quote existing definitions only when they pin the contract, and label them as context. Leave internal helpers and control flow open. -->

_Pinned contract, or "none - internal implementation only"._

## Constraints

<!-- Project conventions to follow, neighboring patterns to mirror, behavior to preserve, and the explicit not-to-do list. -->

_Conventions, preserved behavior, out-of-scope refactors._

## Verification

<!-- Exact command(s), the directory to run them from, and the expected outcome. Include the project's standard gate even when the change looks small. -->

```bash
<command>
```

_Expected: <test count / exit code / output>._

## Skills to load

<!-- Skill names the executor must load before starting. Keep this short; only the ones this task needs. -->

- `<skill-name>`

## Model tier

<!-- REQUIRED: a tier name from the injected tier table - the target agent's mapped tier unless the work is clearly harder or cheaper; add a Reason line when it differs. Name a tier only from that table. -->

- Tier: the target agent's mapped tier unless the work is clearly harder or cheaper
- Model override: `<provider>/<model>` from the injected table, or "none - default"
- Reason (only when the tier differs from the target agent's mapped default): <one line>

## Report contract

<!-- What the executor must return. Summaries without real command output do not count. -->

Condensed report - this is input for an expensive orchestrator; no bulk output.

- **SKILLS**: comma-separated ids of the skills you loaded before starting, or "none" - first line, one line
- **STATUS**: complete | partial | blocked | escalate - one line
- **CHANGES**: one line per file actually modified, from the real diff
- **VERIFIED**: the exact command plus a one-line result each - no raw output dumps; write long logs to a file and cite the path
- **GAPS**: anything unfinished, any ambiguity hit, or "none" - max 5 bullets

## Stop conditions

<!-- Stop and escalate instead of guessing when any of these is true. -->

- The objective or an interface is ambiguous in a way this spec does not resolve.
- The change would need to touch a file listed as out of scope.
- Existing code contradicts the spec's assumption about it.
- The baseline (lint/test/build) is already failing before the change.
- The work outgrows the spec - more files, different files, or a concern the spec did not name. Stop and report partial instead of expanding scope silently.
