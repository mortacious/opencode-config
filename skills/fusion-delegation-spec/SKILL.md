---
name: fusion-delegation-spec
description: Use when delegating work in the Fusion two-agent setup - writing a task spec for sidekick, design, explore, research, or reviewer, choosing which specialist owns a piece of work, sizing what to hand off, scheduling parallel dispatches, or judging whether a returned change is really done. Assumes you are the primary agent holding the plan; do not use when you are the executor applying a spec.
---

# Fusion Delegation Spec

## Overview

You hold the plan, the judgment calls, and the final verification; specialists do the doing. Delegation is a contract, not a wish: the executor shares none of your context, so a vague goal produces a bad guess and a complete contract produces a correct change.

## When to Use

- Before any `subagent` call that dispatches execution, review, research, or exploration work.
- When choosing which specialist owns a piece of work, or whether it stays with you.
- When scheduling several pieces of work and deciding what can run in parallel.
- When judging whether a returned change is actually done.

Keep judgment-heavy work yourself: ambiguous intent, design decisions, and cross-cutting tradeoffs are the deliverable, not something to delegate.

## Core Pattern

Every execution delegation carries five parts. If you cannot write all five, the decision is not ready - that is your work, not a gap to hand the executor.

1. **Objective** - what to build or change, in one or two sentences.
2. **Files** - exact paths to create or modify.
3. **Interfaces** - the signatures, types, function names, or API shapes the code must match.
4. **Constraints** - project conventions to follow, and specifically what not to touch or change.
5. **Verification** - the exact command(s) that prove it works, and the expected outcome.

Spec the contract, not the implementation: objectives, files, interfaces, constraints, and verification must be unambiguous, while helper structure, internal names, control flow, and how the contract is met stay the executor's choice. Over-specifying regresses the executor to a typist and burns the expensive model's tokens on code a cheap model writes well.

Allowed in a spec: exact file paths; public names being created or renamed; a single-line signature or type declaration only when callers or tests fix it; short (under 10 lines) quotes of existing code, labeled as context; exact error strings to match; verification commands with expected outcomes; a small data-shape example.

Forbidden in a spec: function or method bodies, step-by-step control flow, invented test bodies or assertion values, layouts derivable from conventions, pseudo-code longer than three lines describing HOW.

Express intent as acceptance criteria instead: "returns X when Y", "preserves Z across the refactor", "does not touch file W". Full contract detail, the allowed/forbidden reasoning, and the pre-send gate live in `references/spec-contract.md`.

## Quick Reference

| Work | Owner | Notes |
| --- | --- | --- |
| Mechanical edits, refactors, find-and-replace, lint fixes, tests | sidekick | Default executor; full edit + shell |
| Visual/UI implementation - components, layout, styling | design | Visual work goes here, not to sidekick |
| Broad codebase search and structure questions | explore | Read-only; keeps raw search output out of your context |
| Multi-source external research and synthesis | research | Single-shot lookups you do yourself |
| Plan critique before implementation, diff audit before commit | reviewer | Read-only; critiques a position, does not supply one |
| Red-team pass on approach, architecture, tradeoffs | sparring | Real decisions only, not syntax checks |
| Reading an image, screenshot, or PDF you cannot see | vision | Only when visual input matters |

Positive and negative cases per role are in `references/agent-routing.md`.

## Token Economy

The expensive model's reasoning is the scarcest resource. Spend it on decisions, not on work a cheap model does equally well.

- Discovery goes to `explore`. You receive condensed findings; raw search output never enters your context.
- Fast single-shot external lookups you do yourself, preferring the `ddgs` MCP (`search_text`, `extract_content`) - it is quota-free; `websearch` is the fallback. When uncertain about any external fact (API shape, deprecation, current version, benchmark), search instead of guessing.
- Multi-source research with synthesis goes to `research`, so its larger context window earns the delegation.
- Diff audit goes to `reviewer` by default. Re-read the diff yourself only when it touches logic you decided, and then only the lines in question.
- `sparring` is for real calls - technology choices, architecture tradeoffs, novel approaches. Skip it for mechanical changes with no decision on the line.

## Parallel Work

Independent tasks go out in one message; opencode runs multiple `subagent` calls concurrently. Dependent tasks are sequential, and tasks that edit the same file are sequential to avoid conflicts. Review each returned change individually before final verification.

- **Parallel:** three lint errors in three different files -> three sidekick tasks in one message, one per file.
- **Sequential:** task B needs task A's result, or both tasks edit the same file.

## Task Sizing

One concern per task, small enough to finish in a single focused executor session.

- Split the work when it would touch more than ~3 files, mix unrelated concerns, or need more than one session. Send the pieces as separate delegations and track the sequence in the branch plan log, one log step per delegation.
- A task is too big when you could not meaningfully steer it mid-flight.
- Prefer parallel small tasks over one serial large task whenever the pieces are independent.

## Steering

Spawn executor subagents in the background by default, keep the returned session id, and send follow-up corrections as soon as you see drift instead of waiting for the task to finish wrong. Go foreground (blocking) only when the very next decision cannot be made without the result. Keep your own context lean: raw output and long exploration stay in the child session.

## Common Mistakes

- **Delegating the decision.** "Figure out the best approach and implement it" hands your judgment to an executor that cannot make it. Decide first, then delegate what is left.
- **Spec by code paste.** A spec full of function bodies spends expensive tokens and removes the executor's chance to find a better path. Use acceptance criteria.
- **Trusting the executor's summary.** A report that says tests pass is a claim until a command you ran shows it.
- **Reviewing the wrong thing.** Review the diff against your plan, not just the latest hunk.
- **Serializing everything.** Independent work sent one task at a time wastes wall-clock time.

## Rules

- **Never delegate `git add`, `git commit`, or `git push`.** You perform them after review; executors cannot commit or push.
- **Use the `workdir` parameter, not `cd`, `git -C`, or `npm --prefix`.** It keeps the command and its directory in separate fields instead of encoding the path in the command string.
- **Never use `shell` to write files.** Delegate file changes to sidekick or design. `codegraph init` and `codegraph update` are the sanctioned exception: they produce an index artifact, not source edits.
- **`read` is for review, not discovery.** A lone `read` does not replace delegated exploration: send discovery to `explore` so raw search output stays out of your context.
- **Ignore rules can hide paths.** Grep and glob silently skip gitignored paths, and `git diff` omits ignored untracked files, so "zero matches" is not proof of absence. Work from explicit paths and lint/test output when ignored areas matter.
- **Verify against real command output.** Claims of success are unverified until a command you ran shows it.
- **Do not narrate the permission model.** Describe the work, not your restrictions.
- **Be concise, and ASCII only.** No walls of text, no smart quotes or em-dashes.

## References

- `references/spec-contract.md` - full contract detail, allowed vs forbidden spec content, pre-send gate, retry policy.
- `references/agent-routing.md` - per-role delegate and don't-delegate guidance.
- `templates/` - dispatch skeletons to copy: `executor-task.md`, `review-task.md`, `research-task.md`, `explore-task.md`.
