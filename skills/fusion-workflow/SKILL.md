---
name: fusion-workflow
description: Use when starting a session or task in the Fusion setup, or when unsure which skill applies - maps each situation to the right skill and gives the order of the workflow. Do not use as a substitute for the mapped skill's own method, and do not use for one-line edits.
---

# Fusion Workflow

## Overview

This config exposes one primary, `orchestrator`, plus thin subagent capability shells (`sidekick`, `analyst`, `reviewer`). `sidekick` executes (including visual work and commits), `analyst` is the read-only generalist (exploration, research, planning, visual inspection, red-team), and `reviewer` is the audit gate. The shells carry permissions and report format; the method lives in skills. Skills are advertised session-wide, so nothing selects one for you: you load the matching skill with the `skill` tool before acting. Loading it is cheap; skipping it means re-deriving a method that already exists here.

The roster and skill catalog are authoritative, discovered from `agents/*.md` and `skills/`; the names and the map below are current examples, so update them as components change.

## When to Use

- At session or task start, before the first tool call on real work.
- When you are unsure which skill applies to the request in front of you.
- When switching phase: design, planning, execution, research, verification.
- When a task prompt names skills - load those first, regardless of this map.

Do not use this skill in place of a specific one. It routes; it does not carry the method.

## Workflow

1. **Settle the problem** - `fusion-brainstorming`. This is a HARD GATE: questions until the problem is settled, not a design guessed from a vague ask. Research mode inside it grounds prior art and the evidence rule applies.
2. **Plan** - for substantial work, dispatch `analyst` with `fusion-planning` in Skills to load and the settled design, then record the plan per `fusion-plan-log`. Critique risky plans with `plan-review` through `reviewer`.
3. **Execute** - `fusion-delegation-spec`. Pick the shell, copy the matching template (`executor`, `review`, `exploration`, `research`, `plan`, `sparring`, `experiment`, `artifact`, `commit`), and fill every slot, including Model tier and Skills to load.
4. **Verify** - real command output or evaluation results, never a summary. Use `fusion-code-review` for diffs and scientific artifacts. Evidence rule: a claim rests on an evaluation or on a literature reference PROVEN to exist by lookup.
5. **Close** - write the plan-log entry, then delegate the commit: load `fusion-delegation-spec`, fill `templates/commit-task.md`, dispatch `sidekick` with `fusion-commit` in Skills to load, and verify the returned hash/ref read-only.

## Situation map

| Situation | Skill |
| --- | --- |
| Vague or brand-new request | `fusion-brainstorming` |
| Multi-step work, or resuming after compaction | `fusion-plan-log` (plus `analyst` with `fusion-planning`) |
| Delegation, task sizing, model tier | `fusion-delegation-spec` |
| Planning an implementation from a settled design | `fusion-planning` through `analyst` |
| Red-team critique of a design, approach, or claim | `fusion-sparring` through `analyst` |
| Visual inspection of an image, screenshot, or PDF | `analyst` on the tier whose description covers image input |
| Implementing or committing a change | `sidekick` (commits via `fusion-commit`) |
| Auditing a code diff or a scientific artifact | `fusion-code-review` |
| Critiquing a plan before execution | `plan-review` |
| External facts, citations, source selection | `fusion-research-methodology` |
| A repeated workflow that should become reusable | `reflect` |
| Clarity refactor with no behavior change | `simplify` |
| Profile, model, or tier changes | `create-profile` |

## Hard rules

- Check the relevant skill before acting on non-trivial work; guessing the method is the failure mode.
- Load every skill your task prompt names, and list them in the report's first line: `SKILLS: <ids, or none>`.
- Evidence is an evaluation you ran or a reference you resolved by lookup. Memory is not evidence.
- Choose the model tier per delegation from the injected tier table; never invent a model id.
- Primaries never edit files. The orchestrator decides what to commit or push and delegates execution to `sidekick` with `fusion-commit`; no other agent commits.
- Only the orchestrator creates or removes git worktrees; execution agents never do, and a worktree task is delegated with the worktree path in both the task template and the `subagent` `workdir`.
- ASCII only: no smart quotes, no em-dashes, no unicode arrows.
- Plan-log entries follow the one-to-two-line grammar, not a changelog.
- Delegate bulk: no orchestrator reads over ~150 lines, no raw output in its context; prune closed blocks at step close.

## Common Mistakes

- Skipping the settle gate to save time, then building the wrong thing correctly.
- Writing a freehand task spec instead of copying the template - unfilled slots become executor guesses.
- Citing a reference without a lookup; a remembered citation is an unverified one.
- Picking a tier from memory instead of the injected table.
- Treating a subagent's "tests pass" line as verification evidence.
- Loading this skill and stopping there when the situation map points at a method skill.
