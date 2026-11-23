---
name: fusion-planning
description: Use when the orchestrator hands you a settled design summary and asks for an implementation or research plan - turns settled decisions into an ordered, verifiable plan without re-litigating them. Do not use when the problem is still unsettled (settle it with fusion-brainstorming first), for executing the plan, or for auditing a finished diff.
---

# Fusion Planning

## Overview

A plan is the bridge between a settled decision and an executor who shares none of your context.
It is not a restatement of the design and not a place to reopen it: every step names the artifact
it produces, how it is verified, and what it depends on. A plan an executor must interpret is a
plan that will be executed wrong.

## When to Use

- The orchestrator hands you a settled design summary plus binding constraints and asks for an
  implementation or research plan.
- A plan needs to be rebuilt after review found it unactionable.
- Work spans several files, phases, or parallel pieces and needs ordering.

Do not use it to decide the approach (that is the orchestrator's call), to execute steps, or to
critique a plan that already exists (`plan-review` covers that).

## Inputs

- The settled design summary: objective, decisions already made, and their rationale.
- Binding constraints: stack, conventions, review gates, hardware, data, deadlines.
- The branch plan-log path when one exists (`.plans/<branch>.md`).
- Any files, issues, or references the orchestrator names as context.

If a decision is still open, or an interface or acceptance criterion is missing, name it in one
line and stop. Do not invent the missing part.

## Method

1. **OBJECTIVE** - one measurable sentence: the outcome and the evidence that decides it.
2. **Steps** - numbered `Step NN - descriptive title`, each with:
   - the exact files or artifacts to create or change (paths, not abstractions);
   - the interface between steps: signatures, data shapes, config keys, or contracts that the
     next step consumes;
   - how the step is verified: the command and its expected outcome, or the artifact check;
   - `parallelizable: yes` only when no other step writes the same file or consumes its output.
3. **Risks** - the assumptions that could break the plan, each with the cheapest check that would
   falsify it.
4. **Self-check** - load `plan-review` and run its checklist against your own plan. Fix what it
   flags or state why the finding is accepted; do not return a plan you know fails it.

## Output

The plan in your reply, complete and self-contained. No edits, no commits, no delegation, no
state changes. Start the report with the `SKILLS:` line naming every skill you loaded.

## Stop Conditions

- The design is not settled, or a decision the plan depends on is missing: list it and stop.
- The task outgrows the supplied summary (new interface, new file family, changed scope): stop
  and report instead of inventing the missing decision.
- You would need to edit files or run mutating commands to plan: that is out of role.

## Report Format

First line `SKILLS: <ids loaded, or none>`, then exactly these fields:
- STATUS: complete | partial | blocked | escalate
- PLAN: the objective, steps, interfaces, verification per step, parallelizable marks, risks
- VERIFIED: what you checked against the real files or artifacts, separated from what you infer
- GAPS: the missing decision or unverified assumption, or "none"

ASCII only. If STATUS is escalate, put the decision the orchestrator must make in GAPS.
