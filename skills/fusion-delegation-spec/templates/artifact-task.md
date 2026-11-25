# Artifact Task Template

Copy this into a `subagent` delegation for a scientific artifact: a report section, a figure, a table, or a dataset card. Every section is required: fill it, or write "none" with a reason. Delete the guidance comment lines before sending.

## Objective

<!-- One claim and one artifact that carries it. State which section, figure, or table is produced, and which claim it must support. Not "write the results section" but "Figure 3 showing mIoU vs sequence length, supporting the temporal-fusion claim". -->

_Claim: <what the artifact must show>. Artifact: <section, figure, or table>._

## Sources

<!-- Where the numbers come from: experiment output files, prior results, the dataset card. Exact paths, not "our experiments". -->

- Experiment outputs: `<path>` (which run, which metrics file)
- Prior results / baseline numbers: `<path or citation>`
- Literature: `<citation ids or DOIs>`

## Artifact contract

<!-- Target format and location. A figure is a path plus a caption; a section is a path plus a heading; a dataset card is the fields it must carry. -->

- Target: report section | figure | table | dataset card
- Path: `<path>`
- Format: `<markdown / LaTeX / PDF / CSV / image format>`
- Required parts: `<heading, caption, column headers, card fields>`

## Constraints

<!-- Venue and style rules, and the honesty rules that are not negotiable. -->

- Venue / style: `<template, length limit, citation style>`
- No fabricated numbers: every value traces to a source path or an evaluation, never to memory.
- Cite sources: `<citation style and where references live>`; every cited work resolves to an identifier (DOI, arXiv ID, DBLP or Semantic Scholar entry).
- Unresolvable citations: report them under GAPS instead of citing them.
- Do not touch: `<numbers or files outside this artifact>`.

## Verification

<!-- How a reviewer confirms the artifact without trusting the prose. -->

- Numbers reconcile with `<source metrics file>`: state the check you ran.
- Figure is regenerable from `<script + command>`.
- Every claim maps to a verified reference (identifier recorded) or a reported metric; a number with no source, or a citation that does not resolve, is a defect.

## Skills to load

<!-- Skill names the executor must load before starting. Keep this short. -->

- `<skill-name>`

## Model tier

<!-- REQUIRED: a tier name from the injected tier table - the target agent's mapped tier unless the work is clearly harder or cheaper; add a Reason line when it differs. Name a tier only from that table. -->

- Tier: the target agent's mapped tier unless the work is clearly harder or cheaper
- Model override: `<provider>/<model>` from the injected table, or "none - default"
- Reason (only when the tier differs from the target agent's mapped default): <one line>

## Report contract

<!-- What the executor returns, including the reconciliation check. -->

Condensed report - this is input for an expensive orchestrator; no bulk output.

- **SKILLS**: comma-separated ids loaded before starting, or "none"
- **STATUS**: complete | partial | blocked | escalate
- **CHANGES**: one line per file actually written or modified, from the real diff
- **VERIFIED**: max 10 result bullets - the commands run, the reconciliation result with numbers and units, and how the artifact renders or regenerates
- **GAPS**: unsupported claims, missing sources, or "none" - max 5

## Stop conditions

<!-- Stop and escalate instead of guessing. -->

- A required number has no source path or evaluation behind it.
- A citation does not resolve to an identifier.
- The source data contradicts the claim the artifact is meant to support.
- The target format or venue rule is ambiguous in a way this spec does not resolve.
- Producing the artifact would require editing files outside the stated path.
- The scope grows past one artifact. Stop and report partial.
