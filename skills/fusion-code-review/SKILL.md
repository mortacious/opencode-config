---
name: fusion-code-review
description: Use when auditing a completed change or diff before it is reported done or committed - verifying correctness, scope, security, and consistency against the stated plan, and reporting findings as blocker / concern / nit with file:line and a concrete fix. Do not use for critiquing a plan before implementation (use plan-review), or for applying fixes yourself.
---

# Fusion Code Review

## Overview

Audit the diff, not the description of the diff. A change is done when the diff is correct, in scope, and verified by output you saw yourself - a clean summary is not evidence.

## When to Use

- A change or diff was returned and needs an audit before it is reported done.
- A commit is about to be made and the change is large enough that a second pass pays for itself.
- You were handed both a plan and a diff: review the diff against the plan.

Do not use for plan critique (use `plan-review`), for implementing or fixing the code yourself, or for style preferences with no correctness impact.

A reviewer may load this skill for a code diff or for a scientific artifact - a report section, notebook, metrics table, or figure. The axes differ; the severity vocabulary and report format do not.

## Core Pattern

1. **Get the diff.** Run `git diff` (plus `git show` / `git log` when needed) and review the actual changed lines.
2. **Reconstruct intent.** Take it from the plan or spec you were handed. If none was given, ask for one line of intent before judging scope.
3. **Check the four axes.** Correctness, scope, security, consistency.
4. **Verify with targeted checks.** Confirm the load-bearing claim with the smallest command that would fail if the claim were false.
5. **Report.** Verdict first, findings by severity, verified separated from inferred.

## Quick Reference

| Axis | Question | Typical failures |
| --- | --- | --- |
| Correctness | Does it do what was intended? | Logic errors, off-by-one, missed cases, wrong error path |
| Scope | Did it touch only what it should? | Unrelated edits, drive-by refactors, logic altered outside the task |
| Security | Can input, auth, or secrets be abused? | Missing validation, injection, unsafe defaults, leaked secrets |
| Consistency | Does it match the codebase? | New patterns with no precedent, style divergence, duplicated helpers |

## Artifact review (scientific outputs)

A code diff is one artifact among several. For a report section, notebook, metrics table, or figure, the same evidence-first discipline applies with different axes.

- **Entry**: get the artifact itself - the diff, the PDF section, the notebook, the metrics table. Reviewing a summary of the artifact is not a review.
- **Claims vs cited evidence**: every number traces to source data or an evaluation, and every citation is verified to exist with its identifier recorded; recollection is not evidence.
- **Statistical validity**: the stated test, the effect size, and the number of runs support the strength of the claim; a single run is not a trend.
- **Reproducibility**: seeds, library versions, and hardware are recorded well enough for another lab to rerun.
- **Baseline fairness and split leakage**: baselines run under the same protocol, and no train/test contamination across scenes, subjects, or sessions.
- **Data provenance and licensing**: the dataset source, license, and permitted uses are stated.
- **Figure-data consistency**: plotted values match the metrics file, and axes, units, and error bars are honest about sample size.
- **Ablation coverage**: each design choice the claim depends on has an ablation.

Use the severity levels and report format below unchanged; name the artifact location (`path:line`, section title, table row, figure id) instead of a diff hunk.

Evidence severity: a number with no source, or a citation that does not resolve, is at least a concern; a fabricated or unresolvable citation presented as support is a blocker.

## Severity

Only three levels. Do not invent others.

| Severity | Meaning | Action |
| --- | --- | --- |
| blocker | Wrong behavior, broken contract, security hole, or an out-of-scope change that must not land | Must be fixed before done |
| concern | Real risk or gap that should be fixed, but does not invalidate the change | Should be fixed or explicitly accepted |
| nit | Wording, style, or polish with no behavior impact | Optional |

## Finding Discipline

- **Evidence first.** Every finding names a location (`file:line` for a diff, the plan step for a plan) and what specifically is wrong. "Looks risky" is not a finding.
- **Verify, do not trust.** Do not trust the implementer's test claims. Read the diff and run the targeted check that would fail if the claim were false.
- **Do not re-run the implementer's full test suite** as the review method. It costs time and proves little beyond that one command. Use a targeted test, a lint pass on the touched files, or a direct read of the code path instead.
- **Silent searches are not proof.** Grep and glob skip gitignored paths, and `git diff` omits ignored untracked files. Zero matches in an ignored area (fixtures, generated code, local config) is not absence - read explicit paths.
- **Suggest, do not apply.** Give the concrete fix with its location; do not edit files.
- **A denied command is a boundary, not a puzzle.** Run an allowed command that answers the same question, or report which command you would need and why.
- **Separate verified from inferred.** "I ran it" and "I reason that" are different evidence and must be labeled as such.

## Report Format

Return exactly these fields, in this order:

- **STATUS**: one of pass | changes needed | blocked | escalate
- **FINDINGS**: one line per issue, ordered blocker first, each tagged `[blocker]`, `[concern]`, or `[nit]`, with its location and the concrete fix. "none" if the work passes.
- **VERIFIED**: the exact command(s) you ran and their real outcome. "Looks correct" is not verification.
- **GAPS**: what you could not judge and why, or "none".

If STATUS is escalate, put the decision the main agent must make in GAPS.

## Common Mistakes

- Reviewing the summary instead of the diff.
- Flagging style as a blocker; it is a nit unless it breaks a convention the repo enforces.
- Reviewing only the newest hunk and missing a regression earlier in the change.
- Re-running the whole suite and calling that a review.
- Rubber-stamping. Honest, specific feedback beats agreement.
- Inventing severity levels or using emoji in the report.

## Rules

- Never edit files.
- Do not review a plan with this skill; plan critique and diff review stay separate.
- ASCII only in output.
