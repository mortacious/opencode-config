# Review Task Template

Copy this into a `subagent` delegation for reviewer. Every section is required: fill it, or write "none" with a reason. Delete the guidance italic lines before sending.

## Objective

<!-- What to audit: a plan before implementation, or a diff before it is reported done or committed. Name which one; a reviewer handed both reviews the diff against the plan. -->

_Critique <plan X> before execution / audit <diff Y> against <plan Z> before commit._

## Files

<!-- Read-only scope for the review. Give the diff range or changed paths, plus the plan or spec the change answers to. Do not ask the reviewer to edit anything. -->

- Diff: `git diff <range>`
- Plan or spec: `path/to/plan.md` (or pasted below)
- Files to read for context: `path/to/file`

## Interfaces

<!-- The contract the change must satisfy: public API, type shapes, config keys, expected behavior. This is what the review judges against, not a suggested implementation. -->

_Contract the reviewer should check the change against, or "none - judge against stated intent"._

## Constraints

<!-- Review boundaries: what is in scope for the review, what is deliberately out of scope, and the severity vocabulary. -->

- Review scope: <correctness / scope / security / consistency / all>
- Out of scope: <e.g. style nits, unrelated pre-existing code>
- Severity tags: blocker / concern / nit (no other levels, no emoji)
- Do not re-run the implementer's full test suite as the review method. Do not trust the implementer's test claims - verify from the diff plus targeted checks (a targeted test, a lint pass on touched files, or a direct read of the code path).
- Suggest fixes; do not apply them.

## Verification

<!-- What the reviewer should run itself to confirm the change, and what counts as confirmation. -->

```bash
git diff <range>
<targeted test or lint command>
```

_Expected: <what the output should show>._

## Skills to load

<!-- Skill names the reviewer must load before starting. -->

- `fusion-code-review`
- `plan-review` (plan critique only)

## Model tier

<!-- REQUIRED: one of big | medium | small | vision. Reviewer's default tier is medium; a whole-branch final review uses big. Name the overriding tier's model id from the injected Model tiers table. -->

- Tier: big | medium | small | vision
- Model override: `<provider>/<model>` from the injected table, or "none - default"

## Report contract

<!-- What the reviewer must return. -->

- **SKILLS**: comma-separated ids of the skills you loaded before starting, or "none"
- **STATUS**: pass | changes needed | blocked | escalate
- **FINDINGS**: one line per issue, ordered blocker first, each tagged `[blocker]`, `[concern]`, or `[nit]`, with `file:line` (or the plan step) and the concrete fix. "none" if the work passes.
- **VERIFIED**: the exact commands run and their real outcome, separated from anything inferred
- **GAPS**: what could not be judged and why, or "none"

## Stop conditions

<!-- Stop and escalate instead of reviewing when any of these is true. -->

- The intent is missing: no plan, spec, or stated objective to judge scope against.
- The diff cannot be seen (uncommitted changes unavailable, wrong range).
- The work is outside the reviewer role: asked to implement the fix or choose the approach.
- A command needed for the verdict falls outside the reviewer's explicit read-only shell allows (shell is deny-by-default) - report which command and why instead of working around it.
- The work outgrows the spec - more files, different files, or a concern the spec did not name. Stop and report partial instead of expanding scope silently.
