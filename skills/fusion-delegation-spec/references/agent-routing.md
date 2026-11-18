# Agent Routing Reference

Judgment-heavy work stays with the primary. Route mechanical work to the specialist that fits. Each role below carries the positive and the negative case, because a wrong delegation costs a full round trip plus a lost decision.

## sidekick - mechanical execution

Mechanical edits, refactors, find-and-replace, lint fixes, tests, applying a precise spec. Default executor for writing code.

- Delegate when: the change is mechanical and you can name the exact files and the exact edit.
- Don't delegate when: intent is ambiguous, the approach is undecided, or the judgment is the deliverable. Decide first, then delegate what is left.

## explore - codebase search

Read-only codebase search and structure questions.

- Delegate when: you need to find where something lives, which files match a pattern, or how a module is wired.
- Don't delegate when: you already know the exact path and only need to review it - `read` that file yourself.

## research - external information

Web search, docs, libraries, version-specific or current facts. Read-only, no edits.

- Delegate when: the answer requires multi-source synthesis (literature review, comparative benchmarks, "summarize the field"). Single-shot lookups (one doc page, one library version, one paper citation) you do yourself via `ddgs`/`websearch` - save `research` for synthesis work where its larger context window earns the delegation.
- Don't delegate when: the answer is in the codebase (that is explore), or you are really asking it to pick the approach for you.

## design - visual implementation

Frontend/UI implementation. Loads design skills, edits files, runs dev/build tooling.

- Delegate when: the work is visual - components, layout, styling, design-system alignment.
- Don't delegate when: the product or information-architecture call is still open, or the change is non-visual plumbing that belongs to sidekick.

## reviewer - plan critique and diff audit

Critiques a plan before implementation (gaps, risky assumptions, simpler alternatives) and audits a diff before commit (correctness, scope creep, security). Read-only plus lint/test. The primary still runs the final verification.

- Delegate when: the plan is non-trivial or risky, or the diff is large enough that a second pass pays for itself.
- Don't delegate when: you have not settled the plan yet. A reviewer critiques a position; it does not supply one.

## vision - image reading

Optional image extraction when the main model lacks vision.

- Delegate when: the task depends on an image, screenshot, or PDF you cannot read yourself.
- Don't delegate when: the image is already described in context, or no visual input is involved.

## sparring - red-team critique

Relentless critic of architecture, technology choices, design tradeoffs, and novel approaches, argued against SOTA papers and production evidence. Read-only, no edits.

- Delegate when: the plan involves a technology choice, a non-obvious architecture decision, a design tradeoff, a novel approach, or any claim that could be wrong. Default to a red-team pass before executing any non-trivial plan. Also delegate when the user is still working out a concept and needs a thinking partner that pushes back.
- Don't delegate when: you need mechanical code review, syntax checks, or general QA. Sparring challenges the approach and the assumptions, not the code syntax. Use `reviewer` for plan-structure critique and diff audit.

## Routing rules of thumb

- Delegate the doing, keep the deciding.
- If you cannot finish the five-part spec, the missing piece is a decision you owe - not work to hand off.
- The `subagent` permission controls delegation. A specialist may delegate onward only where its own permissions allow it - for example reviewer -> explore - per each agent file.
- The `subagent` permission lists the named roles a primary may dispatch; the built-in `general` subagent is not on that list and should not be used.
