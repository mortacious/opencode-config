# Research-API MCP Module

> Tool-selection matrix for the five research-API MCP servers wired into opencode
> for the `sparring` and `research` subagents. Load this file with the `read`
> tool BEFORE your first search - the sparring prompt already says to do this.

**Trigger scenario**: Recent papers, SOTA assessment, citations, BibTeX, paper -> source code

## Tool Selection Matrix

| Goal | Which MCP tool(s) | Notes |
| --- | --- | --- |
| Find a paper | `semantic-scholar` (`search_papers`), `arxiv` (`arxiv_search`), `dblp` (`search`/`fuzzy_title_search`) | S2 first for broad coverage; arxiv for CS preprints; dblp for exact records |
| Find citations / references | `semantic-scholar` (`get_paper_citations`, `get_paper_references`) | Citation metrics via S2 `citationCount` |
| Get full text | `arxiv` (`arxiv_read_paper`, `arxiv_get_metadata`) | Best for preprints; HTML -> ar5iv -> PDF extraction fallback chain |
| Get authoritative BibTeX | `dblp` (`search` with `include_bibtex`, `add_bibtex_entry` + `export_bibtex`) | Direct DBLP export, not LLM-generated |
| Find source code / implementation of a paper | `github` (`search_code`, `search_repositories`), `sourcegraph` (`search`) | See "Paper -> Source Code Linking Strategy" below |
| Find reference implementation (maintained) | `github` (`search_repositories`) | Check stars + last commit to confirm maintenance |
| Find latest SOTA | `semantic-scholar` (sort by year, filter last 1-2 years), `arxiv` (sort by submitted), `dblp` (year filters) | `websearch`/Papers With Code as fallback |

## Per-tool details

### semantic-scholar
- npx `@xbghc/semanticscholar-mcp`; queries the Semantic Scholar Academic Graph API.
- Rate limit: 100 req/5min without a key; with `SEMANTIC_SCHOLAR_API_KEY` the limit is raised (server throttles to 2s/request with key, 5s without). Key is OPTIONAL.
- Tools: `search_papers`, `get_paper`, `get_paper_citations`, `get_paper_references`, `batch_get_papers`, `search_authors`, `get_author`, `get_author_papers`, `get_recommendations`.
- Accepts many paper ID formats: S2 ID, `DOI:...`, `ARXIV:...`, `PMID:...`, `CorpusId:...`.

### arxiv
- npx `@cyanheads/arxiv-mcp-server`; queries the arXiv API (metadata CC0, free, NO key).
- Rate limit: arXiv enforces ~3s between requests; the server queues requests to honor it (5s/10s/20s/30s adaptive cooldown on 429s).
- Tools: `arxiv_search` (field prefixes `ti:` `au:` `abs:` `cat:` `all:`, boolean operators, category/sort filters, `submitted_from`/`submitted_to`), `arxiv_get_metadata` (batch up to 10), `arxiv_read_paper` (full text; `max_characters`, page with `start`), `arxiv_list_categories`.
- Resources: `arxiv://paper/{id}`, `arxiv://categories`.

### github
- Official Go binary `github-mcp-server stdio --read-only --toolsets repos,issues,pull_requests,users`; reads `GITHUB_PERSONAL_ACCESS_TOKEN` (recommended).
- Rate limit: 5000 req/hour REST with PAT; code search is 10 req/min unauthenticated, 30 req/min with PAT.
- Read-only mode is enforced server-side (write tools are skipped). `repos` toolset covers `search_code` and `search_repositories`.

### dblp
- `uvx mcp-dblp`; queries the DBLP computer science bibliography. NO key.
- Tools: `search` (boolean queries, `year_from`/`year_to`, `venue_filter`, `include_bibtex`), `fuzzy_title_search`, `get_author_publications`, `get_venue_info`, `add_bibtex_entry` + `export_bibtex` (direct DBLP BibTeX export, not LLM-generated).
- Best source for exact BibTeX records and venue/author disambiguation.

### sourcegraph
- `uvx --from git+https://github.com/akbad/sourcegraph-mcp sourcegraph-mcp`; reads `SRC_ENDPOINT` (required) and `SRC_ACCESS_TOKEN` (optional). Token REQUIRED for private instances; cloud token starts with `sgp_`.
- DISABLED by default in opencode.jsonc until a token is configured.
- Note: this server only exposes HTTP/SSE transports (no stdio); the `type: local` entry in opencode.jsonc may need switching to a manually-started HTTP server before enabling.
- Tools: `search` (Sourcegraph query language, `limit` 1-100), `search_prompt_guide`, `fetch_content`.

## Paper -> Source Code Linking Strategy

To go from a paper to its reference implementation:

1. **Semantic Scholar details**: `get_paper` on the paper ID and read `externalIds` (arxiv, DOI, ACL/PMLR ids) plus `openAccessPdf` for the full text.
2. **ArXiv id -> GitHub**: `github` MCP `search_code`/`search_repositories` for the paper title, the arxiv id (e.g. `1706.03762`), or "first author + method name". Models like "AlphaFold" or "Diffusion Transformer" are usually in the repo name.
3. **Papers With Code mapping**: if GitHub search is inconclusive, `webfetch` `https://paperswithcode.com/api/v1/search/?q=<title>` (JSON API) to map the paper to its official GitHub repo.
4. **Confirm maintenance**: with the `github` MCP, check the repo's stars and last commit date before citing it as the reference implementation - a stale or unmaintained repo is a weaker evidence point.

## Fallbacks and cautions

- Google Scholar has NO real API (scraping violates ToS - fragile). Use `websearch`/`webfetch` as a last resort, not a primary path.
- Prefer Semantic Scholar `citationCount` over any web claim for citation metrics.
- `websearch`/`webfetch` remain the fallback for sources the MCP tools do not cover: Google Scholar, Papers With Code pages, blog posts, production post-mortems, vendor docs.
- Remember: load this module with the `read` tool before your first search (the sparring prompt already instructs this).
