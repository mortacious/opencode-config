# AGENTS.md

This repository is the user's personal OpenCode configuration directory (`~/.config/opencode/`), not an application. Every file here is loaded by OpenCode at session start and directly shapes the behavior of future sessions. Treat edits as edits to the agent runtime itself.

## Layout

- `opencode.jsonc` - main config: providers, per-agent models/variants, plugin list, MCP servers, `subagent_depth: 2`.
- `agents/*.md` - agent definitions (frontmatter + prompt body). `build.md` is the PRIMARY main agent; its body is the system prompt fed to the main agent every session. `plan.md` is the second primary (plan-mode, read-only). Editing these changes every future session.
- `skills/<name>/SKILL.md` - skill definitions: `plan-review`, `reflect`, `simplify`.
- `commands/` - custom command directory (currently empty; drop command files here).
- `knowledge/web-search-modules/` - search-strategy modules used by the research/web-search flow.
- `plugins/fusion-audit.js` - read-only observability plugin for the Fusion delegation tree. Logs subagent spawns and edit/task tool calls to OpenCode logs under service `fusion-audit`. It does NOT enforce who-does-what; permissions do that.
- `dcp.jsonc` - schema reference for the `@tarquinen/opencode-dcp` plugin (the `compress` tool comes from this).
- `tui.json` - SEPARATE plugin list loaded in the TUI context. The DCP plugin appears in both this and `opencode.jsonc`; keep them in sync when changing plugin sets.
- `package.json` - runtime dep `@opencode-ai/plugin` (used for authoring plugins).
- `profiles/` - profile overlays. Each subdir holds an `opencode.jsonc` that opencode deep-merges on top of the base config when launched with `oc <profile>`. `default/` is identity; `cheap-local/` swaps every agent model to a local Qwen id (placeholder). Travel with the repo via `git pull`.
- `install.sh` - bootstrap script for multi-machine deployment. Checks codegraph is on PATH, runs `npm install` for local deps, reminds about env-var API keys. Idempotent. See `README.md` for the deploy recipe.
- `bin/oc` - bash wrapper that launches opencode under a profile overlay by setting `OPENCODE_CONFIG`. Subcommands: `oc [profile]`, `oc profile list|switch|add|install`. Symlinked onto PATH by `install.sh`.
- `README.md` - deployment recipe and secret-handling notes for cloning this config to a new machine.

## Gitignore policy

`.gitignore` ignores `node_modules` and `bun.lock`. Everything else - including `package.json`, `package-lock.json`, and `.gitignore` itself - is committed. This makes the config dir self-contained for multi-machine deployment: a fresh clone plus `./install.sh` (see `README.md`) installs the local `@opencode-ai/plugin` dependency and checks the codegraph MCP dependency. Do not re-add `package.json` or `package-lock.json` to `.gitignore` - the deployment flow depends on them being tracked.

## The Fusion delegation pattern

Two `mode: primary` agents (`build`, `plan`) own planning, ambiguity calls, and final review. They CANNOT edit files: `edit`, `write`, `apply_patch`, `grep`, `glob`, `list` are all denied. Their `bash` is allowlisted to read-only git (`diff`, `status`, `log`, `show`, `ls-files`, `add`) plus `lint`/`test`/`typecheck`-style commands; `git commit` and `git push` require per-command user approval. They mutate files only by delegating via `task`.

`task` allowlist on the primary agents: ONLY `sidekick`, `explore`, `research`, `design`, `reviewer`, `vision`, `sparring`. The built-in `general` subagent is explicitly excluded - do not route to it.

Subagents (`mode: subagent`):
- `sidekick` - mechanical execution. Full `edit` + `bash`, but cannot `git commit`/`push` (direct and common wrapper forms are denied). Default executor for code changes.
- `design` - frontend/UI. `edit` + `bash` allowed, `external_directory` denied.
- `reviewer` - plan/diff critique. `edit` denied; read-only git + lint/test + `plan-review`/`reflect` skills.
- `research` - read-only research. `webfetch`/`websearch` plus the research-API MCP servers (`semantic-scholar`, `arxiv`, `github`, `dblp`, `sourcegraph`) and `context7`; may delegate onward to `explore`.
- `explore` - read-only. `webfetch`/`websearch` allowed.
- `sparring` - scientific critic. Read-only (no `edit`/`bash`/`task`): `webfetch`, `websearch`, `date`, plus the research-API MCP servers (`semantic-scholar`, `arxiv`, `github`, `dblp`, `sourcegraph`) and `context7` for library-docs verification.

