# AGENTS.md

This repository is the user's personal OpenCode configuration directory (`~/.config/opencode/`), not an application. Every file here is loaded by OpenCode at session start and directly shapes the behavior of future sessions. Treat edits as edits to the agent runtime itself.

If you are working in this repository itself, also read REPO.md: it holds the repo-specific development rules (file layout, gitignore policy, editing rules) and is not loaded automatically.

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

## Global rules

- Output must be ASCII only across all agents - the response pipeline mangles non-ASCII bytes (em-dashes, smart quotes, ellipsis characters). Use ` - `, straight quotes, `...`.
- The `Amenable Thor 1` provider block in `opencode.jsonc` contains a hardcoded API key and an internal-IP base URL. Treat it as a secret; do not echo it into commits, diffs, logs, or summaries.
