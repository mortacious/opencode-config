---
name: fusion-brainstorming
description: Use when a new request must become a settled problem before design or planning - software features, refactors, tools or commands, changed agent behavior, and scientific work such as research questions, papers, experiments, or study design. Also use when the user asks for a design discussion. Do not use for a request carrying a complete spec or a settled research plan, a one-line mechanical change, or executing an already approved plan.
---

# Fusion Brainstorming

## Overview

You cannot design what you do not understand, and you cannot propose a study you have not grounded. A first request is rarely a spec: it is the visible part of an outcome, and the decisions under it are yours to surface by asking. Two kinds of work arrive here - changes to software and config, and scientific work: research questions, paper claims, experiments, study designs. The loop is the same; the unknowns it targets are not. In Fusion the primary decides with the user and delegates execution later, so this conversation is the cheapest place to be wrong.

## When to Use

Two modes, one skill:

- **Software and config work:** a new feature, refactor, tool or command, changed agent behavior - any request whose outcome, boundaries, or success criteria are not pinned down.
- **Scientific work:** a research question, a paper or paper section, an experiment, or a study design whose gap, novelty, evidence bar, feasibility, or scope is still open.
- The request leans on a vague quality word ("fast", "simple", "novel", "better") that could mean several things.
- The user asks for a design discussion, or plan mode starts on an unscoped request.

Do not use it for a request that already carries a spec or a settled research plan, for a one-line mechanical change whose only sensible reading is obvious, or for executing an approved plan. When the request is small and clear, restate it in one line, say what you will do, and do it.

## Core Pattern

### 1. Look before you ask

Read what the request points at - the files, the notes or drafts, the plan, the earlier conversation - until you can explain how the relevant parts stand today and what the work would touch. Never ask what the repo, the data description, or the context already answers, and never reopen what the user already decided. Then restate the request in a short paragraph: what, for whom, why, plus anything you found that bears on it.

### 2. The question loop

Ask the user questions until the problem is settled. This is the core of the skill, not a formality before it. Software unknowns are in Quick Reference; scientific unknowns are in Research mode below; the loop rules are the same in both.

HARD GATE: if any aspect of the problem is still unsettled, ask another question instead of proceeding. Do not write the design summary until the problem is well settled.

- One question at a time. A small batch of tightly related questions is acceptable only when they share one context; a questionnaire is not.
- Prefer multiple choice with your recommended option first and one line on why. Use open questions while the why, the users, or the gap are still unknown - the user's own words carry intent that your options cannot.
- Say what the answer will change. A question whose answer would not change what gets built or studied is a decision you should make yourself and state as a proposal the user can correct.
- Challenge vague words. "Fast", "simple", "flexible", "novel", "clean", "better" are not requirements: ask for the number, the case, the comparison, or the closest prior work.
- Never assume a default silently. State the call in one line so the user can reject it.
- Play it back in chunks. Once a part is understood - what it is for, who it serves, how it behaves - echo it in a few lines and ask what is wrong or missing.
- Stop when new questions only restate settled ground. If no remaining answer would change the design or the proposal, the problem is settled.

### 3. Research mode (scientific work)

Same loop and gate; different unknowns. Ask one at a time until each is answered or explicitly deferred:

- **Prior art:** what is already known, and what the user believes is still missing.
- **Gap:** where the opening is, stated as a sentence a skeptical reviewer would accept.
- **Contribution:** what would be new - method, evidence, framing, or application - and why it beats the closest existing work.
- **Evidence bar:** what would convince a skeptical reviewer: baselines, datasets, metrics, ablations, statistical standard.
- **Feasibility:** what the available data, compute, time, and skills actually support.
- **Scope:** position note or short paper vs full study, and the target venue's expectations.

Do not propose research ideas until these are settled. A vague "novel" is an open requirement, not a contribution claim.

**Literature phase, before generating ideas.** Ground the discussion in prior work:

- Quick single-shot lookups - one paper, one citation, one SOTA number - you may do directly with the `arxiv`, `semantic-scholar`, or `ddgs` MCP tools.
- Broader sweeps, comparative surveys, and synthesis go to the `research` agent with the `fusion-research-methodology` skill.
- Mandatory before any idea: related work on the exact task, current SOTA baselines with numbers, and the closest existing contribution, named explicitly. An idea that duplicates the closest work is dropped before it reaches the user, not after.

**Candidate directions, once settled.** Present 2-3, each stated as:

1. Research question.
2. Gap it fills.
3. Contribution claim - what is new.
4. Candidate hypothesis.
5. Rough evaluation plan - data, baselines, metrics.
6. Main risks.

