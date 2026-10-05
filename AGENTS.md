# AGENTS.md

This repository is the user's personal OpenCode configuration directory (`~/.config/opencode/`), not an application. Every file here is loaded by OpenCode at session start and directly shapes the behavior of future sessions. Treat edits as edits to the agent runtime itself.

## Layout

- `opencode.jsonc` - main config: providers, per-agent models/variants, plugins list, MCP servers, `experimental.subagent_depth: 2`.
- `agents/*.md` - agent definitions (frontmatter + prompt body). `build.md` is the PRIMARY main agent; its body is the system prompt fed to the main agent every session. `plan.md` is the second primary (plan-mode, read-only). Editing these changes every future session. `explore.md` overrides the built-in explore subagent, pinning opencode-go/deepseek-v4.1-flash and granting the ddgs MCP server for web searches.
- `skills/<name>/SKILL.md` - skill definitions: `plan-review`, `reflect`, `simplify`, `create-profile`.
- `command/` - custom command directory (slash commands); currently holds `quick.md` only. Drop new command files here.
- `knowledge/web-search-modules/` - search-strategy modules used by the research/web-search flow.
- `plugin-src/fusion-audit/` - local plugin package (deps installed via install.sh, registered as `./plugin-src/fusion-audit` in opencode.jsonc) holding the read-only observability plugin for the Fusion delegation tree. Logs subagent spawns and edit/task tool calls to OpenCode logs under service `fusion-audit`. It does NOT enforce who-does-what; permissions do that.
- `plugin-src/fusion-tools/` - local plugin package with two modules: advisor (a peer reviewer that shadows scoped primary sessions and relays `advise` tool notes back into the primary with severity-based delivery) and fanout (a `fanout` tool that splits a job across parallel worker sessions, each isolated in its own git worktree, with schema-validated results reported back via the workers' `submit_result` tool; worktrees are retained for the parent to integrate).
- `plugin-src/profile-switcher/` - local plugin package (deps installed via install.sh, registered as an options object in opencode.jsonc) for in-session profile switching: the server entry (`index.ts`, plugin id "profile-switcher") exposes the `profile` RPC (list/current/set/populate + `changed`/`populate` events), applies the model subset of `profiles/<name>/opencode.jsonc` overlays as live agent-model transforms with availability fallback (state shared with `bin/oc` via `.active-profile`), and on every switch migrates tracked sessions' persisted models to the new profile's targets via `session.switchModel` (consent-gated to sessions matching the previous profile's target; running sessions keep theirs until the next switch); the TUI entry (`./tui`, plugin id "profile-switcher.tui") adds the `/profile` slash command, the sidebar `Profile: <active>` indicator, and seeds the location's pre-existing sessions into the server tracker via the populate RPC at setup (relayed through the plugin event bus to reach every instance).
- `plugin-src/subagent-view/` - local plugin package (TUI-only; server entry is a no-op stub) that restores the v1-style live subagent visibility removed in v2: a collapsible `Subagents (n)` section in the sidebar (sidebar.content slot, mirrors the built-in MCP section's collapse pattern) listing child sessions of the open session with agent, model, live token/context usage (2s polling; network calls only while a child runs) and cost; rows open the child session on click (router navigate - children are not tab-openable), header keeps the true child total, capped at running + 3 most recent finished.
- `dcp.jsonc` - schema reference for the `@tarquinen/opencode-dcp` plugin (the `compress` tool comes from this).
- `.plans/` (in target projects; never tracked, excluded via `.git/info/exclude`) - per-branch plan/notes document `<branch>.md`: approved plan steps, decisions, progress log, implemented features, open issues, final summary. This repo itself keeps its own `.plans/v2-port.md`.
- `tui.json` - SEPARATE plugin list loaded in the TUI context. The DCP plugin appears in both this and `opencode.jsonc`; keep them in sync when changing plugin sets. On the v2-port branch, opencode v2 ignores tui.json and reads cli.json instead; cli.json mirrors this TUI-only plugin set (the DCP plugin), not the main config's plugins.
- `package.json` - plugin-authoring deps `@opencode-ai/plugin` (v1) and `@opencode/plugin` (v2, used on the v2-port branch).
- `profiles/` - profile overlays. Each subdir holds an `opencode.jsonc` that opencode deep-merges on top of the base config when launched with `oc <profile>`. `default/` is identity; `cheap-local/` pins every agent to Amenable Thor 1/qwen38-flash-next (local internal-IP provider); `secure/` pins build/plan/sparring to lumo-tamer/lumo-max and everything else to the Thor flash id. In-session switching (no restart) is handled by the `profile-switcher` plugin: it applies the model subset of an overlay as live agent transforms, keeps `.active-profile` in sync with `bin/oc`, and surfaces `/profile` + a sidebar indicator in the TUI. Travel with the repo via `git pull`.
- `install.sh` - bootstrap script for multi-machine deployment. Checks codegraph is on PATH, runs `npm install` for local deps, reminds about env-var API keys. Idempotent. See `README.md` for the deploy recipe.
- `bin/oc` - bash wrapper that launches opencode under a profile overlay by setting `OPENCODE_CONFIG`. Subcommands: `oc [profile]`, `oc profile list|current|switch|add|delete|rename|install`, `oc completion <shell>`. Symlinked onto PATH by `install.sh`. Related file: `skills/create-profile/SKILL.md` (profile-management skill).
- `README.md` - deployment recipe and secret-handling notes for cloning this config to a new machine.

## Gitignore policy

`.gitignore` ignores `node_modules` and `bun.lock`. Everything else - including `package.json`, `package-lock.json`, and `.gitignore` itself - is committed. This makes the config dir self-contained for multi-machine deployment: a fresh clone plus `./install.sh` (see `README.md`) installs the local plugin-authoring dependencies (`@opencode-ai/plugin`, `@opencode/plugin`) and checks the codegraph MCP dependency. Do not re-add `package.json` or `package-lock.json` to `.gitignore` - the deployment flow depends on them being tracked.

## The Fusion delegation pattern

Two `mode: primary` agents (`build`, `plan`) own planning, ambiguity calls, and final review. They CANNOT edit files: `edit`, `write`, `apply_patch`, `grep`, `glob`, `list` are all denied. Their `bash` is allowlisted to read-only git (`diff`, `status`, `log`, `show`, `ls-files`, `add`) plus `lint`/`test`/`typecheck`-style commands; `git commit` and `git push` require per-command user approval. They mutate files only by delegating via `task`.

`task` allowlist on the primary agents: ONLY `sidekick`, `explore`, `research`, `design`, `reviewer`, `vision`, `sparring`. The built-in `general` subagent is explicitly excluded - do not route to it.

Subagents (`mode: subagent`):
- `sidekick` - mechanical execution. Full `edit` + `bash`, but cannot `git commit`/`push` (direct and common wrapper forms are denied). Default executor for code changes.
- `design` - frontend/UI. `edit` + `bash` allowed, `external_directory` denied.
- `reviewer` - plan/diff critique. `edit` denied; read-only git + lint/test + `plan-review`/`reflect` skills; may delegate read-only lookups to `explore`.
- `research` - read-only research. `webfetch`/`websearch` plus the research-API MCP servers (`semantic-scholar`, `arxiv`, `github`, `dblp`, `sourcegraph`) and `context7`; may delegate onward to `explore`.
- `explore` - read-only. `webfetch`/`websearch` allowed.
- `sparring` - scientific critic. Read-only (no `edit`/`bash`/`task`): `webfetch`, `websearch`, `date`, plus the research-API MCP servers (`semantic-scholar`, `arxiv`, `github`, `dblp`, `sourcegraph`) and `context7` for library-docs verification.
- `vision` - read-only vision-capable executor that runs a visual-inspection spec provided by the delegating agent (edit/bash/task denied).

When editing agent definitions, preserve this separation: primaries must stay unable to edit; execution must stay unable to commit.

## Session tooling conventions

- `compress` call shape: the tool takes `{topic, content}` where `topic` is a short string and `content` is an ARRAY of range entries, each `{startId, endId, summary}`. Never pass `content` as a plain string - the call fails. `startId` must precede `endId`, and both must exist in the visible context. Inside summaries, reference previously compressed blocks only via their `@bN@` placeholders. Summaries must be dense technical records of the range, not labels.
- Subagent spawns (task/subagent tool) run in the background by default so the session stays responsive to user steering; act on completion notifications instead of polling. Foreground (blocking) spawns are the exception: use them only when the very next step cannot even be formulated without the result.

## Models

All model selection for the agents defined here lives in `opencode.jsonc` `agent.*`; profile overlays may swap those values. Three agent files pin `model:` in frontmatter as self-contained overrides (`explore.md`, `advisor.md`, `worker.md`); config `agents.*` model pins and profile overlays take precedence over them. No other `agents/*.md` frontmatter sets `model` or `variant` - the only other model-related frontmatter key is `sparring`'s `temperature: 0.4`.

- `build`, `plan`, `worker`: `opencode-go/glm-5.3-flash` (no variant).
- `sidekick`: `opencode-go/deepseek-v4.1-flash` (audit-found undocumented switch, kept pending user confirmation; revert = one line).
- `advisor`, `sparring`, `reviewer`, `explore`, `research`: `opencode-go/deepseek-v4.1-flash` (no variant).
- `design` and `vision`: `opencode-go/gpt-5.6-luna` - vision-capable, since design handles UI/screenshots.
- `small_model`: `opencode-go/mimo-v2.6-flash`.

Neither MiMo model declares reasoning-effort variants on models.dev, so do not add `variant` keys to them: an unknown variant fails model resolution at startup. The `provider.neuralwatt.models.glm-5.2.variants` block (`high`, `max`) remains in the config but no agent currently references it.

## MCP servers

`codegraph` is configured as a local MCP server (`codegraph serve --mcp`). It only returns results for projects that have a `.codegraph/` index; this config dir has none, so queries here need an explicit `projectPath` pointing at an indexed project. The `build` agent is allowlisted to run `codegraph init` and `codegraph update`, and will create or refresh an index in a code project that lacks one before querying it. `gh_grep` and `context7` are also allowlisted for the primary agents via their `mcps:` frontmatter.

Five research-API MCP servers are wired for the `sparring` and `research` subagents only (NOT for `build`/`plan`): `semantic-scholar` (npx `@xbghc/semanticscholar-mcp`, reads `SEMANTIC_SCHOLAR_API_KEY`), `arxiv` (npx `@cyanheads/arxiv-mcp-server`, no key, stdio is the default transport), `github` (official Go binary at `./bin/github-mcp-server`, auto-downloaded into `./bin/` by `install.sh`; invoked as `{env:HOME}/.config/opencode/bin/github-mcp-server stdio --read-only --toolsets repos,issues,pull_requests,users`, reads `GITHUB_PERSONAL_ACCESS_TOKEN`), `dblp` (installed into `./.venv/` by `install.sh` via `uv`, invoked as `{env:HOME}/.config/opencode/.venv/bin/mcp-dblp`, no key), and `sourcegraph` (NOT auto-installed - akbad/sourcegraph-mcp only exposes HTTP/SSE transports, no stdio, so it stays `disabled: true` until manually set up; reads `SRC_ENDPOINT` + `SRC_ACCESS_TOKEN`). The tokens come from the gitignored `.env` via `{env:VAR}` interpolation. The `github` and `dblp` binaries live in the gitignored `./bin/` and `./.venv/` dirs and are referenced via `{env:HOME}` absolute paths in `opencode.jsonc` - they do NOT rely on system PATH. `semantic-scholar` and `arxiv` use `npx -y`, which auto-fetches on first run. See `knowledge/web-search-modules/research-apis.md` for the tool-selection matrix. A sixth local MCP server, `ddgs`, is wired for the `sparring`, `research`, and `explore` subagents alongside the research-API servers: installed into its own `./.venv-ddgs/` by `install.sh` via `uv` (`ddgs[mcp]`; a separate venv because mcp-dblp pins `mcp<2` while `ddgs[mcp]` requires `mcp>=2.0`), invoked as `{env:HOME}/.config/opencode/.venv-ddgs/bin/ddgs mcp`, no key (scrapes DuckDuckGo). It provides `search_text`, `search_news`, `extract_content`, and other typed search tools - the preferred quota-free general-web search path; `websearch`/`webfetch` are the final fallback. The `build` and `plan` primary agents have `ddgs` plus `websearch`/`webfetch` enabled for single-shot external lookups (one doc page, one library version, one paper citation). They still delegate multi-source synthesis to `research` to keep their context windows lean.

Web search preference (all agents that have the ddgs server wired): for any web lookup, use the ddgs MCP tools FIRST (`ddgs_search_text`, `ddgs_extract_content`; under Code Mode, `tools.ddgs.search_text` / `tools.ddgs.extract_content`). The built-in `websearch` tool (Exa) is the FALLBACK - reach for it only when ddgs is unavailable, errors out, or returns nothing useful.

## Editing this repo

- This is opencode's own config. Prefer loading the `customize-opencode` skill before non-trivial config edits; it carries the validation rules that matter here.
- There is no build/test/lint for config. Verification = start a new OpenCode session (config and agent/skill definitions load at session start; some plugin changes need a restart).
- `package.json` is committed (see Gitignore policy above). The dependencies are the plugin-authoring packages `@opencode-ai/plugin` (v1) and `@opencode/plugin` (v2); `./install.sh` runs `npm install` to populate `node_modules` for plugin authoring on each deployed machine.
- Output must be ASCII only across all agents - the response pipeline mangles non-ASCII bytes (em-dashes, smart quotes, ellipsis characters). Use ` - `, straight quotes, `...`.
- The `Amenable Thor 1` provider block in `opencode.jsonc` contains a hardcoded API key and an internal-IP base URL. Treat it as a secret; do not echo it into commits, diffs, logs, or summaries.
