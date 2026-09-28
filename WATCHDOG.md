# Watchdog notes (reviewer-only)

Review priorities for audits in this OpenCode config repository:

- Secrets: the "Amenable Thor 1" provider block in opencode.jsonc contains a hardcoded API key and an internal-IP base URL. Never allow it into diffs, logs, summaries, or reports beyond the provider block itself.
- Agent .md frontmatter (before the closing `---`) must stay byte-identical when the body changes; flag any frontmatter hunk.
- Output pipeline is ASCII-only; flag any non-ASCII byte introduced in agent, skill, command, or config files.
- Scope creep: hunks in files the task did not name. Expected baseline, not creep: the package-lock.json one-line package-name rename and the profiles/cheap-local/opencode.jsonc overlay, in which every agent model is Amenable Thor 1/qwen38-flash-next, are committed state.
- JSONC config edits must keep $schema, comments, and alignment of untouched keys.
- Verification claims must carry real pasted command output; in this repo, prompt/config edits satisfy the gate with a pasted git diff plus a statement that no exercising command exists.
- Model IDs referenced in configs must exist on models.dev or the local provider; unknown variant keys fail model resolution at startup.