When editing agent definitions, preserve this separation: primaries must stay unable to edit; execution must stay unable to commit.

## Models

Primary agents (`build`, `plan`, `sparring`-as-primary-when-invoked-directly, `reviewer`) use `neuralwatt/glm-5.2` with `reasoningEffort: high` (set in opencode.jsonc `provider.neuralwatt.models.glm-5.2.variants`). `sparring` sets only `temperature: 0.4` in its own frontmatter; its model and variant come from `opencode.jsonc` `agent.sparring` (so the cheap-local profile overlay can swap them). `sidekick`, `explore`, and `research` use `opencode-go/deepseek-v4-flash` max (agentic execution roles). `design` uses `opencode/gpt-5.6-luna` max - a vision-capable model, since the design agent handles UI/screenshots. These per-agent overrides live in `opencode.jsonc` `agent.*`; `sparring` adds only `temperature: 0.4` in its own frontmatter.

## MCP servers

`codegraph` is configured as a local MCP server (`codegraph serve --mcp`). It only returns results for projects that have a `.codegraph/` index; this config dir has none, so queries here need an explicit `projectPath` pointing at an indexed project. The `build` agent is allowlisted to run `codegraph init` and `codegraph update`, and will create or refresh an index in a code project that lacks one before querying it. `gh_grep` and `context7` are also allowlisted for the primary agents via their `mcps:` frontmatter.

Five research-API MCP servers are wired for the `sparring` and `research` subagents only (NOT for `build`/`plan`): `semantic-scholar` (npx `@xbghc/semanticscholar-mcp`, reads `SEMANTIC_SCHOLAR_API_KEY`), `arxiv` (npx `@cyanheads/arxiv-mcp-server`, no key, stdio is the default transport), `github` (official Go binary at `./bin/github-mcp-server`, auto-downloaded into `./bin/` by `install.sh`; invoked as `{env:HOME}/.config/opencode/bin/github-mcp-server stdio --read-only --toolsets repos,issues,pull_requests,users`, reads `GITHUB_PERSONAL_ACCESS_TOKEN`), `dblp` (installed into `./.venv/` by `install.sh` via `uv`, invoked as `{env:HOME}/.config/opencode/.venv/bin/mcp-dblp`, no key), and `sourcegraph` (NOT auto-installed - akbad/sourcegraph-mcp only exposes HTTP/SSE transports, no stdio, so it stays `enabled: false` until manually set up; reads `SRC_ENDPOINT` + `SRC_ACCESS_TOKEN`). The tokens come from the gitignored `.env` via `{env:VAR}` interpolation. The `github` and `dblp` binaries live in the gitignored `./bin/` and `./.venv/` dirs and are referenced via `{env:HOME}` absolute paths in `opencode.jsonc` - they do NOT rely on system PATH. `semantic-scholar` and `arxiv` use `npx -y`, which auto-fetches on first run. See `knowledge/web-search-modules/research-apis.md` for the tool-selection matrix. A sixth local MCP server, `ddgs`, is wired for the `sparring` and `research` subagents alongside the research-API servers: installed into `./.venv/` by `install.sh` via `uv` (`ddgs[mcp]`), invoked as `{env:HOME}/.config/opencode/.venv/bin/ddgs mcp`, no key (scrapes DuckDuckGo). It provides `search_text`, `search_news`, `extract_content`, and other typed search tools - the preferred quota-free general-web search path; `websearch`/`webfetch` are the final fallback. The `build` and `plan` primary agents do NOT have ddgs (or any web search) in their mcps - they delegate search to `research`/`explore`.

## Editing this repo

- This is opencode's own config. Prefer loading the `customize-opencode` skill before non-trivial config edits; it carries the validation rules that matter here.
- There is no build/test/lint for config. Verification = start a new OpenCode session (config and agent/skill definitions load at session start; some plugin changes need a restart).
- `package.json` is committed (see Gitignore policy above). The only dependency is `@opencode-ai/plugin`; `./install.sh` runs `npm install` to populate `node_modules` for plugin authoring on each deployed machine.
- Output must be ASCII only across all agents - the response pipeline mangles non-ASCII bytes (em-dashes, smart quotes, ellipsis characters). Use ` - `, straight quotes, `...`.
- The `Amenable Thor 1` provider block in `opencode.jsonc` contains a hardcoded API key and an internal-IP base URL. Treat it as a secret; do not echo it into commits, diffs, logs, or summaries.
