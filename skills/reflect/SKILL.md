---
name: reflect
description: Use when the user asks to learn from past sessions, improve a recurring workflow, review whether a repeated process should become a reusable skill or knowledge note, or identify what should be turned into reusable agent instructions in this config repo. Do not use for one-off debugging, broad architecture review, or speculative agent creation without workflow evidence.
---

# Reflect

## Overview

Reflect is a learning workflow: look back over recent sessions and the assets that shape them, find friction that actually repeated, and recommend the smallest useful fix. The repo is the agent runtime, so every output is a change to config, an agent prompt, a skill, or a knowledge note - or a deliberate decision to change nothing.

## When to Use

Use Reflect when the user asks to:

- learn from recent sessions or repeated workflows;
- find work they keep doing manually;
- review whether a recurring process should become a reusable skill or playbook;
- turn repeated workflow friction into a safer future default;
- audit this config repo against how it is actually used.

Do not use Reflect for ordinary implementation work, one-off debugging, broad architecture review, or speculative agent creation without workflow evidence.

## Evidence Sources

Use available evidence in this order:

1. Current conversation and explicit user instructions.
2. Repo guidance: `AGENTS.md`, `README.md`, and any project-local `AGENTS.md` in a workspace under review.
3. Existing assets: `agents/*.md`, `skills/*/SKILL.md`, `command/*.md`, `opencode.jsonc` (agent models, permissions, MCP servers), `profiles/`, `plugin-src/`, `knowledge/`.
4. Recent opencode sessions: session storage under `~/.local/share/opencode/` - the SQLite database `opencode.db` (tables including `session`, `message`, `part`) and the `storage/session_diff/` directory. Read only when available and safe to inspect.
5. External docs only when the proposal depends on a third-party tool or library whose behavior needs confirmation.

Respect privacy and safety boundaries. Do not inspect unrelated personal files, credentials, private messages, or external accounts unless the user explicitly asks and the workflow requires it. `opencode.jsonc` contains secrets in some provider blocks - never copy a key into a proposal, a commit message, or a summary.

## Core Contract

Reflect must be conservative and evidence-driven:

- inspect existing assets before suggesting new ones;
- prefer recent, repeated, user-visible friction over isolated incidents;
- recommend the smallest useful form;
- treat "create nothing" as a successful result when evidence is weak;
- ask before changing prompts, skills, commands, agents, MCP access, or config;
- avoid duplicating existing assets;
- explain restart requirements for opencode config, prompt, agent, skill, MCP, or plugin changes.

## Workflow

### 1. Inventory existing assets

Before proposing anything, identify what already exists:

- skills under `skills/` - skills are advertised to every agent by default and loaded with the `skill` tool;
- agent prompts and their permission blocks;
- commands under `command/`;
- model routing and profile overlays in `opencode.jsonc` and `profiles/`;
- knowledge notes under `knowledge/`;
- plugin behavior under `plugin-src/`.

If an existing asset already covers the candidate, recommend extending it instead of creating a near-duplicate.

### 2. Find repeated workflow patterns

Look for repeated signals such as:

- the same command sequence appearing across sessions;
- the user repeatedly asking for the same review, setup, release, or debugging process;
- the same manual research or context-gathering steps recurring;
- the same specialist routing decision being needed again and again;
- the same repo-specific rule being re-explained;
- repeated failures caused by an agent lacking a stable instruction, tool, or permission boundary.

Strong candidates usually have at least two occurrences, stable inputs, a clear output, and a clear stopping condition.

### 3. Score candidates

For each candidate, decide:

- **Frequency:** how often has it happened?
- **Cost:** does it waste meaningful time, context, money, or attention?
- **Risk:** does inconsistent execution cause bugs, regressions, bad decisions, or unsafe changes?
- **Stability:** are the inputs and desired output predictable?
- **Coverage:** is there already an asset that handles it well?

Only recommend creating or changing assets when confidence is high.

### 4. Choose the smallest useful form

Pick the least powerful form that solves the repeated problem:

- **Prompt/config rule:** a small behavior change to an existing agent.
- **Skill:** reusable workflow guidance for a task shape.
- **Command:** a repeatable manual trigger with stable inputs.
- **Custom agent:** a distinct specialist lane with clear delegation rules.
- **MCP/tool permission change:** a safe access adjustment for an existing agent.
- **Knowledge note:** human-readable reference for facts an agent needs on demand.
- **Skip:** weak, one-off, ambiguous, sensitive, or already-covered work.

Avoid creating custom agents when a prompt rule or skill is enough. Avoid skills when a short knowledge note is enough. Avoid config changes when the benefit is unclear.

### 5. Propose before changing

Unless the user explicitly requested a specific edit, present a concise proposal before writing files or changing config:

```text
Found 2 strong repeated workflows and 1 weak candidate.

Recommended:
- Add a small prompt rule to agents/<name>.md for <workflow> because <evidence>.
- Extend existing skill <name> instead of creating a new one because <overlap>.

Skip:
- <candidate> because it only appeared once.

Proceed with the proposed edits?
```

When applying changes, preserve existing user settings and prefer narrow, append-only edits.

## Output Format

Return a compact report:

```text
Findings
- <workflow>: evidence, frequency/confidence, recommended form.

Recommended changes
- <asset/config/doc>: one-line purpose and why this is the smallest useful form.

Skipped
- <candidate>: why not worth packaging now.

Needs more evidence
- <candidate>: what would make it actionable.
```

If nothing qualifies, say:

```text
No strong repeated workflow found. I would not add or change any reusable assets
yet.
```

## Guardrails

- Do not manufacture assets to justify the workflow.
- Do not create overlapping skills or agents.
- Do not silently change global config, prompts, or permissions.
- Do not add broad instructions that make agents more eager, expensive, or invasive without a clear benefit.
- Do not overfit to a single session unless the user explicitly asks for that exact reusable workflow.
- Do not use private or sensitive material as examples in generated assets.
- When config, prompt, agent, skill, MCP, or plugin files change, tell the user: "This applies on the next opencode run; restart opencode if you need it immediately."
- ASCII only in all text written to this repo.
