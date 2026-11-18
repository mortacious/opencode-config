---
name: plan-review
description: Use when reviewing an implementation plan before execution - checking that decisions are sourced, the plan is complete, and its tasks are actionable. Reports findings as blocker / concern / nit against the plan's own steps. Do not use for auditing a code diff (use fusion-code-review) or for executing the plan.
---

# Plan Review

## Overview

A plan is ready when another agent can execute it without re-deriving the decisions: the goal is measurable, the steps are ordered and specific, and its assumptions are checked against the real code rather than restated.

## When to Use

- Before execution starts on a non-trivial or risky plan.
- When auditing plan quality after it was drafted.
- When a retry loop suggests the plan, not the executor, is the problem.

Do not use for diff review, style review, or for executing or editing the plan.

## Core Pattern

1. Read the plan and list every claim it makes about the current code.
2. Check those claims against the files the plan references - do not take the plan's word for the code.
3. Score three categories: citation quality, completeness, actionability.
4. Assign each finding a severity, name its location (the plan step or section), and report.

## Quick Reference

### 1. Citation Quality

| Requirement | Check |
| --- | --- |
| Decisions reference sources | Each architectural choice names its source: a reference id, `file:line`, a URL, or observed command output |
| No unsubstantiated claims | No "industry standard" or "best practice" without a citation |
| Research steps show sources | Completed research tasks cite what was read |
| Citations are verifiable | Each cited id resolves to an actual output |

Red flags:

- A decisions table with empty or `-` in the source column.
- Claims like "industry standard" with nothing behind them.
- Research tasks marked complete with no cited source.

### 2. Completeness

| Requirement | Check |
| --- | --- |
| Goal is specific | Measurable outcome, not vague intent |
| Phases are logical | Sequential, with clear progression |
| Edge cases considered | Error handling and failure modes addressed |
| Assumptions checked | Claims about the code match the code |
| Decisions captured | Key choices recorded with rationale |

Goal examples:

- Bad: "Improve authentication" (vague).
- Bad: "Make it better" (unmeasurable).
- Good: "Add JWT authentication with refresh token support" (specific).
- Good: "Migrate the user table to PostgreSQL with zero downtime" (measurable).

### 3. Actionability

| Requirement | Check |
| --- | --- |
| Tasks are specific | Clear which file or component is affected |
| No ambiguous tasks | No "investigate" or "figure out" without a scope |
| Dependencies clear | Sequential tasks show logical order |
| Verification present | Each risky step names how it is proven |
| Path is obvious | An executor can start without clarification |

Actionability examples:

- Bad: "Set up the backend" (too vague).
- Bad: "Make it work" (no implementation path).
- Good: "Create `src/auth/jwt.ts` with sign/verify functions" (specific file).
- Good: "Add bcrypt password hashing to `UserService.create()`" (clear scope).

## Severity

Only three levels. Do not invent others.

| Severity | Meaning | Action |
| --- | --- | --- |
| blocker | Missing citations on key decisions, no clear goal, unactionable or contradictory tasks, an assumption the code contradicts | Must be fixed before execution |
| concern | Vague tasks, incomplete phases, missing edge-case handling, no verification step on a risky change | Should be fixed or explicitly accepted |
| nit | Missing notes, unclear ordering, incomplete rationale, wording | Optional |

## Report Format

Return exactly these fields, in this order:

- **STATUS**: one of pass | changes needed | blocked | escalate
- **FINDINGS**: one line per issue, ordered blocker first, each tagged `[blocker]`, `[concern]`, or `[nit]`, with its plan location and the concrete fix you suggest. "none" if the plan passes.
- **VERIFIED**: what you read to check the plan (files opened, assumptions confirmed), separated from inference
- **GAPS**: what you could not judge and why, or "none"

Include at least one substantive observation, positive or negative, so the report cannot be a content-free approval.

## Common Mistakes

- Taking the plan's description of the code as true instead of reading the files.
- Reviewing format or markdown structure instead of content quality.
- Evaluating code style; that is diff review, not plan review.
- Accepting a vague goal or an ambiguous task because the rest of the plan looks good.
- Marking everything a blocker; severity exists to order the fixes, not to dramatize them.
- Skipping the citation check for decisions, which is where most plan defects hide.

## Rules

- Do not execute or modify the plan during review.
- Do not review a diff with this skill; diff review and plan critique stay separate.
- Do not use emoji or severity levels beyond blocker, concern, nit.
- ASCII only in output.