Get the user's pick before proceeding. If a direction is contested, optionally route it through the `sparring` agent for a red-team pass before the gate closes.

**Approved output:** a short research-proposal summary - question, gap, contribution, evaluation sketch. It is what planning records in the branch plan log.

### 4. Approaches, once settled (software mode)

Present 2-3 real candidate approaches in one message, concrete enough to picture, each with what it trades off. Recommend one and say why. Drop options the constraints already rule out. Then ask the user to pick. If there is genuinely one sensible path, say so, explain why the others do not fit, and still get the user's nod.

### 5. Approval

Write the summary for explicit approval - a message, not a document. Software mode: intent and why; goals and non-goals; constraints; the chosen approach and why; the calls you made; what is left to the builder. Research mode: question, gap, contribution, evaluation sketch, risks, and the calls you made.

HARD GATE, both modes: nothing gets designed further, planned, or built until the user approves. Reading and exploring are fine; edits, delegation, and planning are not. In research mode, no experiment, data collection, or paper drafting starts before the research-proposal summary is approved; the approved summary goes into the branch plan log at `.plans/<branch>.md` per the `fusion-plan-log` skill (the first execution step seeds the log when it does not exist).

"Sounds good" to an idea is not approval of a summary the user has not seen. Any change to the summary restarts this step.

### 6. Hand off to planning

After approval, the summary is the input to planning, not execution. The plan artifact is the branch plan log at `.plans/<branch>.md` per the `fusion-plan-log` skill. Execution is delegated only after the plan is approved, per `fusion-delegation-spec`.

## Quick Reference

Software-mode unknowns to pin down:

| Question type | What to pin down | Shape of the ask |
| --- | --- | --- |
| Scope | What must exist when this is done, and what merely may | "Milestone one ships X; is Y part of it or a later step?" |
| Users | Who this serves and what they do today | "Is this for maintainers or for every contributor?" |
| Constraints | What cannot change: compatibility, stack, budgets, conventions | "Must this keep working on the current config format?" |
| Failure cases | What must never happen, and what a bad outcome looks like | "If the sync fails halfway, should it roll back or resume?" |
| Success criteria | How the user will know it worked | "What would you check before calling this good?" |
| Out of scope | What this must not become | "Is migration tooling in scope or explicitly not?" |

Treat these as territory, not a script: pick the questions the request actually leaves open, and build each one on the user's last answer. In scientific work, start from the unknowns in Research mode instead.

## Common Mistakes

- **Skipping the loop because the request seems clear.** A clear request is a clear surface, not a settled problem.
- **Asking what the source already answers.** Exploring is free; a question the files or literature answer spends the user's trust.
- **Proposing a solution or research idea in the first message.** Questions first; an early proposal anchors the work on your guess.
- **Proposing an idea before the literature check.** Novelty is a claim about what exists; check the closest work first or you re-propose it.
- **Treating "novel" as the contribution.** "New" without "different from X in Y way" is not a claim a reviewer can assess.
- **Assuming the data or compute is enough.** Feasibility is an unknown to ask about, not a hope to design around.
- **Ten questions in one message.** It reads as a form, earns partial answers, and hides which answers matter.
- **Accepting a vague word.** "Fast" without a number is an open requirement, not an agreed one.
- **Silent defaults.** A default the user never heard is one they could not reject.
- **Taking "sounds good" as approval.** Approval covers the summary they actually saw; an idea is not a summary.
- **Turning the summary into a document.** The approval artifact is a short message; the durable artifact is the branch plan log, written at planning.
- **Handing the design straight to an executor.** Planning comes first; execution is delegated after the plan is approved.

## Red Flags

| Thought | Reality |
| --- | --- |
| "The request seems clear, skip the questions" | Clarity is your reading of it. Ask the one question whose answer would change the build. |
| "Asking wastes the user's time" | One wrong build costs more than five questions; the loop is the cheap part. |
| "I will assume the obvious default" | Say it out loud. A default they never heard is one they could not reject. |
| "I already know what they want" | You know what you would want. Those differ exactly where the design will. |
| "The idea is obviously novel" | Novelty is checked against the closest work, not felt. Name that work first. |
| "The data should be enough" | Feasibility is a question; ask before the evaluation plan rests on it. |
| "I will present the design, then ask" | Approaches and questions come before design; approval comes after it. |
| "They said it sounds good" | That approves what they saw, not a summary they have not read. |
| "This is research, so the gate does not apply" | The gate covers both modes; the approved output is the proposal summary. |
| "They told me to just build it" | Then ask the one question that would change the outcome, state your calls in a line, and proceed - in build mode. |
| "The problem is settled enough" | Settled means no remaining answer would change the design. Check it against the question lists. |
