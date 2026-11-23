---
name: fusion-commit
description: Use when executing a commit or push task from the orchestrator, or when a task prompt names this skill - stages exactly the listed paths, commits with the message verbatim, and pushes only to the explicit target; a spec that names an integration branch also permits one `git merge --no-ff <branch>`. Do not use for deciding what to commit, for editing files, or for plain merges, rebases, and history rewrites.
---

# Fusion Commit

## Overview

The orchestrator decides when and what to commit; this skill is the execution method for that
decision, run by `sidekick`. The task prompt carries a filled `templates/commit-task.md` spec.
You do not judge the change: verify the preconditions, replay the spec exactly, and report the
resulting hash and ref. The permission surface allows `git add`, `git commit`, and `git push` but
denies force, mirror, ref deletion, amend, hook bypass, and every wrapper form.

## When to Use

- A task prompt names `fusion-commit` and carries a commit spec (Objective, Paths, Message,
  Branch + push target, Preconditions, Verification).
- The orchestrator asks you to stage and commit an already-reviewed change.
- A previous attempt failed on a hook and the orchestrator re-delegated with an adjusted spec.

Do not use it to decide what belongs in a commit, to clean up unrelated changes, or to amend
history. Plain merges, rebases, and rewrites are stop conditions, not commit work; the one
exception is the integration merge below.

## Core Pattern

1. Read the spec. Note the objective, exact paths, verbatim message, branch, push target,
   preconditions, and verification.
2. Verify preconditions before staging: `git status --short` and `git branch --show-current`.
   The branch must be the named branch, and the dirty paths must match the spec's expected tree
   state. An unexpected dirty path is a stop condition, not a cleanup task.
3. Stage only the listed paths, one `git add <path>` per spec entry. Never `git add -A`,
   `git add .`, or a directory the spec did not name.
4. Commit with the message verbatim: `git commit -m "<message>"` (use `git commit -F -` with a
   heredoc for a multi-paragraph message). No `--amend`, no `--no-verify`.
5. Push only when the spec gives an explicit target: `git push <remote> <branch>`. A spec that
   says "no push" stops after the commit.
6. Verify: `git log -1 --format=%H` for the hash, `git status --short` for a clean tree, and the
   push output plus `git rev-parse <remote>/<branch>` for the updated ref.
7. Report the commit hash, the pushed ref, and every command run.

## Integration rule

When - and only when - the commit spec names an integration branch, one merge is permitted for
that branch: `git merge --no-ff <branch>`, exactly once, from the branch the spec names. This is
the only merge form allowed; plain `git merge` (no `--no-ff`), rebases, history rewrites, and any
second merge of the same branch stay forbidden and are stop conditions. Report the resulting
commit graph line (`git log --oneline --graph -5`) together with the merge commit hash, so the
orchestrator can verify the integration read-only.

## Quick Reference

| Allowed | Forbidden |
| --- | --- |
| `git status --short`, `git diff --cached` | `git commit --amend ...` |
| `git add <exact path>` | `git commit --no-verify ...` |
| `git commit -m "<message>"` | `git add -A`, `git add .` |
| `git push <remote> <branch>` | `git push --force`, `-f`, `--force-with-lease` |
| `git log -1`, `git show`, `git rev-parse` | `git push --mirror`, `git push --delete` |
| `git branch --show-current` | `git push origin +main`, `git push origin :branch` |
| | `git -C ...`, `git -c ...`, `git --git-dir ...`, `sh -c "git ..."` |

## Common Mistakes

- Running `git add -A` because the spec paths look like "obviously" the dirty ones. Stage the
  exact list; extra paths are a spec mismatch to report.
- Rewriting the message, typo fixes included, instead of using it verbatim.
- Retrying a failed hook or a rejected push with `--no-verify`, `--force`, or a wrapper command.
- Amending after a failed hook; no commit happened, so retry the same spec once the cause is
  fixed, or report.
- Reporting "pushed" without the ref or the push output that shows it.

## Report

First line `SKILLS: fusion-commit`, then STATUS / CHANGES (commit hash + ref, or "not
committed") / VERIFIED (exact commands and real output) / GAPS. A dirty mismatch, hook failure,
rejected push, or ambiguous target returns STATUS blocked or escalate with the observed output -
never a workaround. ASCII only.
