# Agent Routing Reference

Judgment-heavy work stays with the primary. Route the doing to the specialist that fits. Each role below carries the positive and the negative case, because a wrong delegation costs a full round trip plus a lost decision.

The roster is three capability shells: `sidekick` (execution), `analyst` (read-only generalist), and `reviewer` (audit gate). Task-specific method lives in skills, not in agent files, so the task names the skill the shell must load.

## sidekick - execution

Mechanical edits, refactors, find-and-replace, lint fixes, tests, applying a precise spec, and visual/UI implementation (components, layout, styling, design-system alignment) with any advertised design skill the task names. Also the only shell that executes commits and pushes, through the `fusion-commit` skill after the orchestrator decides.

- Delegate when: the change is mechanical or visual and you can name the exact files and the exact edit.
- Don't delegate when: intent is ambiguous, the approach is undecided, or the judgment is the deliverable. Decide first, then delegate what is left.
- A visual/UI task runs on the vision tier; the design skills carry the craft method.

## analyst - read-only generalist

Codebase exploration, external research, planning from a settled summary, visual inspection, and red-team critique. Never edits, never delegates.

- Delegate when: you need condensed discovery rather than raw search output; multi-source external synthesis; an ordered plan from a settled design (task names `fusion-planning`); an image, screenshot, or PDF you cannot read yourself (vision tier); or an adversarial pass on a design or claim (task names `fusion-sparring`).
- Don't delegate when: you already know the exact path and only need to review it - `read` that file yourself; the decision is still open (settle it with the user first); or you are asking it to pick the approach for you.
- Single-shot external lookups you do yourself via `ddgs`/`websearch`; an exploration task that needs no synthesis stays cheap.
- Planning and red-team tasks must name the skill the analyst loads; the analyst body does not carry a method of its own.

## reviewer - plan critique and diff audit

Critiques a plan before implementation (gaps, risky assumptions, simpler alternatives) and audits a diff before commit (correctness, scope creep, security). Read-only plus lint/test. The primary still runs the final verification.

- Delegate when: the plan is non-trivial or risky, or the diff is large enough that a second pass pays for itself.
- Don't delegate when: you have not settled the plan yet. A reviewer critiques a position; it does not supply one.
- The reviewer may delegate a read-only sweep to `analyst`; nothing else.

## Routing rules of thumb

- Delegate the doing, keep the deciding.
- If you cannot finish the five-part spec, the missing piece is a decision you owe - not work to hand off.
- The `subagent` permission controls delegation. A specialist may delegate onward only where its own permissions allow it - for example reviewer -> analyst - per each agent file.
- The `subagent` permission lists the named roles a primary may dispatch; the built-in `general` subagent is not on that list and should not be used.
