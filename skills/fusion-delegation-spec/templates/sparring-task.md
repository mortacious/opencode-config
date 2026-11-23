# Sparring Task Template

Copy this into a `subagent` delegation for a red-team pass. Every section is required: fill it, or
write "none" with a reason. Delete the guidance italic lines before sending.

## Objective

<!-- One or two sentences: the position to attack and the decision its verdict gates. -->

_Red-team <design / approach / claim> to decide whether it ships as stated._

## Inputs and paths

<!-- The position under review, stated precisely enough to attack, plus the files, plan steps, or papers that carry it. -->

- Position under review: <one-paragraph statement of the design and its central claim>
- Paths to read: `path/to/file`, plan step, or "none"
- Decision at stake: <what SHIP / REVISE / REJECT changes>

## Constraints

<!-- What is out of bounds: the parts already settled, the evidence standard, and what not to do. -->

- Do not redesign the solution; name alternatives only as objections.
- Every load-bearing objection or defense names a source actually opened (URL, `path:line`, output,
  or verified paper identifier). Memory is not evidence.
- Read-only: no edits, no commits, no delegation.

## Verification

<!-- What the sparring pass must do to be credible. -->

- Cross-check any single-source objection with a second source when the verdict depends on it.
- State plainly when a search was incomplete; do not present an unsearched claim as settled.

## Skills to load

- `fusion-sparring`
- `fusion-research-methodology` (for the evidence hunt inside fusion-sparring)

## Model tier

<!-- REQUIRED: one of the tier names from the injected tier table (default: this agent's tier). Name a tier only from that table. -->

- Tier: one of the tier names from the injected tier table (default: this agent's tier)
- Model override: `<provider>/<model>` from the injected table, or "none - default"

## Report contract

Condensed report - this is input for an expensive orchestrator; no bulk output.

- **SKILLS**: comma-separated ids of the skills you loaded before starting, or "none"
- **STATUS**: complete | partial | blocked | escalate
- **FINDINGS**: max 5 objections - strongest first, each with counter-evidence and a source
- **VERIFIED**: what was actually opened or run, separated from inference
- **GAPS**: what could not be checked, or "none"
- End with the verdict line (SHIP / REVISE / REJECT).

## Stop conditions

- The position is too vague to attack: ask for the missing claim instead of inventing it.
- The task needs an edit or an implementation: out of role - escalate naming the role that fits.
