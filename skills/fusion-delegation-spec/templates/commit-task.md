# Commit Task Template

Copy this into a `subagent` delegation to `sidekick` after the change is verified. Every
section is required: fill it, or write "none" with a reason. Delete the guidance italic lines
before sending.

## Objective

<!-- One or two sentences: which verified change to record and why, plus the exact commit subject intent. The executor does not re-judge the change. -->

_Record the verified <change> as one commit; no rework._

## Paths

<!-- The exact stage list, one path per line. No directories, no globs, no -A, no ".". Every path must exist in the current tree. -->

- `path/to/file-a`
- `path/to/file-b`

## Message

<!-- Verbatim commit message, including subject and body paragraphs. The executor passes it through unchanged - quote it exactly, typos included. -->

```
<subject line>

<body paragraph(s), or omit>
```

## Branch and push target

<!-- The branch the commit must land on, and the push target. Use the literal "no push" when the change stays local. -->

- Branch: `main`
- Push: `origin main` | no push

## Preconditions

<!-- State the expected tree state and the verification already done, so a mismatch is detectable before staging. -->

- Tests: `<command>` => `<result>` (run by the orchestrator)
- Review: `<reviewer verdict or "not required - small change">`
- Expected tree state: `git status --short` shows only the Paths above as modified; no staged files; no untracked files.
- The commit is a new commit on the named branch - never an amend.

## Verification

<!-- What the returned report must show. -->

- `git log -1 --format=%H` => a new hash, matching the report
- `git status --short` => clean for the listed paths
- When pushed: the push output names the ref, and `git rev-parse <remote>/<branch>` matches the hash

## Skills to load

- `fusion-commit`

## Model tier

<!-- REQUIRED: one of big | medium | small | vision. Mechanical execution, so default to small; override only if the spec needs judgment. -->

- Tier: small
- Model override: `<provider>/<model>` from the injected table, or "none - default"

## Report contract

Condensed report - this is input for an expensive orchestrator; no bulk output.

- **SKILLS**: comma-separated ids of the skills you loaded before starting, or "none"
- **STATUS**: complete | partial | blocked | escalate
- **CHANGES**: the real commit hash and the pushed ref (or "not committed")
- **VERIFIED**: hash + ref + the exact commands only - no output dumps
- **GAPS**: anything unfinished, any ambiguity hit, or "none"

## Stop conditions

<!-- Stop and report instead of working around any of these. -->

- The dirty tree contradicts the Paths list (unexpected dirty, staged, or untracked paths).
- The current branch is not the named branch.
- A pre-commit hook fails: report the hook output; never use `--no-verify` or `--amend`.
- The push is rejected: report the rejection; never force, mirror, or delete a ref.
- The message, branch, or push target is ambiguous, or the spec asks for anything this
  template forbids.
