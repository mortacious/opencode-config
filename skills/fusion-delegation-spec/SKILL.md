---
name: fusion-delegation-spec
description: Use when delegating work in the Fusion two-agent setup - writing a task spec for sidekick, analyst, or reviewer, choosing which specialist owns a piece of work, sizing what to hand off, scheduling parallel dispatches, or judging whether a returned change is really done. Assumes you are the primary agent holding the plan; do not use when you are the executor applying a spec.
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

## Research-mode contract

Scientific delegations carry the same five parts plus four that decide whether the result is reviewable at all. A missing path or an unstated metric turns an experiment into an unreproducible one-off.

1. **Inputs and paths** - dataset roots, sensor configs, calibration files, seeds, and checkpoints, each as an exact path or identifier. "Use the dataset" is not an input; a path plus the split it selects is.
2. **Artifact contract** - the exact output shape: metrics JSON/CSV columns, figure paths, checkpoint naming, log format. Name the file that must exist and the columns or fields it must carry.
3. **Protocol constraints** - compute budget, no train/test leakage, and the fixed protocol (split, preprocessing, hyperparameters) the executor may not tune. State what must stay constant so the number means something.
4. **Verification** - the rerun command, the expected metric range against a named baseline, and the sanity checks (loss decreasing, mask non-empty, residual under a stated bound). "It trained" is not a result. Evidence is an evaluation result versus a named baseline and/or a reference verified to exist with its identifier recorded; a reference that does not resolve is reported as a gap, never cited silently.

Do not spec the model internals or the analysis narrative; those stay the executor's judgment inside the contract. Do spec anything whose variation would make two runs incomparable. Copy `templates/experiment-task.md` for a run and `templates/artifact-task.md` for a section, figure, table, or dataset card.

## Quick Reference

| Work | Owner | Notes |
| --- | --- | --- |
| Mechanical edits, refactors, find-and-replace, lint fixes, tests | sidekick | Default executor; full edit + shell |
| Commit or push execution after you have decided and verified the change | sidekick (`fusion-commit`) | Executes the exact commit spec; you verify the hash/ref |
| Visual/UI implementation - components, layout, styling | sidekick | Same shell; runs on the vision tier and loads the design skill the task names |
| Broad codebase search and structure questions | analyst | Read-only; keeps raw search output out of your context |
| Multi-source external research and synthesis | analyst | Single-shot lookups you do yourself |
| Ordered plan from a settled design summary | analyst | Task names `fusion-planning` |
| Reading an image, screenshot, or PDF you cannot see | analyst | Vision tier; task names the inspection questions |
| Plan critique before implementation, diff audit before commit | reviewer | Read-only; critiques a position, does not supply one |
| Red-team pass on approach, architecture, tradeoffs | analyst | Task names `fusion-sparring`; real decisions only, not syntax checks |
| Parallel fanout across isolated worktrees | worker | Plugin-created only; never dispatch it directly |

Positive and negative cases per role are in `references/agent-routing.md`.

## Token Economy

The expensive model's reasoning is the scarcest resource. Spend it on decisions, not on work a cheap model does equally well. You are the leader: you decide, the worker produces, and only the condensed result comes back.

- **Delegation threshold.** Delegate whenever a request needs more than ~2 of your own tool calls, more than ~3 files, or any file over ~150 lines. Below that, do it yourself; above it, dispatch.
- **Condensed-report contract.** Every dispatch names the report shape from its template; a child that returns bulk gets re-delegated asking for the summary, never read wholesale.
- **Cut convention-restating tokens.** A spec carries decisions, acceptance criteria, and stop conditions only. Anything the child can derive from the repo, the skill catalog, or its own template is deleted.
- Discovery goes to `analyst`. You receive condensed findings; raw search output never enters your context.
- Fast single-shot external lookups you do yourself, preferring the `ddgs` MCP (`search_text`, `extract_content`) - it is quota-free; `websearch` is the fallback. When uncertain about any external fact (API shape, deprecation, current version, benchmark), search instead of guessing.
- Multi-source research with synthesis goes to `analyst`, so the raw sources never occupy your context.
- Diff audit goes to `reviewer` by default. Re-read the diff yourself only when it touches logic you decided, and then only the lines in question.
- `analyst` red-team passes are for real calls - technology choices, architecture tradeoffs, novel approaches. Skip them for mechanical changes with no decision on the line.
- Commit and push are staged work, not reasoning work: delegate their execution to `sidekick` with `templates/commit-task.md` and verify the returned hash yourself.

### Pruning discipline

- Prune at step close, or before starting a new major task - not mid-thought.
- Prune only closed spans: exploration that ended, decisions that landed, verified work. Never prune open questions or the task in front of you.
- Carry decisions forward in the replacement summary via `(bN)` references; a block's content that still binds belongs in the summary, not in the transcript.
- The plan log is the durable record. If a fact matters after compaction and is not in `.plans/<branch>.md`, write it there before pruning.
- Boundary ids (`mNNNN`, `bN`) are renumbered on every dispatch in the fork: read the currently visible tags and never reuse ids from an earlier call.

## Parallel Work

