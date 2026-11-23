# Research Tool Matrix

Per-server reference detail behind the tool-selection table in SKILL.md. Distilled from `knowledge/web-search-modules/research-apis.md`.

## Selection table

| Goal | Which tool(s) | Notes |
| --- | --- | --- |
| Find a paper | `semantic-scholar` (`search_papers`), `arxiv` (`arxiv_search`), `dblp` (`search`, `fuzzy_title_search`) | S2 first for broad coverage; arxiv for CS preprints; dblp for exact records |
| Find citations / references | `semantic-scholar` (`get_paper_citations`, `get_paper_references`) | Citation metrics via S2 `citationCount` |
| Get full text | `arxiv` (`arxiv_read_paper`, `arxiv_get_metadata`) | Best for preprints; HTML -> ar5iv -> PDF extraction fallback chain |
| Get authoritative BibTeX | `dblp` (`search` with `include_bibtex`, `add_bibtex_entry` + `export_bibtex`) | Direct DBLP export, not model-generated |
| Find source code / implementation of a paper | `github` (`search_code`, `search_repositories`), `sourcegraph` (`search`) | See paper-to-code linking below |
| Find a maintained reference implementation | `github` (`search_repositories`) | Check stars and last commit before citing it |
| Find latest SOTA | `semantic-scholar` (sort by year, filter last 1-2 years), `arxiv` (sort by submitted), `dblp` (year filters) | `ddgs` / Papers With Code as fallback |
| Find a dataset or benchmark for a task | `semantic-scholar` (the paper that introduced it), `ddgs` on the benchmark's official site | Check license, split protocol, and version before citing |
| Get a sensor or hardware specification | `ddgs` on the vendor or standards-body page, `webfetch` the datasheet | Vendor datasheet and standards documents are authoritative |
| Read robotics framework docs (ROS 2, MoveIt, Nav2) | `ddgs` on the project docs, `github` for issues and source | Match the pinned distro version |
| Find a reproducibility package or DOI | `github` (paper repo and release tags), `ddgs` for the Zenodo or OSF record | Prefer the DOI record for citation and archival |

## Per-tool details

### semantic-scholar

- npx `@xbghc/semanticscholar-mcp`; queries the Semantic Scholar Academic Graph API.
- Rate limit: 100 requests / 5 min without a key; with `SEMANTIC_SCHOLAR_API_KEY` the limit is raised (server throttles to 2 s per request with a key, 5 s without). Key is optional.
- Tools: `search_papers`, `get_paper`, `get_paper_citations`, `get_paper_references`, `batch_get_papers`, `search_authors`, `get_author`, `get_author_papers`, `get_recommendations`.
- Accepts many paper ID formats: S2 id, `DOI:...`, `ARXIV:...`, `PMID:...`, `CorpusId:...`.

### arxiv

- npx `@cyanheads/arxiv-mcp-server`; queries the arXiv API (metadata is CC0, free, no key).
- Rate limit: arXiv enforces about 3 s between requests; the server queues requests (5/10/20/30 s adaptive cooldown on 429s).
- Tools: `arxiv_search` (field prefixes `ti:` `au:` `abs:` `cat:` `all:`, boolean operators, category and sort filters, `submitted_from` / `submitted_to`), `arxiv_get_metadata` (batch up to 10), `arxiv_read_paper` (full text; `max_characters`, page with `start`), `arxiv_list_categories`.
- Resources: `arxiv://paper/{id}`, `arxiv://categories`.

### github

- Official Go binary `github-mcp-server stdio --read-only --toolsets repos,issues,pull_requests,users`; reads `GITHUB_PERSONAL_ACCESS_TOKEN` (recommended).
- Rate limit: 5000 requests / hour REST with a PAT; code search is 10 requests / min unauthenticated, 30 requests / min with a PAT.
- Read-only mode is enforced server-side (write tools are skipped). The `repos` toolset covers `search_code` and `search_repositories`.

### dblp

- `uvx mcp-dblp`; queries the DBLP computer science bibliography. No key.
- Tools: `search` (boolean queries, `year_from` / `year_to`, `venue_filter`, `include_bibtex`), `fuzzy_title_search`, `get_author_publications`, `get_venue_info`, `add_bibtex_entry` + `export_bibtex`.
- Best source for exact BibTeX records and venue or author disambiguation.

### sourcegraph

- `uvx --from git+https://github.com/akbad/sourcegraph-mcp sourcegraph-mcp`; reads `SRC_ENDPOINT` (required) and `SRC_ACCESS_TOKEN` (optional). Token required for private instances; cloud tokens start with `sgp_`.
- Disabled by default in `opencode.jsonc` until a token is configured.
- This server exposes only HTTP/SSE transports (no stdio), so enabling it means switching the local entry to a manually started HTTP server first. Until then, use `github` code search instead.
- Tools: `search` (Sourcegraph query language, `limit` 1-100), `search_prompt_guide`, `fetch_content`.

## Paper-to-code linking

To go from a paper to its reference implementation:

1. **Semantic Scholar details:** `get_paper` on the paper id and read `externalIds` (arxiv, DOI, ACL/PMLR ids) plus `openAccessPdf` for the full text.
2. **arXiv id to GitHub:** `github` `search_code` / `search_repositories` for the paper title, the arXiv id (for example `1706.03762`), or "first author + method name". Named methods usually appear in the repo name.
3. **Papers With Code mapping:** if GitHub search is inconclusive, `webfetch` `https://paperswithcode.com/api/v1/search/?q=<title>` (JSON API) to map the paper to its official repo.
4. **Confirm maintenance:** with the `github` tool, check stars and last commit date before citing a repo as the reference implementation. A stale or unmaintained repo is weaker evidence.

## Fallbacks and cautions

- `ddgs` (`search_text`, `extract_content`) is the preferred quota-free general-web fallback for sources the research APIs do not cover. `websearch` / `webfetch` are the final fallback when ddgs does not surface the source.
- Google Scholar has no real API; scraping violates its terms and is fragile. Use it as a last resort, never as a primary path.
- Prefer Semantic Scholar `citationCount` over any web claim for citation metrics.
- `websearch` / `webfetch` remain the fallback for Google Scholar, Papers With Code pages, blog posts, production post-mortems, and vendor docs.
