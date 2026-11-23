---
name: plan-review
description: Use when reviewing an implementation plan before execution - checking that decisions are sourced, the plan is complete, and its tasks are actionable. Reports findings as blocker / concern / nit against the plan's own steps. Do not use for auditing a code diff (use fusion-code-review) or for executing the plan.
---

# Plan Review

## Overview

A plan is ready when another agent can execute it without re-deriving the decisions: the goal is measurable, the steps are ordered and specific, and its assumptions are checked against the artifacts (code, data, prior results) rather than restated.

## When to Use

- Before execution starts on a non-trivial or risky plan.
- When auditing plan quality after it was drafted.
- When a retry loop suggests the plan, not the executor, is the problem.

Do not use for diff review, style review, or for executing or editing the plan.

## Core Pattern

1. Read the plan and list every claim it makes about the current artifacts (code, data, prior results).
2. Check those claims against the files the plan references - do not take the plan's word for the artifacts.
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
| Literature is cited | Claims about prior work or the state of the art resolve to a reference id, a DOI, or a paper section |
| Citations are verified | Each cited work was looked up and resolved to an identifier (DOI, arXiv ID, DBLP or Semantic Scholar entry) recorded in the plan |
| Prior results are sourced | Each baseline number names the paper table, figure, or run output it came from |

Red flags:

- A decisions table with empty or `-` in the source column.
- Claims like "industry standard" with nothing behind them.
- Research tasks marked complete with no cited source.
- "State of the art" or "unlike prior work" with no reference behind it.
- A citation with no identifier, or one that does not resolve on lookup.

### 2. Completeness

| Requirement | Check |
| --- | --- |
| Goal is specific | Measurable outcome, not vague intent |
| Phases are logical | Sequential, with clear progression |
| Edge cases considered | Error handling and failure modes addressed |
| Assumptions checked | Claims about the artifacts (code, data, prior results) match what is actually there |
| Decisions captured | Key choices recorded with rationale |
| Goal is a hypothesis | The goal states a claim and the measurable metric that decides it |
| Data provenance checked | The dataset source, license, and availability are named |
| Compute checked | The plan fits the stated hardware and time budget |
| Artifacts defined | The outputs - report section, figure, metrics file, code release - are named |

Goal examples:

- Bad: "Improve authentication" (vague).
- Bad: "Make it better" (unmeasurable).
- Good: "Add JWT authentication with refresh token support" (specific).
- Good: "Migrate the user table to PostgreSQL with zero downtime" (measurable).
- Bad: "Study segmentation quality" (no hypothesis, no metric).
- Good: "Show temporal fusion beats the frame-only baseline by at least 2 mIoU on split B, averaged over 3 seeds" (hypothesis plus metric).

### 3. Actionability

| Requirement | Check |
| --- | --- |
| Tasks are specific | Clear which file or component is affected |
| No ambiguous tasks | No "investigate" or "figure out" without a scope |
| Dependencies clear | Sequential tasks show logical order |
| Verification present | Each risky step names how it is proven |
| Path is obvious | An executor can start without clarification |
| Protocol is specified | Data splits, baselines, ablations, and the statistical test are named per step |
| Verification is quantitative | Expected metric range against a named baseline plus seeds, and/or cited references resolved to an identifier |

Actionability examples:

- Bad: "Set up the backend" (too vague).
- Bad: "Make it work" (no implementation path).
- Good: "Create `src/auth/jwt.ts` with sign/verify functions" (specific file).
- Good: "Add bcrypt password hashing to `UserService.create()`" (clear scope).
- Bad: "Run the experiments and see what works" (no protocol).
- Good: "Train on split A, evaluate on split B against baseline `<name>`, seeds 0-2, report mean and std to `metrics.json`" (protocol plus quantitative verification).

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

- Taking the plan's description of the artifacts as true instead of reading the files.
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