Independent tasks go out in one message; opencode runs multiple `subagent` calls concurrently. Dependent tasks are sequential, and tasks that edit the same file are sequential to avoid conflicts. Review each returned change individually before final verification.

- **Parallel:** three lint errors in three different files -> three sidekick tasks in one message, one per file.
- **Sequential:** task B needs task A's result, or both tasks edit the same file.

## Task Sizing

One concern per task, small enough to finish in a single focused executor session.

- Split the work when it would touch more than ~3 files, produce more than ~3 artifacts, mix unrelated concerns, need more than one session, or carry more than one experiment. One concern per task means one experiment per delegation in scientific work. Send the pieces as separate delegations and track the sequence in the branch plan log, one log step per delegation.
- A task is too big when you could not meaningfully steer it mid-flight.
- Prefer parallel small tasks over one serial large task whenever the pieces are independent.

## Model Tiers

Every profile authors `profiles/<name>/tiers.json`, mapping four tiers to literal model ids and every agent to a default tier. `scripts/tiers-sync.mjs` expands that mapping into the profile's generated agent pins, and fusion-bootstrap injects the active table into primary context. Pick a tier on every delegation and pass its model id as the `subagent` call's `model` parameter when overriding.

- **big** - hard reasoning: novel design, ambiguous tradeoffs, study design and statistical analysis, whole-branch final review.
- **medium** - default implementation, routine review, research synthesis.
- **small** - clearly mechanical work: single-file edits, find-and-replace, mechanical data conversion, plot regeneration.
- **vision** - any task whose input includes images, screenshots, or diagrams; a modality constraint, not a size step.

Default to the delegating agent's tier from the injected table. Downgrade for clearly mechanical work, and escalate one size on fix-loop round 2+ (a failed first pass means the task was mis-sized) - but never below the modality requirement: a vision task stays on the vision tier. Final whole-branch review always uses `big`. Turn count beats token price: a cheap model that needs three rounds costs more wall-clock and more of your context than one pass on the right tier.

## Steering

Spawn executor subagents in the background by default, keep the returned session id, and send follow-up corrections as soon as you see drift instead of waiting for the task to finish wrong. Steering is one channel with two entry points: the `steer` tool (target a direct child by session id or agent name; delivery `steer` interrupts now, `queue` waits for its current step) and the typed command `/steer [agent|session-id] <message>`; bare `/steer` opens a picker over the session's direct children (running first), then prompts for the message. If several children match an agent name and more than one is running, the command lists the candidate ids rather than guessing - retarget by id. Every steer is recorded as a `type:"steer"` line in the fusion channel log and surfaced to the orchestrating session as a synthetic aside, so a delivery means that child's instruction set changed. Go foreground (blocking) only when the very next decision cannot be made without the result. Keep your own context lean: raw output and long exploration stay in the child session. Children push discoveries back through the `report` tool (kind `note|question|blocker`), which writes a durable channel-log line and mirrors the message live; a child's blocker you must act on arrives mid-run, not only in its final report.

## Common Mistakes

- **Delegating the decision.** "Figure out the best approach and implement it" hands your judgment to an executor that cannot make it. Decide first, then delegate what is left.
- **Spec by code paste.** A spec full of function bodies spends expensive tokens and removes the executor's chance to find a better path. Use acceptance criteria.
- **Trusting the executor's summary.** A report that says tests pass is a claim until a command you ran shows it.
- **Reviewing the wrong thing.** Review the diff against your plan, not just the latest hunk.
- **Serializing everything.** Independent work sent one task at a time wastes wall-clock time.

## Rules

- **You decide; delegate execution to `sidekick` with `templates/commit-task.md` and `fusion-commit` in Skills to load; verify the hash/ref yourself.** Never let any other agent commit, and never perform the commit yourself.
- **Use the `workdir` parameter, not `cd`, `git -C`, or `npm --prefix`.** It keeps the command and its directory in separate fields instead of encoding the path in the command string.
- **Never use `shell` to write files.** Delegate file changes to sidekick, visual work included. `codegraph init` and `codegraph update` are the sanctioned exception: they produce an index artifact, not source edits.
- **`read` is for review, not discovery.** A lone `read` does not replace delegated exploration: send discovery to `analyst` so raw search output stays out of your context.
- **Ignore rules can hide paths.** Grep and glob silently skip gitignored paths, and `git diff` omits ignored untracked files, so "zero matches" is not proof of absence. Work from explicit paths and lint/test output when ignored areas matter.
- **Verify against real command output.** Claims of success are unverified until a command you ran shows it.
- **Do not narrate the permission model.** Describe the work, not your restrictions.
- **Be concise, and ASCII only.** No walls of text, no smart quotes or em-dashes.

## References

- `references/spec-contract.md` - full contract detail, allowed vs forbidden spec content, pre-send gate, retry policy.
- `references/agent-routing.md` - per-role delegate and don't-delegate guidance.
- `templates/` - dispatch skeletons to copy: `executor-task.md`, `review-task.md`, `research-task.md`, `exploration-task.md`, `plan-task.md`, `sparring-task.md`, `experiment-task.md`, `artifact-task.md`, `commit-task.md`.
