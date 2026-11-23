# Plan Task Template

Copy this into a `subagent` delegation for planning. Every section is required: fill it, or write
"none" with a reason. Delete the guidance italic lines before sending.

## Objective

<!-- One or two sentences: the plan to produce and the decision it serves. Planning does not reopen settled choices. -->

_Produce an ordered implementation plan for <settled design> so the work can be delegated without
re-deriving decisions._

## Inputs and paths

<!-- The settled design summary, binding constraints, and every path the planner must read. Include the branch plan-log path when one exists. -->

- Settled design summary: <the decisions already made and their rationale>
- Paths to read: `path/to/file` (or "none")
- Plan log: `.plans/<branch>.md` (or "none - no log yet")

## Constraints

<!-- Boundaries the plan must honor: stack, conventions, review gates, hardware, data, deadlines, and what the plan must not change. -->

- <constraint>
- Do not reopen settled decisions; a missing decision is a stop condition.

## Verification

<!-- How the returned plan itself is checked: every step names a command or artifact check with an expected outcome. -->

- Each step names its verification command or artifact check.
- The plan passes the `plan-review` self-check before it is returned.

## Skills to load

- `fusion-planning`
- `plan-review` (self-check inside fusion-planning)

## Model tier

<!-- REQUIRED: one of big | medium | small | vision. Planning default is medium; escalate to big when the plan is novel or cross-cutting. Name the overriding tier's model id from the injected Model tiers table. -->

- Tier: big | medium | small | vision
- Model override: `<provider>/<model>` from the injected table, or "none - default"

## Report contract

Condensed report - this is input for an expensive orchestrator; no bulk output.

- **SKILLS**: comma-separated ids of the skills you loaded before starting, or "none"
- **STATUS**: complete | partial | blocked | escalate
- **PLAN**: the plan only - objective and numbered steps, each step 1-2 lines with files/interfaces/verification/parallelizable marks; no prose recap of the design
- **VERIFIED**: what was checked against the real files, separated from inference
- **GAPS**: the missing decision, or "none"

## Stop conditions

- The design is not settled, or a decision the plan depends on is missing: list it and stop.
- The task outgrows the supplied summary (new interface, new file family, changed scope).
- Planning would require edits or mutating commands: out of role.
