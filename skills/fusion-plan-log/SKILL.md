---
name: fusion-plan-log
description: Use when creating or updating a branch plan log (.plans/<branch>.md) after completing a plan step - keeps entries to a strict one-to-two-line grammar instead of a changelog. Do not use for one-off changes with no plan, or for recording detail that belongs in a commit message or a review finding.
---

# Fusion Plan Log

## Overview

The plan log is a control record, not a changelog. It exists so any agent - or the same agent after compaction - knows where the work stands in seconds. Conversation memory does not survive compaction; the log does.

## When to Use

- Creating `.plans/<branch>.md` at the start of a multi-step task.
- Closing a plan step and recording its outcome.
- Recording a decision that later steps depend on.
- Resuming after compaction and needing the current state.

Do not use a plan log for a one-off change, and do not use it as a place to reproduce specs, diffs, or command output - reference those by path or commit hash instead.

## Core Pattern

### The entry grammar (required)

A step entry is one line, at most two:

`- <YYYY-MM-DD> Step NN - <title>: <one-line outcome>; verified: <command> => pass/fail`

A decision entry is one line:

`<what> - <why>; rejected: <alternative>`

Nothing else belongs in an entry. If a fact does not fit the grammar, it belongs in a file the entry points to, not in the log.

### Sections

- **Live sections - `## Plan`, `## Next step`:** the primary rewrites these wholesale at step close. They always describe the current state, never history.
- **Cumulative sections - `## Decisions`, `## Progress log`, `## Implemented`:** append-only. Each entry is a single line in the grammar above; existing lines are never rewritten or reordered.

### Division of labor

- The **executor** appends filled entry-slots only - the step entry, and a decision entry when a decision was made - and touches nothing else.
- The **primary** rewrites the live sections (`## Plan`, `## Next step`) at step close, and is the only party that restructures the file.

### Prohibited in any log entry

- Code blocks of any kind.
- Pasted command output.
- Narratives or multi-paragraph status reports.
- Quoted spec text, diff text, or review findings.
- Non-ASCII characters - plain ASCII only, with ` - ` instead of em-dashes.

Reference the file path (`path:line`), the commit hash, or the review finding id instead of reproducing it.

### Size gate

`scripts/validate-config.mjs` fails any `.plans/*.md` over 10 KB (10240 bytes). A log that approaches that ceiling is carrying reproduced detail - cut it back to entries and references, or archive closed steps out of the live file.

## Common Mistakes

- **Pasting the verification output.** The grammar wants `verified: <command> => pass/fail`, not the command's transcript.
- **Writing a paragraph where one line fits.** If it takes two sentences, it is a decision entry plus a reference, not narrative.
- **Quoting the spec or the diff.** The log records what happened; the spec and diff already record what was asked and what changed.
- **Rewriting cumulative sections.** Decisions and progress entries are append-only; rewriting them destroys the audit trail compaction relies on.
- **Leaving live sections stale.** A step close that updates only the progress log leaves `## Next step` pointing at finished work.
- **Growing past the size gate.** Every reproduction pushes the file toward the limit that will fail validation.
- **Logging trivial steps.** Not every action is a step; log the ones in the plan, plus decisions later steps depend on.
