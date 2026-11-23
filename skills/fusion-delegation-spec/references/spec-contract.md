# Spec Contract Reference

Read this when a delegation is complex enough that the five-part summary in SKILL.md is not enough: multi-file changes, interface-sensitive work, or a retry after a miss.

## The five parts, expanded

### Objective

What to build or change, in one or two sentences, plus the reason when the reason constrains the shape of the change. State the outcome, not the steps. If the objective needs two paragraphs, the work should be split into separate delegations.

### Files

Exact paths to create and exact paths to modify, marked as such. Also name the files that must not change when scope is the risk. A path the executor has to guess is a defect: guessing produces a wrong file or a duplicate.

### Interfaces

The contract other code or tests depend on: public names being created or renamed, single-line signatures, type declarations, API shapes, config keys. Quote existing definitions only when the exact shape is pinned by callers, and label the quote as context. Internal helper names, private structure, and control flow are not interfaces - leave them open.

### Constraints

Project conventions to follow (read `AGENTS.md` first where one exists), patterns in neighboring code to mirror, and the explicit not-to-do list: files that must not change, behavior that must be preserved, refactors that are out of scope. The negative list prevents the most common review finding: scope creep.

### Verification

The exact command(s) that prove the change works, run from which directory, and the expected outcome (test count, exit code, expected output). For a repo with no test suite, name the smallest command that exercises the change, or state the manual check. "Make sure it works" is not verification.

## Allowed vs forbidden spec content

| Allowed | Forbidden |
| --- | --- |
| Exact file paths, create vs modify | Function or method bodies |
| Public names being created or renamed | Step-by-step control flow |
| A single-line signature or type declaration fixed by callers or tests | Test case bodies and assertion values you invented |
| Short (under 10 lines) quotes of existing code, labeled as context | HTML, CSS, or markdown layouts derivable from conventions |
| Exact error-message or string literals that must be matched | Pseudo-code longer than three lines describing HOW |
| Verification commands with expected outcomes | The full implementation written out as a script for the executor to retype |
| A small example of a data shape (JSON payload, config keys) | Style preferences the project conventions already cover |

## Acceptance criteria instead of implementations

Phrase intent as observable outcomes. Each criterion should be checkable by reading the diff or running a command:

- "returns X when Y"
- "preserves Z across the refactor"
- "does not touch file W"
- "errors with `MESSAGE` when the input is empty"
- "leaves the existing tests passing unmodified"

Acceptance criteria leave the executor freedom in the internals while giving review something objective to check. When the urge to paste code comes from "it would be faster", the paste costs expensive tokens and removes the executor's chance to find a better path.

## Pre-send gate

Before sending any `subagent` call, re-read the spec once and run this filter:

1. Delete every fenced code block whose content is behavior the executor has not written yet, replacing each with one sentence of behavioral prose describing the same outcome.
2. Keep only single-line pinned signatures and labeled existing-code context.
3. If more than about five lines of new implementation code survive the filter, the spec has already done the executor's job - stop and rewrite the contract instead.

Counting dictation uses per session is fair play: more than one or two means the interface or constraint sections are under-specified.

## Retry policy

- **First miss:** name the specific miss and re-delegate. "It is wrong" forces a guess; "the third case returns the wrong error code, expected `E_NOTFOUND`, got `E_INVALID`" does not.
- **Second miss on the same change:** stop describing and dictate. Author the exact replacement text (file, line range, verbatim code) and delegate that as the spec. Applying a verbatim patch needs no judgment, so this ends the retry loop.
- **Dictated patch still fails verification:** the plan is wrong, not the executor. Revise the plan and restart from the decision.
- **Failure outside the code** (broken environment, flaky test, missing dependency): report the blocker with the real command output instead of looping.

Dictation is an emergency lever, not a habit. If it becomes routine, the contracts are the real defect.

## Readiness test

A complete spec is one the executor can start without guessing the objective, the interface, or the constraints - not one that leaves no implementation choice to the executor. Both failure modes are defects: a vague goal and a dictated implementation.
